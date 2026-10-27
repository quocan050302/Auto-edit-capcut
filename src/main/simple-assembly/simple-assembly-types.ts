import {
  type BackgroundMusicMode,
  type VideoAssemblyMode,
  type ShortClipPolicy,
  type VideoProductionModeSettings,
  type SimpleAssemblyProgressPayload,
  type SimpleAssemblyResult,
  type SimpleAssemblySceneInput,
  type SimpleAssemblySceneInfo,
  DEFAULT_PRODUCTION_MODE_SETTINGS
} from '../../../shared/types'

export {
  DEFAULT_PRODUCTION_MODE_SETTINGS,
  type BackgroundMusicMode,
  type VideoAssemblyMode,
  type ShortClipPolicy,
  type VideoProductionModeSettings,
  type SimpleAssemblyProgressPayload,
  type SimpleAssemblyResult,
  type SimpleAssemblySceneInput,
  type SimpleAssemblySceneInfo
}

export interface SimpleAssemblyRequest {
  projectDir: string
  voiceoverPath: string
  sceneSources?: SimpleAssemblySceneInput[]
  sceneFolder?: string | null
  backgroundMusicMode: BackgroundMusicMode
  musicFilePath?: string | null
  outputName?: string
  width?: number
  height?: number
  fps?: number
  shortClipPolicy?: ShortClipPolicy
  signal?: AbortSignal
  onProgress?: (progress: SimpleAssemblyProgressPayload) => void
}

export interface SimpleAssemblyValidationReport {
  valid: boolean
  scenes: SimpleAssemblySceneInput[]
  missingScenes: number[]
  unreadableFiles: Array<{ filePath: string; reason: string }>
  voiceoverDuration: number
  totalAllocatedDuration: number
  warnings: string[]
}
