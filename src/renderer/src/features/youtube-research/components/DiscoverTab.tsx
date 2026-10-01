import React, { useState, useEffect, useRef } from 'react'
import type {
  MarketCode,
  ContentType,
  TimeRange,
  ResearchRunResult,
  ResearchProgressState,
  ApiConnectionStatus,
  ResearchFilters,
  SearchBudget
} from '../types/research.types'
import { SUPPORTED_MARKETS, isResearchRunActive, RESEARCH_PRESETS } from '../types/research.types'
import { ResearchProgressPanel } from './ResearchProgressPanel'
import { OverviewSection } from './OverviewSection'

function parseOptionalNumber(
  value: string,
  options?: { min?: number; max?: number; integer?: boolean }
): number | undefined {
  if (!value || value.trim() === '') return undefined
  const num = options?.integer ? parseInt(value, 10) : parseFloat(value)
  if (isNaN(num) || !isFinite(num)) return undefined
  if (options?.min !== undefined && num < options.min) return undefined
  if (options?.max !== undefined && num > options.max) return undefined
  return num
}

interface Props {
  onStartDiscover: (params: {
    topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
    limit: number
    filters: ResearchFilters
  }) => Promise<void>
  onExpandKeywords: (topic: string, market: MarketCode) => Promise<string[]>
  activeProgress: ResearchProgressState | null
  activeResult: ResearchRunResult | null
  onCancelResearch: () => void
  isCancelling: boolean
  onSelectKeyword: (kw: string) => void
  onCreateProject: (kw: string, angle?: string) => void
  onNavigateTab: (tab: string) => void
  apiReachabilityStatus?: ApiConnectionStatus
  isStartingResearch?: boolean
  errorMessage?: string | null
  errorDetails?: unknown
  onDismissError?: () => void
  onRetryConnection?: () => void
  onRestartSidecar?: () => void
  isAdvancedView?: boolean
}

export function DiscoverTab({
  onStartDiscover,
  onExpandKeywords,
  activeProgress,
  activeResult,
  onCancelResearch,
  isCancelling,
  onSelectKeyword,
  onCreateProject,
  onNavigateTab,
  apiReachabilityStatus = 'reachable',
  isStartingResearch = false,
  errorMessage,
  errorDetails,
  onDismissError,
  onRetryConnection,
  onRestartSidecar,
  isAdvancedView = false
}: Props): React.ReactElement {
  const [topic, setTopic] = useState('grocery prices')
  const [market, setMarket] = useState<MarketCode>('US')
  const [contentType, setContentType] = useState<ContentType>('LONG')
  const [timeRange, setTimeRange] = useState<TimeRange>('30d')
  const [resultLimit, setResultLimit] = useState<number>(50)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false)

  // V2 fields
  const [searchBudget, setSearchBudget] = useState<SearchBudget>(6)
  const [includeUnverified, setIncludeUnverified] = useState<boolean>(true)

  // Advanced Filters State
  const [minViews, setMinViews] = useState<string>('')
  const [maxSubs, setMaxSubs] = useState<string>('')
  const [minVpd, setMinVpd] = useState<string>('')
  const [minOutlier, setMinOutlier] = useState<string>('')
  const [minOpportunity, setMinOpportunity] = useState<string>('')
  const [maxCompetition, setMaxCompetition] = useState<string>('')

  // Keyword expansion suggestions
  const [expandedSuggestions, setExpandedSuggestions] = useState<string[]>([])
  const [isExpanding, setIsExpanding] = useState(false)

  const [showDetails, setShowDetails] = useState(false)
  const [localValidationMessage, setLocalValidationMessage] = useState<string | null>(null)
  const [activeRunFilters, setActiveRunFilters] = useState<ResearchFilters>({})

  const progressPanelRef = useRef<HTMLDivElement>(null)
  const prevBusyRef = useRef<boolean>(false)

  const isRunning = isResearchRunActive(activeProgress)
  const isBusy = Boolean(isStartingResearch || isRunning)
  const shouldShowProgressPanel =
    isBusy ||
    activeProgress?.stage === 'FAILED' ||
    activeProgress?.stage === 'INTERRUPTED' ||
    activeProgress?.stage === 'CANCELLED'
  const canSubmit = Boolean(topic.trim()) && !isBusy && apiReachabilityStatus !== 'blocked' && apiReachabilityStatus !== 'offline'
  const isDisabled = !canSubmit

  useEffect(() => {
    if (shouldShowProgressPanel && !prevBusyRef.current) {
      // Transition from IDLE to busy/panel: scroll progress panel into view smoothly
      progressPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevBusyRef.current = shouldShowProgressPanel
  }, [shouldShowProgressPanel])

  const getDisabledReason = (): string | null => {
    if (!topic.trim()) return 'Please enter a topic keyword to analyze'
    if (isStartingResearch) return 'Starting research request...'
    if (isRunning) return 'A research run is currently in progress'
    if (apiReachabilityStatus === 'blocked') return 'Cannot connect to local research API (connection blocked)'
    if (apiReachabilityStatus === 'offline') return 'Research service is offline. Please start or restart the service.'
    return null
  }

  const handleExecuteDiscover = async (useSnapshot: boolean = false) => {
    if (!topic.trim()) {
      setLocalValidationMessage('Please enter a topic keyword to analyze')
      return
    }

    let filtersToUse: ResearchFilters

    if (useSnapshot) {
      filtersToUse = activeRunFilters
      setLocalValidationMessage(null)
    } else {
      const minViewsVal = parseOptionalNumber(minViews, { min: 0, integer: true })
      const maxSubsVal = parseOptionalNumber(maxSubs, { min: 0, integer: true })
      const minVpdVal = parseOptionalNumber(minVpd, { min: 0 })
      const minOutlierVal = parseOptionalNumber(minOutlier, { min: 0 })
      const minOpportunityVal = parseOptionalNumber(minOpportunity, { min: 0, max: 100 })
      const maxCompetitionVal = parseOptionalNumber(maxCompetition, { min: 0, max: 100 })

      if (minViews && minViewsVal === undefined) return setLocalValidationMessage('Minimum Views must be a positive number')
      if (maxSubs && maxSubsVal === undefined) return setLocalValidationMessage('Maximum Subscribers must be a positive number')
      if (minVpd && minVpdVal === undefined) return setLocalValidationMessage('Minimum Views/Day must be a positive number')
      if (minOutlier && minOutlierVal === undefined) return setLocalValidationMessage('Minimum Outlier Ratio must be a positive number')
      if (minOpportunity && minOpportunityVal === undefined) return setLocalValidationMessage('Minimum Opportunity must be between 0 and 100')
      if (maxCompetition && maxCompetitionVal === undefined) return setLocalValidationMessage('Maximum Competition must be between 0 and 100')

      setLocalValidationMessage(null)

      const filters: ResearchFilters = {}
      if (minViewsVal !== undefined) filters.min_views = minViewsVal
      if (maxSubsVal !== undefined) filters.max_subscribers = maxSubsVal
      if (minVpdVal !== undefined) filters.min_views_per_day = minVpdVal
      if (minOutlierVal !== undefined) filters.min_outlier_ratio = minOutlierVal
      if (minOpportunityVal !== undefined) filters.min_opportunity = minOpportunityVal
      if (maxCompetitionVal !== undefined) filters.max_competition = maxCompetitionVal

      filtersToUse = filters
      setActiveRunFilters(filters)
    }

    await onStartDiscover({
      topic: topic.trim(),
      market,
      content_type: contentType,
      time_range: timeRange,
      limit: resultLimit,
      filters: {
        ...filtersToUse,
        // V2 fields forwarded as filter extensions (backend reads these)
        search_query_budget: searchBudget,
        include_unverified_channels: includeUnverified,
      } as ResearchFilters & { search_query_budget?: number; include_unverified_channels?: boolean }
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) {
      setLocalValidationMessage(getDisabledReason())
      return
    }
    await handleExecuteDiscover(false)
  }

  const handleExpandOnly = async () => {
    if (!topic.trim() || isExpanding) return
    setIsExpanding(true)
    try {
      const kwList = await onExpandKeywords(topic.trim(), market)
      setExpandedSuggestions(kwList)
    } finally {
      setIsExpanding(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      {/* ── Search Form Card ── */}
      <div style={{
        background: 'var(--bg-elevated, #13141c)',
        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
        borderRadius: 'var(--radius-lg, 12px)',
        padding: '24px',
        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)'
      }}>
        <form onSubmit={handleSubmit}>
          {errorMessage && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              padding: '14px 16px',
              marginBottom: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontWeight: 600, color: '#f87171', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>⚠️</span>
                  <span>Research could not start</span>
                </div>
                {onDismissError && (
                  <button
                    type="button"
                    onClick={onDismissError}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}
                    title="Dismiss notice"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: 1.5 }}>
                {errorMessage}
              </div>
              {isAdvancedView && errorDetails && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowDetails(!showDetails)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-brand, #818cf8)', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                  >
                    {showDetails ? 'Hide Technical Details ▲' : 'View Details ▼'}
                  </button>
                  {showDetails && (
                    <pre style={{
                      marginTop: '6px',
                      padding: '8px 12px',
                      background: 'rgba(0, 0, 0, 0.3)',
                      borderRadius: '4px',
                      fontSize: '11px',
                      color: '#e2e8f0',
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                {onRetryConnection && (
                  <button
                    type="button"
                    onClick={onRetryConnection}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '4px 12px' }}
                  >
                    Retry Connection
                  </button>
                )}
                {onRestartSidecar && (
                  <button
                    type="button"
                    onClick={onRestartSidecar}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '4px 12px' }}
                  >
                    Restart Service
                  </button>
                )}
              </div>
            </div>
          )}

          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text-primary)',
              marginBottom: '8px'
            }}>
              What topic do you want to research?
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. grocery prices, personal finance, housing market, ai tools"
                disabled={isBusy}
                style={{
                  flex: 1,
                  background: 'var(--bg-base, #0a0a0f)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  padding: '12px 16px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none'
                }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isDisabled}
                aria-busy={isBusy}
                title={getDisabledReason() || undefined}
                style={{
                  padding: '0 24px',
                  fontSize: '13px',
                  fontWeight: 700,
                  letterSpacing: '0.3px',
                  background: isBusy
                    ? 'rgba(99, 102, 241, 0.45)'
                    : isDisabled
                    ? '#374151'
                    : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                  border: 'none',
                  minWidth: '150px',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.6 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  WebkitAppRegion: 'no-drag' as any
                }}
              >
                {isBusy && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: '12px',
                      height: '12px',
                      border: '2px solid rgba(255, 255, 255, 0.3)',
                      borderTopColor: '#ffffff',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite'
                    }}
                  />
                )}
                <span>
                  {isStartingResearch
                    ? 'Starting...'
                    : activeProgress?.stage === 'QUEUED'
                    ? 'Queued...'
                    : isRunning
                    ? 'Analyzing...'
                    : 'Analyze Market'}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleExpandOnly}
                disabled={!topic.trim() || isBusy || isExpanding}
                style={{ fontSize: '12px', padding: '0 16px', WebkitAppRegion: 'no-drag' as any }}
              >
                {isExpanding ? 'Finding...' : 'Find Related Keywords'}
              </button>
            </div>

            {(isDisabled || localValidationMessage) && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '12px',
                  color:
                    apiReachabilityStatus === 'blocked' || apiReachabilityStatus === 'offline'
                      ? '#f87171'
                      : isBusy
                      ? '#818cf8'
                      : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>{apiReachabilityStatus === 'blocked' || apiReachabilityStatus === 'offline' ? '⚠️' : 'ℹ️'}</span>
                <span>{localValidationMessage || getDisabledReason()}</span>
              </div>
            )}

            {isBusy && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 14px',
                  background: 'rgba(99, 102, 241, 0.1)',
                  border: '1px solid rgba(99, 102, 241, 0.25)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '12px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a5b4fc', fontWeight: 600 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: '#818cf8',
                      animation: 'pulse 1.5s infinite'
                    }}
                  />
                  <span>Stage: {activeProgress?.stage || (isStartingResearch ? 'STARTING' : 'QUEUED')}</span>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                    — {activeProgress?.message || 'Starting market analysis...'}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#818cf8' }}>
                  {activeProgress?.progress_percent ?? 0}%
                </div>
              </div>
            )}
          </div>

          {/* V2 Presets Row */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Quick Preset
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {RESEARCH_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    if (preset.minViews !== undefined) setMinViews(String(preset.minViews))
                    if (preset.maxSubscribers !== undefined) setMaxSubs(String(preset.maxSubscribers))
                    setTimeRange(preset.timeRange)
                    setContentType(preset.contentType)
                    setResultLimit(preset.resultLimit)
                    setSearchBudget(preset.searchBudget)
                    setIncludeUnverified(preset.includeUnverified)
                    if (preset.minViews || preset.maxSubscribers) setShowAdvancedFilters(true)
                  }}
                  style={{
                    fontSize: '11px',
                    padding: '5px 14px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-base)',
                    color: 'var(--text-muted)',
                    cursor: isBusy ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    transition: 'all 0.15s ease',
                  }}
                  title={preset.description}
                >
                  <span>{preset.icon}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Quick Selectors Row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '16px',
            marginBottom: '16px'
          }}>
            {/* Market */}
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Target Market
              </label>
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value as MarketCode)}
                disabled={isBusy}
                style={{
                  width: '100%',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
              >
                {SUPPORTED_MARKETS.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.flag} {m.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Content Format */}
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Content Format
              </label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value as ContentType)}
                disabled={isBusy}
                style={{
                  width: '100%',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
              >
                <option value="LONG">Long-form Video</option>
                <option value="SHORT">YouTube Shorts</option>
                <option value="BOTH">Both Formats</option>
              </select>
            </div>

            {/* Time Range */}
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Time Range
              </label>
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRange)}
                disabled={isBusy}
                style={{
                  width: '100%',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
              >
                <option value="24h">Last 24 Hours</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days (Recommended)</option>
                <option value="90d">Last 90 Days</option>
                <option value="1y">Past Year</option>
                <option value="all">All Time</option>
              </select>
            </div>

            {/* Result Limit */}
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Depth / Samples
              </label>
              <select
                value={resultLimit}
                onChange={(e) => setResultLimit(parseInt(e.target.value, 10))}
                disabled={isBusy}
                style={{
                  width: '100%',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
              >
                <option value={50}>50 Videos (Fast)</option>
                <option value={100}>100 Videos (Balanced)</option>
                <option value={200}>200 Videos (Deep Research)</option>
                <option value={300}>300 Videos (Max)</option>
              </select>
            </div>

            {/* Search Budget (V2) */}
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Search Budget
              </label>
              <select
                value={searchBudget}
                onChange={(e) => setSearchBudget(parseInt(e.target.value, 10) as 3 | 6 | 8 | 10)}
                disabled={isBusy}
                style={{
                  width: '100%',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
                title="Number of search queries sent to YouTube API per run"
              >
                <option value={3}>3 queries (Quick)</option>
                <option value={6}>6 queries (Recommended)</option>
                <option value={8}>8 queries (Thorough)</option>
                <option value={10}>10 queries (Maximum)</option>
              </select>
            </div>
          </div>

          {/* Collapsible Advanced Filters */}
          <div style={{ marginTop: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                type="button"
                onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-brand, #818cf8)',
                  fontSize: '12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 0'
                }}
              >
                <span>{showAdvancedFilters ? '▲ Hide Advanced Filters' : '▼ Show Advanced Filters (Views, Subs, Outlier, Competition)'}</span>
              </button>
              {/* Include Unverified toggle always visible */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeUnverified}
                  onChange={(e) => setIncludeUnverified(e.target.checked)}
                  disabled={isBusy}
                />
                <span title="Show channels where subscriber count is hidden/unknown">Include unverified channels 👁</span>
              </label>
            </div>

            {showAdvancedFilters && (
              <div style={{
                marginTop: '12px',
                padding: '16px',
                background: 'var(--bg-base)',
                borderRadius: '8px',
                border: '1px solid var(--border-subtle)',
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '14px'
              }}>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Minimum Views
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 10000"
                    value={minViews}
                    onChange={(e) => setMinViews(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Maximum Channel Subscribers
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 100000 (Small channels)"
                    value={maxSubs}
                    onChange={(e) => setMaxSubs(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Minimum Views / Day
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 500"
                    value={minVpd}
                    onChange={(e) => setMinVpd(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Minimum Outlier Ratio (e.g. 3.0x)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    placeholder="e.g. 3.0"
                    value={minOutlier}
                    onChange={(e) => setMinOutlier(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Minimum Opportunity Score
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 70"
                    value={minOpportunity}
                    onChange={(e) => setMinOpportunity(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Maximum Competition (0 - 100)
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 50"
                    value={maxCompetition}
                    onChange={(e) => setMaxCompetition(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', color: '#fff', fontSize: '11px' }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Quick Suggestions Chips if user clicked Find Related Keywords */}
          {expandedSuggestions.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Discovered keyword expansions (click to research):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {expandedSuggestions.map((kw) => (
                  <button
                    key={kw}
                    type="button"
                    onClick={() => {
                      setTopic(kw)
                      onSelectKeyword(kw)
                    }}
                    style={{
                      background: 'rgba(99, 102, 241, 0.1)',
                      border: '1px solid rgba(99, 102, 241, 0.3)',
                      color: '#a5b4fc',
                      fontSize: '11px',
                      padding: '4px 10px',
                      borderRadius: '999px',
                      cursor: 'pointer'
                    }}
                  >
                    + {kw}
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </div>

      {/* ── Active Progress Panel ── */}
      {shouldShowProgressPanel && (
        <div ref={progressPanelRef} style={{ scrollMarginTop: '24px' }}>
          <ResearchProgressPanel
            topic={topic}
            progressState={activeProgress}
            onCancel={onCancelResearch}
            isCancelling={isCancelling}
            onRetry={canSubmit ? () => handleExecuteDiscover(true) : undefined}
            onRestartService={onRestartSidecar}
            onDismiss={onDismissError}
          />
        </div>
      )}

      {/* ── Active Result Overview ── */}
      {!shouldShowProgressPanel && activeResult && (
        <OverviewSection
          result={activeResult}
          onSelectKeyword={onSelectKeyword}
          onCreateProjectFromKeyword={onCreateProject}
          onRetry={() => {
            setMinViews('')
            setMaxSubs('')
            setMinVpd('')
            setMinOutlier('')
            setMinOpportunity('')
            setMaxCompetition('')
            setActiveRunFilters({})
            
            onStartDiscover({
              topic: activeResult.topic,
              market: activeResult.market as MarketCode,
              content_type: activeResult.content_type as ContentType,
              time_range: activeResult.time_range as TimeRange,
              limit: resultLimit,
              filters: {}
            })
          }}
        />
      )}
    </div>
  )
}
