import * as fs from 'fs'
import * as path from 'path'
import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { logger } from '../logger'
import { readJsonSafe } from '../production-intelligence/json-store'
import { thumbnailAutoTrigger } from '../thumbnail/thumbnail-auto-trigger'
import type { CaptionPlan, RenderTransitionSettings, RenderQaReport, RenderPreferencesDTO } from '../../../shared/types'
import { runRenderPreflightCached } from '../render-cache/preflight-cache'
import { startCoordinatedRender, loadRenderCaptionPlan } from '../render-cache/render-service'
import { renderJobCoordinator, RenderBusyError } from '../render-cache/render-job-coordinator'
import { inspectRenderRecovery } from '../render-cache/render-recovery'
import { clearRenderCache, getRenderCacheSizeBytes, readActiveRender } from '../render-cache/render-cache-manager'
import { loadRenderPreferences, saveRenderPreferences } from '../render-cache/render-preferences'
import { probeVideoToolbox } from '../render-cache/video-encoder'
import { isRenderCancelledError } from '../render-cache/ffmpeg-process'
import type { RenderResult } from '../renderer'

type ProgressPayload = {
  stage: string
  sceneIndex?: number
  totalScenes?: number
  progress: number
}

function progressSender(event: Electron.IpcMainInvokeEvent): (p: ProgressPayload) => void {
  const win = BrowserWindow.fromWebContents(event.sender)
  return (p) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.RENDER_PROGRESS, p)
  }
}

async function awaitRenderAndTriggerThumbnail(
  projectDir: string,
  promise: Promise<RenderResult>
): Promise<{ success: boolean; result?: RenderResult; error?: string; cancelled?: boolean }> {
  try {
    const result = await promise
    // Thumbnail only after a validated, atomically published final output
    // (thumbnailAutoTrigger is idempotent per output file, so it never runs twice).
    if (result && result.outputPath && fs.existsSync(result.outputPath)) {
      void thumbnailAutoTrigger.startIfEligible({
        projectDir,
        renderOutputPath: result.outputPath
      })
    }
    return { success: true, result }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isRenderCancelledError(err)) {
      logger.info(`Render stopped: ${msg}`)
      return { success: false, error: msg, cancelled: true }
    }
    logger.error(`Render failed: ${msg}`)
    return { success: false, error: msg }
  }
}

export function registerRenderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.RENDER_START,
    async (event, params: {
      projectDir: string
      voiceoverPath: string
      outputName?: string
      resolution?: { width: number; height: number }
      fps?: number
      transitionSettings?: RenderTransitionSettings
    }) => {
      const sendProgress = progressSender(event)

      try {
        // Load caption plan nếu đã generate (optional — không làm hỏng render nếu không có)
        const captionPlan: CaptionPlan | undefined = loadRenderCaptionPlan(params.projectDir)
        if (captionPlan) {
          logger.info(`[RenderIPC] Caption plan loaded: ${captionPlan.phrases.length} phrases, enabled=${captionPlan.enabled}`)
        } else {
          logger.info('[RenderIPC] No enabled caption plan -- skipping caption burn')
        }

        // Project-level render mutex: a double click / second window attaches to the
        // running job instead of spawning a second FFmpeg tree.
        const { promise, attached } = startCoordinatedRender({
          ...params,
          captionPlan,        // truyền vào renderer — undefined = bỏ qua burn step
          source: 'manual',
          onProgress: sendProgress
        })
        if (attached) logger.info('[RenderIPC] Render already running for this project — attached to existing job')
        return await awaitRenderAndTriggerThumbnail(params.projectDir, promise)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (err instanceof RenderBusyError) logger.warn(`[RenderIPC] ${msg}`)
        else logger.error(`Render failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Cancel (user) — completed cache artifacts are kept ─────────────────────
  ipcMain.handle(IPC_CHANNELS.RENDER_CANCEL, (_event, params: { projectDir: string }) => {
    const cancelled = renderJobCoordinator.cancel(params.projectDir, 'user-cancelled')
    return { success: cancelled }
  })

  // ── Render recovery info (for the Render Recovery card) ────────────────────
  ipcMain.handle(IPC_CHANNELS.RENDER_RECOVERY_GET, (_event, params: { projectDir: string }) => {
    const info = inspectRenderRecovery(params.projectDir)
    const active = renderJobCoordinator.getActiveInfo(params.projectDir)
    return { ...info, activeProgress: active?.lastProgress ?? null, activeSource: active?.source ?? null }
  })

  // ── Resume cached render (same settings as the interrupted render) ─────────
  ipcMain.handle(IPC_CHANNELS.RENDER_RESUME_CACHED, async (event, params: { projectDir: string }) => {
    const sendProgress = progressSender(event)
    try {
      const info = inspectRenderRecovery(params.projectDir)
      if (!info.resumeParams) {
        return { success: false, error: 'No interrupted render found to resume.' }
      }
      const { promise } = startCoordinatedRender({
        projectDir: params.projectDir,
        ...info.resumeParams,
        captionPlan: loadRenderCaptionPlan(params.projectDir),
        source: 'manual',
        onProgress: sendProgress
      })
      return await awaitRenderAndTriggerThumbnail(params.projectDir, promise)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[RenderIPC] Resume failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // ── Clear render cache (never while a render is active) ────────────────────
  ipcMain.handle(IPC_CHANNELS.RENDER_CACHE_CLEAR, (_event, params: { projectDir: string }) => {
    if (renderJobCoordinator.isActive(params.projectDir) || readActiveRender(params.projectDir)?.status === 'running') {
      return { success: false, error: 'A render is currently active for this project. Cancel it before clearing the cache.' }
    }
    try {
      const removed = clearRenderCache(params.projectDir)
      logger.info(`[RenderIPC] Cleared render cache for ${params.projectDir} (${removed} entries)`)
      return { success: true, removed, cacheSizeBytes: getRenderCacheSizeBytes(params.projectDir) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Render preferences (resource profile / encoder / auto-resume) ──────────
  ipcMain.handle(IPC_CHANNELS.RENDER_PREFERENCES_GET, () => loadRenderPreferences())
  ipcMain.handle(IPC_CHANNELS.RENDER_PREFERENCES_SET, (_event, patch: Partial<RenderPreferencesDTO>) => saveRenderPreferences(patch))

  // ── Apple VideoToolbox probe (real sample encode, not just the encoder list) ─
  ipcMain.handle(IPC_CHANNELS.RENDER_ENCODER_PROBE, async (_event, params?: { force?: boolean }) => {
    if (process.platform !== 'darwin') return { ok: false, reason: 'Apple VideoToolbox is only available on macOS.' }
    return probeVideoToolbox(!!params?.force)
  })

  // ── Preflight QA ────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RENDER_PREFLIGHT_RUN,
    async (event, params: { projectDir: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      win?.webContents.send(IPC_CHANNELS.RENDER_QA_PROGRESS, {
        stage: 'preflight',
        progress: 0.2,
        message: 'Running preflight checks...'
      })

      let captionPlan: CaptionPlan | undefined = undefined
      const captionPlanPath = path.join(params.projectDir, 'analysis', 'caption-plan.json')
      if (fs.existsSync(captionPlanPath)) {
        try {
          captionPlan = JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8'))
        } catch { /* ignore */ }
      }

      let voiceoverPath: string | undefined
      try {
        const stateFile = fs.existsSync(path.join(params.projectDir, 'project-state.json'))
          ? path.join(params.projectDir, 'project-state.json')
          : path.join(params.projectDir, 'project.json')
        if (fs.existsSync(stateFile)) {
          const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
          voiceoverPath = st?.inputs?.voiceoverPath
        }
      } catch { /* ignore */ }

      // Always re-run when the user asks; the fingerprint stored alongside lets the
      // render that follows reuse this report instead of running preflight twice.
      const { report } = await runRenderPreflightCached({
        projectDir: params.projectDir,
        voiceoverPath,
        captionPlan
      }, { force: true })

      win?.webContents.send(IPC_CHANNELS.RENDER_QA_PROGRESS, {
        stage: 'preflight',
        progress: 1.0,
        message: `Preflight completed: ${report.status}`
      })

      return report
    }
  )

  // ── QA Report Get ───────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RENDER_QA_GET,
    (_event, params: { projectDir: string }) => {
      const qaPath = path.join(params.projectDir, 'analysis', 'render-qa.json')
      const preflightPath = path.join(params.projectDir, 'analysis', 'render-preflight.json')
      if (fs.existsSync(qaPath)) {
        return readJsonSafe<RenderQaReport | null>(qaPath, null)
      }
      if (fs.existsSync(preflightPath)) {
        return readJsonSafe<RenderQaReport | null>(preflightPath, null)
      }
      return null
    }
  )
}

