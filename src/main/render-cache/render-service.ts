/**
 * render-service.ts
 *
 * Single entry point used by BOTH Manual Render (Step 4 IPC) and the Auto Production
 * Pipeline. Every render goes through the project-level RenderJobCoordinator so a
 * project can never have two FFmpeg/Remotion render trees at the same time.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { renderVideo, computeRenderRequestKey, type RenderVideoParams, type RenderResult, type RenderProgress } from '../renderer'
import { renderJobCoordinator, type RenderJobSource } from './render-job-coordinator'
import type { CaptionPlan } from '../../../shared/types'

export type CoordinatedRenderParams = Omit<RenderVideoParams, 'signal' | 'getCancelReason' | 'onProgress'> & {
  onProgress?: (p: RenderProgress) => void
  /** Upstream cancel signal (e.g. pipeline cancel) linked to the render job */
  externalSignal?: AbortSignal
  jobSource?: RenderJobSource
}

/**
 * Loads caption-plan.json exactly like the legacy Render IPC did: only an enabled
 * plan with phrases is burned in, otherwise captions are skipped.
 */
export function loadRenderCaptionPlan(projectDir: string): CaptionPlan | undefined {
  const captionPlanPath = path.join(projectDir, 'analysis', 'caption-plan.json')
  if (!fs.existsSync(captionPlanPath)) return undefined
  try {
    const loaded = JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8')) as CaptionPlan
    if (loaded.enabled && (loaded.phrases?.length ?? 0) > 0) return loaded
  } catch (e) {
    logger.warn(`[RenderService] Could not read caption-plan.json: ${String(e)}`)
  }
  return undefined
}

/**
 * Start (or attach to) the project's render job.
 * Same request → attaches to the running job; different request → RenderBusyError.
 */
export function startCoordinatedRender(params: CoordinatedRenderParams): { promise: Promise<RenderResult>; attached: boolean } {
  const { onProgress, externalSignal, jobSource, ...renderParams } = params
  const requestKey = computeRenderRequestKey(renderParams)
  return renderJobCoordinator.run<RenderResult>({
    projectDir: params.projectDir,
    requestKey,
    source: jobSource ?? params.source ?? 'manual',
    listener: onProgress
      ? (p) => onProgress({ stage: p.stage, progress: p.progress, sceneIndex: p.sceneIndex, totalScenes: p.totalScenes })
      : undefined,
    externalSignal,
    starter: (signal, emit) =>
      renderVideo({
        ...renderParams,
        signal,
        getCancelReason: () => renderJobCoordinator.getCancelReason(params.projectDir),
        onProgress: (p) => emit({ stage: p.stage, progress: p.progress, sceneIndex: p.sceneIndex, totalScenes: p.totalScenes })
      })
  })
}
