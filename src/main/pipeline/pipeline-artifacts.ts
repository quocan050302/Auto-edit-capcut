import * as fs from 'fs'
import * as path from 'path'
import { readJsonSafe } from '../production-intelligence/json-store'
import type {
  TranscriptResult,
  CaptionPlan,
  AudioPlan,
  RenderQaReport,
  StockSceneAssignment,
  AutoPipelineOptions,
  ContentType
} from '../../../shared/types'
import { computeHealthMotionHash } from '../health/health-visual-cache'

export interface StockCompletionResult {
  totalScenes: number
  assignedScenes: number
  downloadedScenes: number
  missingScenes: number
  lowConfidenceScenes: number
  missingSceneIndices: number[]
}

export function isTranscriptionValid(
  projectDir: string,
  voiceoverPath: string
): boolean {
  const transcriptPath = path.join(projectDir, 'analysis', 'transcript.json')
  const cacheMetaPath = path.join(projectDir, 'analysis', 'transcript-meta.json')

  if (!fs.existsSync(transcriptPath)) {
    return false
  }

  try {
    if (voiceoverPath && fs.existsSync(voiceoverPath) && fs.existsSync(cacheMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf-8'))
      const stat = fs.statSync(voiceoverPath)
      const expectedHash = `${voiceoverPath}:${stat.size}:${stat.mtimeMs}`
      if (meta.hash && meta.hash !== expectedHash) return false
    }

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as TranscriptResult
    return !!(transcript && transcript.segments && transcript.segments.length > 0)
  } catch {
    return false
  }
}

export function isPlanningValid(projectDir: string): boolean {
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) return false

  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    if (!plan || !Array.isArray(plan.chapters) || plan.chapters.length === 0) {
      return false
    }
    const sceneCount = (plan.chapters as Array<{ sequences?: Array<{ scenes?: unknown[] }>; chapters_seq?: Array<{ scenes?: unknown[] }> }>).reduce(
      (acc, ch) => {
        const seqs = ch.chapters_seq ?? ch.sequences ?? []
        return acc + seqs.reduce((sAcc, seq) => sAcc + (seq.scenes?.length ?? 0), 0)
      },
      0
    )
    return sceneCount > 0
  } catch {
    return false
  }
}

export function isCaptionsValid(projectDir: string): boolean {
  const captionPlanPath = path.join(projectDir, 'analysis', 'caption-plan.json')
  if (!fs.existsSync(captionPlanPath)) return false

  try {
    const plan = JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8')) as CaptionPlan
    return !!(plan && typeof plan.enabled === 'boolean')
  } catch {
    return false
  }
}

export function isGlobalContextValid(
  projectDir: string,
  scriptHash?: string
): boolean {
  const contextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
  if (!fs.existsSync(contextPath)) return false

  try {
    const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as {
      primarySubject?: string
      _scriptHash?: string
    }
    if (!ctx || !ctx.primarySubject) return false
    if (scriptHash && ctx._scriptHash && ctx._scriptHash !== scriptHash) {
      return false
    }
    return true
  } catch {
    return false
  }
}

export function checkStockCompletion(projectDir: string): StockCompletionResult {
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) {
    return {
      totalScenes: 0,
      assignedScenes: 0,
      downloadedScenes: 0,
      missingScenes: 0,
      lowConfidenceScenes: 0,
      missingSceneIndices: []
    }
  }

  let totalScenes = 0
  const sceneIndices: number[] = []
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    const chapters = plan.chapters ?? []
    for (const ch of chapters) {
      const seqs = ch.chapters_seq ?? ch.sequences ?? []
      for (const seq of seqs) {
        for (const sc of seq.scenes ?? []) {
          totalScenes++
          sceneIndices.push(sc.sceneIndex)
        }
      }
    }
  } catch {
    /* ignore */
  }

  const assignmentsPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
  let assignmentList: StockSceneAssignment[] = []
  if (fs.existsSync(assignmentsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8'))
      if (Array.isArray(parsed)) {
        assignmentList = parsed
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.assignments)) {
          assignmentList = parsed.assignments
        } else if (parsed.assignments && typeof parsed.assignments === 'object') {
          assignmentList = Object.values(parsed.assignments)
        }
      }
    } catch {
      /* ignore */
    }
  }

  const assignmentMap = new Map<number, StockSceneAssignment>()
  for (const a of assignmentList) {
    if (a && typeof a.sceneIndex === 'number') {
      assignmentMap.set(a.sceneIndex, a)
    }
  }

  let assignedScenes = 0
  let downloadedScenes = 0
  let lowConfidenceScenes = 0
  const missingSceneIndices: number[] = []

  for (const idx of sceneIndices) {
    const assign = assignmentMap.get(idx)
    if (!assign || assign.status !== 'assigned') {
      missingSceneIndices.push(idx)
      continue
    }

    assignedScenes++

    // Kiểm tra media file có tồn tại trên disk không với các đường dẫn dự phòng
    let mediaExists = false
    const candidates: string[] = []

    if (assign.asset?.localPath) {
      candidates.push(assign.asset.localPath)
      if (!path.isAbsolute(assign.asset.localPath)) {
        candidates.push(path.join(projectDir, assign.asset.localPath))
      }
    }
    if (assign.asset?.filename) {
      candidates.push(path.join(projectDir, 'assets', 'stock', assign.asset.filename))
    }
    const anyAsset = assign.asset as { mediaFile?: string; localAsset?: string } | null
    if (anyAsset?.mediaFile) {
      candidates.push(path.join(projectDir, 'assets', 'stock', anyAsset.mediaFile))
    }
    if (anyAsset?.localAsset) {
      candidates.push(path.join(projectDir, 'assets', 'stock', anyAsset.localAsset))
    }

    for (const candidatePath of candidates) {
      try {
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) {
          mediaExists = true
          break
        }
      } catch {
        /* ignore */
      }
    }

    if (mediaExists) {
      downloadedScenes++
    } else {
      missingSceneIndices.push(idx)
    }

    // Check low confidence (score < 50)
    if (assign.score !== undefined && assign.score < 50) {
      lowConfidenceScenes++
    }
  }

  return {
    totalScenes,
    assignedScenes,
    downloadedScenes,
    missingScenes: missingSceneIndices.length,
    lowConfidenceScenes,
    missingSceneIndices
  }
}

/**
 * Provider-agnostic completion check for Custom Mix (Google Flow AI, Pexels, Pixabay, local).
 * A scene is complete when it has one assigned, existing media file - regardless of provider.
 * It never implies that missing scenes should be repaired with Stock.
 * Legacy flow keeps using checkStockCompletion().
 */
export function checkVisualCompletion(projectDir: string): StockCompletionResult {
  return checkStockCompletion(projectDir)
}

export function isAudioValid(projectDir: string, requireMusic?: boolean, contentType?: ContentType): boolean {
  const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
  if (!fs.existsSync(audioPlanPath)) return false

  try {
    const plan = JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8')) as AudioPlan
    if (!plan || !Array.isArray(plan.sections)) return false
    if (requireMusic) {
      const hasDownloadedMusic = plan.sections.some(
        (s) => s.approved && s.approvedLocalPath && fs.existsSync(s.approvedLocalPath)
      )
      if (!hasDownloadedMusic) return false
    }

    if (contentType === 'health') {
      const healthPlanPath = path.join(projectDir, 'analysis', 'health-visual-plan.json')
      if (fs.existsSync(healthPlanPath)) {
        try {
          const healthPlan = JSON.parse(fs.readFileSync(healthPlanPath, 'utf-8'))
          const hasSfxCues = (healthPlan.scenes || []).some((s: any) => s.sfxCue)
          if (hasSfxCues) {
            if (!plan.healthSfx?.enabled) return false
            const expectedHash = computeHealthMotionHash(healthPlan)
            if (plan.healthSfx.planHash !== expectedHash) return false
          }
        } catch {
          // ignore
        }
      }
    }

    return true
  } catch {
    return false
  }
}

export function isPreflightValid(projectDir: string): boolean {
  const preflightPath = path.join(projectDir, 'analysis', 'render-preflight.json')
  if (!fs.existsSync(preflightPath)) return false

  try {
    const report = JSON.parse(fs.readFileSync(preflightPath, 'utf-8')) as RenderQaReport
    return report && report.status !== 'failed'
  } catch {
    return false
  }
}

export interface ArtifactReconciliationSummary {
  transcribingValid: boolean
  planningValid: boolean
  captionsValid: boolean
  globalContextValid: boolean
  stockCompletion: StockCompletionResult
  audioValid: boolean
  preflightValid: boolean
  renderValid: boolean
  postflightValid: boolean
}

/**
 * Reconcile toàn bộ artifact thực tế của project qua từng stage.
 */
export function reconcileProjectArtifacts(
  projectDir: string,
  options?: AutoPipelineOptions
): ArtifactReconciliationSummary {
  const voPath = options?.voiceoverPath || ''
  const transcribingValid = voPath ? isTranscriptionValid(projectDir, voPath) : fs.existsSync(path.join(projectDir, 'analysis', 'transcript.json'))
  const planningValid = isPlanningValid(projectDir)
  const captionsValid = isCaptionsValid(projectDir)
  const globalContextValid = isGlobalContextValid(projectDir)
  const stockCompletion = checkStockCompletion(projectDir)
  const audioValid = isAudioValid(projectDir, options?.requireBackgroundMusic)
  const preflightValid = isPreflightValid(projectDir)

  // Render valid: kiểm tra output mp4 hoàn chỉnh (không phải .partial.mp4)
  const outputDir = path.join(projectDir, 'output')
  let renderValid = false
  if (fs.existsSync(outputDir)) {
    try {
      const files = fs.readdirSync(outputDir).filter(
        (f) => f.endsWith('.mp4') && !f.startsWith('_') && !f.includes('.partial') && !f.includes('.working')
      )
      if (files.length > 0) {
        const stat = fs.statSync(path.join(outputDir, files[0]))
        if (stat.size > 1024) renderValid = true
      }
    } catch {
      /* ignore */
    }
  }

  const qaPath = path.join(projectDir, 'analysis', 'render-qa.json')
  const postflightValid = renderValid && fs.existsSync(qaPath)

  return {
    transcribingValid,
    planningValid,
    captionsValid,
    globalContextValid,
    stockCompletion,
    audioValid,
    preflightValid,
    renderValid,
    postflightValid
  }
}
