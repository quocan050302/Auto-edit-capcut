import type {
  ResearchProgressState,
  ResearchRunResult,
  SavedResearchProject,
  ResearchSettings,
  CompetitorAnalysisResult,
  ThumbnailIntelligenceResult,
  MarketCode,
  ContentType,
  TimeRange,
  ResearchFilters,
  ApiKeyTestResult
} from '../types/research.types'
import { isResearchStageTerminal } from '../types/research.types'

export const SIDECAR_DEFAULT_URL = 'http://127.0.0.1:8765'

export type ResearchApiErrorCode =
  | 'API_OFFLINE'
  | 'API_BLOCKED'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'

export type ResearchProgressConnectionErrorCode = 'SIDECAR_DISCONNECTED' | 'POLLING_EXHAUSTED'

export class ResearchProgressConnectionError extends Error {
  code: ResearchProgressConnectionErrorCode
  runId: string

  constructor(message: string, code: ResearchProgressConnectionErrorCode, runId: string) {
    super(message)
    this.name = 'ResearchProgressConnectionError'
    this.code = code
    this.runId = runId
  }
}

export class ResearchApiError extends Error {
  code: ResearchApiErrorCode
  status?: number
  details?: unknown

  constructor(
    message: string,
    code: ResearchApiErrorCode,
    status?: number,
    details?: unknown
  ) {
    super(message)
    this.name = 'ResearchApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function normalizeLocalSidecarUrl(url?: string): string {
  const fallback = SIDECAR_DEFAULT_URL
  if (!url) return fallback
  try {
    const parsed = new URL(url)
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
    if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname)) {
      return fallback
    }
    // Remove trailing slashes
    return parsed.origin.replace(/\/+$/, '')
  } catch {
    return fallback
  }
}

export class ResearchApi {
  private baseUrl: string

  constructor(baseUrl: string = SIDECAR_DEFAULT_URL) {
    this.baseUrl = normalizeLocalSidecarUrl(baseUrl)
  }

  setBaseUrl(url?: string): void {
    this.baseUrl = normalizeLocalSidecarUrl(url)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit & { timeoutMs?: number } = {}
  ): Promise<T> {
    const { timeoutMs = 12000, ...fetchOptions } = options
    const url = `${this.baseUrl}${endpoint}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    // Chain custom signal if provided
    let combinedSignal = controller.signal
    if (fetchOptions.signal) {
      const externalSignal = fetchOptions.signal
      if (externalSignal.aborted) {
        clearTimeout(timeoutId)
        throw new ResearchApiError('Request aborted by caller', 'TIMEOUT')
      }
      externalSignal.addEventListener('abort', () => controller.abort())
    }

    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: combinedSignal
      })

      if (!res.ok) {
        let errData: any = null
        try {
          errData = await res.json()
        } catch {
          // not json
        }

        const detailMsg = errData?.detail || `Request failed with status ${res.status}`
        if (res.status === 422) {
          throw new ResearchApiError(
            `Invalid research request: ${typeof detailMsg === 'string' ? detailMsg : JSON.stringify(detailMsg)}`,
            'HTTP_ERROR',
            422,
            errData
          )
        }
        if (res.status === 500) {
          throw new ResearchApiError(
            'The research service encountered an internal error.',
            'HTTP_ERROR',
            500,
            errData
          )
        }
        throw new ResearchApiError(detailMsg, 'HTTP_ERROR', res.status, errData)
      }

      try {
        return (await res.json()) as T
      } catch (err) {
        throw new ResearchApiError('Invalid JSON response from research service', 'INVALID_RESPONSE')
      }
    } catch (err: unknown) {
      if (err instanceof ResearchApiError) {
        throw err
      }

      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ResearchApiError('The research request timed out before a response was received. Please verify that the local FastAPI sidecar is running.', 'TIMEOUT')
      }

      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CSP')) {
        throw new ResearchApiError(
          'Research service is not responding (blocked or could not connect). Please verify that the local FastAPI sidecar is running at ' + this.baseUrl,
          'API_OFFLINE'
        )
      }

      throw new ResearchApiError(`Connection error: ${msg}`, 'API_OFFLINE')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async checkHealth(): Promise<{ status: string; service: string; version: string; providers?: Record<string, unknown> }> {
    return this.request('/health', { timeoutMs: 3000 })
  }

  async startDiscover(params: {
    topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
    limit?: number
    filters?: ResearchFilters
  }): Promise<{ run_id: string; status: string; message?: string }> {
    return this.request('/api/research/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      timeoutMs: 15000
    })
  }

  async getRunStatus(runId: string): Promise<ResearchProgressState> {
    return this.request(`/api/research/runs/${encodeURIComponent(runId)}/status`, { timeoutMs: 4000 })
  }

  async expandKeywords(topic: string, market: MarketCode): Promise<{ keywords: string[]; sources: Record<string, string[]> }> {
    return this.request('/api/research/expand-keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, market }),
      timeoutMs: 20000
    })
  }

  async cancelRun(runId: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/api/research/cancel/${encodeURIComponent(runId)}`, {
      method: 'POST',
      timeoutMs: 5000
    })
  }

  async getRunResult(runId: string): Promise<ResearchRunResult> {
    return this.request(`/api/research/runs/${encodeURIComponent(runId)}`, { timeoutMs: 10000 })
  }

  async getLatestRun(topic?: string, market?: MarketCode): Promise<ResearchRunResult | null> {
    const query = new URLSearchParams()
    if (topic) query.set('topic', topic)
    if (market) query.set('market', market)
    try {
      return await this.request(`/api/research/runs/latest?${query.toString()}`, { timeoutMs: 5000 })
    } catch (err) {
      if (err instanceof ResearchApiError && err.status === 404) {
        return null
      }
      throw err
    }
  }

  async analyzeCompetitor(channelUrl: string, market: MarketCode = 'US'): Promise<CompetitorAnalysisResult> {
    return this.request('/api/research/competitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_url: channelUrl, market }),
      timeoutMs: 30000
    })
  }

  async analyzeThumbnailIntelligence(payload: {
    channel_id: string
    channel_title: string
    videos: Array<Record<string, unknown>>
    channel_median_views: number
    p75_views: number
    max_videos?: number
  }): Promise<ThumbnailIntelligenceResult> {
    return this.request('/api/research/competitor/thumbnail-intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 120000  // 2 min — downloading 30 thumbnails takes time
    })
  }

  async getSavedProjects(): Promise<SavedResearchProject[]> {
    return this.request('/api/research/saved', { timeoutMs: 5000 })
  }

  async saveProject(payload: {
    name: string
    run_id: string
    seed_topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
  }): Promise<SavedResearchProject> {
    return this.request('/api/research/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 8000
    })
  }

  async renameSavedProject(id: string, name: string): Promise<SavedResearchProject> {
    return this.request(`/api/research/saved/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      timeoutMs: 5000
    })
  }

  async deleteSavedProject(id: string): Promise<{ success: boolean }> {
    return this.request(`/api/research/saved/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      timeoutMs: 5000
    })
  }

  async getSettings(): Promise<ResearchSettings> {
    return this.request('/api/research/settings', { timeoutMs: 5000 })
  }

  async updateSettings(settings: Partial<ResearchSettings>): Promise<ResearchSettings> {
    return this.request('/api/research/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      timeoutMs: 8000
    })
  }

  async testYouTubeApiKey(apiKey: string): Promise<ApiKeyTestResult> {
    return this.request<ApiKeyTestResult>('/api/research/test-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
      timeoutMs: 12000
    })
  }

  async testOllama(url: string, model: string): Promise<{ available: boolean; error?: string }> {
    return this.request('/api/research/test-ollama', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, model }),
      timeoutMs: 10000
    })
  }

  subscribeProgress(
    runId: string,
    onProgress: (state: ResearchProgressState) => void,
    onError: (err: Error) => void,
    onComplete: (state: ResearchProgressState) => void
  ): () => void {
    let closed = false
    let eventSource: EventSource | null = null
    let pollInterval: NodeJS.Timeout | null = null
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 4

    console.log(`[YouTubeResearch] progress.sse.connect run_id=${runId}`)

    const cleanup = () => {
      closed = true
      if (eventSource) {
        eventSource.close()
        eventSource = null
      }
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
    }

    const startPollingFallback = () => {
      if (closed || pollInterval) return
      console.log(`[YouTubeResearch] progress.polling.start run_id=${runId}`)
      pollInterval = setInterval(async () => {
        if (closed) return
        try {
          const status = await this.getRunStatus(runId)
          if (closed) return
          if (consecutiveFailures > 0) {
            console.log(`[YouTubeResearch] progress.polling.recovered run_id=${runId}`)
            consecutiveFailures = 0
          }
          onProgress(status)
          if (isResearchStageTerminal(status.stage)) {
            console.log(`[YouTubeResearch] progress.terminal stage=${status.stage}`)
            cleanup()
            onComplete(status)
          }
        } catch (pollErr) {
          if (closed) return
          consecutiveFailures++
          console.warn(`[YouTubeResearch] progress.polling.failure attempt=${consecutiveFailures}`, pollErr)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[YouTubeResearch] progress.connection.exhausted run_id=${runId}`)
            console.warn(`[YouTubeResearch] run.interrupted run_id=${runId}`)
            cleanup()
            const connErr = new ResearchProgressConnectionError(
              'The local research service stopped unexpectedly. Polling attempts exhausted.',
              'SIDECAR_DISCONNECTED',
              runId
            )
            onError(connErr)
            const interruptedState: ResearchProgressState = {
              run_id: runId,
              stage: 'INTERRUPTED',
              progress_percent: 15,
              message: 'The local research service stopped unexpectedly. Your research run was interrupted. Restart the service and try again.',
              videos_collected: 0,
              channels_analyzed: 0,
              keywords_expanded: 0,
              elapsed_seconds: 0,
              can_cancel: false,
              error: 'Service disconnected'
            }
            onProgress(interruptedState)
            onComplete(interruptedState)
          }
        }
      }, 2000)
    }

    try {
      const sseUrl = `${this.baseUrl}/api/research/stream/${encodeURIComponent(runId)}`
      eventSource = new EventSource(sseUrl)

      eventSource.onmessage = (event) => {
        if (closed) return
        try {
          if (!event.data || event.data.trim() === '{}' || event.data.startsWith(':')) {
            // Heartbeat or comment
            return
          }
          const data = JSON.parse(event.data) as ResearchProgressState
          onProgress(data)
          if (isResearchStageTerminal(data.stage)) {
            console.log(`[YouTubeResearch] progress.terminal stage=${data.stage}`)
            cleanup()
            onComplete(data)
          }
        } catch (err) {
          console.warn('[YouTubeResearch] SSE parse warning', err)
        }
      }

      eventSource.onerror = (err) => {
        if (closed) return
        console.warn(`[YouTubeResearch] progress.sse.disconnected run_id=${runId}`, err)
        if (eventSource) {
          eventSource.close()
          eventSource = null
        }
        // Activate fallback polling without failing the run
        startPollingFallback()
      }
    } catch (err) {
      console.warn(`[YouTubeResearch] progress.sse.disconnected run_id=${runId}`, err)
      startPollingFallback()
    }

    return cleanup
  }
}

export const researchApi = new ResearchApi()
