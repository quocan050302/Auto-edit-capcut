import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import type { AudioPlan } from '../../../shared/types'
import {
  runAudioDirector,
  downloadApprovedAudio,
  loadAudioPlan,
  saveAudioPlan
} from '../audio/audio-director'
import { logger } from '../logger'

export function registerAudioHandlers(ipcMain: IpcMain): void {

  // ── Run full audio search pipeline ──────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_SEARCH_START,
    async (event, params: { projectDir: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, { message, progress })
      }

      try {
        const result = await runAudioDirector(params.projectDir, sendProgress)
        return result
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[AudioIPC] Search error: ${msg}`)
        return { success: false, error: msg, sections: [], sfxAssignments: [] }
      }
    }
  )

  // ── Get current audio plan ───────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.AUDIO_PLAN_GET, (_event, projectDir: string) => {
    return loadAudioPlan(projectDir)
  })

  // ── Save full audio plan ─────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_PLAN_SAVE,
    (_event, params: { projectDir: string; plan: AudioPlan }) => {
      try {
        saveAudioPlan(params.projectDir, params.plan)
        return { success: true }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // ── Approve/reject a music section ───────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_APPROVE_SECTION,
    (_event, params: { projectDir: string; sectionId: string; approved: boolean; volumeDb?: number; fadeInSecs?: number; fadeOutSecs?: number }) => {
      const plan = loadAudioPlan(params.projectDir)
      if (!plan) return { success: false, error: 'No audio plan found' }

      const section = plan.sections.find((s) => s.sectionId === params.sectionId)
      if (!section) return { success: false, error: 'Section not found' }

      section.approved = params.approved
      if (params.volumeDb !== undefined) section.volumeDb = params.volumeDb
      if (params.fadeInSecs !== undefined) section.fadeInSecs = params.fadeInSecs
      if (params.fadeOutSecs !== undefined) section.fadeOutSecs = params.fadeOutSecs

      saveAudioPlan(params.projectDir, plan)
      return { success: true, plan }
    }
  )

  // ── Approve/reject an SFX assignment ─────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_APPROVE_SFX,
    (_event, params: { projectDir: string; sceneIndex: number; approved: boolean; volumeDb?: number }) => {
      const plan = loadAudioPlan(params.projectDir)
      if (!plan) return { success: false, error: 'No audio plan found' }

      const sfx = plan.sfxAssignments.find((s) => s.sceneIndex === params.sceneIndex)
      if (!sfx) return { success: false, error: 'SFX assignment not found' }

      sfx.approved = params.approved
      if (params.volumeDb !== undefined) sfx.volumeDb = params.volumeDb

      saveAudioPlan(params.projectDir, plan)
      return { success: true, plan }
    }
  )

  // ── Download all approved audio ──────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_DOWNLOAD_APPROVED,
    async (event, params: { projectDir: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const plan = loadAudioPlan(params.projectDir)
      if (!plan) return { success: false, error: 'No audio plan found' }

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, { message, progress })
      }

      try {
        const updatedPlan = await downloadApprovedAudio(params.projectDir, plan, sendProgress)
        return { success: true, plan: updatedPlan }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[AudioIPC] Download error: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )
}
