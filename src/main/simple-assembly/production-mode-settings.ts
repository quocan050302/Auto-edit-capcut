import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import {
  DEFAULT_PRODUCTION_MODE_SETTINGS,
  type VideoProductionModeSettings,
  type VideoAssemblyMode,
  type BackgroundMusicMode,
  type ShortClipPolicy
} from './simple-assembly-types'

export const PRODUCTION_MODE_SETTINGS_SCHEMA_VERSION = 1 as const

export function getProductionModeSettingsPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'production-mode-settings.v1.json')
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function validateProductionModeSettings(raw: unknown): VideoProductionModeSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PRODUCTION_MODE_SETTINGS }
  }
  const obj = raw as Record<string, unknown>

  const assemblyMode: VideoAssemblyMode =
    obj.assemblyMode === 'simple-assembly' ? 'simple-assembly' : 'full-production'

  const backgroundMusicMode: BackgroundMusicMode =
    obj.backgroundMusicMode === 'off' ? 'off' : 'auto'

  const shortClipPolicy: ShortClipPolicy =
    obj.shortClipPolicy === 'freeze-last-frame' ? 'freeze-last-frame' : 'freeze-last-frame'

  return {
    schemaVersion: PRODUCTION_MODE_SETTINGS_SCHEMA_VERSION,
    assemblyMode,
    backgroundMusicMode,
    shortClipPolicy
  }
}

export function loadProductionModeSettings(projectDir?: string): VideoProductionModeSettings {
  if (!projectDir) return { ...DEFAULT_PRODUCTION_MODE_SETTINGS }
  const settingsPath = getProductionModeSettingsPath(projectDir)
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULT_PRODUCTION_MODE_SETTINGS }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return validateProductionModeSettings(raw)
  } catch (err) {
    logger.warn(`[ProductionModeSettings] Failed to parse ${settingsPath}, falling back to defaults: ${String(err)}`)
    return { ...DEFAULT_PRODUCTION_MODE_SETTINGS }
  }
}

export function saveProductionModeSettings(
  projectDir: string,
  settings: Partial<VideoProductionModeSettings>
): VideoProductionModeSettings {
  const current = loadProductionModeSettings(projectDir)
  const merged: VideoProductionModeSettings = validateProductionModeSettings({
    ...current,
    ...settings,
    schemaVersion: PRODUCTION_MODE_SETTINGS_SCHEMA_VERSION
  })

  const settingsPath = getProductionModeSettingsPath(projectDir)
  try {
    writeFileAtomic(settingsPath, JSON.stringify(merged, null, 2))
    logger.info(`[ProductionModeSettings] Saved settings to ${settingsPath}: assemblyMode=${merged.assemblyMode} musicMode=${merged.backgroundMusicMode}`)
  } catch (err) {
    logger.error(`[ProductionModeSettings] Failed saving ${settingsPath}: ${String(err)}`)
    throw err
  }
  return merged
}
