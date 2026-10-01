import type {
  ResearchProgressState,
  ResearchRunResult,
  SavedResearchProject,
  ResearchSettings,
  CompetitorAnalysisResult,
  MarketCode,
  ContentType,
  TimeRange
} from '../types/research.types'

const SIDECAR_DEFAULT_URL = 'http://127.0.0.1:8765'

export class ResearchApi {
  private baseUrl: string

  constructor(baseUrl: string = SIDECAR_DEFAULT_URL) {
    this.baseUrl = baseUrl
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  async checkHealth(): Promise<{ status: string; version: string; providers: Record<string, string> }> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`Health check failed with status ${res.status}`)
    return res.json()
  }

  async startDiscover(params: {
    topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
    limit?: number
    filters?: Record<string, unknown>
  }): Promise<{ run_id: string; status: string }> {
    const res = await fetch(`${this.baseUrl}/api/research/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Failed to start research' }))
      throw new Error(err.detail || 'Failed to start research')
    }
    return res.json()
  }

  async expandKeywords(topic: string, market: MarketCode): Promise<{ keywords: string[]; sources: Record<string, string[]> }> {
    const res = await fetch(`${this.baseUrl}/api/research/expand-keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, market })
    })
    if (!res.ok) throw new Error('Failed to expand keywords')
    return res.json()
  }

  async cancelRun(runId: string): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${this.baseUrl}/api/research/cancel/${runId}`, {
      method: 'POST'
    })
    if (!res.ok) throw new Error('Failed to cancel research')
    return res.json()
  }

  async getRunResult(runId: string): Promise<ResearchRunResult> {
    const res = await fetch(`${this.baseUrl}/api/research/runs/${runId}`)
    if (!res.ok) throw new Error('Failed to get research result')
    return res.json()
  }

  async getLatestRun(topic?: string, market?: MarketCode): Promise<ResearchRunResult | null> {
    const query = new URLSearchParams()
    if (topic) query.set('topic', topic)
    if (market) query.set('market', market)
    const res = await fetch(`${this.baseUrl}/api/research/runs/latest?${query.toString()}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error('Failed to get latest run')
    return res.json()
  }

  async analyzeCompetitor(channelUrl: string, market: MarketCode = 'US'): Promise<CompetitorAnalysisResult> {
    const res = await fetch(`${this.baseUrl}/api/research/competitor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_url: channelUrl, market })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Failed to analyze competitor' }))
      throw new Error(err.detail || 'Failed to analyze competitor')
    }
    return res.json()
  }

  async getSavedProjects(): Promise<SavedResearchProject[]> {
    const res = await fetch(`${this.baseUrl}/api/research/saved`)
    if (!res.ok) throw new Error('Failed to fetch saved projects')
    return res.json()
  }

  async saveProject(payload: {
    name: string
    run_id: string
    seed_topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
  }): Promise<SavedResearchProject> {
    const res = await fetch(`${this.baseUrl}/api/research/saved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('Failed to save research project')
    return res.json()
  }

  async renameSavedProject(id: string, name: string): Promise<SavedResearchProject> {
    const res = await fetch(`${this.baseUrl}/api/research/saved/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    })
    if (!res.ok) throw new Error('Failed to rename project')
    return res.json()
  }

  async deleteSavedProject(id: string): Promise<{ success: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/research/saved/${id}`, {
      method: 'DELETE'
    })
    if (!res.ok) throw new Error('Failed to delete project')
    return res.json()
  }

  async getSettings(): Promise<ResearchSettings> {
    const res = await fetch(`${this.baseUrl}/api/research/settings`)
    if (!res.ok) throw new Error('Failed to get research settings')
    return res.json()
  }

  async updateSettings(settings: Partial<ResearchSettings>): Promise<ResearchSettings> {
    const res = await fetch(`${this.baseUrl}/api/research/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
    if (!res.ok) throw new Error('Failed to update research settings')
    return res.json()
  }

  async testYouTubeApiKey(apiKey: string): Promise<{ valid: boolean; quota_remaining?: number; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/research/test-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey })
    })
    if (!res.ok) throw new Error('Failed to test API key')
    return res.json()
  }

  async testOllama(url: string, model: string): Promise<{ available: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/research/test-ollama`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, model })
    })
    if (!res.ok) throw new Error('Failed to test Ollama connection')
    return res.json()
  }

  subscribeProgress(
    runId: string,
    onProgress: (state: ResearchProgressState) => void,
    onError: (err: Error) => void,
    onComplete: (state: ResearchProgressState) => void
  ): () => void {
    const sseUrl = `${this.baseUrl}/api/research/stream/${runId}`
    const eventSource = new EventSource(sseUrl)

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ResearchProgressState
        onProgress(data)
        if (data.stage === 'COMPLETED' || data.stage === 'FAILED' || data.stage === 'CANCELLED') {
          eventSource.close()
          onComplete(data)
        }
      } catch (err) {
        console.error('[Research SSE] Parse error', err)
      }
    }

    eventSource.onerror = (err) => {
      console.warn('[Research SSE] Connection error', err)
      onError(new Error('Connection to research progress stream interrupted'))
      eventSource.close()
    }

    return () => {
      eventSource.close()
    }
  }
}

export const researchApi = new ResearchApi()
