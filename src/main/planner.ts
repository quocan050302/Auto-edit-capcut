import { GoogleGenerativeAI } from '@google/generative-ai'
import * as fs from 'fs'
import { join } from 'path'
import { logger } from './logger'
import type { TranscriptResult, TranscriptSegment } from '../../shared/types'

// ─── Edit Plan Types ──────────────────────────────────────────────────────────

export interface MediaClip {
  filePath: string
  filename: string
  type: 'video' | 'image'
  durationSecs?: number
  fps?: number
  width?: number
  height?: number
}

export interface ScenePlan {
  sceneIndex: number
  mediaFile: string           // matched filename from library
  mediaType: 'video' | 'image'
  startTime: number           // seconds in final timeline
  endTime: number             // seconds in final timeline
  duration: number
  narrativeText: string       // text being spoken during this scene
  transcriptSegmentIds: string[]
  transitionIn?: 'cut' | 'fade' | 'dissolve'
  visualNote?: string         // AI suggestion for what to show
}

export interface SequencePlan {
  sequenceIndex: number
  title: string
  startTime: number
  endTime: number
  scenes: ScenePlan[]
}

export interface ChapterPlan {
  chapterIndex: number
  title: string
  startTime: number
  endTime: number
  sequences: SequencePlan[]
}

export interface MasterEditPlan {
  projectName: string
  totalDuration: number
  totalScenes: number
  language: string
  chapters: ChapterPlan[]
  generatedAt: string
  modelUsed: string
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  transcript: TranscriptResult,
  scriptText: string | null,
  mediaFiles: MediaClip[]
): string {
  const videoFiles = mediaFiles.filter(m => m.type === 'video')
  const imageFiles = mediaFiles.filter(m => m.type === 'image')

  const mediaList = [
    ...videoFiles.map(v => `  VIDEO: ${v.filename} (${v.durationSecs?.toFixed(1) ?? '?'}s)`),
    ...imageFiles.map(i => `  IMAGE: ${i.filename}`)
  ].join('\n')

  const transcriptLines = transcript.segments.map(seg =>
    `[${seg.id}] ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s: "${seg.text}"`
  ).join('\n')

  return `You are a professional documentary video editor AI. Your job is to create a complete master edit plan that matches narration segments with available media files.

## NARRATION TRANSCRIPT (${transcript.segments.length} segments, ${transcript.duration.toFixed(0)}s total)
${transcriptLines}

## AVAILABLE MEDIA LIBRARY
${mediaList}

${scriptText ? `## ORIGINAL SCRIPT\n${scriptText.slice(0, 8000)}\n` : ''}

## YOUR TASK
Create a master edit plan as a JSON object. Rules:
1. Every second of narration MUST be covered by a media clip
2. Match media files logically to the narrative content (use filename clues)
3. Videos can be used for their full duration or trimmed
4. Images should display for 3-8 seconds
5. Divide the content into 3-6 chapters with meaningful titles
6. Each chapter has 2-4 sequences, each sequence has 2-6 scenes
7. Transition between scenes: mostly "cut", use "fade" for chapter breaks

Return ONLY valid JSON, no explanation, matching this exact schema:
{
  "chapters": [
    {
      "chapterIndex": 1,
      "title": "Chapter title",
      "startTime": 0,
      "endTime": 120,
      "sequences": [
        {
          "sequenceIndex": 1,
          "title": "Sequence title",
          "startTime": 0,
          "endTime": 60,
          "scenes": [
            {
              "sceneIndex": 1,
              "mediaFile": "exact_filename.mp4",
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot"
            }
          ]
        }
      ]
    }
  ]
}`
}

// ─── Main planner function ────────────────────────────────────────────────────

export async function buildEditPlan(params: {
  projectDir: string
  apiKey: string
  onProgress?: (msg: string, pct: number) => void
}): Promise<MasterEditPlan> {
  const { projectDir, apiKey, onProgress } = params
  const progress = (msg: string, pct: number): void => {
    logger.info(`[PLAN] ${msg}`)
    onProgress?.(msg, pct)
  }

  // 1. Load transcript
  progress('Loading transcript...', 0.05)
  const transcriptPath = join(projectDir, 'analysis', 'transcript.json')
  if (!fs.existsSync(transcriptPath)) {
    throw new Error('No transcript found. Run transcription first.')
  }
  const transcript: TranscriptResult = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'))

  // 2. Load script (optional)
  progress('Loading script...', 0.08)
  const mediaIndexPath = join(projectDir, 'analysis', 'media-index.json')
  let mediaFiles: MediaClip[] = []

  if (fs.existsSync(mediaIndexPath)) {
    const mediaIndex = JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8'))
    const videos = (mediaIndex.videos ?? []) as Array<{
      filePath: string; filename: string; durationSecs: number; fps: number; width: number; height: number
    }>
    const images = (mediaIndex.images ?? []) as Array<{ filePath: string; filename: string }>

    mediaFiles = [
      ...videos.map(v => ({ ...v, type: 'video' as const })),
      ...images.map(i => ({ ...i, type: 'image' as const }))
    ]
  }

  // 3. Load script text
  let scriptText: string | null = null
  const state = JSON.parse(
    fs.readFileSync(join(projectDir, 'project.json'), 'utf-8')
  )
  if (state?.inputs?.scriptPath && fs.existsSync(state.inputs.scriptPath)) {
    scriptText = fs.readFileSync(state.inputs.scriptPath, 'utf-8')
  }

  progress(`Building prompt (${transcript.segments.length} segments, ${mediaFiles.length} media files)...`, 0.12)

  // 4. Build prompt and call Gemini
  const prompt = buildPrompt(transcript, scriptText, mediaFiles)

  progress('Sending to Gemini AI...', 0.20)

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 32768
    }
  })

  progress('Waiting for Gemini response (may take 30-60 seconds)...', 0.30)

  let rawJson: string
  try {
    const result = await model.generateContent(prompt)
    rawJson = result.response.text()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Gemini API error: ${msg}`)
  }

  progress('Parsing edit plan...', 0.85)

  // 5. Parse and enrich
  let planData: { chapters: ChapterPlan[] }
  try {
    // Strip markdown code fences if present
    const clean = rawJson.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    planData = JSON.parse(clean)
  } catch (err) {
    logger.error('Failed to parse Gemini JSON', { raw: rawJson.slice(0, 500) })
    throw new Error(`Failed to parse AI response as JSON: ${err}`)
  }

  // Compute totals
  const allScenes = planData.chapters.flatMap(c =>
    c.sequences.flatMap(s => s.scenes)
  )
  const totalScenes = allScenes.length
  const totalDuration = transcript.duration

  const plan: MasterEditPlan = {
    projectName: state?.name ?? 'Unnamed',
    totalDuration,
    totalScenes,
    language: transcript.language,
    chapters: planData.chapters,
    generatedAt: new Date().toISOString(),
    modelUsed: 'gemini-1.5-flash'
  }

  // 6. Save
  progress('Saving edit plan...', 0.95)
  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  logger.info('Edit plan saved', { chapters: plan.chapters.length, scenes: totalScenes })

  progress(`Done — ${plan.chapters.length} chapters, ${totalScenes} scenes`, 1.0)
  return plan
}
