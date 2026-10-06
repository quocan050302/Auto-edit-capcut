import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../../shared/types'
import type { ManualAiStatus } from '../../../../shared/types'
import { logger } from '../../logger'
import { normalizeProjectDir } from '../../pipeline/pipeline-state'
import {
  getManualAiPromptJsonPath,
  getManualAiPromptTxtPath
} from './manual-ai-types'
import { evaluateManualAiStatusForProject } from './manual-ai-validator'

/**
 * Single centralized evaluator of Manual AI status for a project directory.
 * Always normalizes projectDir before reading artifacts.
 */
export function getManualAiStatus(projectDir: string): ManualAiStatus {
  const norm = normalizeProjectDir(projectDir)
  const status = evaluateManualAiStatusForProject(norm)

  const jsonExists = fs.existsSync(getManualAiPromptJsonPath(norm))
  const txtExists = fs.existsSync(getManualAiPromptTxtPath(norm))

  logger.debug(
    `[ManualAI:Status] projectDir=${norm} promptJsonExists=${jsonExists} promptTxtExists=${txtExists} expected=${status.expected} ready=${status.ready}`
  )

  return status
}

/**
 * Reusable broadcaster that pushes MANUAL_AI_STATUS_UPDATED to all open BrowserWindow instances.
 * Safe to call in environments without BrowserWindow (CLI, unit tests).
 */
export function broadcastManualAiStatus(
  projectDir: string,
  status?: ManualAiStatus
): ManualAiStatus {
  const norm = normalizeProjectDir(projectDir)
  const s = status ?? getManualAiStatus(norm)

  try {
    if (typeof BrowserWindow !== 'undefined' && typeof BrowserWindow.getAllWindows === 'function') {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.MANUAL_AI_STATUS_UPDATED, {
            projectDir: norm,
            status: s
          })
        }
      }
    }
  } catch (err) {
    logger.debug(`[ManualAI] BrowserWindow broadcast skipped or failed: ${String(err)}`)
  }

  return s
}
