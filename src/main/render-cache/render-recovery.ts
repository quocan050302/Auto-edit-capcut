/**
 * render-recovery.ts
 *
 * Read-only inspection of the persistent render cache for crash recovery:
 *  - reconciles active-render.json (dead owner → interrupted/crashed),
 *  - compares the cached manifest against the CURRENT project inputs,
 *  - reports how much work is already cached (scenes, assembly, audio, overlays).
 *
 * Never deletes anything and never runs FFmpeg (fast enough to call on project open).
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { prepareRenderPlan, encoderKeyFor } from '../renderer'
import {
  getRenderCacheRoot,
  reconcileActiveRender,
  readActiveRender,
  readCacheIndex,
  getRenderCacheSizeBytes,
  type ActiveRenderRecord,
  type RenderResumeParams
} from './render-cache-manager'
import { readManifest, readArtifactMeta, type RenderArtifactCheckpoint } from './render-manifest'
import { renderJobCoordinator } from './render-job-coordinator'
import { loadRenderCaptionPlan } from './render-service'
import { loadRenderPreferences } from './render-preferences'
import type { RenderRecoveryInfo } from '../../../shared/types'

export type { RenderRecoveryInfo }

/** Relative cost of each phase, used for "estimated work saved". */
const PHASE_WEIGHTS = { scenes: 0.55, assembly: 0.1, audio: 0.05, overlay: 0.25, composite: 0.05 }

function emptyInfo(extra: Partial<RenderRecoveryInfo> = {}): RenderRecoveryInfo {
  return {
    manifestFound: false,
    resumable: false,
    fingerprintMatches: false,
    completedScenes: 0,
    totalScenes: 0,
    completedOverlayBlocks: 0,
    totalOverlayBlocks: 0,
    invalidArtifacts: [],
    status: 'none',
    ...extra
  }
}

/** Cheap validity check (no ffprobe): file exists, non-empty, sidecar fingerprint matches. */
function artifactLooksValid(artifactPath: string | undefined, fingerprint: string): boolean {
  if (!artifactPath || !fingerprint) return false
  try {
    const st = fs.statSync(artifactPath)
    if (!st.isFile() || st.size <= 0) return false
    const meta = readArtifactMeta(artifactPath)
    return !!meta && meta.fingerprint === fingerprint && (!meta.sizeBytes || meta.sizeBytes === st.size)
  } catch {
    return false
  }
}

function checkpointValid(cp: RenderArtifactCheckpoint | undefined): boolean {
  return !!cp && cp.status === 'completed' && artifactLooksValid(cp.artifactPath, cp.fingerprint)
}

function latestWorkspace(projectDir: string): string | null {
  const index = readCacheIndex(projectDir)
  const entries = Object.entries(index.workspaces).sort((a, b) => (b[1].lastUsedAt ?? '').localeCompare(a[1].lastUsedAt ?? ''))
  return entries[0]?.[0] ?? null
}

function paramsFromActive(active: ActiveRenderRecord | null): RenderResumeParams | null {
  if (active?.params?.voiceoverPath !== undefined) return active.params
  return null
}

export interface InspectOptions {
  /** Override the params used to compute the current fingerprint (defaults to the last render's params). */
  params?: RenderResumeParams
  /** Used only when there is no active-render record (e.g. pipeline options). */
  fallbackParams?: RenderResumeParams
}

export function inspectRenderRecovery(projectDir: string, opts: InspectOptions = {}): RenderRecoveryInfo {
  try {
    const root = getRenderCacheRoot(projectDir)
    if (!fs.existsSync(root)) return emptyInfo()

    const isActiveHere = renderJobCoordinator.isActive(projectDir)
    const active = reconcileActiveRender(projectDir, isActiveHere) ?? readActiveRender(projectDir)
    const workspaceName = active?.workspace ?? latestWorkspace(projectDir)
    const cacheSizeBytes = getRenderCacheSizeBytes(projectDir)
    if (!workspaceName) return emptyInfo({ cacheSizeBytes })

    const manifest = readManifest(path.join(root, workspaceName, 'manifest.json'))
    if (!manifest) return emptyInfo({ cacheSizeBytes })

    const resumeParams = opts.params ?? paramsFromActive(active) ?? opts.fallbackParams
    const invalidArtifacts: string[] = []

    // ── Compare with current inputs ──────────────────────────────────────────
    let fingerprintMatches = false
    let currentSceneFps: string[] | null = null
    let currentAssemblyFp: string | null = null
    if (resumeParams) {
      try {
        const prepared = prepareRenderPlan({
          projectDir,
          voiceoverPath: resumeParams.voiceoverPath,
          outputName: resumeParams.outputName,
          resolution: resumeParams.resolution,
          fps: resumeParams.fps,
          captionPlan: loadRenderCaptionPlan(projectDir),
          transitionSettings: resumeParams.transitionSettings,
          encoderKey: encoderKeyFor(manifest.settings.encoderMode, resumeParams.resolution, resumeParams.fps)
        })
        fingerprintMatches = prepared.renderFingerprint === manifest.renderFingerprint
        currentSceneFps = prepared.sceneJobs.map((j) => j.fingerprint)
        currentAssemblyFp = prepared.assemblyFingerprint
      } catch (err) {
        logger.warn(`[RenderRecovery] Could not compute current render fingerprint: ${String(err)}`)
      }
    }

    // ── Scenes ───────────────────────────────────────────────────────────────
    let completedScenes = 0
    let totalScenes = manifest.scenes.length
    if (currentSceneFps && !fingerprintMatches) {
      // Inputs changed: count scenes whose CURRENT fingerprint already has a cached clip
      totalScenes = currentSceneFps.length
      const index = readCacheIndex(projectDir)
      const byFp = new Map(manifest.scenes.map((s) => [s.fingerprint, s]))
      for (const fp of currentSceneFps) {
        const local = byFp.get(fp)
        if (local && checkpointValid(local)) { completedScenes++; continue }
        const entry = index.entries[fp]
        if (entry && artifactLooksValid(path.join(root, entry.path), fp)) completedScenes++
      }
    } else {
      for (const s of manifest.scenes) {
        if (s.status !== 'completed') continue
        if (checkpointValid(s)) completedScenes++
        else invalidArtifacts.push(s.artifactPath ?? `scene-${s.ordinal}`)
      }
    }

    // ── Downstream phases ────────────────────────────────────────────────────
    const assemblyStillValid = fingerprintMatches || (!!currentAssemblyFp && currentAssemblyFp === manifest.assembly.fingerprint)
    const statusOf = (cp: RenderArtifactCheckpoint | undefined, stillValid: boolean): string => {
      if (!cp || cp.status === 'pending' || cp.status === 'running') return 'pending'
      if (cp.status !== 'completed') return cp.status
      if (!stillValid) return 'invalid'
      if (!checkpointValid(cp)) {
        if (cp.artifactPath) invalidArtifacts.push(cp.artifactPath)
        return 'invalid'
      }
      return 'completed'
    }
    const assemblyStatus = statusOf(manifest.assembly, assemblyStillValid)
    const audioMixStatus = statusOf(manifest.audioMix, fingerprintMatches)
    // A composite equal to the audio mix (no overlay) has no own sidecar
    const compositeStatus =
      manifest.composite.artifactPath && manifest.composite.artifactPath === manifest.audioMix.artifactPath
        ? audioMixStatus
        : statusOf(manifest.composite, fingerprintMatches)

    let completedOverlayBlocks = 0
    const totalOverlayBlocks = manifest.overlayBlocks.length
    if (fingerprintMatches) {
      for (const b of manifest.overlayBlocks) {
        if (b.status !== 'completed') continue
        if (checkpointValid(b)) completedOverlayBlocks++
        else invalidArtifacts.push(b.artifactPath ?? `overlay-block-${b.blockIndex}`)
      }
    }

    // ── Final output ─────────────────────────────────────────────────────────
    const finalDone =
      manifest.status === 'completed' &&
      !!manifest.finalOutput?.artifactPath &&
      fs.existsSync(manifest.finalOutput.artifactPath)

    const sceneRatio = totalScenes > 0 ? completedScenes / totalScenes : 0
    const overlayRatio = totalOverlayBlocks > 0 ? completedOverlayBlocks / totalOverlayBlocks : (compositeStatus === 'completed' ? 1 : 0)
    const saved =
      PHASE_WEIGHTS.scenes * sceneRatio +
      PHASE_WEIGHTS.assembly * (assemblyStatus === 'completed' ? 1 : 0) +
      PHASE_WEIGHTS.audio * (audioMixStatus === 'completed' ? 1 : 0) +
      PHASE_WEIGHTS.overlay * overlayRatio +
      PHASE_WEIGHTS.composite * (compositeStatus === 'completed' ? 1 : 0)
    const estimatedWorkSavedPct = Math.round(Math.min(1, saved) * 100)

    const lastValidArtifact =
      compositeStatus === 'completed' ? manifest.composite.artifactPath
        : audioMixStatus === 'completed' ? manifest.audioMix.artifactPath
          : assemblyStatus === 'completed' ? manifest.assembly.artifactPath
            : [...manifest.scenes].reverse().find((s) => checkpointValid(s))?.artifactPath

    const hasCachedWork = completedScenes > 0 || assemblyStatus === 'completed'
    const isRunning = isActiveHere || active?.status === 'running'
    let status: RenderRecoveryInfo['status'] = 'none'
    if (isRunning) status = 'resuming'
    else if (finalDone && fingerprintMatches) status = 'complete'
    else if (hasCachedWork) status = fingerprintMatches || !resumeParams ? 'available' : 'partially-invalidated'

    const resumable = !isRunning && !(finalDone && fingerprintMatches) && hasCachedWork && !!resumeParams

    const prefs = loadRenderPreferences()
    const canAutoResume =
      resumable &&
      !!active &&
      active.status === 'interrupted' &&
      active.interruptionReason !== 'user-cancelled' &&
      active.source === 'pipeline' &&
      active.autoResumeAfterCrash !== false &&
      prefs.autoResumeAfterCrash &&
      (active.autoResumeCount ?? 0) < 1

    let message: string | undefined
    if (resumable && totalScenes > 0) {
      message = completedScenes >= totalScenes
        ? `Render interrupted — ${completedScenes}/${totalScenes} scenes cached\nResume from ${manifest.progress.currentPhase || 'the next checkpoint'}`
        : `Render interrupted — ${completedScenes}/${totalScenes} scenes cached\nResume from cached scene ${completedScenes + 1}`
    }

    return {
      manifestFound: true,
      resumable,
      fingerprintMatches,
      currentPhase: manifest.progress.currentPhase || manifest.status,
      completedScenes,
      totalScenes,
      completedOverlayBlocks,
      totalOverlayBlocks,
      lastValidArtifact,
      invalidArtifacts,
      status,
      assemblyStatus,
      audioMixStatus,
      compositeStatus,
      interruptionReason: active?.interruptionReason ?? manifest.interruptionReason,
      source: active?.source,
      canAutoResume,
      estimatedWorkSavedPct,
      cacheSizeBytes,
      message,
      resumeParams
    }
  } catch (err) {
    logger.warn(`[RenderRecovery] Inspection failed for ${projectDir}: ${String(err)}`)
    return emptyInfo()
  }
}
