/**
 * render-cache-manager.ts
 *
 * Persistent, crash-safe render cache rooted at  <projectDir>/.cache/render-v2/
 *
 *   .cache/render-v2/
 *   ├── active-render.json        ← which render is (or was) active + resume params
 *   ├── cache-index.json          ← artifact fingerprint → path (cross-workspace reuse)
 *   └── <renderFingerprint>/      ← one workspace per render fingerprint
 *       ├── manifest.json
 *       ├── scenes/ assembly/ audio/ overlays/ composite/ logs/
 *
 * Safety rules:
 *   - Every destructive operation validates the target is strictly inside the cache root.
 *   - Completed artifacts are never deleted by reconciliation — only unconfirmed *.partial.mp4.
 *   - Cross-workspace reuse uses hard links / APFS clones, never moves.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { APP_INSTANCE_ID, isProcessAlive } from '../pipeline/pipeline-state'
import { probeMedia, type MediaProbe } from './ffmpeg-process'
import {
  readArtifactMeta,
  writeArtifactMeta,
  metaPathFor,
  readJsonWithRecovery,
  writeJsonAtomic,
  readManifest,
  writeManifest,
  type ArtifactMeta,
  type InterruptionReason,
  type RenderManifestV2
} from './render-manifest'
import { shortFingerprint } from './render-fingerprint'
import type { RenderTransitionSettings } from '../../../shared/types'

export const RENDER_CACHE_RELATIVE = path.join('.cache', 'render-v2')

// ─── Path safety ─────────────────────────────────────────────────────────────

export function getRenderCacheRoot(projectDir: string): string {
  return path.join(path.resolve(projectDir), RENDER_CACHE_RELATIVE)
}

/** True only if `target` is strictly inside the cache root (no traversal, not the root itself). */
export function isInsideCacheRoot(projectDir: string, target: string): boolean {
  const root = path.resolve(getRenderCacheRoot(projectDir))
  const resolved = path.resolve(target)
  const rel = path.relative(root, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  // Resolve symlinks of the existing portion to defeat link-based escapes
  try {
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    let probe = resolved
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe)
    const realProbe = fs.realpathSync(probe)
    const relReal = path.relative(realRoot, realProbe)
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return false
  } catch {
    return false
  }
  return true
}

export function assertInsideCacheRoot(projectDir: string, target: string): void {
  if (!isInsideCacheRoot(projectDir, target)) {
    throw new Error(`Refusing to modify path outside render cache: ${target}`)
  }
}

/** Deletes a file/dir ONLY if it is validated to live inside the render cache root. */
export function safeRemoveCachePath(projectDir: string, target: string): boolean {
  assertInsideCacheRoot(projectDir, target)
  try {
    if (!fs.existsSync(target)) return false
    const st = fs.lstatSync(target)
    if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true })
    else fs.unlinkSync(target)
    return true
  } catch (err) {
    logger.warn(`[RenderCache] Could not remove ${target}: ${String(err)}`)
    return false
  }
}

function linkOrClone(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.linktmp`
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
  try {
    fs.linkSync(src, tmp)
  } catch {
    // Different volume or FS without hard links — APFS clone (copy-on-write) or copy
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE)
  }
  fs.renameSync(tmp, dst)
}

// ─── Active render record ────────────────────────────────────────────────────

export interface RenderResumeParams {
  voiceoverPath: string
  outputName: string
  resolution: { width: number; height: number }
  fps: number
  transitionSettings?: RenderTransitionSettings
}

export type ActiveRenderStatus = 'running' | 'completed' | 'interrupted' | 'cancelled' | 'failed'

export interface ActiveRenderRecord {
  schemaVersion: 1
  renderFingerprint: string
  workspace: string
  status: ActiveRenderStatus
  interruptionReason?: InterruptionReason
  source: 'manual' | 'pipeline'
  pid: number
  appInstanceId: string
  startedAt: string
  heartbeatAt: string
  endedAt?: string
  params: RenderResumeParams
  autoResumeAfterCrash: boolean
  autoResumeCount: number
  childPids?: number[]
  pipelineRunId?: string
  lastError?: string
}

export function getActiveRenderPath(projectDir: string): string {
  return path.join(getRenderCacheRoot(projectDir), 'active-render.json')
}

export function readActiveRender(projectDir: string): ActiveRenderRecord | null {
  return readJsonWithRecovery<ActiveRenderRecord>(getActiveRenderPath(projectDir), (v) => {
    const r = v as ActiveRenderRecord
    return !!r && r.schemaVersion === 1 && typeof r.renderFingerprint === 'string'
  })
}

export function writeActiveRender(projectDir: string, record: ActiveRenderRecord): void {
  writeJsonAtomic(getActiveRenderPath(projectDir), record)
}

/**
 * If the record says "running" but its owner process is gone (crash / power loss /
 * force quit), convert it to "interrupted/crashed". Returns the (possibly updated) record.
 */
export function reconcileActiveRender(projectDir: string, isJobActiveInThisProcess: boolean): ActiveRenderRecord | null {
  const rec = readActiveRender(projectDir)
  if (!rec) return null
  if (rec.status !== 'running') return rec
  const ownedHere = rec.appInstanceId === APP_INSTANCE_ID
  if (ownedHere && isJobActiveInThisProcess) return rec
  const ownerAlive = !ownedHere && isProcessAlive(rec.pid)
  const heartbeatAge = Date.now() - new Date(rec.heartbeatAt).getTime()
  if (ownerAlive && heartbeatAge < 30000) return rec // genuinely running in another instance

  rec.status = 'interrupted'
  rec.interruptionReason = 'crashed'
  rec.endedAt = new Date().toISOString()
  try {
    writeActiveRender(projectDir, rec)
  } catch {
    /* ignore */
  }
  killOrphanedRenderChildren(rec)
  // Mirror in the workspace manifest
  try {
    const manifestPath = path.join(getRenderCacheRoot(projectDir), rec.workspace, 'manifest.json')
    const m = readManifest(manifestPath)
    if (m && m.status !== 'completed' && m.status !== 'cancelled') {
      m.status = 'interrupted'
      m.interruptionReason = 'crashed'
      m.interruptedAt = rec.endedAt
      writeManifest(manifestPath, m)
    }
  } catch {
    /* ignore */
  }
  logger.info(`[RenderCache] Detected crashed render for ${projectDir} → marked interrupted`)
  return rec
}

/** Kills orphaned FFmpeg / Chromium children recorded by a crashed render (best effort). */
export function killOrphanedRenderChildren(rec: ActiveRenderRecord): number {
  if (!rec.childPids?.length || process.platform === 'win32') return 0
  let killed = 0
  for (const pid of rec.childPids) {
    if (!pid || pid === process.pid || !isProcessAlive(pid)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require('child_process') as typeof import('child_process')
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 2000 }).trim()
      if (!/ffmpeg|ffprobe|chrome|chromium|remotion|compositor/i.test(comm)) continue
      process.kill(pid, 'SIGKILL')
      killed++
      logger.warn(`[RenderCache] Killed orphaned render process pid=${pid} (${comm})`)
    } catch {
      /* already gone / not permitted */
    }
  }
  return killed
}

/** Lists descendant render processes (ffmpeg / chrome / remotion) of this app. */
export function listRenderDescendantPids(): Promise<number[]> {
  if (process.platform === 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFile } = require('child_process') as typeof import('child_process')
    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const children = new Map<number, Array<{ pid: number; comm: string }>>()
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        if (!m) continue
        const pid = Number(m[1])
        const ppid = Number(m[2])
        const list = children.get(ppid) ?? []
        list.push({ pid, comm: m[3] })
        children.set(ppid, list)
      }
      const result: number[] = []
      const stack = [process.pid]
      const seen = new Set<number>()
      while (stack.length) {
        const p = stack.pop()!
        for (const c of children.get(p) ?? []) {
          if (seen.has(c.pid)) continue
          seen.add(c.pid)
          stack.push(c.pid)
          if (/ffmpeg|ffprobe|chrome|chromium|remotion|compositor/i.test(c.comm)) result.push(c.pid)
        }
      }
      resolve(result)
    })
  })
}

// ─── Cache index ─────────────────────────────────────────────────────────────

export interface CacheIndex {
  schemaVersion: 1
  entries: Record<string, { path: string; kind: string; sizeBytes: number; updatedAt: string }>
  workspaces: Record<string, {
    renderFingerprint: string
    lastUsedAt: string
    completedAt?: string
    outputPath?: string
  }>
}

function emptyIndex(): CacheIndex {
  return { schemaVersion: 1, entries: {}, workspaces: {} }
}

export function getCacheIndexPath(projectDir: string): string {
  return path.join(getRenderCacheRoot(projectDir), 'cache-index.json')
}

export function readCacheIndex(projectDir: string): CacheIndex {
  return (
    readJsonWithRecovery<CacheIndex>(getCacheIndexPath(projectDir), (v) => {
      const i = v as CacheIndex
      return !!i && i.schemaVersion === 1 && typeof i.entries === 'object'
    }) ?? emptyIndex()
  )
}

export function writeCacheIndex(projectDir: string, index: CacheIndex): void {
  writeJsonAtomic(getCacheIndexPath(projectDir), index)
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ArtifactExpectation {
  fingerprint: string
  kind: string
  width?: number
  height?: number
  durationSecs?: number
  durationTolerance?: number
  fps?: number
  frames?: number
  requireAudio?: boolean
  /**
   * Legacy-compatible validation: only a structurally valid video stream is required
   * (the legacy renderer merely warned on duration / resolution drift). Reuse of a
   * lenient artifact is verified against the values recorded when it was committed.
   */
  lenient?: boolean
}

export interface ArtifactValidation {
  ok: boolean
  reason?: string
  probe?: MediaProbe
  meta?: ArtifactMeta
}

export function checkProbeAgainstExpectation(probe: MediaProbe | null, expect: ArtifactExpectation): string | null {
  if (!probe) return 'ffprobe failed'
  if (!probe.hasVideo) return 'no video stream'
  if (expect.lenient) {
    if (probe.width <= 0 || probe.height <= 0) return 'invalid video dimensions'
    if (probe.duration <= 0) return 'zero duration'
    if (expect.requireAudio && !probe.hasAudio) return 'missing audio stream'
    return null
  }
  if (expect.width && probe.width !== expect.width) return `width ${probe.width} != ${expect.width}`
  if (expect.height && probe.height !== expect.height) return `height ${probe.height} != ${expect.height}`
  if (probe.duration <= 0) return 'zero duration'
  if (typeof expect.durationSecs === 'number' && expect.durationSecs > 0) {
    const tol = expect.durationTolerance ?? Math.max(0.12, (expect.fps ? 2 / expect.fps : 0.1) + 0.05)
    if (Math.abs(probe.duration - expect.durationSecs) > tol) {
      return `duration ${probe.duration.toFixed(3)} != ${expect.durationSecs.toFixed(3)} (±${tol.toFixed(3)})`
    }
  }
  if (expect.fps && probe.fps > 0 && Math.abs(probe.fps - expect.fps) > 0.5) return `fps ${probe.fps} != ${expect.fps}`
  if (expect.fps && probe.fps <= 0) return 'invalid fps'
  if (typeof expect.frames === 'number' && probe.frames !== null && Math.abs(probe.frames - expect.frames) > 1) {
    return `frames ${probe.frames} != ${expect.frames}`
  }
  if (expect.requireAudio && !probe.hasAudio) return 'missing audio stream'
  return null
}

/** Full validation of a completed artifact (file + sidecar fingerprint + ffprobe). */
export async function validateCompletedArtifact(
  artifactPath: string,
  expect: ArtifactExpectation,
  signal?: AbortSignal
): Promise<ArtifactValidation> {
  try {
    if (!fs.existsSync(artifactPath)) return { ok: false, reason: 'missing' }
    const st = fs.statSync(artifactPath)
    if (st.size <= 0) return { ok: false, reason: 'empty file' }
    const meta = readArtifactMeta(artifactPath)
    if (!meta) return { ok: false, reason: 'missing meta' }
    if (meta.fingerprint !== expect.fingerprint) return { ok: false, reason: 'fingerprint mismatch', meta }
    if (meta.sizeBytes && meta.sizeBytes !== st.size) return { ok: false, reason: 'size changed since completion', meta }
    const probe = await probeMedia(artifactPath, { signal })
    const problem = checkProbeAgainstExpectation(probe, expect) ?? (expect.lenient ? compareWithMeta(probe!, meta) : null)
    if (problem) return { ok: false, reason: problem, meta, probe: probe ?? undefined }
    return { ok: true, probe: probe!, meta }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/** For lenient artifacts: the file must still match what was recorded when it was committed. */
function compareWithMeta(probe: MediaProbe, meta: ArtifactMeta): string | null {
  if (meta.width && probe.width !== meta.width) return `width ${probe.width} != recorded ${meta.width}`
  if (meta.height && probe.height !== meta.height) return `height ${probe.height} != recorded ${meta.height}`
  if (typeof meta.durationSecs === 'number' && meta.durationSecs > 0 && Math.abs(probe.duration - meta.durationSecs) > 0.1) {
    return `duration ${probe.duration.toFixed(3)} != recorded ${meta.durationSecs.toFixed(3)}`
  }
  return null
}

// ─── Workspace ───────────────────────────────────────────────────────────────

export class RenderWorkspace {
  readonly root: string
  readonly dir: string
  readonly name: string
  private index: CacheIndex
  private eventsBytes = 0

  constructor(readonly projectDir: string, readonly renderFingerprint: string) {
    this.root = getRenderCacheRoot(projectDir)
    this.name = shortFingerprint(renderFingerprint, 24)
    this.dir = path.join(this.root, this.name)
    this.index = readCacheIndex(projectDir)
  }

  ensure(): void {
    for (const sub of ['scenes', 'assembly', path.join('assembly', 'segments'), 'audio', 'overlays', 'composite', 'logs']) {
      fs.mkdirSync(path.join(this.dir, sub), { recursive: true })
    }
  }

  get manifestPath(): string { return path.join(this.dir, 'manifest.json') }
  scenePath(ordinal: number): string { return path.join(this.dir, 'scenes', `scene-${String(ordinal).padStart(4, '0')}.mp4`) }
  assemblySegmentPath(i: number): string { return path.join(this.dir, 'assembly', 'segments', `segment-${String(i).padStart(4, '0')}.mp4`) }
  get rawVideoPath(): string { return path.join(this.dir, 'assembly', 'raw-video.mp4') }
  get mixedVideoPath(): string { return path.join(this.dir, 'audio', 'mixed-video.mp4') }
  overlayBlockPath(i: number): string { return path.join(this.dir, 'overlays', `block-${String(i).padStart(4, '0')}.mp4`) }
  get overlayFullPath(): string { return path.join(this.dir, 'overlays', 'overlay-full.mp4') }
  get compositePath(): string { return path.join(this.dir, 'composite', 'composited-working.mp4') }
  get eventsPath(): string { return path.join(this.dir, 'logs', 'render-events.jsonl') }

  loadManifest(): RenderManifestV2 | null {
    return readManifest(this.manifestPath)
  }

  saveManifest(m: RenderManifestV2): void {
    writeManifest(this.manifestPath, m)
  }

  logEvent(event: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n'
      // Rotate at ~4MB so the log can never grow unbounded
      if (this.eventsBytes === 0 && fs.existsSync(this.eventsPath)) this.eventsBytes = fs.statSync(this.eventsPath).size
      if (this.eventsBytes > 4 * 1024 * 1024) {
        const rotated = this.eventsPath + '.1'
        try { fs.renameSync(this.eventsPath, rotated) } catch { /* ignore */ }
        this.eventsBytes = 0
      }
      fs.appendFileSync(this.eventsPath, line)
      this.eventsBytes += line.length
    } catch {
      /* logging must never break rendering */
    }
  }

  touch(meta: Partial<CacheIndex['workspaces'][string]> = {}): void {
    this.index.workspaces[this.name] = {
      ...(this.index.workspaces[this.name] ?? { renderFingerprint: this.renderFingerprint }),
      renderFingerprint: this.renderFingerprint,
      lastUsedAt: new Date().toISOString(),
      ...meta
    }
    this.flushIndex()
  }

  private flushIndex(): void {
    try {
      writeCacheIndex(this.projectDir, this.index)
    } catch (err) {
      logger.warn(`[RenderCache] Could not write cache index: ${String(err)}`)
    }
  }

  /**
   * Deletes stale *.partial.mp4 / *.linktmp files left by an interrupted run.
   * Completed artifacts are never touched.
   */
  cleanupStalePartials(): string[] {
    const removed: string[] = []
    const walk = (d: string): void => {
      let list: fs.Dirent[]
      try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const ent of list) {
        const full = path.join(d, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (/\.partial\.mp4$|\.linktmp$|\.partial\.txt$/i.test(ent.name)) {
          if (safeRemoveCachePath(this.projectDir, full)) removed.push(full)
        }
      }
    }
    if (fs.existsSync(this.dir)) walk(this.dir)
    if (removed.length) logger.info(`[RenderCache] Removed ${removed.length} stale partial artifact(s) in ${this.name}`)
    return removed
  }

  /**
   * Try to reuse an artifact: first in this workspace, then any workspace via the index.
   * Returns the probe of the reusable artifact, or null if it must be (re)rendered.
   */
  async tryReuse(artifactPath: string, expect: ArtifactExpectation, signal?: AbortSignal): Promise<ArtifactValidation> {
    const local = await validateCompletedArtifact(artifactPath, expect, signal)
    if (local.ok) {
      this.register(artifactPath, expect.kind, local.meta?.sizeBytes ?? 0, expect.fingerprint)
      return local
    }
    const entry = this.index.entries[expect.fingerprint]
    if (entry) {
      const candidate = path.join(this.root, entry.path)
      if (path.resolve(candidate) !== path.resolve(artifactPath) && isInsideCacheRoot(this.projectDir, candidate)) {
        const remote = await validateCompletedArtifact(candidate, expect, signal)
        if (remote.ok) {
          try {
            linkOrClone(candidate, artifactPath)
            writeArtifactMeta(artifactPath, { ...(remote.meta as ArtifactMeta), sizeBytes: fs.statSync(artifactPath).size })
            return { ...remote, ok: true }
          } catch (err) {
            logger.warn(`[RenderCache] Could not link cached artifact ${candidate}: ${String(err)}`)
          }
        } else {
          delete this.index.entries[expect.fingerprint]
        }
      }
    }
    return local
  }

  /**
   * Validate a freshly rendered .partial.mp4 and atomically promote it to its final name.
   */
  async commitPartial(
    partialPath: string,
    finalPath: string,
    expect: ArtifactExpectation,
    extra: { encoder?: string; signal?: AbortSignal } = {}
  ): Promise<MediaProbe> {
    if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size <= 0) {
      throw new Error(`${expect.kind} did not produce a valid file`)
    }
    const probe = await probeMedia(partialPath, { signal: extra.signal })
    const problem = checkProbeAgainstExpectation(probe, expect)
    if (problem) {
      safeRemoveCachePath(this.projectDir, partialPath)
      throw new Error(`${expect.kind} validation failed: ${problem}`)
    }
    // Remove stale sidecar first so a crash between rename and meta write can never
    // leave an old fingerprint pointing at new bytes.
    try { if (fs.existsSync(metaPathFor(finalPath))) fs.unlinkSync(metaPathFor(finalPath)) } catch { /* ignore */ }
    fs.renameSync(partialPath, finalPath)
    const size = fs.statSync(finalPath).size
    writeArtifactMeta(finalPath, {
      fingerprint: expect.fingerprint,
      kind: expect.kind,
      sizeBytes: size,
      durationSecs: probe!.duration,
      width: probe!.width,
      height: probe!.height,
      fps: probe!.fps,
      frames: probe!.frames,
      completedAt: new Date().toISOString(),
      encoder: extra.encoder
    })
    this.register(finalPath, expect.kind, size, expect.fingerprint)
    return probe!
  }

  private register(artifactPath: string, kind: string, sizeBytes: number, fingerprint: string): void {
    const rel = path.relative(this.root, artifactPath)
    const existing = this.index.entries[fingerprint]
    if (existing && existing.path === rel) return
    this.index.entries[fingerprint] = { path: rel, kind, sizeBytes, updatedAt: new Date().toISOString() }
    this.flushIndex()
  }
}

// ─── Size / cleanup ──────────────────────────────────────────────────────────

/** Total on-disk size of the cache (hard-linked files counted once). */
export function getRenderCacheSizeBytes(projectDir: string): number {
  const root = getRenderCacheRoot(projectDir)
  if (!fs.existsSync(root)) return 0
  const seen = new Set<string>()
  let total = 0
  const walk = (d: string): void => {
    let list: fs.Dirent[]
    try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of list) {
      const full = path.join(d, ent.name)
      try {
        const st = fs.lstatSync(full)
        if (st.isDirectory()) walk(full)
        else {
          const key = `${st.dev}:${st.ino}`
          if (seen.has(key)) continue
          seen.add(key)
          total += st.size
        }
      } catch { /* ignore */ }
    }
  }
  walk(root)
  return total
}

export interface PruneOptions {
  keepWorkspaces: string[]
  maxBytes: number
}

/**
 * Removes old workspaces (oldest first) until the cache fits under maxBytes.
 * Never removes kept workspaces (current/active/most recent completed).
 */
export function pruneRenderCache(projectDir: string, opts: PruneOptions): string[] {
  const root = getRenderCacheRoot(projectDir)
  if (!fs.existsSync(root)) return []
  const index = readCacheIndex(projectDir)
  const active = readActiveRender(projectDir)
  const keep = new Set(opts.keepWorkspaces)
  if (active?.workspace) keep.add(active.workspace)
  const mostRecentCompleted = Object.entries(index.workspaces)
    .filter(([, w]) => !!w.completedAt)
    .sort((a, b) => (b[1].completedAt ?? '').localeCompare(a[1].completedAt ?? ''))[0]?.[0]
  if (mostRecentCompleted) keep.add(mostRecentCompleted)

  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-f0-9]{8,64}$/i.test(d.name) && !keep.has(d.name))
    .map((d) => ({ name: d.name, lastUsed: index.workspaces[d.name]?.lastUsedAt ?? '' }))
    .sort((a, b) => a.lastUsed.localeCompare(b.lastUsed))

  const removed: string[] = []
  for (const d of dirs) {
    if (getRenderCacheSizeBytes(projectDir) <= opts.maxBytes) break
    const full = path.join(root, d.name)
    if (safeRemoveCachePath(projectDir, full)) {
      removed.push(d.name)
      delete index.workspaces[d.name]
    }
  }
  if (removed.length) {
    // Drop index entries pointing into removed workspaces
    for (const [fp, e] of Object.entries(index.entries)) {
      const top = e.path.split(/[\\/]/)[0]
      if (removed.includes(top)) delete index.entries[fp]
    }
    writeCacheIndex(projectDir, index)
    logger.info(`[RenderCache] Pruned ${removed.length} old render workspace(s)`)
  }
  return removed
}

/** Removes the whole render cache for a project (caller must ensure no active render). */
export function clearRenderCache(projectDir: string): number {
  const root = getRenderCacheRoot(projectDir)
  if (!fs.existsSync(root)) return 0
  let removed = 0
  for (const ent of fs.readdirSync(root)) {
    if (safeRemoveCachePath(projectDir, path.join(root, ent))) removed++
  }
  return removed
}

/**
 * Deletes orphan publish temp files (<name>.partial.mp4) in the project's output dir.
 * Legacy `_x_working.mp4` files and completed outputs are left untouched.
 */
export function cleanupOrphanOutputPartials(projectDir: string): string[] {
  const outputDir = path.join(path.resolve(projectDir), 'output')
  const removed: string[] = []
  if (!fs.existsSync(outputDir)) return removed
  for (const f of fs.readdirSync(outputDir)) {
    if (!f.endsWith('.partial.mp4')) continue
    const full = path.join(outputDir, f)
    try {
      fs.unlinkSync(full)
      removed.push(full)
    } catch { /* ignore */ }
  }
  if (removed.length) logger.info(`[RenderCache] Removed ${removed.length} orphan output partial file(s)`)
  return removed
}
