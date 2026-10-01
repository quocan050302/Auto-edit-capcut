import React, { useState, useEffect } from 'react'
import type { ResearchSettings, MarketCode, ContentType, TimeRange } from '../types/research.types'
import { SUPPORTED_MARKETS } from '../types/research.types'
import { researchApi } from '../api/researchApi'

interface Props {
  onClose: () => void
  onSettingsUpdated: () => void
}

export function ResearchSettingsModal({ onClose, onSettingsUpdated }: Props): React.ReactElement {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Settings State
  const [useOfficialApi, setUseOfficialApi] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [scraperFallback, setScraperFallback] = useState(true)
  const [providerPriority, setProviderPriority] = useState<'official_first' | 'scraper_first'>('scraper_first')

  const [defaultMarket, setDefaultMarket] = useState<MarketCode>('US')
  const [defaultLanguage, setDefaultLanguage] = useState('en')
  const [defaultDateRange, setDefaultDateRange] = useState<TimeRange>('30d')
  const [defaultContentType, setDefaultContentType] = useState<ContentType>('LONG')
  const [defaultResultSize, setDefaultResultSize] = useState(50)

  const [aiProvider, setAiProvider] = useState<'ollama' | 'gemini' | 'openai' | 'anthropic' | 'disabled'>('disabled')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useState('llama3')
  const [cloudAiKey, setCloudAiKey] = useState('')
  const [hasCloudAiKey, setHasCloudAiKey] = useState(false)

  const [maxExpandedKeywords, setMaxExpandedKeywords] = useState(25)
  const [rawVideoLimit, setRawVideoLimit] = useState(150)
  const [maxEnrichmentVideos, setMaxEnrichmentVideos] = useState(50)
  const [channelBaselineSize, setChannelBaselineSize] = useState(25)
  const [debugMode, setDebugMode] = useState(false)

  // Scoring Weights
  const [weights, setWeights] = useState({
    demand: 0.20,
    velocity: 0.20,
    outlier: 0.20,
    cross_channel: 0.10,
    market_fit: 0.10,
    freshness: 0.10,
    competition: 0.10
  })

  // Test statuses
  const [testingKey, setTestingKey] = useState(false)
  const [keyTestStatus, setKeyTestStatus] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [aiTestStatus, setAiTestStatus] = useState<string | null>(null)

  useEffect(() => {
    researchApi.getSettings().then((s) => {
      setUseOfficialApi(s.use_official_api)
      setHasApiKey(s.has_official_api_key)
      setScraperFallback(s.scraper_fallback)
      setProviderPriority(s.provider_priority)
      setDefaultMarket(s.default_market)
      setDefaultLanguage(s.default_language)
      setDefaultDateRange(s.default_date_range)
      setDefaultContentType(s.default_content_type)
      setDefaultResultSize(s.default_result_size)
      setAiProvider(s.ai_provider)
      setOllamaUrl(s.ollama_base_url)
      setOllamaModel(s.ollama_model)
      setHasCloudAiKey(s.has_cloud_ai_key)
      setMaxExpandedKeywords(s.max_expanded_keywords)
      setRawVideoLimit(s.raw_video_limit)
      setMaxEnrichmentVideos(s.max_enrichment_videos)
      setChannelBaselineSize(s.channel_baseline_size)
      setDebugMode(s.debug_mode)
      if (s.scoring_weights) setWeights(s.scoring_weights)
      setLoading(false)
    }).catch((err) => {
      setError(`Failed loading settings: ${err.message}`)
      setLoading(false)
    })
  }, [])

  const handleTestKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) {
      setKeyTestStatus({ type: 'error', message: '✗ Please enter an API key first' })
      return
    }
    setTestingKey(true)
    setKeyTestStatus(null)
    try {
      const res = await researchApi.testYouTubeApiKey(key)
      if (res.valid) {
        setKeyTestStatus({ type: 'success', message: '✓ Connected — YouTube Data API v3 is active' })
      } else {
        const statusLabels: Record<string, string> = {
          invalid_key: '✗ Invalid API key — check the key value and try again',
          api_not_enabled: '✗ API not enabled — enable YouTube Data API v3 at console.cloud.google.com',
          quota_exhausted: '⚠ Quota exhausted — key is valid but daily limit reached. Resets at midnight PT.',
          network_error: '✗ Network error — check your internet connection',
          server_error: '✗ Google server error — try again in a moment',
          rate_limited: '⚠ Rate limited — wait a moment and try again',
          not_configured: '✗ Key is empty',
        }
        const isWarning = res.status === 'quota_exhausted' || res.status === 'rate_limited'
        const label = statusLabels[res.status || ''] || `✗ ${res.error || 'Connection failed'}`
        setKeyTestStatus({ type: isWarning ? 'warning' : 'error', message: label })
      }
    } catch (err: unknown) {
      setKeyTestStatus({ type: 'error', message: `✗ Test error: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTestingKey(false)
    }
  }

  const handleTestAi = async () => {
    setTestingAi(true)
    setAiTestStatus(null)
    try {
      const res = await researchApi.testOllama(ollamaUrl, ollamaModel)
      if (res.available) {
        setAiTestStatus('✓ Local Ollama service is reachable')
      } else {
        setAiTestStatus(`✗ Ollama unreachable: ${res.error || 'Connection refused'}`)
      }
    } catch (err: unknown) {
      setAiTestStatus(`✗ Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTestingAi(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccessMsg(null)

    // Validate weights sum
    const totalWeights = Object.values(weights).reduce((a, b) => a + b, 0)
    if (Math.abs(totalWeights - 1.0) > 0.01) {
      setError(`Scoring weights sum must equal 1.0 (Current sum: ${totalWeights.toFixed(2)})`)
      setSaving(false)
      return
    }

    try {
      const payload: Partial<ResearchSettings> = {
        use_official_api: useOfficialApi,
        scraper_fallback: scraperFallback,
        provider_priority: providerPriority,
        default_market: defaultMarket,
        default_language: defaultLanguage,
        default_date_range: defaultDateRange,
        default_content_type: defaultContentType,
        default_result_size: defaultResultSize,
        ai_provider: aiProvider,
        ollama_base_url: ollamaUrl,
        ollama_model: ollamaModel,
        max_expanded_keywords: maxExpandedKeywords,
        raw_video_limit: rawVideoLimit,
        max_enrichment_videos: maxEnrichmentVideos,
        channel_baseline_size: channelBaselineSize,
        debug_mode: debugMode,
        scoring_weights: weights
      }

      if (apiKeyInput.trim()) {
        (payload as any).official_api_key = apiKeyInput.trim()
      }
      if (cloudAiKey.trim()) {
        (payload as any).cloud_ai_key = cloudAiKey.trim()
      }

      await researchApi.updateSettings(payload)
      setSuccessMsg('Settings saved successfully!')
      setApiKeyInput('')
      setCloudAiKey('')
      setHasApiKey(useOfficialApi && (hasApiKey || !!apiKeyInput.trim()))
      onSettingsUpdated()
      setTimeout(() => setSuccessMsg(null), 3000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1200,
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--bg-elevated, #13141c)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '12px',
        width: '680px',
        maxWidth: '92vw',
        maxHeight: '90vh',
        overflowY: 'auto',
        padding: '28px',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              YouTube Research Settings
            </h2>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
              Configure provider credentials, market defaults, scoring weights, and local AI.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading settings...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
            {/* ── Section 1: YouTube Providers ── */}
            <div style={{ background: 'var(--bg-base)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px 0' }}>
                1. YouTube Data Providers
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={useOfficialApi}
                    onChange={(e) => setUseOfficialApi(e.target.checked)}
                  />
                  <span>Enable Official YouTube Data API v3 (Optional)</span>
                </label>

                {useOfficialApi && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <div style={{ position: 'relative', flex: 1 }}>
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          placeholder={hasApiKey ? '(configured — enter new key to update)' : 'Paste YouTube Data API Key...'}
                          value={apiKeyInput}
                          onChange={(e) => {
                            setApiKeyInput(e.target.value)
                            setKeyTestStatus(null)
                          }}
                          style={{
                            width: '100%',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            padding: '6px 36px 6px 10px',
                            color: '#fff',
                            fontSize: '12px',
                            fontFamily: 'var(--font-mono)',
                            boxSizing: 'border-box'
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          style={{
                            position: 'absolute',
                            right: '8px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                            fontSize: '11px',
                            padding: '2px'
                          }}
                          title={showApiKey ? 'Hide key' : 'Show key'}
                        >
                          {showApiKey ? '👁️' : '🙈'}
                        </button>
                      </div>
                      <button
                        className="btn btn-secondary"
                        onClick={handleTestKey}
                        disabled={testingKey}
                        style={{ fontSize: '11px', padding: '0 12px', whiteSpace: 'nowrap' }}
                      >
                        {testingKey ? '⏳ Testing...' : 'Test Connection'}
                      </button>
                    </div>

                    {hasApiKey && !apiKeyInput && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        ✓ API key is stored (value hidden for security)
                      </div>
                    )}

                    {keyTestStatus && (
                      <div style={{
                        fontSize: '11px',
                        color: keyTestStatus.type === 'success' ? '#34d399'
                          : keyTestStatus.type === 'warning' ? '#fbbf24'
                          : '#f87171',
                        padding: '6px 8px',
                        background: keyTestStatus.type === 'success' ? 'rgba(52,211,153,0.08)'
                          : keyTestStatus.type === 'warning' ? 'rgba(251,191,36,0.08)'
                          : 'rgba(248,113,113,0.08)',
                        borderRadius: '4px',
                        border: `1px solid ${keyTestStatus.type === 'success' ? 'rgba(52,211,153,0.2)'
                          : keyTestStatus.type === 'warning' ? 'rgba(251,191,36,0.2)'
                          : 'rgba(248,113,113,0.2)'}`
                      }}>
                        {keyTestStatus.message}
                      </div>
                    )}
                  </div>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={scraperFallback}
                    onChange={(e) => setScraperFallback(e.target.checked)}
                  />
                  <span>Free Public Scraper Fallback (active if Official API quota is depleted)</span>
                </label>
              </div>
            </div>

            {/* ── Section 2: Market Defaults ── */}
            <div style={{ background: 'var(--bg-base)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px 0' }}>
                2. Market Defaults
              </h3>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Default Market
                  </label>
                  <select
                    value={defaultMarket}
                    onChange={(e) => setDefaultMarket(e.target.value as MarketCode)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '12px' }}
                  >
                    {SUPPORTED_MARKETS.map((m) => (
                      <option key={m.code} value={m.code}>{m.flag} {m.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Default Content Format
                  </label>
                  <select
                    value={defaultContentType}
                    onChange={(e) => setDefaultContentType(e.target.value as ContentType)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '12px' }}
                  >
                    <option value="LONG">Long-form Video</option>
                    <option value="SHORT">Shorts</option>
                    <option value="BOTH">Both</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Default Date Range
                  </label>
                  <select
                    value={defaultDateRange}
                    onChange={(e) => setDefaultDateRange(e.target.value as TimeRange)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '12px' }}
                  >
                    <option value="24h">24 Hours</option>
                    <option value="7d">7 Days</option>
                    <option value="30d">30 Days</option>
                    <option value="90d">90 Days</option>
                    <option value="1y">1 Year</option>
                  </select>
                </div>
              </div>
            </div>

            {/* ── Section 3: AI Intelligence Layer ── */}
            <div style={{ background: 'var(--bg-base)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px 0' }}>
                3. AI Intelligence Layer (Free-First & Optional)
              </h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 12px 0' }}>
                AI is only used for summarizing angles and content gaps. Analytics scores are always computed deterministically.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '10px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    AI Provider
                  </label>
                  <select
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value as any)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '12px' }}
                  >
                    <option value="disabled">Disabled (Deterministic Rule Analyzer)</option>
                    <option value="ollama">Local Ollama (Free)</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>

                {aiProvider === 'ollama' && (
                  <>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                        Ollama Base URL
                      </label>
                      <input
                        type="text"
                        value={ollamaUrl}
                        onChange={(e) => setOllamaUrl(e.target.value)}
                        style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '11px' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                        Model
                      </label>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input
                          type="text"
                          value={ollamaModel}
                          onChange={(e) => setOllamaModel(e.target.value)}
                          style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px', borderRadius: '4px', fontSize: '11px' }}
                        />
                        <button
                          className="btn btn-secondary"
                          onClick={handleTestAi}
                          disabled={testingAi}
                          style={{ fontSize: '10px', padding: '0 8px' }}
                        >
                          {testingAi ? '...' : 'Ping'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {aiTestStatus && (
                <div style={{ fontSize: '11px', color: aiTestStatus.startsWith('✓') ? '#34d399' : '#f87171' }}>
                  {aiTestStatus}
                </div>
              )}
            </div>

            {/* ── Section 4: Scoring Weights ── */}
            <div style={{ background: 'var(--bg-base)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  4. Opportunity Scoring Weights (Sum = 1.0)
                </h3>
                <span style={{ fontSize: '11px', color: '#818cf8', fontFamily: 'var(--font-mono)' }}>
                  Total: {Object.values(weights).reduce((a, b) => a + b, 0).toFixed(2)}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                {Object.entries(weights).map(([k, v]) => (
                  <div key={k}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', textTransform: 'capitalize', marginBottom: '2px' }}>
                      {k.replace('_', ' ')}
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.0"
                      max="1.0"
                      value={v}
                      onChange={(e) => setWeights({ ...weights, [k]: parseFloat(e.target.value) || 0.0 })}
                      style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: '#fff', padding: '4px 6px', borderRadius: '4px', fontSize: '11px' }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ── Section 5: Developer Debug Mode ── */}
            <div style={{ background: 'var(--bg-base)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={debugMode}
                  onChange={(e) => setDebugMode(e.target.checked)}
                />
                <span>Enable Developer Debug Panel (Health, Cache Hits, Quota details)</span>
              </label>
            </div>
          </div>
        )}

        {error && (
          <div style={{ padding: '10px', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', fontSize: '11px' }}>
            ⚠ {error}
          </div>
        )}

        {successMsg && (
          <div style={{ padding: '10px', background: 'rgba(52, 211, 153, 0.1)', color: '#34d399', border: '1px solid rgba(52, 211, 153, 0.3)', borderRadius: '6px', fontSize: '11px' }}>
            ✓ {successMsg}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', borderTop: '1px solid var(--border-subtle)', paddingTop: '14px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving} style={{ padding: '8px 18px' }}>
            Close
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading} style={{ padding: '8px 24px' }}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
