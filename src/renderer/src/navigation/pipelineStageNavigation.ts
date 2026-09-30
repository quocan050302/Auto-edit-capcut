import type { Page } from '../App'
import type { PipelineStage } from '../../../../shared/types'

/**
 * Bảng mapping chuẩn hóa 1-to-1 từ PipelineStage sang Page tương ứng trong App.tsx.
 * Tuyệt đối không cast mù stage thành Page.
 */
export const PIPELINE_STAGE_TO_PAGE: Record<PipelineStage, Page> = {
  idle: 'input',
  validating: 'input',
  transcribing: 'transcribe',
  planning: 'planning',
  captions: 'captions',
  'global-context': 'stock',
  'stock-search': 'stock',
  'audio-search': 'audio',
  preflight: 'render',
  rendering: 'render',
  postflight: 'render',
  completed: 'render',
  'needs-attention': 'stock',
  cancelled: 'production',
  failed: 'production'
}

/**
 * Lấy Page tương ứng cho một PipelineStage.
 * Đảm bảo luôn trả về một Page hợp lệ được định nghĩa trong App.tsx.
 */
export function getPageForPipelineStage(stage: PipelineStage | string | null | undefined): Page {
  if (!stage) return 'production'
  if (stage in PIPELINE_STAGE_TO_PAGE) {
    return PIPELINE_STAGE_TO_PAGE[stage as PipelineStage]
  }
  return 'production'
}

export interface StageDescriptionMeta {
  title: string
  friendlyAction: string
  description: string
  stageNumber: number
  totalStages: number
  workspacePageTitle: string
}

export const STAGE_DESCRIPTIONS: Record<string, StageDescriptionMeta> = {
  validating: {
    title: 'Validate Inputs',
    friendlyAction: 'Checking files and settings',
    description: 'Ensuring your script, voiceover audio, settings, and media assets are valid and ready for production.',
    stageNumber: 1,
    totalStages: 10,
    workspacePageTitle: 'Setup & Input'
  },
  transcribing: {
    title: 'Transcription',
    friendlyAction: 'Converting voiceover into timed text',
    description: 'Generating word-level accurate timestamps from your voiceover audio for precise scene timing and captions.',
    stageNumber: 2,
    totalStages: 10,
    workspacePageTitle: 'Transcription Workspace'
  },
  planning: {
    title: 'AI Planning',
    friendlyAction: 'Building chapters, sequences and scenes',
    description: 'Structuring your narrative into cohesive chapters, dynamic sequences, and visual scenes.',
    stageNumber: 3,
    totalStages: 10,
    workspacePageTitle: 'AI Planning Workspace'
  },
  captions: {
    title: 'Dynamic Captions',
    friendlyAction: 'Creating timed dynamic captions',
    description: 'Styling, timing, and animating retention-focused word highlights and subtitle phrases.',
    stageNumber: 4,
    totalStages: 10,
    workspacePageTitle: 'Captions Studio'
  },
  'global-context': {
    title: 'Global Visual Context',
    friendlyAction: 'Understanding the full visual story',
    description: 'Extracting key themes, locations, characters, and tonal mood to guide accurate footage searches.',
    stageNumber: 5,
    totalStages: 10,
    workspacePageTitle: 'Stock Media Workspace'
  },
  'stock-search': {
    title: 'Stock Search & Ranking',
    friendlyAction: 'Finding, ranking and downloading footage',
    description: 'Querying footage providers, scoring candidate visual relevance, and downloading high-resolution assets.',
    stageNumber: 6,
    totalStages: 10,
    workspacePageTitle: 'Stock Media Workspace'
  },
  'audio-search': {
    title: 'Background Music & SFX',
    friendlyAction: 'Matching background music and sound effects',
    description: 'Selecting cinematic musical tracks, ducking levels, and placing sound effects on key narrative beats.',
    stageNumber: 7,
    totalStages: 10,
    workspacePageTitle: 'Audio Director'
  },
  preflight: {
    title: 'Render Preflight QA',
    friendlyAction: 'Checking media, captions, audio and transitions',
    description: 'Running automated quality assurance checks on all clips, audio streams, and dimensions prior to render.',
    stageNumber: 8,
    totalStages: 10,
    workspacePageTitle: 'Render & Export'
  },
  rendering: {
    title: 'Rendering Video',
    friendlyAction: 'Building the final video',
    description: 'Encoding video frames, applying transitions, compositing captions overlays, and mixing final audio tracks.',
    stageNumber: 9,
    totalStages: 10,
    workspacePageTitle: 'Render & Export'
  },
  postflight: {
    title: 'Postflight QA',
    friendlyAction: 'Verifying the finished output',
    description: 'Validating the final output file integrity, audio sync, frame count, and export specifications.',
    stageNumber: 10,
    totalStages: 10,
    workspacePageTitle: 'Render & Export'
  }
}
