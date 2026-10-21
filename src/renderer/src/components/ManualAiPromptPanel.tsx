import type {
  AutoPipelineState,
  EditorialGenerationSettings,
  ManualAiImportMapping,
  ManualAiImportPlan,
  ManualAiImportRejection,
  ManualAiStatus,
  ProjectState
} from '../../../../shared/types'
import { resolveAiImageMode, resolveVisualMixConfig } from '../../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'

interface ManualAiPromptPanelProps {
  project: ProjectState
  pipelineState: AutoPipelineState | null
}

export type ManualAiPanelState =
  | 'loading'
  | 'bridge-unavailable'
  | 'waiting-for-prompts'
  | 'waiting-for-images'
  | 'ready'
  | 'error'

const MAX_MISSING_PREVIEW = 40

function copyToClipboard(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function formatMissing(indices: number[]): string {
  if (indices.length === 0) return '—'
  const shown = indices.slice(0, MAX_MISSING_PREVIEW).join(', ')
  return indices.length > MAX_MISSING_PREVIEW ? `${shown}, … (+${indices.length - MAX_MISSING_PREVIEW})` : shown
}

const cardStyle: React.CSSProperties = {
  marginTop: '16px',
  padding: '16px 20px',
  borderRadius: 'var(--radius-lg, 12px)',
  border: '1px solid rgba(129, 140, 248, 0.35)',
  background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.10), rgba(14, 165, 233, 0.06))',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px'
}

const statBoxStyle: React.CSSProperties = {
  flex: '1 1 160px',
  padding: '10px 14px',
  borderRadius: '8px',
  background: 'rgba(0, 0, 0, 0.25)',
  border: '1px solid rgba(255, 255, 255, 0.08)'
}

interface VideoImportSelection {
  mode: 'files' | 'folder'
  folderPath?: string
  filePaths: string[]
  mappedCount: number
  rejectedCount: number
  mappings: ManualAiImportMapping[]
  rejections: ManualAiImportRejection[]
  needsConfirmation?: boolean
}

interface MixedMediaSelection {
  mode: 'files' | 'folder'
  folderPath?: string
  filePaths: string[]
  imageCount: number
  videoCount: number
  mappedCount: number
  rejectedCount: number
  mappings: ManualAiImportMapping[]
  rejections: ManualAiImportRejection[]
  needsConfirmation?: boolean
}

export function ManualAiPromptPanel({ project, pipelineState }: ManualAiPromptPanelProps): React.ReactElement | null {
  const projectDir = project.projectDir
  const mix = resolveVisualMixConfig({
    visualSourceMode: project.inputs.visualSourceMode,
    visualMixConfig: project.inputs.visualMixConfig,
    contentType: project.inputs.contentType
  })
  const isPromptMode =
    mix.mode === 'custom-mix' && mix.aiImageRatio > 0 && resolveAiImageMode(mix) === 'prompt'

  const hasBridge = typeof window !== 'undefined' && Boolean(window.api?.manualAi)

  const [status, setStatus] = useState<ManualAiStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<ManualAiImportPlan | null>(null)
  const [videoSelection, setVideoSelection] = useState<VideoImportSelection | null>(null)
  const [mixedSelection, setMixedSelection] = useState<MixedMediaSelection | null>(null)
  const [pendingRejections, setPendingRejections] = useState<ManualAiImportRejection[]>([])
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [showVideoImportMenu, setShowVideoImportMenu] = useState(false)
  const [showMixedImportMenu, setShowMixedImportMenu] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const [editorialSettings, setEditorialSettings] = useState<EditorialGenerationSettings | null>(null)
  const [showSourceOnlyConfirm, setShowSourceOnlyConfirm] = useState(false)
  const lastVersion = useRef<number | undefined>(undefined)
  const bridgeLoggedRef = useRef(false)

  // Warn once in console if preload bridge is missing
  useEffect(() => {
    if (!hasBridge && !bridgeLoggedRef.current) {
      bridgeLoggedRef.current = true
      console.error(
        '[ManualAI] window.api.manualAi is unavailable. The preload bundle may be stale or not loaded.'
      )
    }
  }, [hasBridge])

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectDir) return
    if (!window.api?.manualAi) {
      return
    }
    try {
      const s = await window.api.manualAi.getStatus(projectDir)
      setStatus(s)
      if (window.api.manualAi.getEditorialSettings) {
        const ed = await window.api.manualAi.getEditorialSettings(projectDir)
        if (ed.success && ed.settings) {
          setEditorialSettings(ed.settings)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[ManualAI] getStatus failed:', msg)
      setNotice(`Unable to read Manual AI status: ${msg}`)
    }
  }, [projectDir])

  // Initial load + push updates from the importer / engine broadcaster.
  useEffect(() => {
    if (!isPromptMode || !projectDir) return
    void refresh()
    const off = window.api?.manualAi?.onStatusUpdated?.((payload) => {
      if (payload.projectDir === projectDir) {
        setStatus(payload.status)
      }
    })
    return () => {
      off?.()
    }
  }, [isPromptMode, projectDir, refresh])

  // Re-read the status whenever the running pipeline publishes a new state.
  useEffect(() => {
    if (!isPromptMode || !projectDir) return
    const v = pipelineState?.version
    if (v !== lastVersion.current) {
      lastVersion.current = v
      void refresh()
    }
  }, [isPromptMode, projectDir, pipelineState?.version, refresh])

  const stockStage = pipelineState?.stages?.['stock-search']
  const waitInfo = stockStage?.manualAiWait

  // Section 11: Combine direct Manual AI IPC status and pipeline stage metadata as fallback
  const effectiveExpected = status?.expected ?? waitInfo?.expected ?? 0
  const effectiveReady = status?.ready ?? waitInfo?.ready ?? 0
  const effectivePromptFilePath = status?.promptFilePath ?? waitInfo?.promptFilePath
  const effectiveHasPromptPack = Boolean(status?.hasPromptPack || waitInfo?.promptFilePath)
  const effectiveAllReady = Boolean(
    status?.allReady || (effectiveExpected > 0 && effectiveReady >= effectiveExpected)
  )
  const effectiveMissingCount = Math.max(0, effectiveExpected - effectiveReady)

  const stockExpected = waitInfo?.stockExpected ?? 0
  const stockReady = waitInfo?.stockReady ?? 0
  const showStock = Boolean(waitInfo)

  const missing = status?.missingSceneIndices?.length
    ? status.missingSceneIndices
    : waitInfo?.missingSceneIndices ?? []
  const staleCount = status?.staleSceneIndices?.length ?? 0

  const rows = useMemo(() => status?.rows ?? [], [status])

  // Section 31: Low-frequency status refresh fallback (every 2.5s) while waiting for AI images
  useEffect(() => {
    if (!isPromptMode || !projectDir || !hasBridge) return
    if (effectiveAllReady) return
    const isWaiting = Boolean(waitInfo && !effectiveAllReady)
    if (!isWaiting) return

    const timer = setInterval(() => {
      void refresh()
    }, 2500)
    return () => {
      clearInterval(timer)
    }
  }, [isPromptMode, projectDir, hasBridge, effectiveAllReady, Boolean(waitInfo), refresh])

  if (!isPromptMode) return null

  // Section 5 & 42: Explicit error display when preload bridge is missing
  if (!hasBridge) {
    return (
      <div id="manual-ai-prompt-panel" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>AI Prompt Images</div>
            <div style={{ fontSize: '12px', color: '#f87171', marginTop: '4px' }}>
              Manual AI bridge unavailable. The Electron preload bundle may be stale or not loaded. Restart the application after rebuilding preload.
            </div>
          </div>
          <span
            id="manual-ai-status-pill"
            style={{
              padding: '4px 12px',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(239, 68, 68, 0.15)',
              color: '#f87171'
            }}
          >
            Bridge Unavailable
          </span>
        </div>
      </div>
    )
  }

  async function handleCopyAll(): Promise<void> {
    if (!window.api?.manualAi) return
    const res = await window.api.manualAi.getPromptText(projectDir)
    if (!res.success || !res.text) {
      setNotice(res.error || 'No prompt pack exists yet.')
      return
    }
    setNotice(
      copyToClipboard(res.text)
        ? `Copied ${effectiveExpected} prompts to clipboard.`
        : 'Could not access the clipboard.'
    )
  }

  async function handleCopyAllVideoPrompts(): Promise<void> {
    if (!window.api?.manualAi) return
    try {
      const res = await window.api.manualAi.getVideoPromptText(projectDir, editorialSettings ?? undefined)
      if (!res.success || !res.text) {
        setNotice(res.error || 'Video prompts are unavailable.')
        return
      }
      const copied = copyToClipboard(res.text)
      const modeLabel = editorialSettings?.promptMode === 'embedded-editorial' ? 'editorial video' : 'video'
      setNotice(
        copied
          ? `Copied ${effectiveExpected} ${modeLabel} prompts to clipboard.`
          : 'Could not access the clipboard.'
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateEditorialSettings(patch: Partial<EditorialGenerationSettings>): Promise<void> {
    if (!window.api?.manualAi?.updateEditorialSettings || !projectDir) return
    try {
      const res = await window.api.manualAi.updateEditorialSettings(projectDir, patch)
      if (res.success && res.settings) {
        setEditorialSettings(res.settings)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleExport(): Promise<void> {
    if (!window.api?.manualAi) return
    const res = await window.api.manualAi.exportTxt(projectDir)
    if (res.canceled) return
    setNotice(res.success ? `Exported to ${res.filePath}` : res.error || 'Export failed.')
  }

  async function handleOpenFile(): Promise<void> {
    if (!window.api?.manualAi) return
    const res = await window.api.manualAi.openPromptFile(projectDir)
    if (!res.success) setNotice(res.error || 'Could not open the prompt file.')
  }

  async function commit(
    mappings: ManualAiImportMapping[],
    opts: { replaceExisting?: boolean; allowLowResolution?: boolean } = {}
  ): Promise<void> {
    if (!window.api?.manualAi) return
    setBusy(true)
    try {
      const res = await window.api.manualAi.commitImport({ projectDir, mappings, ...opts })
      if (!res.success || !res.result) {
        setNotice(res.error || 'Import failed.')
        return
      }
      setStatus(res.result.status)
      setPendingRejections((prev) => [
        ...prev.filter((r) => !mappings.some((m) => m.filePath === r.filePath)),
        ...res.result!.rejections
      ])
      const n = res.result.imported.length
      setNotice(
        `${n} asset${n === 1 ? '' : 's'} imported · ${res.result.status.ready}/${res.result.status.expected} ready` +
          (res.result.rejections.length > 0 ? ` · ${res.result.rejections.length} need attention` : '')
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleSelect(mode: 'files' | 'folder', mediaType: 'image' | 'video' = 'image'): Promise<void> {
    if (!window.api?.manualAi) return
    setShowImportMenu(false)
    setShowVideoImportMenu(false)
    setShowMixedImportMenu(false)
    setNotice(null)
    const picked = mediaType === 'video'
      ? await window.api.manualAi.selectVideos(mode)
      : await window.api.manualAi.selectImages(mode)
    if (!picked.success) {
      setNotice(picked.error || 'Could not open the file picker.')
      return
    }
    if (picked.filePaths.length === 0) {
      if (!picked.canceled) {
        setNotice(
          mediaType === 'video'
            ? 'No supported videos (MP4, MOV, WEBM, MKV) found.'
            : 'No supported images (PNG, JPG, JPEG, WEBP) found.'
        )
      }
      return
    }
    const planned = await window.api.manualAi.planImport({
      projectDir,
      filePaths: picked.filePaths,
      ...(mediaType === 'video' ? { mediaType: 'video' as const } : {})
    })
    if (!planned.success || !planned.plan) {
      setNotice(planned.error || 'Could not analyse the selected files.')
      return
    }
    setPendingRejections(planned.plan.rejections)

    if (mediaType === 'video') {
      // Always provide video selection preview for folder or unnumbered files before committing (Sections 28-30)
      if (mode === 'folder' || planned.plan.needsConfirmation) {
        setVideoSelection({
          mode,
          folderPath: (picked as any).folderPath,
          filePaths: picked.filePaths,
          mappedCount: planned.plan.mappings.length,
          rejectedCount: planned.plan.rejections.length,
          mappings: planned.plan.mappings,
          rejections: planned.plan.rejections,
          needsConfirmation: planned.plan.needsConfirmation
        })
        return
      }
      setVideoSelection(null)
      if (planned.plan.mappings.length > 0) {
        await commit(planned.plan.mappings)
      } else {
        setNotice('No videos could be mapped to AI scenes. See the messages below.')
      }
      return
    }

    if (planned.plan.needsConfirmation) {
      // Guessed (natural-sort) mapping: NEVER commit silently.
      setPlan(planned.plan)
      return
    }
    setPlan(null)
    if (planned.plan.mappings.length > 0) await commit(planned.plan.mappings)
    else setNotice('Nothing could be imported. See the messages below.')
  }

  async function handleSelectMixed(mode: 'files' | 'folder'): Promise<void> {
    if (!window.api?.manualAi) return
    setShowImportMenu(false)
    setShowVideoImportMenu(false)
    setShowMixedImportMenu(false)
    setNotice(null)

    const picked = await (window.api.manualAi as any).selectMixed(mode)
    if (!picked.success) {
      setNotice(picked.error || 'Could not open the file picker.')
      return
    }
    if (picked.filePaths.length === 0) {
      if (!picked.canceled) {
        setNotice('No supported media files (Images: PNG, JPG, JPEG, WEBP / Videos: MP4, MOV, WEBM, MKV) found.')
      }
      return
    }

    const planned = await window.api.manualAi.planImport({
      projectDir,
      filePaths: picked.filePaths,
      mediaType: 'mixed'
    })
    if (!planned.success || !planned.plan) {
      setNotice(planned.error || 'Could not analyse the selected files.')
      return
    }
    setPendingRejections(planned.plan.rejections)

    const imgCount = picked.imageCount ?? picked.filePaths.filter((f: string) => /\.(png|jpg|jpeg|webp)$/i.test(f)).length
    const vidCount = picked.videoCount ?? picked.filePaths.filter((f: string) => /\.(mp4|mov|webm|mkv)$/i.test(f)).length

    setMixedSelection({
      mode,
      folderPath: picked.folderPath,
      filePaths: picked.filePaths,
      imageCount: imgCount,
      videoCount: vidCount,
      mappedCount: planned.plan.mappings.length,
      rejectedCount: planned.plan.rejections.length,
      mappings: planned.plan.mappings,
      rejections: planned.plan.rejections,
      needsConfirmation: planned.plan.needsConfirmation
    })
  }

  function createMappingFromRejection(r: ManualAiImportRejection): ManualAiImportMapping | null {
    if (r.sceneIndex === undefined) return null
    const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(r.filePath)
    return {
      filePath: r.filePath,
      fileName: r.fileName,
      sceneIndex: r.sceneIndex,
      via: 'filename',
      ...(isVideo ? { mediaType: 'video' as const } : {})
    }
  }

  const rejectionAction = (r: ManualAiImportRejection): React.ReactNode => {
    const mapping = createMappingFromRejection(r)
    if (!mapping) return null
    if (r.code === 'LOW_RESOLUTION') {
      return (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => void commit([mapping], { allowLowResolution: true })}
        >
          Use Anyway
        </button>
      )
    }
    if (r.code === 'ALREADY_IMPORTED') {
      return (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => void commit([mapping], { replaceExisting: true })}
        >
          Replace
        </button>
      )
    }
    return null
  }

  return (
    <div id="manual-ai-prompt-panel" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>AI Prompt Images</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            AI Image Mode: <strong>Prompt</strong> ·{' '}
            {effectiveHasPromptPack
              ? `${effectiveExpected} prompts ready`
              : 'Prompts are generated when Find Visuals starts'}
          </div>
        </div>
        <span
          id="manual-ai-status-pill"
          style={{
            padding: '4px 12px',
            borderRadius: '999px',
            fontSize: '12px',
            fontWeight: 600,
            background: effectiveAllReady
              ? 'rgba(34, 197, 94, 0.15)'
              : !effectiveHasPromptPack
                ? 'rgba(148, 163, 184, 0.15)'
                : 'rgba(251, 191, 36, 0.15)',
            color: effectiveAllReady
              ? '#4ade80'
              : !effectiveHasPromptPack
                ? '#94a3b8'
                : '#fbbf24'
          }}
        >
          {!effectiveHasPromptPack
            ? 'Waiting for prompts'
            : effectiveAllReady
              ? 'All AI images ready ✓'
              : `Waiting for ${effectiveMissingCount} AI image${effectiveMissingCount === 1 ? '' : 's'}`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Prompts</div>
          <div id="manual-ai-prompts-count" style={{ fontSize: '15px', fontWeight: 700 }}>
            {effectiveHasPromptPack
              ? `${effectiveExpected} / ${effectiveExpected} generated ✓`
              : '0 / 0 generated'}
          </div>
        </div>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>AI Images</div>
          <div id="manual-ai-imported-count" style={{ fontSize: '15px', fontWeight: 700 }}>
            {effectiveReady} / {effectiveExpected} imported
          </div>
        </div>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Real Footage</div>
          <div id="manual-ai-stock-count" style={{ fontSize: '15px', fontWeight: 700 }}>
            {showStock
              ? `${stockReady} / ${stockExpected} ready${stockReady >= stockExpected && stockExpected > 0 ? ' ✓' : ''}`
              : '—'}
          </div>
        </div>
      </div>

      {/* Universal AI-Embedded Editorial Director Controls */}
      <div
        style={{
          padding: '12px 16px',
          borderRadius: '8px',
          background: 'rgba(15, 23, 42, 0.45)',
          border: '1px solid rgba(129, 140, 248, 0.2)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              🎬 Video Prompt Style:
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '12px',
                background: editorialSettings?.promptMode === 'embedded-editorial' ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                color: editorialSettings?.promptMode === 'embedded-editorial' ? '#a5b4fc' : 'var(--text-secondary)'
              }}
            >
              {editorialSettings?.promptMode === 'embedded-editorial' ? 'AI Embedded Editorial Active' : 'Classic Mode'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              id="editorial-mode-classic"
              className={`btn btn-sm ${editorialSettings?.promptMode !== 'embedded-editorial' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => void handleUpdateEditorialSettings({ promptMode: 'classic' })}
            >
              Classic (Original)
            </button>
            <button
              type="button"
              id="editorial-mode-embedded"
              className={`btn btn-sm ${editorialSettings?.promptMode === 'embedded-editorial' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => void handleUpdateEditorialSettings({ promptMode: 'embedded-editorial' })}
            >
              AI Embedded Editorial
            </button>
          </div>
        </div>

        {editorialSettings?.promptMode === 'embedded-editorial' && (
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-secondary)', paddingTop: '4px', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                id="editorial-senior-friendly-toggle"
                checked={editorialSettings.readability === 'senior-friendly'}
                onChange={(e) => void handleUpdateEditorialSettings({ readability: e.target.checked ? 'senior-friendly' : 'standard' })}
              />
              Senior-Friendly Readability (50+ Contrast & Sizing)
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                id="editorial-density-toggle"
                checked={editorialSettings.labelDensity === 'balanced'}
                onChange={(e) => void handleUpdateEditorialSettings({ labelDensity: e.target.checked ? 'balanced' : 'minimal' })}
              />
              Balanced Density (Include grounded focus labels)
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                id="editorial-leader-lines-toggle"
                checked={editorialSettings.preferLeaderLines}
                onChange={(e) => void handleUpdateEditorialSettings({ preferLeaderLines: e.target.checked })}
              />
              Include Graphic Leader Lines
            </label>
          </div>
        )}

        {/* Render Presentation Mode selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              ⚡ Render Output Mode:
            </span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: editorialSettings?.renderOverlayMode === 'source-only' ? '#38bdf8' : '#a3e635' }}>
              {editorialSettings?.renderOverlayMode === 'source-only' ? 'Source Only (Overlays Omitted)' : 'Full Production (Remotion Captions + Overlays)'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              id="render-mode-full"
              className={`btn btn-sm ${editorialSettings?.renderOverlayMode !== 'source-only' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => void handleUpdateEditorialSettings({ renderOverlayMode: 'full' })}
            >
              Full (Default)
            </button>
            <button
              type="button"
              id="render-mode-source-only"
              className={`btn btn-sm ${editorialSettings?.renderOverlayMode === 'source-only' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                if (editorialSettings?.renderOverlayMode !== 'source-only') {
                  setShowSourceOnlyConfirm(true)
                }
              }}
            >
              Source Only (Low-Memory)
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showSourceOnlyConfirm}
        title="Activate Source Only Render Mode?"
        message="Source Only mode renders directly from imported/generated visuals and audio without app-generated visual overlays.

Trade-offs:
• Remotion dynamic captions will NOT be rendered
• Proof Visual overlays will NOT be rendered
• Visual Scene Grammar overlays will NOT be rendered
• Opening graphic overlays will NOT be rendered

Voiceover, music, footage, scene transitions, and final QA remain 100% intact. Labels must already exist in source media."
        confirmText="Activate Source Only"
        cancelText="Keep Full Mode"
        onConfirm={() => {
          setShowSourceOnlyConfirm(false)
          void handleUpdateEditorialSettings({ renderOverlayMode: 'source-only' })
        }}
        onCancel={() => setShowSourceOnlyConfirm(false)}
      />

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', position: 'relative', alignItems: 'center' }}>
        <button
          type="button"
          id="manual-ai-copy-all"
          className="btn btn-secondary btn-sm"
          disabled={!effectiveHasPromptPack}
          onClick={() => void handleCopyAll()}
        >
          Copy All Prompts
        </button>
        <button
          type="button"
          id="manual-ai-copy-all-video-prompts"
          className="btn btn-secondary btn-sm"
          disabled={!effectiveHasPromptPack || busy}
          onClick={() => void handleCopyAllVideoPrompts()}
        >
          Copy All Video Prompts
        </button>
        <button
          type="button"
          id="manual-ai-export-txt"
          className="btn btn-secondary btn-sm"
          disabled={!effectiveHasPromptPack}
          onClick={() => void handleExport()}
        >
          Export TXT
        </button>
        <button
          type="button"
          id="manual-ai-open-file"
          className="btn btn-secondary btn-sm"
          disabled={!effectiveHasPromptPack || !effectivePromptFilePath}
          onClick={() => void handleOpenFile()}
        >
          Open Prompt File
        </button>

        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            id="manual-ai-import"
            className="btn btn-primary btn-sm"
            disabled={!effectiveHasPromptPack || effectiveExpected === 0 || busy}
            onClick={() => { setShowVideoImportMenu(false); setShowMixedImportMenu(false); setShowImportMenu((v) => !v) }}
          >
            Import AI Images ▾
          </button>
          {showImportMenu && (
            <div
              id="manual-ai-import-menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(129, 140, 248, 0.4)',
                borderRadius: '6px',
                padding: '6px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                minWidth: '150px'
              }}
            >
              <button
                type="button"
                id="manual-ai-import-files"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelect('files')}
              >
                Select Images…
              </button>
              <button
                type="button"
                id="manual-ai-import-folder"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelect('folder')}
              >
                Select Folder…
              </button>
            </div>
          )}
        </div>

        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            id="manual-ai-import-videos"
            className="btn btn-secondary btn-sm"
            disabled={!effectiveHasPromptPack || effectiveExpected === 0 || busy}
            onClick={() => { setShowImportMenu(false); setShowMixedImportMenu(false); setShowVideoImportMenu((v) => !v) }}
          >
            Import AI Videos ▾
          </button>
          {showVideoImportMenu && (
            <div
              id="manual-ai-video-import-menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(129, 140, 248, 0.4)',
                borderRadius: '6px',
                padding: '6px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                minWidth: '160px'
              }}
            >
              <button
                type="button"
                id="manual-ai-import-video-files"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelect('files', 'video')}
              >
                Select Videos…
              </button>
              <button
                type="button"
                id="manual-ai-import-video-folder"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelect('folder', 'video')}
              >
                Select Video Folder…
              </button>
            </div>
          )}
        </div>

        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            id="manual-ai-import-mixed"
            className="btn btn-secondary btn-sm"
            disabled={!effectiveHasPromptPack || effectiveExpected === 0 || busy}
            onClick={() => {
              setShowImportMenu(false)
              setShowVideoImportMenu(false)
              setShowMixedImportMenu((v) => !v)
            }}
          >
            Import Mixed Media ▾
          </button>
          {showMixedImportMenu && (
            <div
              id="manual-ai-mixed-import-menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(129, 140, 248, 0.4)',
                borderRadius: '6px',
                padding: '6px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                minWidth: '160px'
              }}
            >
              <button
                type="button"
                id="manual-ai-import-mixed-files"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelectMixed('files')}
              >
                Select Mixed Files…
              </button>
              <button
                type="button"
                id="manual-ai-import-mixed-folder"
                className="btn btn-secondary btn-sm"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => void handleSelectMixed('folder')}
              >
                Select Mixed Folder…
              </button>
            </div>
          )}
        </div>
      </div>

      {videoSelection && (
        <div
          id="manual-ai-video-import-preview"
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.4)',
            border: '1px solid rgba(129, 140, 248, 0.4)'
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
            {videoSelection.mode === 'folder' ? 'Video Folder Discovery Result' : 'Selected Video Files'}
          </div>
          {videoSelection.folderPath && (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', fontFamily: 'monospace' }}>
              Source: {videoSelection.folderPath}
            </div>
          )}
          <div style={{ fontSize: '12px', color: '#93c5fd', marginBottom: '8px' }}>
            {videoSelection.filePaths.length} video{videoSelection.filePaths.length === 1 ? '' : 's'} discovered ·{' '}
            {videoSelection.mappedCount} AI scene{videoSelection.mappedCount === 1 ? '' : 's'} matched ·{' '}
            {videoSelection.rejectedCount} rejected
          </div>
          {videoSelection.mappings.length > 0 && (
            <div style={{ maxHeight: '140px', overflowY: 'auto', fontSize: '12px', fontFamily: 'monospace', marginBottom: '8px' }}>
              {videoSelection.mappings.map((m) => (
                <div key={m.filePath} style={{ color: 'var(--text-secondary)' }}>
                  {m.fileName} → Scene {m.sceneIndex}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            {videoSelection.mappings.length > 0 && (
              <button
                type="button"
                id="manual-ai-confirm-video-import"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => {
                  const mappings = videoSelection.mappings
                  setVideoSelection(null)
                  void commit(mappings)
                }}
              >
                Import {videoSelection.mappings.length} Video{videoSelection.mappings.length === 1 ? '' : 's'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setVideoSelection(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mixedSelection && (
        <div
          id="manual-ai-mixed-import-preview"
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.4)',
            border: '1px solid rgba(129, 140, 248, 0.4)'
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
            {mixedSelection.mode === 'folder' ? 'Mixed Media Folder Discovery Result' : 'Selected Mixed Media Files'}
          </div>
          {mixedSelection.folderPath && (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', fontFamily: 'monospace' }}>
              Source: {mixedSelection.folderPath}
            </div>
          )}
          <div style={{ fontSize: '12px', color: '#93c5fd', marginBottom: '8px' }}>
            {mixedSelection.filePaths.length} media file{mixedSelection.filePaths.length === 1 ? '' : 's'} discovered ·{' '}
            {mixedSelection.imageCount} image{mixedSelection.imageCount === 1 ? '' : 's'} ·{' '}
            {mixedSelection.videoCount} video{mixedSelection.videoCount === 1 ? '' : 's'} ·{' '}
            {mixedSelection.mappedCount} AI scene{mixedSelection.mappedCount === 1 ? '' : 's'} matched ·{' '}
            {mixedSelection.rejectedCount} rejected
          </div>
          {mixedSelection.mappings.length > 0 && (
            <div style={{ maxHeight: '140px', overflowY: 'auto', fontSize: '12px', fontFamily: 'monospace', marginBottom: '8px' }}>
              {mixedSelection.mappings.map((m) => (
                <div key={m.filePath} style={{ color: 'var(--text-secondary)' }}>
                  {m.fileName} → Scene {m.sceneIndex} [{m.mediaType === 'video' ? 'VIDEO' : 'IMAGE'}]
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            {mixedSelection.mappings.length > 0 && (
              <button
                type="button"
                id="manual-ai-confirm-mixed-import"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => {
                  const mappings = mixedSelection.mappings
                  setMixedSelection(null)
                  void commit(mappings)
                }}
              >
                Import {mixedSelection.mappings.length} Media File{mixedSelection.mappings.length === 1 ? '' : 's'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setMixedSelection(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div id="manual-ai-notice" style={{ fontSize: '12px', color: '#93c5fd' }}>
          {notice}
        </div>
      )}

      {plan && plan.needsConfirmation && (
        <div
          id="manual-ai-confirm-mapping"
          style={{
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(251,191,36,0.4)'
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#fbbf24', marginBottom: '6px' }}>
            These files have no scene numbers. Confirm the proposed mapping (natural filename order → missing AI scenes):
          </div>
          <div style={{ maxHeight: '160px', overflowY: 'auto', fontSize: '12px', fontFamily: 'monospace' }}>
            {plan.mappings.map((m) => (
              <div key={m.filePath}>
                {m.fileName} → Scene {m.sceneIndex}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => {
                const mappings = plan.mappings
                setPlan(null)
                void commit(mappings)
              }}
            >
              Confirm mapping
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingRejections.length > 0 && (
        <div id="manual-ai-rejections" style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {pendingRejections.map((r) => (
            <div key={`${r.filePath}-${r.code}`} style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24' }}>
              <span>⚠ {r.fileName}: {r.message}</span>
              {rejectionAction(r)}
            </div>
          ))}
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            {pendingRejections.some((r) => r.code === 'LOW_RESOLUTION') && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ fontSize: '11px', padding: '2px 8px' }}
                disabled={busy}
                onClick={() => {
                  const mappings = pendingRejections
                    .filter((r) => r.code === 'LOW_RESOLUTION')
                    .map(createMappingFromRejection)
                    .filter((m): m is ManualAiImportMapping => m !== null)
                  if (mappings.length > 0) void commit(mappings, { allowLowResolution: true })
                }}
              >
                Accept All
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ fontSize: '11px', padding: '2px 8px' }}
              onClick={() => setPendingRejections([])}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {effectiveHasPromptPack && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          <strong>Missing scenes:</strong> {formatMissing(missing)}
          {staleCount > 0 && (
            <div style={{ color: '#fbbf24', marginTop: '2px' }}>
              {status?.staleSceneIndices.slice(0, 10).map((i) => `Scene ${i}`).join(', ')}
              {staleCount > 10 ? '…' : ''} image needs regeneration because the prompt changed.
            </div>
          )}
        </div>
      )}

      {effectiveHasPromptPack && (
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ fontSize: '11px' }}
            onClick={() => setShowPrompts((v) => !v)}
          >
            {showPrompts ? 'Hide prompts' : 'Show prompts & expected filenames'}
          </button>
          {showPrompts && (
            <div
              id="manual-ai-prompt-list"
              style={{
                marginTop: '8px',
                maxHeight: '320px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}
            >
              {rows.map((r) => (
                <div
                  key={r.sceneIndex}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'rgba(0,0,0,0.25)',
                    fontSize: '12px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <strong>Scene {r.sceneIndex}</strong>
                    <span style={{ fontFamily: 'monospace' }}>Expected file: {r.expectedFilename}</span>
                    <span
                      style={{
                        color:
                          r.status === 'ready'
                            ? '#4ade80'
                            : r.status === 'stale'
                              ? '#fbbf24'
                              : 'var(--text-secondary)'
                      }}
                    >
                      {r.status === 'ready' ? 'Ready' : r.status === 'stale' ? 'Stale' : 'Waiting'}
                    </span>
                  </div>
                  <div style={{ marginTop: '4px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {r.prompt}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
