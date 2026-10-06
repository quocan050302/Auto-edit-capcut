import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AutoPipelineState,
  ManualAiImportMapping,
  ManualAiImportPlan,
  ManualAiImportRejection,
  ManualAiStatus,
  ProjectState
} from '../../../../shared/types'
import { resolveAiImageMode, resolveVisualMixConfig } from '../../../../shared/types'

interface ManualAiPromptPanelProps {
  project: ProjectState
  pipelineState: AutoPipelineState | null
}

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

export function ManualAiPromptPanel({ project, pipelineState }: ManualAiPromptPanelProps): React.ReactElement | null {
  const projectDir = project.projectDir
  const mix = resolveVisualMixConfig({
    visualSourceMode: project.inputs.visualSourceMode,
    visualMixConfig: project.inputs.visualMixConfig,
    contentType: project.inputs.contentType
  })
  const isPromptMode =
    mix.mode === 'custom-mix' && mix.aiImageRatio > 0 && resolveAiImageMode(mix) === 'prompt'

  const [status, setStatus] = useState<ManualAiStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<ManualAiImportPlan | null>(null)
  const [pendingRejections, setPendingRejections] = useState<ManualAiImportRejection[]>([])
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const lastVersion = useRef<number | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectDir || !window.api?.manualAi) return
    try {
      const s = await window.api.manualAi.getStatus(projectDir)
      setStatus(s)
    } catch {
      /* ignore transient IPC errors */
    }
  }, [projectDir])

  // Initial load + push updates from the importer.
  useEffect(() => {
    if (!isPromptMode) return
    void refresh()
    const off = window.api?.manualAi?.onStatusUpdated?.((payload) => {
      if (payload.projectDir === projectDir) setStatus(payload.status)
    })
    return () => {
      off?.()
    }
  }, [isPromptMode, projectDir, refresh])

  // Re-read the status whenever the running pipeline publishes a new state (cheap, local files).
  useEffect(() => {
    if (!isPromptMode) return
    const v = pipelineState?.version
    if (v !== lastVersion.current) {
      lastVersion.current = v
      void refresh()
    }
  }, [isPromptMode, pipelineState?.version, refresh])

  const stockStage = pipelineState?.stages?.['stock-search']
  const wait = stockStage?.manualAiWait
  const stockExpected = wait?.stockExpected ?? 0
  const stockReady = wait?.stockReady ?? 0
  const showStock = !!wait

  const missing = status?.missingSceneIndices ?? []
  const staleCount = status?.staleSceneIndices.length ?? 0
  const expected = status?.expected ?? 0
  const ready = status?.ready ?? 0
  const missingCount = Math.max(0, expected - ready)
  const allReady = !!status?.allReady

  const rows = useMemo(() => status?.rows ?? [], [status])

  if (!isPromptMode) return null

  async function handleCopyAll(): Promise<void> {
    const res = await window.api.manualAi.getPromptText(projectDir)
    if (!res.success || !res.text) {
      setNotice(res.error || 'No prompt pack exists yet.')
      return
    }
    setNotice(copyToClipboard(res.text) ? `Copied ${expected} prompts to clipboard.` : 'Could not access the clipboard.')
  }

  async function handleExport(): Promise<void> {
    const res = await window.api.manualAi.exportTxt(projectDir)
    if (res.canceled) return
    setNotice(res.success ? `Exported to ${res.filePath}` : res.error || 'Export failed.')
  }

  async function handleOpenFile(): Promise<void> {
    const res = await window.api.manualAi.openPromptFile(projectDir)
    if (!res.success) setNotice(res.error || 'Could not open the prompt file.')
  }

  async function commit(
    mappings: ManualAiImportMapping[],
    opts: { replaceExisting?: boolean; allowLowResolution?: boolean } = {}
  ): Promise<void> {
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
        `${n} image${n === 1 ? '' : 's'} imported · ${res.result.status.ready}/${res.result.status.expected} ready` +
          (res.result.rejections.length > 0 ? ` · ${res.result.rejections.length} need attention` : '')
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleSelect(mode: 'files' | 'folder'): Promise<void> {
    setShowImportMenu(false)
    setNotice(null)
    const picked = await window.api.manualAi.selectImages(mode)
    if (!picked.success) {
      setNotice(picked.error || 'Could not open the file picker.')
      return
    }
    if (picked.filePaths.length === 0) {
      if (!picked.canceled) setNotice('No supported images (PNG, JPG, JPEG, WEBP) found.')
      return
    }
    const planned = await window.api.manualAi.planImport({ projectDir, filePaths: picked.filePaths })
    if (!planned.success || !planned.plan) {
      setNotice(planned.error || 'Could not analyse the selected files.')
      return
    }
    setPendingRejections(planned.plan.rejections)
    if (planned.plan.needsConfirmation) {
      // Guessed (natural-sort) mapping: NEVER commit silently.
      setPlan(planned.plan)
      return
    }
    setPlan(null)
    if (planned.plan.mappings.length > 0) await commit(planned.plan.mappings)
    else setNotice('Nothing could be imported. See the messages below.')
  }

  const rejectionAction = (r: ManualAiImportRejection): React.ReactNode => {
    if (r.sceneIndex === undefined) return null
    const mapping: ManualAiImportMapping = {
      filePath: r.filePath,
      fileName: r.fileName,
      sceneIndex: r.sceneIndex,
      via: 'filename'
    }
    if (r.code === 'LOW_RESOLUTION') {
      return (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void commit([mapping], { allowLowResolution: true })}>
          Use Anyway
        </button>
      )
    }
    if (r.code === 'ALREADY_IMPORTED') {
      return (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void commit([mapping], { replaceExisting: true })}>
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
            AI Image Mode: <strong>Prompt</strong> · {status?.hasPromptPack ? `${expected} prompts ready` : 'Prompts are generated when Find Visuals starts'}
          </div>
        </div>
        <span
          id="manual-ai-status-pill"
          style={{
            padding: '4px 12px',
            borderRadius: '999px',
            fontSize: '12px',
            fontWeight: 600,
            background: allReady ? 'rgba(34, 197, 94, 0.15)' : 'rgba(251, 191, 36, 0.15)',
            color: allReady ? '#4ade80' : '#fbbf24'
          }}
        >
          {!status?.hasPromptPack
            ? 'Waiting for prompts'
            : allReady
              ? 'All AI images ready ✓'
              : `Waiting for ${missingCount} AI image${missingCount === 1 ? '' : 's'}`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Prompts</div>
          <div style={{ fontSize: '15px', fontWeight: 700 }}>
            {expected} / {expected} generated {status?.hasPromptPack ? '✓' : ''}
          </div>
        </div>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>AI Images</div>
          <div id="manual-ai-imported-count" style={{ fontSize: '15px', fontWeight: 700 }}>
            {ready} / {expected} imported
          </div>
        </div>
        <div style={statBoxStyle}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Real Footage</div>
          <div id="manual-ai-stock-count" style={{ fontSize: '15px', fontWeight: 700 }}>
            {showStock ? `${stockReady} / ${stockExpected} ready${stockReady >= stockExpected && stockExpected > 0 ? ' ✓' : ''}` : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', position: 'relative' }}>
        <button type="button" id="manual-ai-copy-all" className="btn btn-secondary btn-sm" disabled={!status?.hasPromptPack} onClick={() => void handleCopyAll()}>
          Copy All Prompts
        </button>
        <button type="button" id="manual-ai-export-txt" className="btn btn-secondary btn-sm" disabled={!status?.hasPromptPack} onClick={() => void handleExport()}>
          Export TXT
        </button>
        <button type="button" id="manual-ai-open-file" className="btn btn-secondary btn-sm" disabled={!status?.hasPromptPack} onClick={() => void handleOpenFile()}>
          Open Prompt File
        </button>
        <button
          type="button"
          id="manual-ai-import"
          className="btn btn-primary btn-sm"
          disabled={!status?.hasPromptPack || busy}
          onClick={() => setShowImportMenu((v) => !v)}
        >
          Import AI Images
        </button>
        {showImportMenu && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" id="manual-ai-import-files" className="btn btn-secondary btn-sm" onClick={() => void handleSelect('files')}>
              Select Images…
            </button>
            <button type="button" id="manual-ai-import-folder" className="btn btn-secondary btn-sm" onClick={() => void handleSelect('folder')}>
              Select Folder…
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div id="manual-ai-notice" style={{ fontSize: '12px', color: '#93c5fd' }}>
          {notice}
        </div>
      )}

      {plan && plan.needsConfirmation && (
        <div id="manual-ai-confirm-mapping" style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(251,191,36,0.4)' }}>
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
            {pendingRejections.some(r => r.code === 'LOW_RESOLUTION') && (
              <button 
                type="button" 
                className="btn btn-secondary btn-sm" 
                style={{ fontSize: '11px', padding: '2px 8px' }} 
                disabled={busy}
                onClick={() => {
                  const mappings = pendingRejections
                    .filter(r => r.code === 'LOW_RESOLUTION' && r.sceneIndex !== undefined)
                    .map(r => ({ filePath: r.filePath, fileName: r.fileName, sceneIndex: r.sceneIndex!, via: 'filename' as const }));
                  if (mappings.length > 0) void commit(mappings, { allowLowResolution: true });
                }}
              >
                Accept All
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => setPendingRejections([])}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {status?.hasPromptPack && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          <strong>Missing scenes:</strong> {formatMissing(missing)}
          {staleCount > 0 && (
            <div style={{ color: '#fbbf24', marginTop: '2px' }}>
              {status.staleSceneIndices.slice(0, 10).map((i) => `Scene ${i}`).join(', ')}
              {staleCount > 10 ? '…' : ''} image needs regeneration because the prompt changed.
            </div>
          )}
        </div>
      )}

      {status?.hasPromptPack && (
        <div>
          <button type="button" className="btn btn-secondary btn-sm" style={{ fontSize: '11px' }} onClick={() => setShowPrompts((v) => !v)}>
            {showPrompts ? 'Hide prompts' : 'Show prompts & expected filenames'}
          </button>
          {showPrompts && (
            <div id="manual-ai-prompt-list" style={{ marginTop: '8px', maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {rows.map((r) => (
                <div key={r.sceneIndex} style={{ padding: '8px 10px', borderRadius: '6px', background: 'rgba(0,0,0,0.25)', fontSize: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <strong>Scene {r.sceneIndex}</strong>
                    <span style={{ fontFamily: 'monospace' }}>Expected file: {r.expectedFilename}</span>
                    <span style={{ color: r.status === 'ready' ? '#4ade80' : r.status === 'stale' ? '#fbbf24' : 'var(--text-secondary)' }}>
                      {r.status === 'ready' ? 'Ready' : r.status === 'stale' ? 'Stale' : 'Waiting'}
                    </span>
                  </div>
                  <div style={{ marginTop: '4px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{r.prompt}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
