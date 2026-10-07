/**
 * render-fingerprint.ts
 *
 * Deterministic SHA-256 fingerprints on canonical JSON for the resumable render engine.
 *
 * Dependency graph (what invalidates what):
 *
 *   scene media / timing / beats ─► scene clip ─► assembly ─► audio mix ─► composite ─► final
 *   transition settings ───────────────────────► assembly ─► …
 *   voiceover / audio plan ─────────────────────────────────► audio mix ─► …
 *   captions / proof visuals / visual grammar ─► overlay blocks ─────────► composite ─► …
 *   resolution / fps / encoder ─► everything visual (separate workspace)
 *   output filename ─► nothing (final publish only)
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/** Bump when the scene encoding pipeline changes in a way that alters clips. */
export const SCENE_RENDERER_VERSION = 'scene-v2.0'
/** Bump when assembly / audio / composite logic changes. */
export const RENDERER_SCHEMA_VERSION = 'render-v2.0'
/** Bump when the overlay block pipeline changes. */
export const OVERLAY_RENDERER_VERSION = 'overlay-v2.0'

// ─── Canonical JSON ──────────────────────────────────────────────────────────

function normalizeForCanonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    // Avoid 0.1+0.2 style noise — 6 decimals is far below frame precision
    return Math.round(value * 1e6) / 1e6
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(normalizeForCanonical)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined || typeof v === 'function') continue
      out[key] = normalizeForCanonical(v)
    }
    return out
  }
  return String(value)
}

/** Stable JSON: sorted keys, undefined dropped, numbers rounded to 1e-6. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForCanonical(value))
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export function fingerprintOf(value: unknown): string {
  return sha256(canonicalJson(value))
}

// ─── File signatures ─────────────────────────────────────────────────────────

export interface FileSignature {
  normalizedPath: string
  size: number
  mtimeMs: number
  missing?: boolean
}

export function normalizeSignaturePath(p: string): string {
  return path.normalize(path.resolve(p))
}

export function fileSignature(filePath: string | null | undefined): FileSignature | null {
  if (!filePath) return null
  const normalizedPath = normalizeSignaturePath(filePath)
  try {
    const st = fs.statSync(normalizedPath)
    return { normalizedPath, size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
  } catch {
    return { normalizedPath, size: 0, mtimeMs: 0, missing: true }
  }
}

const SMALL_JSON_LIMIT = 8 * 1024 * 1024

/**
 * Content hash for small JSON/text files; falls back to signature hash for large files.
 * Returns 'absent' if the file does not exist.
 */
export function hashFileContent(filePath: string): string {
  try {
    const st = fs.statSync(filePath)
    if (st.size <= SMALL_JSON_LIMIT) {
      return sha256(fs.readFileSync(filePath))
    }
    return fingerprintOf(fileSignature(filePath))
  } catch {
    return 'absent'
  }
}

/** Hash of a parsed JSON value (canonicalized so key order does not matter). */
export function hashJsonValue(value: unknown): string {
  return value === undefined || value === null ? 'none' : fingerprintOf(value)
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface VisualBaseSettings {
  width: number
  height: number
  fps: number
  /** e.g. 'libx264:fast:crf20' or 'h264_videotoolbox:<bitrate>' */
  encoderProfile: string
}

// ─── Scene fingerprint ───────────────────────────────────────────────────────

export interface SceneFingerprintInput {
  sceneOrdinal: number            // position in render order (1-based)
  sceneIndex: number              // plan sceneIndex / ID
  duration: number
  startTime: number
  mediaType: string               // 'video' | 'image' | 'placeholder'
  mediaSignature: FileSignature | null
  visualBeats: unknown            // retention beats incl. crop/zoom
  filterChain: string             // effective base scale/pad filter
  multiBeat: boolean
  semanticCrop: boolean
  base: VisualBaseSettings
}

export function computeSceneFingerprint(input: SceneFingerprintInput): string {
  return fingerprintOf({
    v: SCENE_RENDERER_VERSION,
    // NOTE: sceneOrdinal is intentionally excluded — clip pixels do not depend on
    // render position, so inserting a scene elsewhere must not invalidate this clip.
    sceneIndex: input.sceneIndex,
    duration: input.duration,
    startTime: input.startTime,
    mediaType: input.mediaType,
    media: input.mediaSignature,
    beats: input.visualBeats ?? null,
    filter: input.filterChain,
    multiBeat: input.multiBeat,
    semanticCrop: input.semanticCrop,
    base: input.base
  })
}

// ─── Downstream fingerprints ─────────────────────────────────────────────────

export interface AssemblyFingerprintInput {
  sceneFingerprints: string[]
  /** chapter/sequence boundary flags + transitionIn per scene (affects resolved transitions) */
  sceneBoundaryMeta: Array<{ c: number; s: number; fc: boolean; fs: boolean; t?: string; d: number }>
  transitionSettings: unknown
  base: VisualBaseSettings
}

export function computeAssemblyFingerprint(input: AssemblyFingerprintInput): string {
  return fingerprintOf({ v: RENDERER_SCHEMA_VERSION, kind: 'assembly', ...input })
}

export interface AudioFingerprintInput {
  assemblyFingerprint: string
  voiceover: FileSignature | null
  audioPlanHash: string
  musicSignatures: Array<FileSignature | null>
  sfxSignatures: Array<FileSignature | null>
}

export function computeAudioFingerprint(input: AudioFingerprintInput): string {
  return fingerprintOf({ v: RENDERER_SCHEMA_VERSION, kind: 'audio', ...input })
}

export interface OverlayFingerprintInput {
  overlayPropsHash: string        // captions + proof visuals + visual grammar
  startFrame: number
  endFrameExclusive: number
  totalFrames: number
  base: VisualBaseSettings
  remotionSourceHash: string
  hardwareAcceleration: string
}

export function computeOverlayBlockFingerprint(input: OverlayFingerprintInput): string {
  return fingerprintOf({ v: OVERLAY_RENDERER_VERSION, kind: 'overlay-block', ...input })
}

export function computeCompositeFingerprint(input: {
  audioFingerprint: string
  overlayBlockFingerprints: string[] | null
  base: VisualBaseSettings
}): string {
  return fingerprintOf({ v: RENDERER_SCHEMA_VERSION, kind: 'composite', ...input })
}

export interface RenderFingerprintInput {
  masterEditPlanHash: string
  mediaIndexHash: string
  stockAssignmentsHash: string
  captionPlanHash: string
  audioPlanHash: string
  voiceover: FileSignature | null
  base: VisualBaseSettings
  transitionSettings: unknown
  retentionSettings: unknown
  proofVisualSettings: unknown
  visualGrammarSettings: unknown
  sceneFingerprints: string[]
}

/**
 * Overall render fingerprint. Identifies a complete render request.
 * The output filename is intentionally NOT included.
 */
export function computeRenderFingerprint(input: RenderFingerprintInput): string {
  return fingerprintOf({ v: RENDERER_SCHEMA_VERSION, kind: 'render', ...input })
}

/** Directory-safe short form of a fingerprint. */
export function shortFingerprint(fp: string, len = 16): string {
  return fp.replace(/[^a-f0-9]/gi, '').slice(0, len)
}

/**
 * Lightweight signature of the Remotion source folder (file names + size + mtime).
 * Ensures overlay blocks are re-rendered if components change after an app update.
 */
export function computeDirectorySignature(dir: string, maxEntries = 2000): string {
  const entries: Array<[string, number, number]> = []
  const walk = (d: string): void => {
    if (entries.length >= maxEntries) return
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of list) {
      if (entries.length >= maxEntries) return
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else {
        try {
          const st = fs.statSync(full)
          entries.push([path.relative(dir, full), st.size, Math.floor(st.mtimeMs)])
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return entries.length ? fingerprintOf(entries) : 'absent'
}
