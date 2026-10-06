/**
 * render-preferences.ts
 *
 * Machine-level render preferences (stored in Electron userData, not in projects).
 * Missing file / missing fields → safe defaults (Balanced, software H.264).
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { normalizeResourceProfile, type RenderResourceProfile } from './render-resource-manager'
import { readJsonWithRecovery, writeJsonAtomic } from './render-manifest'

export type VideoEncoderMode = 'software-h264' | 'videotoolbox-h264'

export interface RenderPreferences {
  resourceProfile: RenderResourceProfile
  videoEncoder: VideoEncoderMode
  /** Remotion `hardwareAcceleration: 'if-possible'` (experimental, macOS only) */
  remotionHardwareAcceleration: boolean
  /** Auto-resume an Auto Production render after a crash (once). */
  autoResumeAfterCrash: boolean
  /** Old render workspaces are pruned above this size (after a confirmed final output). */
  maxCacheBytes: number
}

export const DEFAULT_RENDER_PREFERENCES: RenderPreferences = {
  resourceProfile: 'balanced',
  videoEncoder: 'software-h264',
  remotionHardwareAcceleration: false,
  autoResumeAfterCrash: true,
  maxCacheBytes: 30 * 1024 * 1024 * 1024
}

let overridePath: string | null = null

/** Test hook */
export function setRenderPreferencesPathForTests(p: string | null): void {
  overridePath = p
}

function prefsPath(): string {
  if (overridePath) return overridePath
  const base = app && typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd()
  return path.join(base, 'render-preferences.json')
}

export function normalizeRenderPreferences(raw: Partial<RenderPreferences> | null | undefined): RenderPreferences {
  const r = raw ?? {}
  return {
    resourceProfile: normalizeResourceProfile(r.resourceProfile),
    videoEncoder: r.videoEncoder === 'videotoolbox-h264' ? 'videotoolbox-h264' : 'software-h264',
    remotionHardwareAcceleration: r.remotionHardwareAcceleration === true,
    autoResumeAfterCrash: r.autoResumeAfterCrash !== false,
    maxCacheBytes:
      typeof r.maxCacheBytes === 'number' && r.maxCacheBytes > 1024 * 1024 * 1024
        ? r.maxCacheBytes
        : DEFAULT_RENDER_PREFERENCES.maxCacheBytes
  }
}

export function loadRenderPreferences(): RenderPreferences {
  try {
    const p = prefsPath()
    if (!fs.existsSync(p)) return { ...DEFAULT_RENDER_PREFERENCES }
    return normalizeRenderPreferences(readJsonWithRecovery<Partial<RenderPreferences>>(p))
  } catch {
    return { ...DEFAULT_RENDER_PREFERENCES }
  }
}

export function saveRenderPreferences(patch: Partial<RenderPreferences>): RenderPreferences {
  const next = normalizeRenderPreferences({ ...loadRenderPreferences(), ...patch })
  writeJsonAtomic(prefsPath(), next)
  return next
}
