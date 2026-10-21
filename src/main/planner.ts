import { GoogleGenAI } from '@google/genai'
import * as fs from 'fs'
import { join, extname } from 'path'
import { logger } from './logger'
import { normalizeApiKey } from './utils/api-key'
import {
  normalizePreferredTextModel,
  classifyGeminiErrorKind,
  DEPRECATED_TEXT_MODELS
} from './utils/gemini-fallback'
import { getAvailableModelsForTask } from './ai/model-router'
import { recordModelSuccess, recordModelFailure } from './ai/model-health'
import { sanitizeStockQuery, dedupeStockQueries } from './stock/query-sanitizer'
import {
  executePlanningRequest,
  PlanningTimeoutError,
  PlanningCancelledError,
  computeBatchTimeoutMs,
  computeOutputTokenBudget
} from './ai/planning-request'
import type { TranscriptResult, MasterEditPlanRetentionExt, Pacing, GlobalScriptContext } from '../../shared/types'
import { analyzePacing, flattenPlanScenes } from './pacing-guard'
import type { PacingScene } from './pacing-guard'
import { buildSceneSkeleton, type SceneSkeleton } from './planning/scene-segmenter'
import { validateScenePlanCoverage } from './planning/scene-validator'
import { analyzeGlobalContext } from './stock/global-context-analyzer'
import { computeSourceFingerprint } from './pipeline/source-fingerprint'
import { loadContentIntelligence } from './content-intelligence/content-intelligence-analyzer'
import { validateSemanticFidelity } from './content-intelligence/semantic-fidelity'
import { generateVisualIdentityBible } from './content-intelligence/visual-identity-bible'

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
  // ─── Retention Engine fields (optional, added by pacing-guard) ───────────
  energyLevel?: 'low' | 'medium' | 'high'          // used by pacing-guard & audio intensity
  shotType?: 'wide' | 'medium' | 'close-up' | 'abstract' // used by pattern interrupt detection
  motifIds?: string[]                               // links to MasterEditPlan.motifRegistry
  isPatternInterrupt?: boolean                       // marked by pacing-guard
  localPath?: string                                // set by stock engine or user upload
  localAsset?: string
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

export interface MasterEditPlan extends MasterEditPlanRetentionExt {
  projectName: string
  totalDuration: number
  totalScenes: number
  language: string
  chapters: ChapterPlan[]
  generatedAt: string
  modelUsed: string
  sourceHash?: string
}

// ─── Algorithmic rule-based helpers ──────────────────────────────────────────

export function extractVisualQueries(text: string): string[] {
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

function inferEnergyLevelFromText(text: string): 'low' | 'medium' | 'high' {
  const lower = text.toLowerCase()
  const highCues = ['conflict', 'battle', 'crisis', 'explosion', 'urgent', 'reveal', 'shocking', 'protest', 'disaster', 'death']
  if (highCues.some((c) => lower.includes(c))) return 'high'
  const lowCues = ['peaceful', 'quiet', 'meditation', 'reflection', 'landscape', 'slow', 'history', 'archive']
  if (lowCues.some((c) => lower.includes(c))) return 'low'
  return 'medium'
}

function inferShotTypeFromText(text: string): 'wide' | 'medium' | 'close-up' | 'abstract' {
  const lower = text.toLowerCase()
  if (lower.includes('close') || lower.includes('face') || lower.includes('detail') || lower.includes('hand')) return 'close-up'
  if (lower.includes('aerial') || lower.includes('wide') || lower.includes('landscape') || lower.includes('panorama')) return 'wide'
  if (lower.includes('abstract') || lower.includes('symbol') || lower.includes('silhouette')) return 'abstract'
  return 'medium'
}

// ─── Outline Types & Helpers ──────────────────────────────────────────────────

interface OutlineSequence {
  sequenceIndex: number
  title: string
  startSceneIndex: number
  endSceneIndex: number
}

interface OutlineChapter {
  chapterIndex: number
  title: string
  purpose?: string
  startSceneIndex: number
  endSceneIndex: number
  sequences: OutlineSequence[]
}

function buildAlgorithmicOutline(
  skeletons: SceneSkeleton[],
  totalDuration: number,
  globalContextSummary?: string
): OutlineChapter[] {
  if (skeletons.length === 0) return []

  // Short script optimization: 1 scene
  if (skeletons.length === 1) {
    const s = skeletons[0]
    return [
      {
        chapterIndex: 1,
        title: 'Chapter 1: Story Arc',
        purpose: 'Narrative presentation',
        startSceneIndex: s.sceneIndex,
        endSceneIndex: s.sceneIndex,
        sequences: [
          {
            sequenceIndex: 1,
            title: 'Sequence 1: Visual Presentation',
            startSceneIndex: s.sceneIndex,
            endSceneIndex: s.sceneIndex
          }
        ]
      }
    ]
  }

  // Short script optimization: 2 scenes
  if (skeletons.length === 2) {
    const s1 = skeletons[0]
    const s2 = skeletons[1]
    return [
      {
        chapterIndex: 1,
        title: 'Chapter 1: Introduction & Premise',
        purpose: 'Introduction and subject establishment',
        startSceneIndex: s1.sceneIndex,
        endSceneIndex: s1.sceneIndex,
        sequences: [
          {
            sequenceIndex: 1,
            title: 'Sequence 1: Opening Shot',
            startSceneIndex: s1.sceneIndex,
            endSceneIndex: s1.sceneIndex
          }
        ]
      },
      {
        chapterIndex: 2,
        title: 'Chapter 2: Development & Conclusion',
        purpose: 'Narrative payoff',
        startSceneIndex: s2.sceneIndex,
        endSceneIndex: s2.sceneIndex,
        sequences: [
          {
            sequenceIndex: 1,
            title: 'Sequence 1: Conclusion',
            startSceneIndex: s2.sceneIndex,
            endSceneIndex: s2.sceneIndex
          }
        ]
      }
    ]
  }

  // Normal / Multi-scene project: 3+ scenes
  const maxPossibleChapters = Math.min(skeletons.length, 6)
  const minPossibleChapters = Math.min(skeletons.length, skeletons.length >= 6 ? 3 : 2)
  const durationBasedChapters = Math.round(totalDuration / 180)
  const numChapters = Math.max(
    minPossibleChapters,
    Math.min(maxPossibleChapters, durationBasedChapters || minPossibleChapters)
  )

  const chapters: OutlineChapter[] = []
  let currentScenePointer = 0

  for (let chIdx = 0; chIdx < numChapters && currentScenePointer < skeletons.length; chIdx++) {
    const remainingChapters = numChapters - chIdx
    const remainingScenes = skeletons.length - currentScenePointer
    const countForThisChapter = chIdx === numChapters - 1
      ? remainingScenes
      : Math.min(remainingScenes, Math.max(1, Math.ceil(remainingScenes / remainingChapters)))

    const chScenes = skeletons.slice(currentScenePointer, currentScenePointer + countForThisChapter)
    currentScenePointer += countForThisChapter
    if (chScenes.length === 0) continue

    const startSceneIndex = chScenes[0].sceneIndex
    const endSceneIndex = chScenes[chScenes.length - 1].sceneIndex

    const maxSequences = Math.min(chScenes.length, 4)
    const numSequences = Math.max(1, Math.min(maxSequences, Math.round(chScenes.length / 8) || 1))
    const sequences: OutlineSequence[] = []

    let seqPointer = 0
    for (let seqIdx = 0; seqIdx < numSequences && seqPointer < chScenes.length; seqIdx++) {
      const remainingSeqs = numSequences - seqIdx
      const remainingSeqScenes = chScenes.length - seqPointer
      const countForThisSeq = seqIdx === numSequences - 1
        ? remainingSeqScenes
        : Math.min(remainingSeqScenes, Math.max(1, Math.ceil(remainingSeqScenes / remainingSeqs)))

      const seqScenes = chScenes.slice(seqPointer, seqPointer + countForThisSeq)
      seqPointer += countForThisSeq
      if (seqScenes.length === 0) continue

      sequences.push({
        sequenceIndex: seqIdx + 1,
        title: `Sequence ${seqIdx + 1}`,
        startSceneIndex: seqScenes[0].sceneIndex,
        endSceneIndex: seqScenes[seqScenes.length - 1].sceneIndex
      })
    }

    chapters.push({
      chapterIndex: chIdx + 1,
      title: chIdx === 0
        ? 'Chapter 1: Introduction & Premise'
        : chIdx === numChapters - 1
          ? `Chapter ${chIdx + 1}: Conclusion & Legacy`
          : `Chapter ${chIdx + 1}: Narrative Progression`,
      purpose: 'Documentary narrative arc',
      startSceneIndex,
      endSceneIndex,
      sequences
    })
  }

  return chapters
}

async function generateChapterOutlineWithGemini(
  ai: GoogleGenAI,
  modelChain: string[],
  skeletons: SceneSkeleton[],
  globalContextSummary: string,
  totalDuration: number,
  signal?: AbortSignal,
  onProgress?: (msg: string, pct: number) => void
): Promise<OutlineChapter[]> {
  if (skeletons.length === 0) return []

  // Deterministic valid outline for 1-2 scenes without slow API overhead
  if (skeletons.length <= 2) {
    logger.info(`[PLAN] Short script with ${skeletons.length} scenes: using deterministic chapter outline`)
    return buildAlgorithmicOutline(skeletons, totalDuration, globalContextSummary)
  }

  if (!modelChain || modelChain.length === 0) {
    logger.warn('[PLAN] No models available for outline. Using algorithmic outline.')
    return buildAlgorithmicOutline(skeletons, totalDuration, globalContextSummary)
  }

  const firstIndex = skeletons[0].sceneIndex
  const lastIndex = skeletons[skeletons.length - 1].sceneIndex
  const step = Math.max(1, Math.floor(skeletons.length / 10))
  const sampleScenes = skeletons
    .filter((_, i) => i === 0 || i === skeletons.length - 1 || i % step === 0)
    .map((s) => `Scene ${s.sceneIndex} (${s.startTime.toFixed(1)}s): "${s.narrativeText.slice(0, 70)}"`)
    .join('\n')

  const isShortScript = skeletons.length <= 5
  const chapterPromptGoal = isShortScript
    ? `Divide the ${skeletons.length} scenes into 1 to 2 chapters, each with 1 to 2 sequences.`
    : `Divide the ${skeletons.length} scenes into 3 to 6 chapters, each with 2 to 4 sequences.`
  const minRequiredChapters = isShortScript ? 1 : 2

  const prompt = `You are a documentary story director creating a high-level chapter and sequence outline.
Video Duration: ${totalDuration.toFixed(0)}s
Total Scenes: ${skeletons.length} (Scene ${firstIndex} to Scene ${lastIndex})

${globalContextSummary ? `## GLOBAL CONTEXT\n${globalContextSummary}\n` : ''}
## SAMPLE SCENE TIMELINE
${sampleScenes}

## YOUR TASK
${chapterPromptGoal}
Every scene from ${firstIndex} to ${lastIndex} MUST be included in exactly one sequence.
Ensure no gaps and no overlaps in startSceneIndex and endSceneIndex.

Return ONLY valid JSON matching this schema:
{
  "chapters": [
    {
      "chapterIndex": 1,
      "title": "Meaningful Chapter Title",
      "purpose": "Narrative purpose",
      "startSceneIndex": 1,
      "endSceneIndex": ${skeletons.length},
      "sequences": [
        {
          "sequenceIndex": 1,
          "title": "Sequence title",
          "startSceneIndex": 1,
          "endSceneIndex": ${skeletons.length}
        }
      ]
    }
  ]
}`

  const outlineTimeoutMs = isShortScript ? 35000 : 50000
  const maxAttempts = Math.min(2, modelChain.length)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new PlanningCancelledError('generateChapterOutlineWithGemini')
    }
    const model = modelChain[attempt]
    try {
      onProgress?.(`Generating story arc outline (${model})...`, 0.20)
      const res = await executePlanningRequest({
        task: `Chapter outline (${model})`,
        timeoutMs: outlineTimeoutMs,
        signal,
        execute: (reqSignal) =>
          ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 4096,
              abortSignal: reqSignal,
              httpOptions: { timeout: outlineTimeoutMs }
            }
          })
      })
      const clean = (res.text ?? '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
      const data = JSON.parse(clean) as { chapters?: OutlineChapter[] }

      if (data.chapters && data.chapters.length >= minRequiredChapters) {
        const covered = new Set<number>()
        let valid = true
        for (const ch of data.chapters) {
          if (!ch.sequences || ch.sequences.length === 0) {
            valid = false
            break
          }
          for (const seq of ch.sequences) {
            if (seq.startSceneIndex > seq.endSceneIndex) {
              valid = false
              break
            }
            for (let idx = seq.startSceneIndex; idx <= seq.endSceneIndex; idx++) {
              if (covered.has(idx)) {
                valid = false
                break
              }
              covered.add(idx)
            }
          }
        }
        if (valid && covered.size === skeletons.length && !skeletons.some((s) => !covered.has(s.sceneIndex))) {
          recordModelSuccess(model)
          logger.info(`[PLAN] Gemini chapter outline successfully generated: ${data.chapters.length} chapters`)
          return data.chapters
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted || err instanceof PlanningCancelledError) {
        throw err
      }
      const { kind } = classifyGeminiErrorKind(err)
      recordModelFailure(model, kind)
      if (kind === 'AUTH_ERROR') {
        break
      }
      logger.warn(`[PLAN] Gemini outline attempt with ${model} failed (${kind}): ${err}`)
    }
  }

  logger.info('[PLAN] Using algorithmic chapter outline fallback')
  return buildAlgorithmicOutline(skeletons, totalDuration, globalContextSummary)
}

// ─── Batch Prompt Builder ─────────────────────────────────────────────────────

function buildBatchEnrichmentPrompt(
  batchScenes: SceneSkeleton[],
  globalContextSummary: string,
  mediaFiles: MediaClip[]
): string {
  const hasLocalMedia = mediaFiles.length > 0
  const mediaList = hasLocalMedia
    ? [
        ...mediaFiles.filter((m) => m.type === 'video').map((v) => `  VIDEO: ${v.filename}`),
        ...mediaFiles.filter((m) => m.type === 'image').map((i) => `  IMAGE: ${i.filename}`)
      ].join('\n')
    : ''

  const mediaSection = hasLocalMedia
    ? `## AVAILABLE LOCAL MEDIA FILES (Match exact filename to localAsset if appropriate, otherwise null):\n${mediaList}\n`
    : `## MEDIA MODE: STOCK SEARCH ONLY\nNo local media files. Set localAsset to null for all scenes. Default mediaType to "video".\n`

  const scenesJson = JSON.stringify(
    batchScenes.map((s) => ({
      sceneIndex: s.sceneIndex,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration,
      narrativeText: s.narrativeText,
      transcriptSegmentIds: s.transcriptSegmentIds
    })),
    null,
    2
  )

  return `You are enriching a PRE-DETERMINED documentary scene timeline.

CRITICAL RULES:
- Do not add scenes.
- Do not remove scenes.
- Do not merge scenes.
- Do not split scenes.
- Do not renumber scenes.
- Return exactly one result for every provided sceneIndex.
- Keep results in the same order.
- Only provide visual metadata.
- Each visualIntent must describe one visible concept (3-10 words).
- Search queries must remain visually searchable (3-5 queries per scene, each query 2-6 words).
- Do not use abstract narration sentences as stock queries.
  BAD:  "family has to borrow money to cover funeral expenses"
  GOOD: ["worried family bills", "financial stress loan", "credit card bills debt"]
- Maintain global documentary context across all batches.
- Avoid repeating the same stock concept for consecutive scenes.
- Prefer real-life documentary footage.
- Use transitionIn="cut" for most scenes. Use dissolve/fade sparingly.
- Vary shotType ("wide", "medium", "close-up", "abstract") across consecutive scenes.
- Hook scenes should use visually strong and specific footage.
- mediaType must be "video" or "image" (default "video").

${globalContextSummary ? `## GLOBAL DOCUMENTARY CONTEXT\n${globalContextSummary}\n` : ''}
${mediaSection}
## SCENES TO ENRICH (${batchScenes.length} scenes)
${scenesJson}

Return ONLY valid JSON array matching this exact schema:
[
  {
    "sceneIndex": 1,
    "visualIntent": "3-10 words visual description",
    "visualNote": "Director suggestion for visual tone and camera angle",
    "searchQueries": ["short query 1", "short query 2", "short query 3"],
    "mediaType": "video",
    "transitionIn": "cut",
    "energyLevel": "medium",
    "shotType": "medium",
    "localAsset": null
  }
]`
}

// ─── Batch Enrichment Runner ──────────────────────────────────────────────────

async function enrichScenesBatchWithGemini(
  ai: GoogleGenAI,
  modelChain: string[],
  batchScenes: SceneSkeleton[],
  globalContextSummary: string,
  mediaFiles: MediaClip[],
  batchIndex: number,
  totalBatches: number,
  signal?: AbortSignal,
  onProgress?: (msg: string, pct: number) => void
): Promise<{ enrichedMap: Map<number, Partial<ScenePlan>>; modelUsed: string; usedFallback: boolean }> {
  const enrichedMap = new Map<number, Partial<ScenePlan>>()

  if (!modelChain || modelChain.length === 0) {
    logger.warn(`[PLAN] No available models in planning route for batch ${batchIndex + 1}. Using algorithmic fallback.`)
    for (const skel of batchScenes) {
      const queries = extractVisualQueries(skel.narrativeText)
      enrichedMap.set(skel.sceneIndex, {
        sceneIndex: skel.sceneIndex,
        visualIntent: queries[0] ?? 'Documentary cinematic b-roll',
        visualNote: `Visual shot: ${queries[0]}`,
        searchQueries:
          queries.length >= 3
            ? queries
            : [...queries, 'documentary archive footage', 'historical b-roll cinematic'].slice(0, 3),
        mediaType: 'video',
        transitionIn: 'cut',
        energyLevel: inferEnergyLevelFromText(skel.narrativeText),
        shotType: inferShotTypeFromText(skel.narrativeText)
      })
    }
    return { enrichedMap, modelUsed: 'algorithmic-fallback', usedFallback: true }
  }

  const prompt = buildBatchEnrichmentPrompt(batchScenes, globalContextSummary, mediaFiles)
  const timeoutMs = computeBatchTimeoutMs(batchScenes.length)
  const outputTokenBudget = computeOutputTokenBudget(batchScenes.length)
  const validBatchIndices = new Set(batchScenes.map((s) => s.sceneIndex))

  let activeModelIndex = 0
  let lastError = ''
  let successModel = modelChain[0]
  let usedFallback = false
  const maxAttempts = Math.min(2, Math.max(1, modelChain.length))

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new PlanningCancelledError('enrichScenesBatchWithGemini')
    }

    const currentModel = modelChain[activeModelIndex]
    if (!currentModel) break

    const requestStartTime = Date.now()
    try {
      onProgress?.(
        `Analyzing visual plan batch ${batchIndex + 1}/${totalBatches} (${batchScenes.length} scenes, attempt ${attempt}/${maxAttempts}: ${currentModel})...`,
        0.25 + (batchIndex / totalBatches) * 0.55 + (attempt - 1) * 0.02
      )

      const res = await executePlanningRequest({
        task: `Planning batch ${batchIndex + 1}/${totalBatches} (${currentModel})`,
        timeoutMs,
        signal,
        execute: (reqSignal) =>
          ai.models.generateContent({
            model: currentModel,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.3,
              maxOutputTokens: outputTokenBudget,
              abortSignal: reqSignal,
              httpOptions: { timeout: timeoutMs }
            }
          })
      })

      const clean = (res.text ?? '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
      const items = JSON.parse(clean) as Array<Partial<ScenePlan> & { sceneIndex?: number }>

      if (Array.isArray(items)) {
        let acceptedCount = 0
        for (const item of items) {
          if (typeof item.sceneIndex === 'number' && validBatchIndices.has(item.sceneIndex)) {
            if (!enrichedMap.has(item.sceneIndex)) {
              const validatedItem: Partial<ScenePlan> = {
                sceneIndex: item.sceneIndex,
                visualIntent: typeof item.visualIntent === 'string' && item.visualIntent.trim()
                  ? item.visualIntent.trim()
                  : undefined,
                visualNote: typeof item.visualNote === 'string' ? item.visualNote.trim() : undefined,
                searchQueries: Array.isArray(item.searchQueries) && item.searchQueries.length > 0
                  ? item.searchQueries.filter((q) => typeof q === 'string' && q.trim())
                  : undefined,
                mediaType: item.mediaType === 'image' || item.mediaType === 'video' ? item.mediaType : 'video',
                transitionIn: item.transitionIn === 'fade' || item.transitionIn === 'dissolve' || item.transitionIn === 'wipe' ? item.transitionIn : 'cut',
                energyLevel: item.energyLevel === 'low' || item.energyLevel === 'high' ? item.energyLevel : 'medium',
                shotType: item.shotType === 'wide' || item.shotType === 'close-up' || item.shotType === 'abstract' ? item.shotType : 'medium',
                localAsset: typeof item.localAsset === 'string' ? item.localAsset.trim() : null
              }
              enrichedMap.set(item.sceneIndex, validatedItem)
              acceptedCount++
            }
          }
        }

        if (acceptedCount > 0) {
          recordModelSuccess(currentModel)
          successModel = currentModel
          const elapsed = Date.now() - requestStartTime
          logger.info(
            `[PLAN] Batch ${batchIndex + 1}/${totalBatches} enriched ${acceptedCount}/${batchScenes.length} scenes with ${currentModel} in ${elapsed}ms`
          )
          break
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted || err instanceof PlanningCancelledError) {
        throw err
      }

      const elapsed = Date.now() - requestStartTime
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg
      const { kind } = classifyGeminiErrorKind(err)
      recordModelFailure(currentModel, kind)

      logger.warn(
        `[PLAN] Batch ${batchIndex + 1} attempt ${attempt} with ${currentModel} failed after ${elapsed}ms (${kind}): ${msg}`
      )

      if (kind === 'AUTH_ERROR') {
        logger.error(`[PLAN] Authentication error encountered. Stopping AI attempts for batch.`)
        break
      }

      if (activeModelIndex + 1 < modelChain.length) {
        activeModelIndex++
        const nextModel = modelChain[activeModelIndex]
        logger.info(`[PLAN] Switching to fallback model: ${nextModel}`)
      }
    }
  }

  // Verify that all scenes in this batch have enrichment; fill any missing via algorithmic fallback
  let fallbackCount = 0
  for (const skel of batchScenes) {
    if (!enrichedMap.has(skel.sceneIndex)) {
      fallbackCount++
      usedFallback = true
      const queries = extractVisualQueries(skel.narrativeText)
      enrichedMap.set(skel.sceneIndex, {
        sceneIndex: skel.sceneIndex,
        visualIntent: queries[0] ?? 'Documentary cinematic b-roll',
        visualNote: `Visual shot: ${queries[0]}`,
        searchQueries:
          queries.length >= 3
            ? queries
            : [...queries, 'documentary archive footage', 'historical b-roll cinematic'].slice(0, 3),
        mediaType: 'video',
        transitionIn: 'cut',
        energyLevel: inferEnergyLevelFromText(skel.narrativeText),
        shotType: inferShotTypeFromText(skel.narrativeText)
      })
    }
  }

  if (fallbackCount > 0) {
    logger.warn(
      `[PLAN] Batch ${batchIndex + 1}: ${fallbackCount}/${batchScenes.length} scenes used algorithmic fallback (${lastError || 'missing AI data'})`
    )
  }

  return { enrichedMap, modelUsed: successModel, usedFallback }
}

// ─── Local Media Assignment Helper ────────────────────────────────────────────

function applyLocalMediaMatching(
  scene: ScenePlan,
  localAssetSuggestion: string | null | undefined,
  mediaFiles: MediaClip[]
): void {
  if (localAssetSuggestion && mediaFiles.length > 0) {
    const cleanSuggestion = localAssetSuggestion.trim().toLowerCase()
    const matched = mediaFiles.find(
      (m) =>
        m.filename.toLowerCase() === cleanSuggestion ||
        m.filename.toLowerCase().includes(cleanSuggestion)
    )
    if (matched) {
      scene.localAsset = matched.filename
      scene.mediaFile = matched.filename
      scene.localPath = matched.filePath
      const ext = extname(matched.filename).toLowerCase()
      if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) {
        scene.mediaType = 'video'
      } else if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'].includes(ext)) {
        scene.mediaType = 'image'
      }
      return
    }
  }

  // Stock search default
  scene.mediaFile = ''
  scene.mediaType = 'video'
  scene.localAsset = undefined
}

// ─── Full Algorithmic Plan Fallback Generator ─────────────────────────────────

export function buildAlgorithmicPlan(
  transcript: TranscriptResult,
  projectName: string,
  pacing: Pacing = 'balanced',
  sourceHash?: string
): MasterEditPlan {
  const skeletons = buildSceneSkeleton(transcript, pacing)
  const outline = buildAlgorithmicOutline(skeletons, transcript.duration)

  const skeletonMap = new Map<number, SceneSkeleton>()
  for (const skel of skeletons) {
    skeletonMap.set(skel.sceneIndex, skel)
  }

  const chapters: ChapterPlan[] = outline.map((ch) => ({
    chapterIndex: ch.chapterIndex,
    title: ch.title,
    startTime: 0,
    endTime: 0,
    sequences: ch.sequences.map((seq) => {
      const scenes: ScenePlan[] = []
      for (let idx = seq.startSceneIndex; idx <= seq.endSceneIndex; idx++) {
        const skel = skeletonMap.get(idx)
        if (!skel) continue
        const queries = extractVisualQueries(skel.narrativeText)
        scenes.push({
          sceneIndex: skel.sceneIndex,
          mediaFile: '',
          mediaType: 'video',
          startTime: skel.startTime,
          endTime: skel.endTime,
          duration: skel.duration,
          narrativeText: skel.narrativeText,
          transcriptSegmentIds: [...skel.transcriptSegmentIds],
          transitionIn: 'cut',
          visualNote: `Visual shot: ${queries[0]}`,
          visualIntent: queries[0] ?? 'Documentary cinematic b-roll',
          searchQueries:
            queries.length >= 3
              ? queries
              : [...queries, 'documentary archive footage', 'historical b-roll cinematic'].slice(0, 3),
          energyLevel: inferEnergyLevelFromText(skel.narrativeText),
          shotType: inferShotTypeFromText(skel.narrativeText)
        })
      }
      const seqStart = scenes[0]?.startTime ?? 0
      const seqEnd = scenes[scenes.length - 1]?.endTime ?? 0
      return {
        sequenceIndex: seq.sequenceIndex,
        title: seq.title,
        startTime: seqStart,
        endTime: seqEnd,
        scenes
      }
    })
  }))

  // Set chapter start/end
  for (const ch of chapters) {
    const allSeqScenes = ch.sequences.flatMap((s) => s.scenes)
    ch.startTime = allSeqScenes[0]?.startTime ?? 0
    ch.endTime = allSeqScenes[allSeqScenes.length - 1]?.endTime ?? 0
  }

  // Global sceneIndex normalization
  let globalSceneIndex = 1
  for (const ch of chapters) {
    for (const seq of ch.sequences) {
      seq.scenes.sort((a, b) => a.startTime - b.startTime)
      for (const sc of seq.scenes) {
        sc.sceneIndex = globalSceneIndex++
      }
    }
  }

  const allScenes = chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))

  // Run Pacing Guard
  let pacingIssues: import('../../shared/types').PacingIssue[] = []
  try {
    const flatScenes = flattenPlanScenes({ chapters })
    pacingIssues = analyzePacing(flatScenes)
  } catch (err) {
    logger.warn(`[PLAN] Algorithmic plan pacing guard warning: ${err}`)
  }

  const initialFlags: import('../../shared/types').RetentionFlag[] = pacingIssues.map((issue) => ({
    sceneId: issue.sceneId,
    severity: issue.accumulatedMonotoneSeconds > 240 ? 'high' : issue.accumulatedMonotoneSeconds > 150 ? 'medium' : 'low',
    issue: `${issue.suggestion === 'vary_shot_type' ? 'Monotone shot type' : 'Monotone energy level'} for ${Math.round(issue.accumulatedMonotoneSeconds)}s (pacing-guard)`,
    suggestion:
      issue.suggestion === 'insert_broll'
        ? 'Insert a B-roll cutaway or add a stock clip with high motion/contrast'
        : issue.suggestion === 'insert_text_overlay'
          ? 'Add a text overlay (keyword callout) at this scene to break visual monotony'
          : `Change shot type for visual variety`
  }))

  return {
    projectName,
    totalDuration: transcript.duration,
    totalScenes: allScenes.length,
    language: transcript.language,
    chapters,
    generatedAt: new Date().toISOString(),
    modelUsed: 'rule-based-segmenter',
    openLoops: [],
    motifRegistry: [],
    retentionFlags: initialFlags,
    sourceHash
  }
}

// ─── Main planner function ────────────────────────────────────────────────────

export async function buildEditPlan(params: {
  projectDir: string
  apiKey: string
  model?: string
  scriptPath?: string | null
  signal?: AbortSignal
  onProgress?: (msg: string, pct: number) => void
}): Promise<MasterEditPlan> {
  const { projectDir, apiKey, onProgress, signal } = params
  if (signal?.aborted) {
    throw new PlanningCancelledError('buildEditPlan')
  }

  const modelId = params.model ?? 'gemini-3.8-flash'
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

  // 2. Load media index
  progress('Loading media library...', 0.07)
  const mediaIndexPath = join(projectDir, 'analysis', 'media-index.json')
  let mediaFiles: MediaClip[] = []

  if (fs.existsSync(mediaIndexPath)) {
    try {
      const rawItems = JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8')) as Array<{
        type: string
        path?: string
        filename: string
        durationSecs?: number
        fps?: number
        width?: number
        height?: number
      }>
      mediaFiles = rawItems.map((item) => ({
        filePath: item.path ?? '',
        filename: item.filename,
        type: (item.type === 'video' ? 'video' : 'image') as 'video' | 'image',
        durationSecs: item.durationSecs,
        fps: item.fps,
        width: item.width,
        height: item.height
      }))
    } catch { /* ignore */ }
  }

  // 3. Load script text and project state
  let scriptText: string | null = null
  let projectName = 'Unnamed'
  let projectPacing: Pacing = 'balanced'

  try {
    const stateFile = fs.existsSync(join(projectDir, 'project-state.json'))
      ? join(projectDir, 'project-state.json')
      : join(projectDir, 'project.json')

    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      projectName = st?.name ?? 'Unnamed'
      if (st?.settings?.pacing && ['slow', 'balanced', 'fast', 'cinematic'].includes(st.settings.pacing)) {
        projectPacing = st.settings.pacing as Pacing
      }
      const scriptPathFromState = st?.inputs?.scriptPath as string | undefined
      const resolvedScriptPath = params.scriptPath ?? scriptPathFromState
      if (resolvedScriptPath && fs.existsSync(resolvedScriptPath)) {
        scriptText = fs.readFileSync(resolvedScriptPath, 'utf-8')
      }
    }
  } catch (err) {
    logger.warn(`Could not load script text or project settings: ${err}`)
  }

  const sourceHash = scriptText ? computeSourceFingerprint(scriptText) : undefined

  // 4. Deterministic Scene Segmentation (Sections 4, 5, 6, 7, 8)
  progress(`Segmenting ${transcript.segments.length} transcript segments into scenes (${projectPacing} pacing)...`, 0.10)
  const skeletons = buildSceneSkeleton(transcript, projectPacing)
  progress(
    `Created ${skeletons.length} scene skeletons (avg ${(transcript.duration / skeletons.length).toFixed(1)}s/scene)...`,
    0.14
  )

  const cleanApiKey = normalizeApiKey(apiKey)
  if (!cleanApiKey) {
    logger.warn('[PLAN] No API key provided, creating algorithmic edit plan')
    const fallbackPlan = buildAlgorithmicPlan(transcript, projectName, projectPacing, sourceHash)
    const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
    fs.writeFileSync(planPath, JSON.stringify(fallbackPlan, null, 2), 'utf-8')
    progress(`Done — algorithmic plan created (${fallbackPlan.totalScenes} scenes)`, 1.0)
    return fallbackPlan
  }

  // 5. Global Script Context (Section 12) - Scope Fix (Part J)
  let ctx: GlobalScriptContext | null = null
  let globalContextSummary = ''
  try {
    progress('Preparing global documentary context...', 0.16)
    ctx = await analyzeGlobalContext({
      projectDir,
      apiKey: cleanApiKey,
      model: modelId,
      scriptText,
      transcript,
      signal,
      onProgress: (m, p) => progress(m, 0.16 + p * 0.04)
    })
    globalContextSummary = [
      `Primary Subject: ${ctx.primarySubject}`,
      `Central Thesis: ${ctx.centralThesis}`,
      ctx.geography?.primaryCountry ? `Geography: ${ctx.geography.primaryCountry} (${ctx.geography.primaryRegion ?? ''})` : '',
      ctx.timeContext?.primaryPeriod ? `Period: ${ctx.timeContext.primaryPeriod}` : '',
      ctx.exactTopicAnchors?.length ? `Topic Anchors: ${ctx.exactTopicAnchors.join(', ')}` : '',
      ctx.negativeKeywords?.length ? `Negative Keywords (avoid): ${ctx.negativeKeywords.join(', ')}` : '',
      ctx.visualWorld?.documentaryStyle ? `Visual Style: ${ctx.visualWorld.documentaryStyle}` : ''
    ].filter(Boolean).join('\n')
  } catch (err: unknown) {
    if (signal?.aborted || err instanceof PlanningCancelledError) {
      throw err
    }
    logger.warn(`[PLAN] Global context extraction failed: ${err}`)
  }

  // 6. Chapter & Sequence Outline (Section 13)
  const ai = new GoogleGenAI({
    apiKey: cleanApiKey,
    httpOptions: { apiVersion: 'v1beta' }
  })

  if (modelId && DEPRECATED_TEXT_MODELS.has(modelId)) {
    logger.warn(`[GeminiModel] Saved model ${modelId} is unavailable for this account.`)
    logger.info(`[GeminiModel] Falling back to ${normalizePreferredTextModel(modelId)}.`)
  }

  const fallbackModelChain = getAvailableModelsForTask('planning', modelId)

  progress('Creating chapter and sequence outline...', 0.20)
  const outline = await generateChapterOutlineWithGemini(
    ai,
    fallbackModelChain,
    skeletons,
    globalContextSummary,
    transcript.duration,
    signal,
    (m, p) => progress(m, p)
  )

  // 7. Batch Enrichment via Gemini (Sections 10, 11, 16)
  const BATCH_SIZE = 20
  const totalBatches = Math.ceil(skeletons.length / BATCH_SIZE)
  const allEnrichedMap = new Map<number, Partial<ScenePlan>>()
  let hadAnyBatchFallback = false
  let primaryModelUsed = fallbackModelChain[0] ?? 'gemini-3.8-flash'

  // Safe interim checkpointing (Part K)
  const checkpointPath = join(projectDir, 'analysis', '.planning-checkpoint.json')
  if (sourceHash && fs.existsSync(checkpointPath)) {
    try {
      const ckpt = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'))
      if (ckpt && ckpt.sourceHash === sourceHash && ckpt.totalScenes === skeletons.length && ckpt.scenes) {
        for (const [idxStr, sc] of Object.entries(ckpt.scenes)) {
          allEnrichedMap.set(Number(idxStr), sc as Partial<ScenePlan>)
        }
        logger.info(`[PLAN] Reused ${allEnrichedMap.size}/${skeletons.length} enriched scenes from checkpoint`)
      }
    } catch {
      /* ignore invalid checkpoint */
    }
  }

  for (let b = 0; b < totalBatches; b++) {
    if (signal?.aborted) {
      throw new PlanningCancelledError('buildEditPlan')
    }

    const batchScenes = skeletons.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE)
    const isBatchAlreadyComplete = batchScenes.every((s) => allEnrichedMap.has(s.sceneIndex))

    if (isBatchAlreadyComplete) {
      logger.info(`[PLAN] Batch ${b + 1}/${totalBatches} fully present in checkpoint. Skipping Gemini request.`)
      continue
    }

    const { enrichedMap, modelUsed, usedFallback } = await enrichScenesBatchWithGemini(
      ai,
      fallbackModelChain,
      batchScenes,
      globalContextSummary,
      mediaFiles,
      b,
      totalBatches,
      signal,
      progress
    )

    for (const [idx, data] of enrichedMap.entries()) {
      allEnrichedMap.set(idx, data)
    }
    if (usedFallback) hadAnyBatchFallback = true
    if (b === 0) primaryModelUsed = modelUsed

    // Persist checkpoint after each batch
    if (sourceHash) {
      try {
        const scenesObj: Record<number, Partial<ScenePlan>> = {}
        for (const [idx, sc] of allEnrichedMap.entries()) {
          scenesObj[idx] = sc
        }
        fs.writeFileSync(
          checkpointPath,
          JSON.stringify({ sourceHash, totalScenes: skeletons.length, scenes: scenesObj }),
          'utf-8'
        )
      } catch {
        /* non-fatal */
      }
    }
  }

  // 8. Assemble Full Plan Structure (Chapters -> Sequences -> Scenes)
  progress('Assembling master edit plan...', 0.85)
  
  const ci = sourceHash ? loadContentIntelligence(projectDir, sourceHash) : null

  let identityBible: any = null
  if (ci && ctx && scriptText && sourceHash) {
    try {
      identityBible = generateVisualIdentityBible({
        projectDir,
        scriptText,
        globalContext: ctx,
        contentIntelligence: ci
      })
      logger.info(`[PLAN] Visual Identity Bible generated. Mode: ${identityBible.identityMode}`)
    } catch (err) {
      logger.warn(`[PLAN] Failed to generate visual identity bible: ${err}`)
    }
  }
  const skeletonMap = new Map<number, SceneSkeleton>()
  for (const skel of skeletons) {
    skeletonMap.set(skel.sceneIndex, skel)
  }

  const chapters: ChapterPlan[] = outline.map((ch) => ({
    chapterIndex: ch.chapterIndex,
    title: ch.title,
    startTime: 0,
    endTime: 0,
    sequences: ch.sequences.map((seq) => {
      const scenes: ScenePlan[] = []
      for (let idx = seq.startSceneIndex; idx <= seq.endSceneIndex; idx++) {
        const skel = skeletonMap.get(idx)
        if (!skel) continue

        const aiData = allEnrichedMap.get(skel.sceneIndex)
        const rawQueries = aiData?.searchQueries && aiData.searchQueries.length >= 3
          ? aiData.searchQueries
          : extractVisualQueries(skel.narrativeText)
        const queries = dedupeStockQueries(rawQueries.map((q) => sanitizeStockQuery(q, skel.narrativeText)))

        let finalIntent = aiData?.visualIntent ?? queries[0] ?? 'Documentary cinematic b-roll'
        let finalQueries = queries

        if (ci) {
          const intentFid = validateSemanticFidelity(finalIntent, ci, skel.narrativeText)
          if (!intentFid.valid) {
            logger.warn(`[SemanticGate] Rejected visualIntent "${finalIntent}" in Scene ${skel.sceneIndex}: ${intentFid.reason}`)
            finalIntent = 'Documentary cinematic b-roll'
          }

          finalQueries = queries.filter(q => {
            const fid = validateSemanticFidelity(q, ci, skel.narrativeText)
            if (!fid.valid) {
              logger.warn(`[SemanticGate] Rejected query "${q}" in Scene ${skel.sceneIndex}: ${fid.reason}`)
            }
            return fid.valid
          })

          if (finalQueries.length === 0) {
            finalQueries.push('documentary cinematic b-roll')
          }
        }

        const sc: ScenePlan = {
          sceneIndex: skel.sceneIndex, // will be globally normalized below
          mediaFile: '',
          mediaType: aiData?.mediaType === 'image' ? 'image' : 'video',
          startTime: skel.startTime,
          endTime: skel.endTime,
          duration: skel.duration,
          narrativeText: skel.narrativeText,
          transcriptSegmentIds: [...skel.transcriptSegmentIds],
          transitionIn: (aiData?.transitionIn as 'cut' | 'fade' | 'dissolve') ?? 'cut',
          visualNote: aiData?.visualNote ?? `Visual shot: ${finalQueries[0]}`,
          visualIntent: finalIntent,
          searchQueries: finalQueries,
          energyLevel: (aiData?.energyLevel as 'low' | 'medium' | 'high') ?? inferEnergyLevelFromText(skel.narrativeText),
          shotType: (aiData?.shotType as 'wide' | 'medium' | 'close-up' | 'abstract') ?? inferShotTypeFromText(skel.narrativeText)
        }

        applyLocalMediaMatching(sc, aiData?.localAsset, mediaFiles)
        scenes.push(sc)
      }

      const seqStart = scenes[0]?.startTime ?? 0
      const seqEnd = scenes[scenes.length - 1]?.endTime ?? 0
      return {
        sequenceIndex: seq.sequenceIndex,
        title: seq.title,
        startTime: seqStart,
        endTime: seqEnd,
        scenes
      }
    })
  }))

  // Ensure chapter start and end times reflect their sequences
  for (const ch of chapters) {
    const chScenes = ch.sequences.flatMap((s) => s.scenes)
    ch.startTime = chScenes[0]?.startTime ?? 0
    ch.endTime = chScenes[chScenes.length - 1]?.endTime ?? 0
  }

  // 9. Re-index sceneIndex globally (Section 14)
  let globalSceneIndex = 1
  for (const ch of chapters) {
    for (const seq of ch.sequences) {
      seq.scenes.sort((a, b) => a.startTime - b.startTime)
      for (const sc of seq.scenes) {
        sc.sceneIndex = globalSceneIndex++
      }
    }
  }

  const allFinalScenes = chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))

  // Validate global uniqueness of sceneIndex
  const sceneIds = allFinalScenes.map((s) => s.sceneIndex)
  if (new Set(sceneIds).size !== sceneIds.length) {
    throw new Error('Duplicate global sceneIndex detected after assembly')
  }

  // 10. Validate Transcript Coverage (Section 15)
  progress('Validating transcript coverage...', 0.88)
  const coverageResult = validateScenePlanCoverage(transcript, allFinalScenes)
  if (!coverageResult.valid) {
    logger.error('[PLAN] Transcript coverage validation encountered issues:', { errors: coverageResult.errors })
    // If fatal validation errors exist, log and throw
    if (coverageResult.missingSegmentIds.length > 0) {
      throw new Error(`Transcript coverage validation failed: missing segments [${coverageResult.missingSegmentIds.join(', ')}]`)
    }
  }

  // 11. Run Pacing Guard (Section 18)
  progress('Running Pacing Guard analysis...', 0.90)
  let pacingIssues: import('../../shared/types').PacingIssue[] = []
  try {
    const flatScenes = flattenPlanScenes({ chapters })
    pacingIssues = analyzePacing(flatScenes)
    logger.info(`[PLAN] Pacing Guard: ${pacingIssues.length} issues found, scenes annotated in-place`)
  } catch (pgErr: unknown) {
    logger.warn(`[PLAN] Pacing Guard error (non-fatal): ${pgErr instanceof Error ? pgErr.message : String(pgErr)}`)
  }

  const initialFlags: import('../../shared/types').RetentionFlag[] = pacingIssues.map((issue) => ({
    sceneId: issue.sceneId,
    severity: issue.accumulatedMonotoneSeconds > 240 ? 'high' : issue.accumulatedMonotoneSeconds > 150 ? 'medium' : 'low',
    issue: `${issue.suggestion === 'vary_shot_type' ? 'Monotone shot type' : 'Monotone energy level'} for ${Math.round(issue.accumulatedMonotoneSeconds)}s (pacing-guard)`,
    suggestion:
      issue.suggestion === 'insert_broll'
        ? 'Insert a B-roll cutaway or add a stock clip with high motion/contrast'
        : issue.suggestion === 'insert_text_overlay'
          ? 'Add a text overlay (keyword callout) at this scene to break visual monotony'
          : `Change shot type to "${(allFinalScenes[Number(issue.sceneId) - 1] as ScenePlan | undefined)?.shotType ?? 'wide'}" for visual variety`
  }))

  const finalModelUsed = hadAnyBatchFallback
    ? `${primaryModelUsed} + partial-fallback`
    : primaryModelUsed

  const plan: MasterEditPlan = {
    projectName,
    totalDuration: transcript.duration,
    totalScenes: allFinalScenes.length,
    language: transcript.language,
    chapters,
    generatedAt: new Date().toISOString(),
    modelUsed: finalModelUsed,
    openLoops: [],
    motifRegistry: [],
    retentionFlags: initialFlags,
    sourceHash
  }

  // 12. Save Master Edit Plan (Section 19)
  if (signal?.aborted) {
    throw new PlanningCancelledError('buildEditPlan')
  }

  progress('Saving master edit plan...', 0.95)
  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')

  // Clean up interim checkpoint if present
  try {
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath)
    }
  } catch {
    /* ignore */
  }

  logger.info('Edit plan saved', {
    chapters: plan.chapters.length,
    scenes: plan.totalScenes,
    pacingIssues: pacingIssues.length,
    model: finalModelUsed
  })

  progress(
    `Done — ${plan.chapters.length} chapters, ${plan.totalScenes} scenes (${(plan.totalDuration / plan.totalScenes).toFixed(1)}s/scene), ${initialFlags.length} pacing flags`,
    1.0
  )

  return plan
}
