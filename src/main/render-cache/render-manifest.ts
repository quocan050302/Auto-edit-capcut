/**
 * render-manifest.ts
 *
 * Schema + crash-safe persistence for Resumable Render Engine V2.
 *
 * All JSON is written atomically:  <file>.tmp → fsync → close → rename → (dir fsync)
 * so a crash can never leave a half-written manifest behind.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { RenderTransitionSettings } from '../../../shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RenderManifestStatus =
  | 'initializing'
  | 'rendering-scenes'
  | 'assembling-scenes'
  | 'mixing-audio'
  | 'rendering-overlays'
  | 'compositing'
  | 'postflight'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'

export type CheckpointStatus = 'pending' | 'running' | 'completed' | 'invalid' | 'failed'

export interface RenderArtifactCheckpoint {
  status: CheckpointStatus
  artifactPath?: string
  fingerprint: string
  sizeBytes?: number
  durationSecs?: number
  width?: number
  height?: number
  fps?: number
  frames?: number
  startedAt?: string
  completedAt?: string
  error?: string
  /** true when this artifact was reused from cache in the current run */
  reused?: boolean
}

export interface RenderSceneCheckpoint extends RenderArtifactCheckpoint {
  ordinal: number
  sceneIndex: number
  expectedDuration: number
}

export interface OverlayBlockCheckpoint extends RenderArtifactCheckpoint {
  blockIndex: number
  startFrame: number
  endFrameExclusive: number
}

export type InterruptionReason = 'user-cancelled' | 'app-closed' | 'crashed' | 'error'

export interface RenderManifestV2 {
  schemaVersion: 2
  renderFingerprint: string
  projectDir: string
  outputName: string

  status: RenderManifestStatus

  createdAt: string
  updatedAt: string
  interruptedAt?: string
  interruptionReason?: InterruptionReason
  completedAt?: string

  settings: {
    resolution: { width: number; height: number }
    fps: number
    transitionSettings: RenderTransitionSettings | null
    resourceProfile: string
    encoderMode: string
  }

  scenes: RenderSceneCheckpoint[]
  assembly: RenderArtifactCheckpoint
  audioMix: RenderArtifactCheckpoint
  overlayBlocks: OverlayBlockCheckpoint[]
  overlayFull?: RenderArtifactCheckpoint
  composite: RenderArtifactCheckpoint
  finalOutput: RenderArtifactCheckpoint

  progress: {
    completedScenes: number
    totalScenes: number
    completedOverlayBlocks: number
    totalOverlayBlocks: number
    currentPhase: string
    reusedScenes?: number
    reusedOverlayBlocks?: number
  }

  invalidationReasons: string[]
  warnings: string[]
}

export const MANIFEST_SCHEMA_VERSION = 2 as const

export function emptyCheckpoint(fingerprint = ''): RenderArtifactCheckpoint {
  return { status: 'pending', fingerprint }
}

export function createManifest(params: {
  renderFingerprint: string
  projectDir: string
  outputName: string
  settings: RenderManifestV2['settings']
}): RenderManifestV2 {
  const now = new Date().toISOString()
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    renderFingerprint: params.renderFingerprint,
    projectDir: params.projectDir,
    outputName: params.outputName,
    status: 'initializing',
    createdAt: now,
    updatedAt: now,
    settings: params.settings,
    scenes: [],
    assembly: emptyCheckpoint(),
    audioMix: emptyCheckpoint(),
    overlayBlocks: [],
    composite: emptyCheckpoint(),
    finalOutput: emptyCheckpoint(),
    progress: {
      completedScenes: 0,
      totalScenes: 0,
      completedOverlayBlocks: 0,
      totalOverlayBlocks: 0,
      currentPhase: 'initializing'
    },
    invalidationReasons: [],
    warnings: []
  }
}

export function recomputeManifestProgress(m: RenderManifestV2): void {
  m.progress.totalScenes = m.scenes.length
  m.progress.completedScenes = m.scenes.filter((s) => s.status === 'completed').length
  m.progress.totalOverlayBlocks = m.overlayBlocks.length
  m.progress.completedOverlayBlocks = m.overlayBlocks.filter((b) => b.status === 'completed').length
}

// ─── Atomic JSON I/O ─────────────────────────────────────────────────────────

function fsyncDirBestEffort(dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* not supported on every platform/filesystem */
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * Atomically writes JSON: tmp file → fsync → close → rename.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const content = JSON.stringify(data, null, 2)
  const fd = fs.openSync(tmpPath, 'w')
  try {
    fs.writeSync(fd, content, 0, 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  fsyncDirBestEffort(dir)
}

function tryParse<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Reads JSON written by writeJsonAtomic, recovering from a crash mid-write:
 *  - primary valid  → use it, drop any stale .tmp
 *  - primary broken/missing but .tmp valid → promote .tmp
 *  - both broken → null
 */
export function readJsonWithRecovery<T>(
  filePath: string,
  validate: (v: unknown) => boolean = () => true
): T | null {
  const tmpPath = `${filePath}.tmp`
  const primary = tryParse<T>(filePath)
  if (primary !== null && validate(primary)) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    }
    return primary
  }
  const tmp = tryParse<T>(tmpPath)
  if (tmp !== null && validate(tmp)) {
    try {
      fs.renameSync(tmpPath, filePath)
    } catch {
      /* ignore — still return the recovered data */
    }
    return tmp
  }
  return null
}

export function isValidManifest(v: unknown): v is RenderManifestV2 {
  const m = v as RenderManifestV2
  return !!m && typeof m === 'object' && m.schemaVersion === 2 && typeof m.renderFingerprint === 'string' &&
    Array.isArray(m.scenes) && Array.isArray(m.overlayBlocks) && !!m.assembly && !!m.audioMix
}

export function writeManifest(manifestPath: string, manifest: RenderManifestV2): void {
  manifest.updatedAt = new Date().toISOString()
  recomputeManifestProgress(manifest)
  writeJsonAtomic(manifestPath, manifest)
}

export function readManifest(manifestPath: string): RenderManifestV2 | null {
  return readJsonWithRecovery<RenderManifestV2>(manifestPath, isValidManifest)
}

// ─── Artifact meta (sidecar) ─────────────────────────────────────────────────

export interface ArtifactMeta {
  fingerprint: string
  kind: string
  sizeBytes: number
  durationSecs: number
  width: number
  height: number
  fps: number
  frames?: number | null
  completedAt: string
  /** encoder actually used — helps diagnose fallback */
  encoder?: string
}

export function metaPathFor(artifactPath: string): string {
  return artifactPath.replace(/\.mp4$/i, '') + '.meta.json'
}

export function writeArtifactMeta(artifactPath: string, meta: ArtifactMeta): void {
  writeJsonAtomic(metaPathFor(artifactPath), meta)
}

export function readArtifactMeta(artifactPath: string): ArtifactMeta | null {
  return readJsonWithRecovery<ArtifactMeta>(metaPathFor(artifactPath), (v) => {
    const m = v as ArtifactMeta
    return !!m && typeof m.fingerprint === 'string'
  })
}

export function partialPathFor(artifactPath: string): string {
  return artifactPath.replace(/\.mp4$/i, '') + '.partial.mp4'
}
