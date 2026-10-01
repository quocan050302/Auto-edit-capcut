import {
  ThumbnailImageProvider,
  ThumbnailGenerateRequest,
  ThumbnailGenerateResult,
  ThumbnailExportRequest,
  ThumbnailExportResult
} from './thumbnail-provider'
import { googleFlowClient, GoogleFlowClient } from '../google-flow-client'
import type { ThumbnailProviderHealth } from '../../../../shared/types'

export class GoogleFlowProvider implements ThumbnailImageProvider {
  public readonly name = 'google-flow'
  private client: GoogleFlowClient

  constructor(client?: GoogleFlowClient) {
    this.client = client || googleFlowClient
  }

  public async healthCheck(bridgeUrl?: string): Promise<ThumbnailProviderHealth> {
    if (bridgeUrl) {
      this.client.setBridgeUrl(bridgeUrl)
    }
    return this.client.checkHealth()
  }

  public async generateImage(request: ThumbnailGenerateRequest): Promise<ThumbnailGenerateResult> {
    return this.client.generateImage(request)
  }

  public async exportImage(request: ThumbnailExportRequest): Promise<ThumbnailExportResult> {
    return this.client.exportImage(request)
  }
}

export const googleFlowProvider = new GoogleFlowProvider()
