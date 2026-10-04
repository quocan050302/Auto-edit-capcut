export * from '../../../shared/types'
import type {
  HealthVisualPlan,
  HealthVisualScenePlan,
  HealthVisualConfig,
  HealthMotionPreset,
  HealthMotionSpec,
  HealthSfxType,
  HealthSfxCuePlan,
  HealthMotionReport
} from '../../../shared/types'

export const HEALTH_SCHEMA_VERSION = 1

export const DEFAULT_HEALTH_CONFIG: Required<HealthVisualConfig> = {
  aiRatio: 0.8,
  stockRatio: 0.2,
  width: 1920,
  height: 1080,
  motionEnabled: true
}
