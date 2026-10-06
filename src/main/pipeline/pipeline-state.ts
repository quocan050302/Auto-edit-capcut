import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_EXECUTION_STAGES
} from './pipeline-types'
import { resolveVisualMixConfig, resolveContentProfileMode } from '../../../shared/types'
import type {
  AutoPipelineState,
  AutoPipelineOptions,
  InputFingerprint,
  PipelineStage,
  PipelineStageState,
  PipelineLease,
  PipelineSnapshot
} from './pipeline-types'

/** ID duy nhất của instance ứng dụng hiện tại (thay đổi mỗi khi app khởi động lại) */
export const APP_INSTANCE_ID = uuidv4()

/** Chuẩn hóa đường dẫn thư mục dự án */
export function normalizeProjectDir(projectDir: string): string {
  if (!projectDir) return ''
  const resolved = path.resolve(projectDir)
  return path.normalize(resolved)
}

export function getPipelineStatePath(projectDir: string): string {
  return path.join(normalizeProjectDir(projectDir), 'analysis', 'auto-pipeline-state.json')
}

export function getPipelineStateBackupPath(projectDir: string): string {
  return path.join(normalizeProjectDir(projectDir), 'analysis', 'auto-pipeline-state.backup.json')
}

/**
 * Kiểm tra xem một process ID có còn đang chạy hay không.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    return process.kill(pid, 0)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    return code === 'EPERM'
  }
}

/**
 * Tạo lease mới để đảm bảo tính độc quyền của tiến trình chạy pipeline.
 */
export function createLease(runId: string, currentStage: PipelineStage): PipelineLease {
  const now = new Date().toISOString()
  return {
    runId,
    appInstanceId: APP_INSTANCE_ID,
    pid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
    currentStage
  }
}

/**
 * Cập nhật heartbeat của lease.
 */
export function updateHeartbeat(state: AutoPipelineState): void {
  const now = new Date().toISOString()
  if (state.lease) {
    state.lease.heartbeatAt = now
    state.lease.currentStage = state.currentStage
  } else {
    state.lease = createLease(state.runId, state.currentStage)
  }
  state.updatedAt = now
}

/**
 * Giải phóng lease khi pipeline kết thúc hoặc bị hủy.
 */
export function releaseLease(state: AutoPipelineState): void {
  delete state.lease
  state.updatedAt = new Date().toISOString()
}

/**
 * Xác định xem lease có bị stale (tiến trình sở hữu đã chết hoặc timeout heartbeat) hay không.
 */
export function isLeaseStale(
  lease?: PipelineLease | null,
  heartbeatTimeoutMs = 15000
): boolean {
  if (!lease) return false

  // Nếu thuộc về instance khác
  if (lease.appInstanceId !== APP_INSTANCE_ID) {
    // 1. Kiểm tra xem process PID cũ còn sống không
    if (!isProcessAlive(lease.pid)) {
      return true
    }
    // 2. Kiểm tra heartbeat timeout
    const lastHeartbeat = new Date(lease.heartbeatAt).getTime()
    if (isNaN(lastHeartbeat) || Date.now() - lastHeartbeat > heartbeatTimeoutMs) {
      return true
    }
    // 3. Instance khác đã chạy từ trước nhưng app hiện tại khởi động lại
    return true
  }

  // Nếu cùng instance nhưng heartbeat đã quá lâu không cập nhật
  const lastHeartbeat = new Date(lease.heartbeatAt).getTime()
  if (!isNaN(lastHeartbeat) && Date.now() - lastHeartbeat > heartbeatTimeoutMs) {
    return true
  }

  return false
}

/**
 * Chuyển đổi AutoPipelineState thành PipelineSnapshot có version đơn điệu.
 */
export function toSnapshot(state: AutoPipelineState): PipelineSnapshot {
  return {
    version: state.version,
    runId: state.runId,
    projectDir: state.projectDir,
    currentStage: state.currentStage,
    overallStatus: state.overallStatus,
    stages: state.stages,
    updatedAt: state.updatedAt,
    lease: state.lease,
    warnings: state.warnings,
    fatalErrors: state.fatalErrors,
    renderOutputPath: state.renderOutputPath,
    preflightReportPath: state.preflightReportPath,
    postflightReportPath: state.postflightReportPath
  }
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
 * Tạo một AutoPipelineState mới với version khởi đầu = 1.
 */
export function createInitialPipelineState(
  options: AutoPipelineOptions,
  fingerprint: InputFingerprint,
  runId?: string
): AutoPipelineState {
  const now = new Date().toISOString()
  const rId = runId ?? uuidv4()
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    version: 1,
    runId: rId,
    projectDir: normalizeProjectDir(options.projectDir),
    currentStage: 'idle',
    overallStatus: 'idle',
    startedAt: now,
    updatedAt: now,
    inputFingerprint: fingerprint,
    options: {
      ...options,
      projectDir: normalizeProjectDir(options.projectDir)
    },
    stages: createDefaultStageStates(),
    warnings: [],
    fatalErrors: []
  }
}

/**
 * Đọc trạng thái pipeline từ file JSON an toàn, fallback sang backup nếu file chính lỗi.
 */
export function loadPipelineState(projectDir: string): AutoPipelineState | null {
  const statePath = getPipelineStatePath(projectDir)
  const backupPath = getPipelineStateBackupPath(projectDir)

  // 1. Thử đọc file chính
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf-8')
      const parsed = JSON.parse(raw) as AutoPipelineState
      if (parsed && typeof parsed === 'object' && parsed.stages) {
        if (!parsed.version) parsed.version = 1
        return parsed
      }
    } catch (err) {
      logger.warn(`[PipelineState] Primary state corrupt, trying backup: ${String(err)}`)
    }
  }

  // 2. Thử đọc file backup
  if (fs.existsSync(backupPath)) {
    try {
      const rawBackup = fs.readFileSync(backupPath, 'utf-8')
      const parsedBackup = JSON.parse(rawBackup) as AutoPipelineState
      if (parsedBackup && typeof parsedBackup === 'object' && parsedBackup.stages) {
        logger.info(`[PipelineState] Successfully recovered pipeline state from backup`)
        if (!parsedBackup.version) parsedBackup.version = 1
        return parsedBackup
      }
    } catch {
      /* ignore */
    }
  }

  return null
}

/**
 * Queue đồng bộ hóa các thao tác ghi state để tránh xung đột ghi đồng thời.
 */
class StateWriteQueue {
  private queue = Promise.resolve()

  public enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const res = await fn()
          resolve(res)
        } catch (err) {
          reject(err)
        }
      })
    })
  }
}

const writeQueue = new StateWriteQueue()

/**
 * Ghi state atomically:
 * 1. Tăng version đơn điệu
 * 2. Lưu bản sao lưu backup hợp lệ
 * 3. Ghi vào file .tmp
 * 4. Rename sang file chính
 */
export function savePipelineStateAtomic(
  projectDir: string,
  state: AutoPipelineState
): void {
  const normDir = normalizeProjectDir(projectDir)
  state.projectDir = normDir
  state.version = (state.version || 0) + 1
  state.updatedAt = new Date().toISOString()

  const finalPath = getPipelineStatePath(normDir)
  const backupPath = getPipelineStateBackupPath(normDir)
  const dir = path.dirname(finalPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Nếu file chính hiện tại hợp lệ, tạo backup
  if (fs.existsSync(finalPath)) {
    try {
      fs.copyFileSync(finalPath, backupPath)
    } catch {
      /* ignore backup copy error */
    }
  }

  const tmpPath = path.join(
    dir,
    `auto-pipeline-state.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  )

  const content = JSON.stringify(state, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf-8')
  fs.renameSync(tmpPath, finalPath)

  try {
    fs.copyFileSync(finalPath, backupPath)
  } catch {
    /* ignore backup copy error */
  }
}

/**
 * Async version của savePipelineStateAtomic sử dụng writeQueue serialize.
 */
export async function savePipelineStateQueued(
  projectDir: string,
  state: AutoPipelineState
): Promise<void> {
  return writeQueue.enqueue(() => savePipelineStateAtomic(projectDir, state))
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

  // Content profile mode hoặc legacy contentType thay đổi
  const oldProfileMode = resolveContentProfileMode(oldState.options)
  const newProfileMode = resolveContentProfileMode(newOptions)
  const oldContentType = oldState.options.contentType ?? 'default'
  const newContentType = newOptions.contentType ?? 'default'

  if (oldProfileMode !== newProfileMode || oldContentType !== newContentType) {
    invalidated.add('stock-search')
    if (
      oldProfileMode === 'health' ||
      newProfileMode === 'health' ||
      oldContentType === 'health' ||
      newContentType === 'health'
    ) {
      invalidated.add('audio-search')
    }
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  // Visual source mode thay đổi
  const oldVisualMode = oldState.options.visualSourceMode ?? (oldProfileMode === 'health' ? 'custom-mix' : 'legacy')
  const newVisualMode = newOptions.visualSourceMode ?? (newProfileMode === 'health' ? 'custom-mix' : 'legacy')
  if (oldVisualMode !== newVisualMode) {
    invalidated.add('stock-search')
    if (oldProfileMode === 'health' || newProfileMode === 'health' || oldContentType === 'health' || newContentType === 'health') {
      invalidated.add('audio-search')
    }
    invalidated.add('preflight')
    invalidated.add('rendering')
    invalidated.add('postflight')
  }

  // Visual mix config hoặc legacy health visual config thay đổi
  const oldResolvedMix = oldState.options.visualMixConfig ? resolveVisualMixConfig({
    visualSourceMode: oldState.options.visualSourceMode,
    visualMixConfig: oldState.options.visualMixConfig,
    contentType: oldContentType
  }) : undefined
  const newResolvedMix = newOptions.visualMixConfig ? resolveVisualMixConfig({
    visualSourceMode: newOptions.visualSourceMode,
    visualMixConfig: newOptions.visualMixConfig,
    contentType: newContentType
  }) : undefined

  const oldVisualConfigStr = JSON.stringify(oldState.options.visualMixConfig ?? oldState.options.healthVisualConfig)
  const newVisualConfigStr = JSON.stringify(newOptions.visualMixConfig ?? newOptions.healthVisualConfig)
  const visualConfigChanged =
    oldVisualConfigStr !== newVisualConfigStr ||
    oldResolvedMix?.aiImageRatio !== newResolvedMix?.aiImageRatio ||
    oldResolvedMix?.stockFootageRatio !== newResolvedMix?.stockFootageRatio ||
    oldResolvedMix?.imageOutputResolution !== newResolvedMix?.imageOutputResolution ||
    oldResolvedMix?.aiFailureBehavior !== newResolvedMix?.aiFailureBehavior

  if (visualConfigChanged) {
    invalidated.add('stock-search')
    if (oldContentType === 'health' || newContentType === 'health') {
      invalidated.add('audio-search')
    }
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
