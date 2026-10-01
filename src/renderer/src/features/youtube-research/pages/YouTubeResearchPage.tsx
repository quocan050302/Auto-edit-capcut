import React, { useState, useEffect, useRef } from 'react'
import type {
  MarketCode,
  ContentType,
  TimeRange,
  ResearchRunResult,
  ResearchProgressState,
  SavedResearchProject,
  KeywordMetricRecord,
  ProviderSource,
  ResearchSidecarStatus,
  ResearchProjectHandoffPayload,
  ApiConnectionStatus,
  ResearchFilters
} from '../types/research.types'
import { isResearchRunActive } from '../types/research.types'
import { researchApi, ResearchApiError } from '../api/researchApi'
import { ResearchErrorBoundary } from '../components/ResearchErrorBoundary'
import { ResearchHeader } from '../components/ResearchHeader'
import { DiscoverTab } from '../components/DiscoverTab'
import { KeywordExplorerTab } from '../components/KeywordExplorerTab'
import { KeywordDetailModal } from '../components/KeywordDetailModal'
import { BreakoutVideosTab } from '../components/BreakoutVideosTab'
import { TrendRadarTab } from '../components/TrendRadarTab'
import { CompetitorTab } from '../components/CompetitorTab'
import { SavedResearchTab } from '../components/SavedResearchTab'
import { CreateVideoProjectModal } from '../components/CreateVideoProjectModal'
import { ResearchSettingsModal } from '../components/ResearchSettingsModal'
import { DeveloperDebugPanel } from '../components/DeveloperDebugPanel'

interface Props {
  onNavigate: (page: string) => void
  project: any
}

type InternalTab = 'discover' | 'keywords' | 'breakouts' | 'trends' | 'competitors' | 'saved'

export function YouTubeResearchPage({ onNavigate }: Props): React.ReactElement {
  const [activeTab, setActiveTab] = useState<InternalTab>('discover')
  const [isAdvancedView, setIsAdvancedView] = useState<boolean>(false)

  // Service & Provider Status
  const [sidecarStatus, setSidecarStatus] = useState<ResearchSidecarStatus | null>(null)
  const [apiReachabilityStatus, setApiReachabilityStatus] = useState<ApiConnectionStatus>('checking')
  const [providerSource, setProviderSource] = useState<ProviderSource>('SCRAPER')
  const [debugMode, setDebugMode] = useState<boolean>(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [discoverErrorDetails, setDiscoverErrorDetails] = useState<unknown>(null)

  // Active Research State
  const [isStartingResearch, setIsStartingResearch] = useState<boolean>(false)
  const [activeProgress, setActiveProgress] = useState<ResearchProgressState | null>(null)
  const [activeResult, setActiveResult] = useState<ResearchRunResult | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined)
  const [isCancelling, setIsCancelling] = useState(false)
  const [sseConnected, setSseConnected] = useState(false)

  // Saved Projects List
  const [savedProjects, setSavedProjects] = useState<SavedResearchProject[]>([])

  // Modals
  const [detailRecord, setDetailRecord] = useState<KeywordMetricRecord | null>(null)
  const [handoffKeyword, setHandoffKeyword] = useState<string | null>(null)
  const [handoffAngle, setHandoffAngle] = useState<string | undefined>(undefined)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)

  const sseCleanupRef = useRef<(() => void) | null>(null)

  // 1. Initial Load: Check sidecar & fetch saved projects
  const refreshStatusAndProjects = async () => {
    setApiReachabilityStatus('checking')
    let isSidecarOnline = false

    try {
      if (window.api?.research) {
        const sStatus = await window.api.research.getStatus()
        setSidecarStatus(sStatus)
        isSidecarOnline = Boolean(sStatus?.online)
        if (sStatus?.url) {
          researchApi.setBaseUrl(sStatus.url)
        }
      }

      // Check health from renderer with limited retry
      let health = null
      let attempts = 0
      while (attempts < 3) {
        try {
          health = await researchApi.checkHealth()
          if (health) break
        } catch {
          attempts++
          if (attempts < 3) {
            await new Promise((r) => setTimeout(r, attempts === 1 ? 400 : 1000))
          }
        }
      }

      if (health && health.status === 'online') {
        setApiReachabilityStatus('reachable')
        const prov = (health.providers?.last_provenance as ProviderSource) || 'SCRAPER'
        setProviderSource(prov)
        setDiscoverError(null)

        const saved = await researchApi.getSavedProjects().catch(() => [])
        setSavedProjects(saved)

        const settings = await researchApi.getSettings().catch(() => null)
        if (settings) {
          setDebugMode(settings.debug_mode)
        }

        // Load latest completed run if no run active
        if (!activeResult) {
          const latest = await researchApi.getLatestRun().catch(() => null)
          if (latest) {
            setActiveResult(latest)
            setActiveRunId(latest.run_id)
          }
        }
      } else {
        setApiReachabilityStatus(isSidecarOnline ? 'blocked' : 'offline')
      }
    } catch (err) {
      console.warn('[YouTubeResearch] Initial status check failed:', err)
      setApiReachabilityStatus(isSidecarOnline ? 'blocked' : 'offline')
    }
  }

  useEffect(() => {
    refreshStatusAndProjects()
    return () => {
      if (sseCleanupRef.current) {
        sseCleanupRef.current()
      }
    }
  }, [])

  // 2. Start Discovery & Stream Progress
  const handleStartDiscover = async (params: {
    topic: string
    market: MarketCode
    content_type: ContentType
    time_range: TimeRange
    limit: number
    filters: ResearchFilters
  }) => {
    // Prevent double-clicks or starting when already active
    if (isStartingResearch || isResearchRunActive(activeProgress)) {
      console.warn('[YouTubeResearch] discover.request.skipped - research already starting or active')
      return
    }

    console.log(`[YouTubeResearch] analyze.click topic="${params.topic}" market=${params.market}`)
    setDiscoverError(null)
    setDiscoverErrorDetails(null)
    setIsStartingResearch(true)

    // Immediate optimistic progress state (<100ms)
    setActiveProgress({
      run_id: null,
      stage: 'STARTING',
      progress_percent: 1,
      message: 'Starting market analysis...',
      videos_collected: 0,
      channels_analyzed: 0,
      keywords_expanded: 0,
      elapsed_seconds: 0,
      can_cancel: false
    })

    // Clean old SSE if any before starting new run
    if (sseCleanupRef.current) {
      sseCleanupRef.current()
      sseCleanupRef.current = null
    }

    try {
      if (apiReachabilityStatus === 'blocked') {
        try {
          const health = await researchApi.checkHealth()
          if (health) setApiReachabilityStatus('reachable')
        } catch (err) {
          const errMsg = 'The local research service is running, but this window cannot connect to its API (connection blocked).'
          console.error(`[YouTubeResearch] discover.request.failed reason=${errMsg}`, err)
          setDiscoverError(errMsg)
          setDiscoverErrorDetails(err)
          setActiveProgress({
            run_id: null,
            stage: 'FAILED',
            progress_percent: 0,
            message: errMsg,
            videos_collected: 0,
            channels_analyzed: 0,
            keywords_expanded: 0,
            elapsed_seconds: 0,
            can_cancel: false,
            error: errMsg
          })
          return
        }
      }

      console.log('[YouTubeResearch] discover.request.start')
      const response = await researchApi.startDiscover(params)
      if (!response?.run_id) {
        throw new Error('Research service did not return a run ID.')
      }

      const run_id = response.run_id
      console.log(`[YouTubeResearch] discover.request.success run_id=${run_id}`)
      setActiveRunId(run_id)
      setActiveProgress((previous) => ({
        run_id,
        stage: 'QUEUED',
        progress_percent: Math.max(previous?.progress_percent ?? 0, 5),
        message: 'Research job queued...',
        videos_collected: 0,
        channels_analyzed: 0,
        keywords_expanded: 0,
        elapsed_seconds: 0,
        can_cancel: true
      }))

      setSseConnected(true)
      const currentRunId = run_id
      const cleanup = researchApi.subscribeProgress(
        run_id,
        (progress) => {
          // Reject stale events from previous or mismatched runs
          if (progress.run_id && progress.run_id !== currentRunId) {
            return
          }
          setActiveProgress((previous) => {
            if (previous && progress.stage === previous.stage && (progress.progress_percent ?? 0) < (previous.progress_percent ?? 0)) {
              return { ...progress, progress_percent: previous.progress_percent }
            }
            return progress
          })
        },
        (error) => {
          console.warn('[YouTubeResearch] progress.sse.warning:', error)
          setSseConnected(false)
          const isDisconnect =
            (error as any).code === 'SIDECAR_DISCONNECTED' ||
            (error as any).code === 'POLLING_EXHAUSTED' ||
            error.message?.includes('disconnected') ||
            error.message?.includes('exhausted')
          if (isDisconnect) {
            console.warn(`[YouTubeResearch] run.interrupted run_id=${currentRunId}`)
            setActiveProgress({
              run_id: currentRunId,
              stage: 'INTERRUPTED',
              progress_percent: 15,
              message: 'The local research service stopped unexpectedly. Your research run was interrupted. Restart the service and try again.',
              videos_collected: 0,
              channels_analyzed: 0,
              keywords_expanded: 0,
              elapsed_seconds: 0,
              can_cancel: false,
              error: 'Research service disconnected'
            })
          }
        },
        async (completedState) => {
          setSseConnected(false)
          console.log(`[YouTubeResearch] progress.terminal stage=${completedState.stage}`)
          if (completedState.stage === 'COMPLETED') {
            try {
              const fullResult = await researchApi.getRunResult(currentRunId)
              setActiveResult(fullResult)
              setProviderSource(fullResult.provider_source)
            } catch (err) {
              console.error('[YouTubeResearch] Failed to fetch completed run result:', err)
            }
          }
        }
      )

      sseCleanupRef.current = cleanup
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[YouTubeResearch] discover.request.failed reason=${msg}`, err)
      setDiscoverError(msg)
      setDiscoverErrorDetails(err)
      setActiveProgress({
        run_id: null,
        stage: 'FAILED',
        progress_percent: 0,
        message: msg,
        videos_collected: 0,
        channels_analyzed: 0,
        keywords_expanded: 0,
        elapsed_seconds: 0,
        can_cancel: false,
        error: msg
      })
    } finally {
      setIsStartingResearch(false)
    }
  }

  // 3. Cancel Research
  const handleCancelResearch = async () => {
    if (!activeRunId || isCancelling) return
    setIsCancelling(true)
    try {
      await researchApi.cancelRun(activeRunId)
    } catch (err) {
      console.warn('[Research] Cancel failed:', err)
    } finally {
      setIsCancelling(false)
    }
  }

  // 4. Restart Sidecar
  const handleRestartSidecar = async () => {
    try {
      if (window.api?.research) {
        const s = await window.api.research.restartSidecar()
        setSidecarStatus(s)
        await refreshStatusAndProjects()
      }
    } catch (err) {
      alert(`Failed to restart sidecar: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 5. Saved Projects Management
  const handleOpenSavedProject = async (proj: SavedResearchProject) => {
    if (proj.last_run_id) {
      try {
        const res = await researchApi.getRunResult(proj.last_run_id)
        setActiveResult(res)
        setActiveRunId(res.run_id)
        setActiveTab('discover')
      } catch (err) {
        alert(`Failed to load saved dossier: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const handleRenameSavedProject = async (id: string, newName: string) => {
    await researchApi.renameSavedProject(id, newName)
    const updated = await researchApi.getSavedProjects()
    setSavedProjects(updated)
  }

  const handleDeleteSavedProject = async (id: string) => {
    await researchApi.deleteSavedProject(id)
    const updated = await researchApi.getSavedProjects()
    setSavedProjects(updated)
  }

  const handleRefreshSavedProject = async (proj: SavedResearchProject) => {
    setActiveTab('discover')
    handleStartDiscover({
      topic: proj.seed_topic,
      market: proj.market,
      content_type: proj.content_type,
      time_range: proj.time_range,
      limit: 50,
      filters: {}
    })
  }

  // 6. Project Handoff
  const handleConfirmHandoff = async (payload: ResearchProjectHandoffPayload) => {
    if (!window.api?.research?.createProjectHandoff) {
      throw new Error('Project handoff IPC is unavailable in this session')
    }

    const res = await window.api.research.createProjectHandoff(payload)
    if (res.success && res.projectDir) {
      // Open the newly created project in the app!
      if (window.api?.project?.open) {
        const openRes = await window.api.project.open(res.projectDir)
        if (openRes.success) {
          onNavigate('input')
        }
      }
    } else {
      throw new Error(res.error || 'Failed creating project')
    }
  }

  return (
    <ResearchErrorBoundary>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-base, #0a0a0f)',
        color: 'var(--text-primary)',
        overflowY: 'auto'
      }}>
        {/* Top Header */}
        <ResearchHeader
          providerSource={providerSource}
          isAdvancedView={isAdvancedView}
          onToggleView={() => setIsAdvancedView(!isAdvancedView)}
          onOpenSettings={() => setSettingsModalOpen(true)}
          sidecarStatus={sidecarStatus?.status || 'running'}
          apiReachabilityStatus={apiReachabilityStatus}
          onRestartSidecar={handleRestartSidecar}
          onRetryConnection={refreshStatusAndProjects}
          hasExecutedRun={activeResult !== null}
          lastResearchTopic={activeResult?.topic}
        />

        {/* Internal Sub-Navigation Bar */}
        <div style={{
          display: 'flex',
          gap: '8px',
          padding: '12px 24px',
          background: 'var(--bg-elevated, #13141c)',
          borderBottom: '1px solid var(--border-subtle)'
        }}>
          <button
            className={`btn ${activeTab === 'discover' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('discover')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            🔍 Discover
          </button>
          <button
            className={`btn ${activeTab === 'keywords' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('keywords')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            📊 Keyword Explorer {activeResult ? `(${activeResult.keywords.length})` : ''}
          </button>
          <button
            className={`btn ${activeTab === 'breakouts' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('breakouts')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            🚀 Breakout Videos {activeResult ? `(${activeResult.breakout_videos.length})` : ''}
          </button>
          <button
            className={`btn ${activeTab === 'trends' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('trends')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            📈 Trend Radar
          </button>
          <button
            className={`btn ${activeTab === 'competitors' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('competitors')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            🎯 Competitors
          </button>
          <button
            className={`btn ${activeTab === 'saved' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('saved')}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            📁 Saved Research ({savedProjects.length})
          </button>
        </div>

        {/* Tab Content Body */}
        <div style={{ padding: '24px', flex: 1, maxWidth: '1440px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
          {activeTab === 'discover' && (
            <DiscoverTab
              onStartDiscover={handleStartDiscover}
              onExpandKeywords={async (topic, market) => {
                const res = await researchApi.expandKeywords(topic, market)
                return res.keywords
              }}
              activeProgress={activeProgress}
              activeResult={activeResult}
              onCancelResearch={handleCancelResearch}
              isCancelling={isCancelling}
              onSelectKeyword={(kw) => {
                const found = activeResult?.keywords.find((k) => k.keyword.toLowerCase() === kw.toLowerCase())
                if (found) setDetailRecord(found)
              }}
              onCreateProject={(kw, angle) => {
                setHandoffKeyword(kw)
                setHandoffAngle(angle)
              }}
              onNavigateTab={(tab) => setActiveTab(tab as InternalTab)}
              apiReachabilityStatus={apiReachabilityStatus}
              isStartingResearch={isStartingResearch}
              errorMessage={discoverError}
              errorDetails={discoverErrorDetails}
              onDismissError={() => {
                setDiscoverError(null)
                setDiscoverErrorDetails(null)
                if (activeProgress && ['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(activeProgress.stage)) {
                  setActiveProgress(null)
                }
              }}
              onRetryConnection={refreshStatusAndProjects}
              onRestartSidecar={handleRestartSidecar}
              isAdvancedView={isAdvancedView}
            />
          )}

          {activeTab === 'keywords' && (
            <KeywordExplorerTab
              keywords={activeResult?.keywords || []}
              isAdvancedView={isAdvancedView}
              onOpenDetail={(rec) => setDetailRecord(rec)}
              onCreateProject={(kw) => {
                setHandoffKeyword(kw)
              }}
            />
          )}

          {activeTab === 'breakouts' && (
            <BreakoutVideosTab
              breakoutVideos={activeResult?.breakout_videos || []}
              onCreateProjectFromVideo={(title) => {
                setHandoffKeyword(title)
              }}
            />
          )}

          {activeTab === 'trends' && (
            <TrendRadarTab
              radarItems={activeResult?.trend_radar || []}
              onSelectTopic={(t) => {
                setActiveTab('keywords')
              }}
              onCreateProject={(t) => {
                setHandoffKeyword(t)
              }}
            />
          )}

          {activeTab === 'competitors' && (
            <CompetitorTab
              onAnalyzeCompetitor={(url, mkt) => researchApi.analyzeCompetitor(url, mkt)}
              onCreateProjectFromVideo={(title) => {
                setHandoffKeyword(title)
              }}
            />
          )}

          {activeTab === 'saved' && (
            <SavedResearchTab
              savedProjects={savedProjects}
              onOpenProject={handleOpenSavedProject}
              onRenameProject={handleRenameSavedProject}
              onDeleteProject={handleDeleteSavedProject}
              onRefreshData={handleRefreshSavedProject}
              onCreateVideoProject={(kw) => {
                setHandoffKeyword(kw)
              }}
            />
          )}

          {/* Developer Debug Panel */}
          {debugMode && (
            <DeveloperDebugPanel
              sidecarStatus={sidecarStatus}
              providerSource={providerSource}
              activeRunId={activeRunId}
              sseConnected={sseConnected}
            />
          )}
        </div>

        {/* Keyword Detail Modal */}
        {detailRecord && (
          <KeywordDetailModal
            record={detailRecord}
            onClose={() => setDetailRecord(null)}
            onCreateProject={(kw) => {
              setHandoffKeyword(kw)
            }}
          />
        )}

        {/* Create Video Project Handoff Modal */}
        {handoffKeyword && (
          <CreateVideoProjectModal
            initialKeyword={handoffKeyword}
            initialAngle={handoffAngle}
            researchResult={activeResult}
            onClose={() => {
              setHandoffKeyword(null)
              setHandoffAngle(undefined)
            }}
            onConfirmHandoff={handleConfirmHandoff}
          />
        )}

        {/* Research Settings Modal */}
        {settingsModalOpen && (
          <ResearchSettingsModal
            onClose={() => setSettingsModalOpen(false)}
            onSettingsUpdated={refreshStatusAndProjects}
            onRestartSidecar={handleRestartSidecar}
          />
        )}
      </div>
    </ResearchErrorBoundary>
  )
}
