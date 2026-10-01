import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { probeImageDimensions } from './utils/image-probe'
import type {
  ThumbnailProviderHealth,
  ThumbnailGenerateRequest,
  ThumbnailGenerateResult,
  ThumbnailExportRequest,
  ThumbnailExportResult
} from '../../../../shared/types'

export const DEFAULT_FLOWKIT_BRIDGE_URL = 'http://127.0.0.1:8100'

export interface FlowKitErrorResponse {
  status?: number
  error?: string
  detail?: string | unknown
  reason?: string
}

export class GoogleFlowClient {
  private bridgeUrl: string

  constructor(bridgeUrl?: string) {
    this.bridgeUrl = (bridgeUrl || DEFAULT_FLOWKIT_BRIDGE_URL).replace(/\/+$/, '')
  }

  public setBridgeUrl(url: string): void {
    this.bridgeUrl = (url || DEFAULT_FLOWKIT_BRIDGE_URL).replace(/\/+$/, '')
  }

  public getBridgeUrl(): string {
    return this.bridgeUrl
  }

  public async checkHealth(): Promise<ThumbnailProviderHealth> {
    const health: ThumbnailProviderHealth = {
      reachable: false,
      providerAvailable: false,
      extensionConnected: false,
      signedIn: false,
      supportsImageGeneration: false,
      requestedExportQuality: '4k',
      message: 'Checking connection...'
    }

    try {
      // 1. Check bridge server /health
      const healthResp = await this.fetchWithTimeout(`${this.bridgeUrl}/health`, { method: 'GET' }, 3000)
      if (!healthResp.ok) {
        health.message = `FlowKit bridge responded with status ${healthResp.status}`
        return health
      }
      health.reachable = true
      const healthData = (await healthResp.json()) as { extension_connected?: boolean; version?: string }
      health.extensionConnected = Boolean(healthData.extension_connected)

      // 2. Check /api/flow/status
      try {
        const flowStatusResp = await this.fetchWithTimeout(`${this.bridgeUrl}/api/flow/status`, { method: 'GET' }, 3000)
        if (flowStatusResp.ok) {
          const flowData = (await flowStatusResp.json()) as {
            connected?: boolean
            flow_project_id?: string
            generation_throttle?: { min_interval_s?: number; cooldown_active?: boolean }
            session_project?: { project_id?: string }
          }
          if (flowData.connected) {
            health.extensionConnected = true
          }
          health.details = {
            version: healthData.version,
            flowProjectId: flowData.flow_project_id || flowData.session_project?.project_id,
            generationThrottle: flowData.generation_throttle
          }
        }
      } catch (err) {
        logger.debug(`[GoogleFlowClient] /api/flow/status check notice: ${err}`)
      }

      // 3. Check /api/providers/status
      try {
        const provResp = await this.fetchWithTimeout(`${this.bridgeUrl}/api/providers/status`, { method: 'GET' }, 3000)
        if (provResp.ok) {
          const provs = (await provResp.json()) as Array<{
            name: string
            available: boolean
            capabilities?: { generate_image?: boolean }
          }>
          const flowProv = provs.find((p) => p.name === 'flow')
          if (flowProv) {
            health.providerAvailable = flowProv.available
            health.supportsImageGeneration = Boolean(flowProv.capabilities?.generate_image)
          }
        }
      } catch (err) {
        logger.debug(`[GoogleFlowClient] /api/providers/status check notice: ${err}`)
      }

      // 4. Check /api/flow/credits to verify Google Flow sign-in status
      if (health.extensionConnected) {
        try {
          const credResp = await this.fetchWithTimeout(`${this.bridgeUrl}/api/flow/credits`, { method: 'GET' }, 4000)
          if (credResp.ok) {
            health.signedIn = true
            health.supportsImageGeneration = true
          } else if (credResp.status === 503) {
            health.extensionConnected = false
            health.message = 'Google Flow Chrome extension is disconnected.'
          } else if (credResp.status === 502) {
            health.signedIn = false
            health.message = 'Google Flow account not signed in. Open Google Flow in Chrome and log in.'
          }
        } catch {
          // If credits check times out, fallback to extension connection state
          health.signedIn = health.extensionConnected
        }
      }

      if (!health.extensionConnected) {
        health.message = 'Chrome extension disconnected. Open Google Flow in Chrome, reconnect the extension, then retry.'
      } else if (!health.signedIn) {
        health.message = 'Google Flow is not signed in. Please log into Google Flow in Chrome.'
      } else {
        health.message = 'FlowKit bridge and Google Flow are connected and ready for 4K thumbnail generation.'
      }

      return health
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      health.reachable = false
      health.message = `FlowKit bridge unreachable at ${this.bridgeUrl} (${msg}). Ensure FlowKit is running.`
      return health
    }
  }

  public async generateImage(
    request: ThumbnailGenerateRequest,
    options?: { maxRetries?: number }
  ): Promise<ThumbnailGenerateResult> {
    const maxRetries = options?.maxRetries ?? 3
    const url = `${this.bridgeUrl}/api/flow/generate-image`

    const payload = {
      prompt: request.prompt,
      project_id: request.projectId || '',
      image_model: request.imageModel || 'GEM_PIX_2',
      aspect_ratio: request.aspectRatio || '16:9',
      count: 1,
      reference_media_ids: []
    }

    let attempt = 0
    let lastError: Error | null = null

    while (attempt <= maxRetries) {
      attempt++
      try {
        logger.info(
          `[GoogleFlowClient] Generating candidate ${request.optionId} (attempt ${attempt}/${maxRetries + 1})...`
        )

        const resp = await this.fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-flowkit-caller': 'long-form-video-factory/thumbnail-studio'
            },
            body: JSON.stringify(payload)
          },
          120000
        )

        if (resp.ok) {
          const data = (await resp.json()) as {
            media?: Array<{
              name?: string
              image?: { generatedImage?: { mediaId?: string; fifeUrl?: string } }
            }>
            project_id?: string
          }

          const firstMedia = data.media?.[0]
          const mediaId = firstMedia?.image?.generatedImage?.mediaId || firstMedia?.name
          const fifeUrl = firstMedia?.image?.generatedImage?.fifeUrl

          if (!mediaId) {
            throw new Error('FLOW_GENERATION_FAILED: FlowKit returned response without mediaId.')
          }

          logger.info(`[GoogleFlowClient] Candidate ${request.optionId} generated media: ${mediaId}`)
          return {
            mediaId,
            projectId: data.project_id || request.projectId || '',
            fifeUrl,
            raw: data
          }
        }

        // Handle error responses
        const status = resp.status
        let errorBody: FlowKitErrorResponse = {}
        try {
          errorBody = (await resp.json()) as FlowKitErrorResponse
        } catch {
          // non-JSON error
        }

        const errMsg = errorBody.error || errorBody.detail || (typeof errorBody === 'string' ? errorBody : '') || `HTTP ${status}`

        // 1. Extension disconnected
        if (status === 503 || String(errMsg).toLowerCase().includes('extension not connected')) {
          throw new Error('FLOW_EXTENSION_DISCONNECTED: Chrome extension is disconnected. Open Google Flow in Chrome and reconnect.')
        }

        // 2. Non-retryable argument errors
        if (status === 400 || status === 422 || String(errMsg).toLowerCase().includes('invalid argument')) {
          throw new Error(`FLOW_GENERATION_FAILED: Invalid argument: ${errMsg}`)
        }

        // 3. Rate limiting (429) & Cooldown
        if (status === 429 || String(errMsg).toLowerCase().includes('rate limit') || String(errMsg).toLowerCase().includes('cooldown')) {
          const retryAfterSec = parseInt(resp.headers.get('Retry-After') || '10', 10) || 10
          if (attempt <= maxRetries) {
            const waitMs = Math.min(retryAfterSec * 1000, 35000)
            logger.warn(`[GoogleFlowClient] Rate limited. Waiting ${waitMs}ms before retry...`)
            await new Promise((r) => setTimeout(r, waitMs))
            continue
          }
          throw new Error(`FLOW_RATE_LIMITED: Google Flow rate limit reached. (${errMsg})`)
        }

        // 4. reCAPTCHA transient failures
        if (String(errMsg).toLowerCase().includes('recaptcha')) {
          if (attempt <= maxRetries) {
            const waitMs = 5000 * attempt
            logger.warn(`[GoogleFlowClient] reCAPTCHA challenge transient error. Retrying in ${waitMs}ms...`)
            await new Promise((r) => setTimeout(r, waitMs))
            continue
          }
          throw new Error(`FLOW_RECAPTCHA_FAILED: Google Flow reCAPTCHA verification failed. (${errMsg})`)
        }

        // 5. 502 / 503 / 504 server overload
        if (status >= 500) {
          if (attempt <= maxRetries) {
            const waitMs = 4000 * Math.pow(2, attempt - 1)
            logger.warn(`[GoogleFlowClient] Server error ${status}. Retrying in ${waitMs}ms...`)
            await new Promise((r) => setTimeout(r, waitMs))
            continue
          }
        }

        throw new Error(`FLOW_GENERATION_FAILED: ${errMsg}`)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const msg = lastError.message

        if (
          msg.startsWith('FLOW_EXTENSION_DISCONNECTED') ||
          msg.startsWith('FLOW_RATE_LIMITED') ||
          msg.startsWith('FLOW_RECAPTCHA_FAILED') ||
          msg.startsWith('FLOW_GENERATION_FAILED')
        ) {
          throw lastError
        }

        if (attempt <= maxRetries) {
          const waitMs = 3000 * attempt
          logger.warn(`[GoogleFlowClient] Request exception: ${msg}. Retrying in ${waitMs}ms...`)
          await new Promise((r) => setTimeout(r, waitMs))
          continue
        }
      }
    }

    throw lastError || new Error('FLOW_GENERATION_FAILED: Unknown generation error')
  }

  public async exportImage(request: ThumbnailExportRequest): Promise<ThumbnailExportResult> {
    const destDir = path.dirname(request.destinationPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    // First attempt: 4K export
    let result = await this.tryExportAtQuality(request.mediaId, request.projectId, '4k', request.destinationPath)

    if (result.success && result.buffer) {
      fs.writeFileSync(request.destinationPath, result.buffer)
      const dims = probeImageDimensions(result.buffer)
      const stats = fs.statSync(request.destinationPath)
      return {
        filePath: request.destinationPath,
        fileSize: stats.size,
        width: dims?.width || 3840,
        height: dims?.height || 2160,
        actualQuality: 'native-4k'
      }
    }

    const is4kGated =
      result.statusCode === 400 ||
      result.statusCode === 403 ||
      result.statusCode === 502 ||
      String(result.error).toLowerCase().includes('tier') ||
      String(result.error).toLowerCase().includes('plan') ||
      String(result.error).toLowerCase().includes('not supported') ||
      String(result.error).toLowerCase().includes('upscale')

    logger.warn(`[GoogleFlowClient] 4K export failed (${result.error}). Attempting 2K fallback...`)

    // Second attempt: 2K fallback
    result = await this.tryExportAtQuality(request.mediaId, request.projectId, '2k', request.destinationPath)
    if (result.success && result.buffer) {
      fs.writeFileSync(request.destinationPath, result.buffer)
      const dims = probeImageDimensions(result.buffer)
      const stats = fs.statSync(request.destinationPath)
      return {
        filePath: request.destinationPath,
        fileSize: stats.size,
        width: dims?.width || 2560,
        height: dims?.height || 1440,
        actualQuality: '2k-fallback',
        is4kPlanGated: is4kGated
      }
    }

    // Third attempt: Original fallback via signed fifeUrl if available
    if (request.fallbackToOriginalUrl) {
      logger.warn(`[GoogleFlowClient] 2K export failed. Falling back to original image download from fifeUrl...`)
      try {
        const origResp = await this.fetchWithTimeout(request.fallbackToOriginalUrl, { method: 'GET' }, 30000)
        if (origResp.ok) {
          const arrayBuf = await origResp.arrayBuffer()
          const buf = Buffer.from(arrayBuf)
          fs.writeFileSync(request.destinationPath, buf)
          const dims = probeImageDimensions(buf)
          const stats = fs.statSync(request.destinationPath)
          return {
            filePath: request.destinationPath,
            fileSize: stats.size,
            width: dims?.width || 1376,
            height: dims?.height || 768,
            actualQuality: 'original-fallback',
            is4kPlanGated: true
          }
        }
      } catch (fifeErr) {
        logger.error(`[GoogleFlowClient] Original fifeUrl download failed: ${fifeErr}`)
      }
    }

    throw new Error(`FLOW_EXPORT_FAILED: Failed to export image for media ${request.mediaId}: ${result.error || 'Unknown export error'}`)
  }

  private async tryExportAtQuality(
    mediaId: string,
    projectId: string | undefined,
    quality: '4k' | '2k',
    _destPath: string
  ): Promise<{ success: boolean; buffer?: Buffer; statusCode?: number; error?: string }> {
    const url = `${this.bridgeUrl}/api/flow/export-image`
    const payload = {
      media_id: mediaId,
      project_id: projectId || '',
      quality: quality.toLowerCase()
    }

    try {
      const resp = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-flowkit-caller': 'long-form-video-factory/thumbnail-studio'
          },
          body: JSON.stringify(payload)
        },
        90000
      )

      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer()
        const buf = Buffer.from(arrayBuf)
        if (buf.length > 0) {
          return { success: true, buffer: buf, statusCode: resp.status }
        }
        return { success: false, statusCode: resp.status, error: 'Empty binary response returned' }
      }

      let errorMsg = `HTTP ${resp.status}`
      try {
        const errJson = (await resp.json()) as FlowKitErrorResponse
        errorMsg = errJson.error || errJson.detail || errorMsg
      } catch {
        // non-JSON
      }

      return { success: false, statusCode: resp.status, error: String(errorMsg) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        ...init,
        signal: controller.signal
      })
      return resp
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

export const googleFlowClient = new GoogleFlowClient()
