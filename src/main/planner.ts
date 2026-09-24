import { GoogleGenAI } from '@google/genai'
import * as fs from 'fs'
import { join } from 'path'
import { logger } from './logger'
import type { TranscriptResult } from '../../shared/types'

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
  visualIntent?: string
  searchQueries?: string[]
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
  const hasLocalMedia = mediaFiles.length > 0

  const mediaList = hasLocalMedia ? [
    ...videoFiles.map(v => `  VIDEO: ${v.filename} (${v.durationSecs?.toFixed(1) ?? '?'}s)`),
    ...imageFiles.map(i => `  IMAGE: ${i.filename}`)
  ].join('\n') : ''

  const transcriptLines = transcript.segments.map(seg =>
    `[${seg.id}] ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s: "${seg.text}"`
  ).join('\n')

  const mediaSection = hasLocalMedia
    ? `## AVAILABLE LOCAL MEDIA LIBRARY\n${mediaList}\n`
    : `## MEDIA MODE: STOCK SEARCH ONLY\nNo local media files provided. You MUST NOT invent filenames. Set "localAsset" to null for all scenes.\n`

  const sceneSchemaExample = hasLocalMedia
    ? `{
              "sceneIndex": 1,
              "localAsset": "exact_filename.mp4 or null if no match",
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot",
              "visualIntent": "short description of visual concept (3-10 words)",
              "searchQueries": ["short query 1", "short query 2", "short query 3"]
            }`
    : `{
              "sceneIndex": 1,
              "localAsset": null,
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot",
              "visualIntent": "short description of visual concept (3-10 words)",
              "searchQueries": ["short query 1", "short query 2", "short query 3"]
            }`

  return `You are a professional documentary video editor AI. Your job is to create a complete master edit plan.

## NARRATION TRANSCRIPT (${transcript.segments.length} segments, ${transcript.duration.toFixed(0)}s total)
${transcriptLines}

${mediaSection}
${scriptText ? `## ORIGINAL SCRIPT\n${scriptText.slice(0, 8000)}\n` : ''}

## YOUR TASK
Create a master edit plan as a JSON object. Rules:
1. Every second of narration MUST be covered by a media clip
2. ${hasLocalMedia ? 'Match local files logically to narrative content. Set "localAsset" to the exact filename if matched, or null if no local file fits — stock search will fill those gaps.' : 'Set "localAsset" to null for all scenes (stock will be auto-searched).'}
3. Videos can be used for their full duration or trimmed
4. Images should display for 3-8 seconds
5. Divide the content into 3-6 chapters with meaningful titles
6. Each chapter has 2-4 sequences, each sequence has 2-6 scenes
7. Transition between scenes: mostly "cut", use "fade" for chapter breaks
8. For EVERY scene, write a "visualIntent" (3-10 words describing the visual concept) and 3-5 "searchQueries".
   IMPORTANT — searchQueries must be SHORT and VISUALLY SEARCHABLE (not literal narration sentences).
   BAD:  "family has to borrow money to cover funeral expenses"
   GOOD: ["worried family bills", "credit card debt", "financial stress", "loan paperwork"]

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
            ${sceneSchemaExample}
          ]
        }
      ]
    }
  ]
}`
}

// ─── Algorithmic rule-based fallback generator (Guarantees 100% success) ──────

function extractVisualQueries(text: string): string[] {
  const clean = text.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'0-9]/g, ' ').trim()
  const words = clean.split(/\s+/).filter((w) => w.length > 2)
  const queries: string[] = []
  if (words.length >= 3) {
    queries.push(words.slice(0, 4).join(' '))
    const mid = Math.floor(words.length / 2)
    queries.push(words.slice(mid, mid + 3).join(' '))
    queries.push(words.slice(-3).join(' '))
  } else {
    queries.push(clean || 'documentary cinematic shot')
  }
  return queries.filter((q) => q.length >= 3).slice(0, 3)
}

function buildAlgorithmicPlan(
  transcript: TranscriptResult,
  projectName: string
): MasterEditPlan {
  const segments = transcript.segments
  const totalDuration = transcript.duration

  const numChapters = Math.min(5, Math.max(2, Math.round(totalDuration / 90)))
  const segsPerChapter = Math.ceil(segments.length / numChapters)

  const chapters: ChapterPlan[] = []
  let globalSceneIdx = 1

  for (let chIdx = 0; chIdx < numChapters; chIdx++) {
    const chSegs = segments.slice(chIdx * segsPerChapter, (chIdx + 1) * segsPerChapter)
    if (chSegs.length === 0) continue

    const chStart = chSegs[0].start
    const chEnd = chSegs[chSegs.length - 1].end

    const seqsPerCh = Math.min(3, Math.max(1, Math.ceil(chSegs.length / 4)))
    const segsPerSeq = Math.ceil(chSegs.length / seqsPerCh)
    const sequences: SequencePlan[] = []

    for (let seqIdx = 0; seqIdx < seqsPerCh; seqIdx++) {
      const seqSegs = chSegs.slice(seqIdx * segsPerSeq, (seqIdx + 1) * segsPerSeq)
      if (seqSegs.length === 0) continue

      const scenes: ScenePlan[] = seqSegs.map((seg) => {
        const dur = Math.max(2, Number((seg.end - seg.start).toFixed(1)))
        const queries = extractVisualQueries(seg.text)
        return {
          sceneIndex: globalSceneIdx++,
          mediaFile: '',
          mediaType: 'video',
          startTime: seg.start,
          endTime: seg.end,
          duration: dur,
          narrativeText: seg.text,
          transcriptSegmentIds: [seg.id],
          transitionIn: 'cut',
          visualNote: `Visual shot: ${queries[0]}`,
          visualIntent: queries[0] ?? 'Documentary cinematic b-roll',
          searchQueries: queries
        }
      })

      sequences.push({
        sequenceIndex: seqIdx + 1,
        title: `Sequence ${seqIdx + 1}`,
        startTime: seqSegs[0].start,
        endTime: seqSegs[seqSegs.length - 1].end,
        scenes
      })
    }

    chapters.push({
      chapterIndex: chIdx + 1,
      title: chIdx === 0 ? 'Chapter 1: Introduction' : chIdx === numChapters - 1 ? `Chapter ${chIdx + 1}: Conclusion` : `Chapter ${chIdx + 1}`,
      startTime: chStart,
      endTime: chEnd,
      sequences
    })
  }

  const allScenes = chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))

  return {
    projectName,
    totalDuration,
    totalScenes: allScenes.length,
    language: transcript.language,
    chapters,
    generatedAt: new Date().toISOString(),
    modelUsed: 'rule-based-engine'
  }
}

// ─── Main planner function ────────────────────────────────────────────────────

export async function buildEditPlan(params: {
  projectDir: string
  apiKey: string
  model?: string
  scriptPath?: string | null
  onProgress?: (msg: string, pct: number) => void
}): Promise<MasterEditPlan> {
  const { projectDir, apiKey, onProgress } = params
  const modelId = params.model ?? 'gemini-2.0-flash'
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
    const rawItems = JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8')) as Array<{
      type: string
      path?: string
      filename: string
      durationSecs?: number
      fps?: number
      width?: number
      height?: number
    }>

    mediaFiles = rawItems.map(item => ({
      filePath: item.path ?? '',
      filename: item.filename,
      type: (item.type === 'video' ? 'video' : 'image') as 'video' | 'image',
      durationSecs: item.durationSecs,
      fps: item.fps,
      width: item.width,
      height: item.height
    }))
  }

  // 3. Load script text — prefer passed param, fallback to reading state file
  let scriptText: string | null = null
  try {
    // Try project-state.json (correct filename)
    const stateFile = fs.existsSync(join(projectDir, 'project-state.json'))
      ? join(projectDir, 'project-state.json')
      : join(projectDir, 'project.json')

    const scriptPathFromParams = params.scriptPath
    const scriptPathFromState = (() => {
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
        return st?.inputs?.scriptPath as string | undefined
      } catch { return undefined }
    })()

    const resolvedScriptPath = scriptPathFromParams ?? scriptPathFromState
    if (resolvedScriptPath && fs.existsSync(resolvedScriptPath)) {
      scriptText = fs.readFileSync(resolvedScriptPath, 'utf-8')
    }
  } catch (err) {
    logger.warn(`Could not load script text: ${err}`)
  }

  // Re-read project name from state
  let projectName = 'Unnamed'
  try {
    const stateFile = fs.existsSync(join(projectDir, 'project-state.json'))
      ? join(projectDir, 'project-state.json')
      : join(projectDir, 'project.json')
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
    projectName = st?.name ?? 'Unnamed'
  } catch { /* ignore */ }

  progress(`Building prompt (${transcript.segments.length} segments, ${mediaFiles.length} media files)...`, 0.12)

  // 4. Build prompt and call Gemini
  const prompt = buildPrompt(transcript, scriptText, mediaFiles)

  progress('Sending to Gemini AI...', 0.20)

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1alpha' }
  })

  // Fallback model chain: selected model -> gemini-2.0-flash -> gemini-1.5-flash
  const fallbackModelChain = [
    modelId,
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ].filter((v, i, a) => a.indexOf(v) === i)

  let activeModelIndex = 0
  let rawJson = ''
  let finalModelUsed = modelId
  const maxRetries = 5

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const currentModel = fallbackModelChain[activeModelIndex]
    try {
      progress(
        attempt === 1
          ? `Đang gửi yêu cầu tới Gemini AI (${currentModel})...`
          : `Thử lại lần ${attempt}/${maxRetries} (${currentModel})...`,
        0.20 + (attempt - 1) * 0.1
      )
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 32768
        }
      })
      rawJson = response.text ?? ''
      finalModelUsed = currentModel
      break
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const isOverloaded =
        msg.includes('503') ||
        msg.includes('high demand') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('429')

      // Case A: Model is overloaded and we have another model in the fallback chain -> auto-switch immediately!
      if (isOverloaded && activeModelIndex + 1 < fallbackModelChain.length) {
        activeModelIndex++
        const nextModel = fallbackModelChain[activeModelIndex]
        logger.warn(`Model ${currentModel} overloaded (503). Auto-switching to fallback: ${nextModel}`)
        progress(
          `Model ${currentModel} đang quá tải (503). Tự động chuyển sang model dự phòng "${nextModel}"...`,
          0.30 + (attempt / maxRetries) * 0.35
        )
        await new Promise((res) => setTimeout(res, 2000))
        continue
      }

      // Case B: Retry with countdown backoff
      if (isOverloaded && attempt < maxRetries) {
        const waitSec = Math.min(attempt * 4, 16)
        logger.warn(`Gemini 503 high demand (attempt ${attempt}/${maxRetries}), waiting ${waitSec}s...`)
        for (let sec = waitSec; sec > 0; sec--) {
          progress(
            `Google AI đang quá tải (503 High Demand), tự động thử lại lần ${attempt + 1}/${maxRetries} sau ${sec}s...`,
            0.30 + ((attempt - 1) / maxRetries) * 0.35
          )
          await new Promise((res) => setTimeout(res, 1000))
        }
        continue
      }

      // Case C: If all AI attempts fail, activate rule-based fallback generator
      logger.warn(`All AI attempts failed (${msg}). Activating algorithmic rule-based fallback generator...`)
      progress('Google AI tạm thời quá tải trên diện rộng. Tự động kích hoạt bộ tạo phân cảnh thông minh theo kịch bản...', 0.85)
      const fallbackPlan = buildAlgorithmicPlan(transcript, projectName)
      const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
      fs.writeFileSync(planPath, JSON.stringify(fallbackPlan, null, 2), 'utf-8')
      progress(`Hoàn tất — đã tạo phân cảnh dự phòng (${fallbackPlan.totalScenes} scenes)`, 1.0)
      return fallbackPlan
    }
  }

  progress('Parsing edit plan...', 0.85)

  // 5. Parse and enrich
  let planData: { chapters: ChapterPlan[] }
  try {
    // Strip markdown code fences if present
    const clean = rawJson.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    planData = JSON.parse(clean)
  } catch (err) {
    logger.warn('Failed to parse Gemini JSON, falling back to algorithmic plan', { raw: rawJson.slice(0, 300) })
    const fallbackPlan = buildAlgorithmicPlan(transcript, projectName)
    const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
    fs.writeFileSync(planPath, JSON.stringify(fallbackPlan, null, 2), 'utf-8')
    progress(`Hoàn tất — đã tạo phân cảnh dự phòng (${fallbackPlan.totalScenes} scenes)`, 1.0)
    return fallbackPlan
  }

  // Ensure every scene has mediaFile defined
  for (const ch of planData.chapters || []) {
    const seqs = (ch as { sequences?: unknown[]; chapters_seq?: unknown[] }).sequences ?? (ch as { chapters_seq?: unknown[] }).chapters_seq ?? []
    for (const seq of seqs as Array<{ scenes?: Array<ScenePlan & { localAsset?: string }> }>) {
      for (const sc of (seq.scenes || [])) {
        if (!sc.mediaFile) {
          sc.mediaFile = sc.localAsset || ''
        }
        if (!sc.mediaType) {
          sc.mediaType = 'video'
        }
      }
    }
  }

  // Compute totals
  const allScenes = planData.chapters.flatMap(c =>
    ((c as { sequences?: unknown[]; chapters_seq?: unknown[] }).sequences ?? (c as { chapters_seq?: unknown[] }).chapters_seq ?? [] as Array<{ scenes?: ScenePlan[] }>).flatMap(s => s.scenes ?? [])
  )
  const totalScenes = allScenes.length
  const totalDuration = transcript.duration

  const plan: MasterEditPlan = {
    projectName: projectName,
    totalDuration,
    totalScenes,
    language: transcript.language,
    chapters: planData.chapters,
    generatedAt: new Date().toISOString(),
    modelUsed: finalModelUsed
  }

  // 6. Save
  progress('Saving edit plan...', 0.95)
  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  logger.info('Edit plan saved', { chapters: plan.chapters.length, scenes: totalScenes })

  progress(`Done — ${plan.chapters.length} chapters, ${totalScenes} scenes`, 1.0)
  return plan
}
