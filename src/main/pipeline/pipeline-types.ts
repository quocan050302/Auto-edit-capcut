export * from '../../../shared/types'

import type { PipelineStage } from '../../../shared/types'

export const PIPELINE_SCHEMA_VERSION = 1

/**
 * Thứ tự các stage trong Auto Production Pipeline:
 * 1. validating
 * 2. transcribing
 * 3. planning
 * 4. captions
 * 5. global-context
 * 6. stock-search
 * 7. audio-search
 * 8. preflight
 * 9. rendering
 * 10. postflight
 */
export const PIPELINE_EXECUTION_STAGES: readonly PipelineStage[] = [
  'validating',
  'transcribing',
  'planning',
  'captions',
  'global-context',
  'stock-search',
  'audio-search',
  'preflight',
  'rendering',
  'postflight'
] as const

export const STAGE_DISPLAY_NAMES: Record<PipelineStage, string> = {
  'idle': 'Idle',
  'validating': 'Validate Inputs',
  'transcribing': 'Transcription',
  'planning': 'AI Planning',
  'captions': 'Dynamic Captions',
  'global-context': 'Global Visual Context',
  'stock-search': 'Stock Media Search & Ranking',
  'audio-search': 'Background Music & SFX',
  'preflight': 'Render Preflight QA',
  'rendering': 'Rendering Video',
  'postflight': 'Postflight QA',
  'completed': 'Completed',
  'needs-attention': 'Needs Attention',
  'cancelled': 'Cancelled',
  'failed': 'Failed'
}

/** Mapping mỗi stage với trang UI tương ứng */
export const STAGE_NAV_TARGETS: Partial<Record<PipelineStage, string>> = {
  'transcribing': 'transcribe',
  'planning': 'planning',
  'captions': 'captions',
  'global-context': 'stock',
  'stock-search': 'stock',
  'audio-search': 'audio',
  'preflight': 'render',
  'rendering': 'render',
  'postflight': 'render',
  'completed': 'render'
}
