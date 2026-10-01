import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import type {
  ThumbnailJobState,
  ThumbnailCandidate,
  ThumbnailJobStatus,
  ThumbnailPlan
} from '../../../shared/types'

const APP_INSTANCE_ID = uuidv4()

export function getThumbnailJobStatePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'thumbnail-job-state.json')
}

export function getThumbnailJobStateBackupPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'thumbnail-job-state.backup.json')
}

export function computeThumbnailJobKey(params: {
  renderOutputPath: string
  renderFileSize: number
  renderMtimeMs: number
  scriptHash: string
  templateSnapshotHash: string
  generationRound: number
}): string {
  const payload = [
    params.renderOutputPath,
    String(params.renderFileSize),
    String(params.renderMtimeMs),
    params.scriptHash,
    params.templateSnapshotHash,
    String(params.generationRound)
  ].join('::')

  return crypto.createHash('sha256').update(payload, 'utf-8').digest('hex')
}

export function createCandidatesFromPlan(plan: ThumbnailPlan, round = 1): ThumbnailCandidate[] {
  return plan.options.map((opt) => ({
    id: `cand-${uuidv4()}`,
    optionId: opt.id,
    round,
    revision: 1,
    conceptName: opt.conceptName,
    yellowText: opt.yellowText,
    whiteText: opt.whiteText,
    imagePrompt: opt.imagePrompt,
    titleClear: opt.titleClear,
    titleCuriosity: opt.titleCuriosity,
    status: 'pending',
    attempts: 0
  }))
}

export function createInitialThumbnailJobState(params: {
  projectDir: string
  renderOutputPath: string
  renderFileSize?: number
  renderMtimeMs?: number
  scriptHash: string
  templateSnapshotHash: string
  generationRound?: number
  plan?: ThumbnailPlan
  flowProjectId?: string
}): ThumbnailJobState {
  const round = params.generationRound || 1
  const jobKey = computeThumbnailJobKey({
    renderOutputPath: params.renderOutputPath,
    renderFileSize: params.renderFileSize || 0,
    renderMtimeMs: params.renderMtimeMs || 0,
    scriptHash: params.scriptHash,
    templateSnapshotHash: params.templateSnapshotHash,
    generationRound: round
  })

  const candidates = params.plan ? createCandidatesFromPlan(params.plan, round) : []
  const now = new Date().toISOString()
  const jobId = `job-${uuidv4()}`

  return {
    schemaVersion: 1,
    version: 1,
    jobId,
    jobKey,
    projectDir: params.projectDir,
    renderOutputPath: params.renderOutputPath,
    status: params.plan ? 'generating' : 'planning',
    generationRound: round,
    scriptHash: params.scriptHash,
    templateSnapshotHash: params.templateSnapshotHash,
    flowProjectId: params.flowProjectId,
    candidates,
    createdAt: now,
    updatedAt: now,
    warnings: [],
    errors: [],
    lease: {
      jobId,
      appInstanceId: APP_INSTANCE_ID,
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now
    }
  }
}

export function isThumbnailLeaseStale(lease?: ThumbnailJobState['lease'], thresholdMs = 30000): boolean {
  if (!lease) return false

  // Different instance and different pid or dead process
  if (lease.appInstanceId !== APP_INSTANCE_ID) {
    const age = Date.now() - new Date(lease.heartbeatAt).getTime()
    if (age > thresholdMs) {
      return true
    }

    try {
      process.kill(lease.pid, 0)
      return false
    } catch {
      return true
    }
  }

  return false
}

export function saveThumbnailJobStateAtomic(projectDir: string, state: ThumbnailJobState): void {
  const filePath = getThumbnailJobStatePath(projectDir)
  const backupPath = getThumbnailJobStateBackupPath(projectDir)
  const dir = path.dirname(filePath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  state.version = (state.version || 0) + 1
  state.updatedAt = new Date().toISOString()
  if (state.lease) {
    state.lease.heartbeatAt = state.updatedAt
  }

  const serialized = JSON.stringify(state, null, 2)
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`

  fs.writeFileSync(tmpPath, serialized, 'utf-8')
  try {
    fs.renameSync(tmpPath, filePath)
    // Update backup file
    try {
      fs.copyFileSync(filePath, backupPath)
    } catch {
      // ignore
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // ignore
      }
    }
  }
}

export function loadThumbnailJobState(projectDir: string): ThumbnailJobState | null {
  const filePath = getThumbnailJobStatePath(projectDir)
  const backupPath = getThumbnailJobStateBackupPath(projectDir)

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as ThumbnailJobState
    } catch (err) {
      logger.warn(`[ThumbnailState] Primary state corrupted at ${filePath}: ${err}. Attempting recovery from backup...`)
    }
  }

  if (fs.existsSync(backupPath)) {
    try {
      const raw = fs.readFileSync(backupPath, 'utf-8')
      const recovered = JSON.parse(raw) as ThumbnailJobState
      logger.info(`[ThumbnailState] Successfully recovered thumbnail state from backup for ${projectDir}`)
      saveThumbnailJobStateAtomic(projectDir, recovered)
      return recovered
    } catch (err) {
      logger.error(`[ThumbnailState] Backup state also corrupted at ${backupPath}: ${err}`)
    }
  }

  return null
}
