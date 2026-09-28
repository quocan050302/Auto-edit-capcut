import * as path from 'path'
import * as fs from 'fs'
import {
  type ProductionIntelligenceSettings,
  DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS
} from '../../../shared/types'
import { loadConfig, saveConfig } from '../config'
import { atomicReadJson, atomicWriteJson } from './json-store'
import { logger } from '../logger'

export function getProjectSettingsPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'production-settings.json')
}

export function loadProductionSettings(projectDir?: string): ProductionIntelligenceSettings {
  // 1. Try project-specific settings file first
  if (projectDir) {
    const projectSettingsPath = getProjectSettingsPath(projectDir)
    if (fs.existsSync(projectSettingsPath)) {
      const projectSettings = atomicReadJson<Partial<ProductionIntelligenceSettings>>(
        projectSettingsPath,
        {}
      )
      return {
        ...DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS,
        ...projectSettings
      }
    }
  }

  // 2. Try global config
  try {
    const config = loadConfig() as { productionIntelligenceSettings?: Partial<ProductionIntelligenceSettings> }
    if (config.productionIntelligenceSettings) {
      return {
        ...DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS,
        ...config.productionIntelligenceSettings
      }
    }
  } catch (err) {
    logger.warn(`[ProductionSettings] Error reading global config: ${String(err)}`)
  }

  // 3. Fallback to default
  return { ...DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS }
}

export function saveProductionSettings(
  settings: Partial<ProductionIntelligenceSettings>,
  projectDir?: string
): ProductionIntelligenceSettings {
  const current = loadProductionSettings(projectDir)
  const updated: ProductionIntelligenceSettings = {
    ...current,
    ...settings
  }

  // 1. If projectDir is supplied, save to project analysis folder
  if (projectDir) {
    const projectSettingsPath = getProjectSettingsPath(projectDir)
    try {
      atomicWriteJson(projectSettingsPath, updated)
      logger.info(`[ProductionSettings] Saved project settings: ${projectSettingsPath}`)
    } catch (err) {
      logger.error(`[ProductionSettings] Failed saving project settings: ${String(err)}`)
    }
  }

  // 2. Also save to global app config
  try {
    const config = loadConfig() as Record<string, unknown>
    config.productionIntelligenceSettings = updated
    saveConfig(config)
  } catch (err) {
    logger.warn(`[ProductionSettings] Failed saving to global config: ${String(err)}`)
  }

  return updated
}
