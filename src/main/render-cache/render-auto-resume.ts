/**
 * render-auto-resume.ts
 *
 * Crash auto-resume for the Auto Production Pipeline's render stage.
 *
 * The app does not scan the disk at startup: the check runs when a project is
 * opened. If the last render of that project was an Auto Pipeline render that was
 * interrupted by a crash / app close / power loss (NOT a user cancel), the pipeline
 * is resumed exactly once. Manual renders are never auto-started — the Render
 * Recovery card offers "Resume Cached Render" instead.
 */

import * as path from 'path'
import { logger } from '../logger'
import { inspectRenderRecovery } from './render-recovery'
import { readActiveRender, writeActiveRender } from './render-cache-manager'
import { renderJobCoordinator } from './render-job-coordinator'

const attempted = new Set<string>()

function key(projectDir: string): string {
  return path.normalize(path.resolve(projectDir))
}

export interface AutoResumeDeps {
  /** Resumes the pipeline (injected to avoid an import cycle with the orchestrator). */
  resumePipeline: (projectDir: string) => Promise<unknown>
  /** Returns the persisted pipeline status, if any. */
  getPipelineStatus: (projectDir: string) => { overallStatus: string; stages: Record<string, { status: string }> } | null
  isPipelineActive: (projectDir: string) => boolean
}

/**
 * Decide and (if allowed) perform the one-time auto resume.
 * Returns true when a resume was started.
 */
export async function maybeAutoResumeRender(projectDir: string, deps: AutoResumeDeps): Promise<boolean> {
  const k = key(projectDir)
  if (attempted.has(k)) return false
  attempted.add(k)

  if (renderJobCoordinator.isActive(projectDir) || deps.isPipelineActive(projectDir)) return false

  const info = inspectRenderRecovery(projectDir)
  if (!info.canAutoResume) return false

  const pipeline = deps.getPipelineStatus(projectDir)
  if (!pipeline) return false
  const interrupted = pipeline.overallStatus === 'interrupted' || pipeline.overallStatus === 'running'
  const renderPending = pipeline.stages?.rendering?.status !== 'completed'
  if (!interrupted || !renderPending) return false

  // Consume the one-time budget BEFORE starting, so a crash during the resumed
  // render can never trigger an endless crash → resume loop.
  const rec = readActiveRender(projectDir)
  if (!rec || rec.status !== 'interrupted' || rec.interruptionReason === 'user-cancelled') return false
  rec.autoResumeCount = (rec.autoResumeCount ?? 0) + 1
  writeActiveRender(projectDir, rec)

  logger.info(
    `[RenderAutoResume] Resuming interrupted Auto Pipeline render for ${projectDir} ` +
    `(${info.completedScenes}/${info.totalScenes} scenes cached)`
  )
  try {
    await deps.resumePipeline(projectDir)
    return true
  } catch (err) {
    logger.warn(`[RenderAutoResume] Auto resume failed: ${String(err)}`)
    return false
  }
}

/** Schedules the check shortly after the project is opened (UI ready, non-blocking). */
export function scheduleRenderAutoResume(projectDir: string, deps: AutoResumeDeps, delayMs = 2000): void {
  const t = setTimeout(() => {
    void maybeAutoResumeRender(projectDir, deps).catch((err) =>
      logger.warn(`[RenderAutoResume] ${String(err)}`)
    )
  }, delayMs)
  t.unref?.()
}

export function resetAutoResumeForTests(): void {
  attempted.clear()
}
