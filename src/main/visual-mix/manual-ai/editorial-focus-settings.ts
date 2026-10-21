import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'

export const EDITORIAL_SETTINGS_SCHEMA_VERSION = 1 as const

export type EditorialPromptMode = 'classic' | 'embedded-editorial'
export type EditorialLabelDensity = 'minimal' | 'balanced'
export type EditorialReadability = 'standard' | 'senior-friendly'
export type EditorialRenderOverlayMode = 'full' | 'source-only'

export interface EditorialGenerationSettings {
  schemaVersion: 1
  promptMode: EditorialPromptMode
  labelDensity: EditorialLabelDensity
  readability: EditorialReadability
  preferLeaderLines: boolean
  renderOverlayMode: EditorialRenderOverlayMode
}

export const DEFAULT_EDITORIAL_SETTINGS: EditorialGenerationSettings = {
  schemaVersion: EDITORIAL_SETTINGS_SCHEMA_VERSION,
  promptMode: 'classic',
  labelDensity: 'minimal',
  readability: 'standard',
  preferLeaderLines: true,
  renderOverlayMode: 'full'
}

export function getEditorialFocusSettingsPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'editorial-focus-settings.v1.json')
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function validateSettings(raw: unknown): EditorialGenerationSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_EDITORIAL_SETTINGS }
  }
  const obj = raw as Record<string, unknown>

  const promptMode: EditorialPromptMode =
    obj.promptMode === 'embedded-editorial' ? 'embedded-editorial' : 'classic'

  const labelDensity: EditorialLabelDensity =
    obj.labelDensity === 'balanced' ? 'balanced' : 'minimal'

  const readability: EditorialReadability =
    obj.readability === 'senior-friendly' ? 'senior-friendly' : 'standard'

  const preferLeaderLines: boolean =
    typeof obj.preferLeaderLines === 'boolean' ? obj.preferLeaderLines : true

  const renderOverlayMode: EditorialRenderOverlayMode =
    obj.renderOverlayMode === 'source-only' ? 'source-only' : 'full'

  return {
    schemaVersion: EDITORIAL_SETTINGS_SCHEMA_VERSION,
    promptMode,
    labelDensity,
    readability,
    preferLeaderLines,
    renderOverlayMode
  }
}

export function loadEditorialFocusSettings(projectDir?: string): EditorialGenerationSettings {
  if (!projectDir) return { ...DEFAULT_EDITORIAL_SETTINGS }
  const settingsPath = getEditorialFocusSettingsPath(projectDir)
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULT_EDITORIAL_SETTINGS }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return validateSettings(raw)
  } catch (err) {
    logger.warn(`[EditorialSettings] Failed to parse ${settingsPath}, falling back to defaults: ${String(err)}`)
    return { ...DEFAULT_EDITORIAL_SETTINGS }
  }
}

export function saveEditorialFocusSettings(
  projectDir: string,
  settings: Partial<EditorialGenerationSettings>
): EditorialGenerationSettings {
  const current = loadEditorialFocusSettings(projectDir)
  const merged: EditorialGenerationSettings = validateSettings({
    ...current,
    ...settings,
    schemaVersion: EDITORIAL_SETTINGS_SCHEMA_VERSION
  })

  const settingsPath = getEditorialFocusSettingsPath(projectDir)
  writeFileAtomic(settingsPath, JSON.stringify(merged, null, 2))
  logger.info(`[EditorialSettings] Saved project editorial settings to ${settingsPath}`)
  return merged
}
