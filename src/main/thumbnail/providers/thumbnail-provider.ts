import type { ThumbnailProviderHealth } from '../../../../shared/types'

export interface ThumbnailGenerateRequest {
  prompt: string
  projectId?: string
  imageModel?: string
  aspectRatio?: '16:9' | 'IMAGE_ASPECT_RATIO_LANDSCAPE'
  candidateId: string
  optionId: 'A' | 'B' | 'C' | 'D' | 'E'
}

export interface ThumbnailGenerateResult {
  mediaId: string
  projectId: string
  fifeUrl?: string
  raw?: unknown
}

export interface ThumbnailExportRequest {
  mediaId: string
  projectId?: string
  quality: '4k' | '2k'
  fallbackToOriginalUrl?: string
  destinationPath: string
}

export interface ThumbnailExportResult {
  filePath: string
  fileSize: number
  width: number
  height: number
  actualQuality: 'native-4k' | '2k-fallback' | 'original-fallback'
  is4kPlanGated?: boolean
  error?: string
}

export interface ThumbnailImageProvider {
  name: string
  healthCheck(bridgeUrl?: string): Promise<ThumbnailProviderHealth>
  generateImage(request: ThumbnailGenerateRequest): Promise<ThumbnailGenerateResult>
  exportImage(request: ThumbnailExportRequest): Promise<ThumbnailExportResult>
}
