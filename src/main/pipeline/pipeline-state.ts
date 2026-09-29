import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_EXECUTION_STAGES
} from './pipeline-types'
import type {
  AutoPipelineState,
  AutoPipelineOptions,
  InputFingerprint,
  PipelineStage,
  PipelineStageState
} from './pipeline-types'

export function getPipelineStatePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'auto-pipeline-state.json')
}

/**
 * Tính toán fingerprint cho cặp file Script và Voiceover.
 */
export function computeInputFingerprint(
  _projectDir: string,
  scriptPath: string,
  voiceoverPath: string
): InputFingerprint {
  let scriptHash: string | undefined
  if (scriptPath && fs.existsSync(scriptPath)) {
    try {
      const content = fs.readFileSync(scriptPath)
      scriptHash = crypto.createHash('md5').update(content).digest('hex')
    } catch {
      /* ignore */
    }
  }

  let voiceoverSize: number | undefined
  let voiceoverMtimeMs: number | undefined
  if (voiceoverPath && fs.existsSync(voiceoverPath)) {
    try {
      const stat = fs.statSync(voiceoverPath)
      voiceoverSize = stat.size
      voiceoverMtimeMs = stat.mtimeMs
    } catch {
      /* ignore */
    }
  }

  return {
    scriptPath,
    scriptHash,
    voiceoverPath,
    voiceoverSize,
    voiceoverMtimeMs
  }
}

export function isFingerprintEqual(
  a?: InputFingerprint | null,
  b?: InputFingerprint | null
): boolean {
  if (!a || !b) return false
  return (
    a.scriptPath === b.scriptPath &&
    a.scriptHash === b.scriptHash &&
    a.voiceoverPath === b.voiceoverPath &&
    a.voiceoverSize === b.voiceoverSize &&
    a.voiceoverMtimeMs === b.voiceoverMtimeMs
  )
}

/**
 * Khởi tạo Pipeline Stage States mặc định cho tất cả các stage.
 */
export function createDefaultStageStates(): Record<string, PipelineStageState> {
  const stages: Record<string, PipelineStageState> = {}
  for (const stage of PIPELINE_EXECUTION_STAGES) {
    stages[stage] = {
      status: 'pending',
      progress: 0
    }
  }
  return stages
}

/**
 * Tạo một AutoPipelineState mới.
 */
export function createInitialPipelineState(
  options: AutoPipelineOptions,
  fingerprint: InputFingerprint,
  runId?: string
): AutoPipelineState {
  const now = new Date().toISOString()
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    runId: runId ?? uuidv4(),
    projectDir: options.projectDir,
    currentStage: 'idle',
    overallStatus: 'idle',
    startedAt: now,
    updatedAt: now,
    inputFingerprint: fingerprint,
    options,
    stages: createDefaultStageStates(),
    warnings: [],
    fatalErrors: []
  }
}

/**
 * Đọc trạng thái pipeline từ file JSON an toàn.
 */
export function loadPipelineState(projectDir: string): AutoPipelineState | null {
  const statePath = getPipelineStatePath(projectDir)
  if (!fs.existsSync(statePath)) return null
  try {
    const raw = fs.readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as AutoPipelineState
    if (!parsed || typeof parsed !== 'object' || !parsed.stages) return null
    return parsed
  } catch (err) {
    logger.warn(`[PipelineState] Failed to parse ${statePath}: ${String(err)}`)
    return null
  }
}

/**
 * Ghi state atomically: ghi vào file .tmp trước rồi rename để tránh corrupt khi crash/kill.
 */
export function savePipelineStateAtomic(
  projectDir: string,
  state: AutoPipelineState
): void {
  const finalPath = getPipelineStatePath(projectDir)
  const dir = path.dirname(finalPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpPath = path.join(
    dir,
    `auto-pipeline-state.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  )

  const content = JSON.stringify(state, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf-8')
  fs.renameSync(tmpPath, finalPath)
}

/**
 * Xác định các stage bị invalidate khi fingerprint hoặc options thay đổi.
 */
export function determineInvalidatedStages(
  oldState: AutoPipelineState,
  newOptions: AutoPipelineOptions,
  newFingerprint: InputFingerprint
): PipelineStage[] {
  const invalidated = new Set<PipelineStage>()

  const voiceoverChanged =
    oldState.inputFingerprint.voiceoverPath !== newFingerprint.voiceoverPath ||
    oldState.inputFingerprint.voiceoverSize !== newFingerprint.voiceoverSize ||
    oldState.inputFingerprint.voiceoverMtimeMs !== newFingerprint.voiceoverMtimeMs

  const scriptChanged =
    oldState.inputFingerprint.scriptPath !== newFingerprint.scriptPath ||
    oldState.inputFingerprint.scriptHash !== newFingerprint.scriptHash

  if (voiceoverChanged) {
    // Voiceover đổi → invalidate transcription và toàn bộ downstream
    return [
      'transcribing',
      'planning',
      'captions',
      'global-context',
      'stock-search',
      'audio-search',
      'preflight',
      'rendering',
      'postflight'
    ]
  }

  if (scriptChanged) {
    // Script đổi → invalidate planning và toàn bộ downstream
    return [
      'planning',
      'captions',
      'global-context',
      'stock-search',
      'audio-search',
      'preflight',
      'rendering',
      'postflight'
    ]
  }

  // Whisper model option thay đổi
  if (oldState.options.whisperModel !== newOptions.whisperModel && newOptions.whisperModel) {
    return [
      'transcribing',
      'planning',
      'captions',
      'global-context',
      'stock-search',
      'audio-search',
      'preflight',
      'rendering',
      'postflight'
    ]
  }

  // Caption settings thay đổi
  if (
    oldState.options.forceRegenerateCaptions !== newOptions.forceRegenerateCaptions &&
    newOptions.forceRegenerateCaptions
  ) {
    invalidated.add('captions')
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  // Stock provider / settings thay đổi
  if (oldState.options.preferredStockProvider !== newOptions.preferredStockProvider) {
    invalidated.add('stock-search')
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  // Audio settings thay đổi
  if (oldState.options.requireBackgroundMusic !== newOptions.requireBackgroundMusic) {
    invalidated.add('audio-search')
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  // Render settings thay đổi
  if (
    oldState.options.fps !== newOptions.fps ||
    oldState.options.resolution?.width !== newOptions.resolution?.width ||
    oldState.options.resolution?.height !== newOptions.resolution?.height ||
    oldState.options.outputName !== newOptions.outputName
  ) {
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  return Array.from(invalidated)
}

/**
 * Đặt lại trạng thái của các stage bị invalidate về 'pending'.
 */
export function applyInvalidation(
  state: AutoPipelineState,
  invalidatedStages: PipelineStage[]
): void {
  for (const stage of invalidatedStages) {
    if (state.stages[stage]) {
      state.stages[stage] = {
        status: 'pending',
        progress: 0,
        message: 'Invalidated due to input/setting change'
      }
    }
  }
}
