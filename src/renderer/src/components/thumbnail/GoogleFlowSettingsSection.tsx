import React, { useState, useEffect, useCallback, useRef } from 'react'

// Types inline to avoid circular imports in renderer
interface RuntimeSettings {
  mode: 'external' | 'managed'
  bridgeUrl: string
  flowKitPath?: string
  pythonPath?: string
  flowProjectId?: string
  autoStartBridge: boolean
  autoOpenGoogleFlow: boolean
}

interface StatusIndicatorProps {
  label: string
  value: 'ok' | 'warn' | 'unknown' | 'offline'
  detail?: string
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ label, value, detail }) => {
  const colors = {
    ok: { dot: '#22c55e', text: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
    warn: { dot: '#f59e0b', text: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    offline: { dot: '#ef4444', text: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
    unknown: { dot: '#6b7280', text: '#9ca3af', bg: 'rgba(107,114,128,0.1)' }
  }
  const c = colors[value]
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 10px', borderRadius: '6px', background: c.bg,
      fontSize: '12px', lineHeight: '1.3'
    }}>
      <span style={{
        width: '7px', height: '7px', borderRadius: '50%',
        background: c.dot, flexShrink: 0,
        boxShadow: value === 'ok' ? `0 0 6px ${c.dot}` : undefined
      }} />
      <span style={{ color: '#9ca3af', fontWeight: 500 }}>{label}</span>
      {detail && <span style={{ color: c.text, marginLeft: 'auto', fontWeight: 500 }}>{detail}</span>}
    </div>
  )
}

export const GoogleFlowSettingsSection: React.FC = () => {
  const [settings, setSettings] = useState<RuntimeSettings>({
    mode: 'external',
    bridgeUrl: 'http://127.0.0.1:8100',
    autoStartBridge: false,
    autoOpenGoogleFlow: false
  })
  const [bridgeStatus, setBridgeStatus] = useState<{ ok: boolean; extensionConnected: boolean; signedIn: boolean; imageGen: boolean } | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [pythonVersion, setPythonVersion] = useState<string>('')
  const [detectingPython, setDetectingPython] = useState(false)
  const [startLog, setStartLog] = useState<string[]>([])
  const [runtimeStatus, setRuntimeStatus] = useState<{ bridgeRunning: boolean; managedPid?: number } | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Load persisted settings on mount
  useEffect(() => {
    window.api.thumbnail.runtime.getSettings().then((res) => {
      if (res.success && res.settings) {
        setSettings(res.settings as RuntimeSettings)
      }
    }).catch(() => {})

    window.api.thumbnail.runtime.getStatus().then((status) => {
      setRuntimeStatus({ bridgeRunning: status.bridgeRunning, managedPid: status.managedPid })
    }).catch(() => {})

    // Subscribe to runtime status/log events
    const unsubStatus = window.api.thumbnail.runtime.onStatus((status) => {
      setRuntimeStatus({ bridgeRunning: status.bridgeRunning, managedPid: status.managedPid })
    })
    const unsubLog = window.api.thumbnail.runtime.onLog((entry) => {
      setStartLog((prev) => [...prev.slice(-199), entry.message])
    })
    return () => { unsubStatus(); unsubLog() }
  }, [])

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [startLog])

  const handleCheckHealth = useCallback(async () => {
    setIsChecking(true)
    setBridgeStatus(null)
    try {
      const health = await window.api.thumbnail.flow.checkHealth(settings.bridgeUrl)
      setBridgeStatus({
        ok: health.reachable,
        extensionConnected: health.extensionConnected,
        signedIn: health.signedIn,
        imageGen: health.supportsImageGeneration
      })
    } finally {
      setIsChecking(false)
    }
  }, [settings.bridgeUrl])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const res = await window.api.thumbnail.runtime.saveSettings(settings)
      if (res.success) {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2500)
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleBrowseFolder = async () => {
    const res = await window.api.thumbnail.runtime.selectFolder()
    if (res.success && res.folderPath) {
      setSettings((s) => ({ ...s, flowKitPath: res.folderPath }))
      setPythonVersion('')
    } else if (!res.success && res.error && res.error !== 'Cancelled') {
      alert(`❌ ${res.error}`)
    }
  }

  const handleBrowsePython = async () => {
    const res = await window.api.thumbnail.runtime.selectPython()
    if (res.success && res.pythonPath) {
      setSettings((s) => ({ ...s, pythonPath: res.pythonPath }))
      setPythonVersion('')
    }
  }

  const handleDetectPython = async () => {
    setDetectingPython(true)
    setPythonVersion('')
    try {
      const res = await window.api.thumbnail.runtime.detectPython(settings.flowKitPath)
      if (res.success && res.pythonPath) {
        setSettings((s) => ({ ...s, pythonPath: res.pythonPath }))
        setPythonVersion(res.version || res.pythonPath)
      } else {
        setPythonVersion('Not found (install Python 3.10+)')
      }
    } finally {
      setDetectingPython(false)
    }
  }

  const handleStartBridge = async () => {
    setIsStarting(true)
    setStartLog([])
    try {
      const res = await window.api.thumbnail.runtime.start()
      if (!res.success && res.error) {
        setStartLog((prev) => [...prev, `❌ ${res.error}`])
      }
    } finally {
      setIsStarting(false)
    }
  }

  const handleStopBridge = async () => {
    await window.api.thumbnail.runtime.stop()
  }

  const handleOpenGoogleFlow = async () => {
    await window.api.thumbnail.flow.openFlow()
  }

  const isRunning = runtimeStatus?.bridgeRunning ?? false
  const isManagedMode = settings.mode === 'managed'
  const canStart = isManagedMode && Boolean(settings.flowKitPath) && !isRunning && !isStarting

  const getStatusValue = (v: boolean | undefined | null, checked: boolean): StatusIndicatorProps['value'] => {
    if (!checked) return 'unknown'
    if (v) return 'ok'
    return 'offline'
  }

  const sectionStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '10px',
    padding: '16px',
    marginBottom: '12px'
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '11px',
    fontWeight: 600,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '6px'
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(0,0,0,0.3)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '6px',
    color: '#e5e7eb',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box'
  }

  const btnPrimary: React.CSSProperties = {
    padding: '7px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    color: '#fff', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap'
  }

  const btnSecondary: React.CSSProperties = {
    padding: '7px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.06)', color: '#e5e7eb',
    fontSize: '12px', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap'
  }

  const btnDanger: React.CSSProperties = {
    ...btnSecondary,
    border: '1px solid rgba(239,68,68,0.3)',
    color: '#ef4444',
    background: 'rgba(239,68,68,0.07)'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>🎨</span>
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#f3f4f6' }}>Google Flow Connector</span>
        </div>
        <span style={{
          padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 600,
          background: isRunning ? 'rgba(34,197,94,0.15)' : 'rgba(107,114,128,0.15)',
          color: isRunning ? '#22c55e' : '#9ca3af'
        }}>
          {isRunning ? `● BRIDGE RUNNING (PID ${runtimeStatus?.managedPid ?? '?'})` : '○ BRIDGE OFFLINE'}
        </span>
      </div>

      {/* Mode selection */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Runtime Mode</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['external', 'managed'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setSettings((s) => ({ ...s, mode: m }))}
              style={{
                flex: 1, padding: '8px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                fontWeight: 600, fontSize: '13px', transition: 'all 0.15s',
                background: settings.mode === m ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.04)',
                color: settings.mode === m ? '#a5b4fc' : '#6b7280',
                outline: settings.mode === m ? '1px solid #6366f1' : '1px solid transparent'
              }}
            >
              {m === 'external' ? '🔌 External' : '⚙️ Managed'}
            </button>
          ))}
        </div>
        <p style={{ fontSize: '11px', color: '#6b7280', margin: '8px 0 0' }}>
          {settings.mode === 'external'
            ? 'Run FlowKit manually. App only polls /health. No process management.'
            : 'App spawns FlowKit automatically. Requires Python 3.10+ and FlowKit folder.'}
        </p>
      </div>

      {/* Bridge URL */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Bridge URL</label>
        <input
          style={inputStyle}
          value={settings.bridgeUrl}
          onChange={(e) => setSettings((s) => ({ ...s, bridgeUrl: e.target.value }))}
          placeholder="http://127.0.0.1:8100"
        />
        <p style={{ fontSize: '11px', color: '#6b7280', margin: '6px 0 0' }}>
          Default: http://127.0.0.1:8100 — must match the port FlowKit is listening on.
        </p>
      </div>

      {/* Managed Mode fields */}
      {isManagedMode && (
        <div style={sectionStyle}>
          <label style={labelStyle}>FlowKit Folder</label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={settings.flowKitPath || ''}
              readOnly
              placeholder="Select the folder containing agent/main.py"
            />
            <button style={btnSecondary} onClick={handleBrowseFolder}>Browse…</button>
          </div>

          <label style={labelStyle}>Python Executable</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={settings.pythonPath || ''}
              onChange={(e) => setSettings((s) => ({ ...s, pythonPath: e.target.value || undefined }))}
              placeholder="Auto-detected (leave blank to auto-detect)"
            />
            <button style={btnSecondary} onClick={handleDetectPython} disabled={detectingPython}>
              {detectingPython ? 'Detecting…' : 'Auto Detect'}
            </button>
            <button style={btnSecondary} onClick={handleBrowsePython}>Browse…</button>
          </div>
          {pythonVersion && (
            <p style={{ fontSize: '11px', color: pythonVersion.includes('Not found') ? '#ef4444' : '#22c55e', margin: '6px 0 0' }}>
              {pythonVersion.includes('Not found') ? '⚠ ' : '✓ '}{pythonVersion}
            </p>
          )}
        </div>
      )}

      {/* Flow Project ID */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Google Flow Project ID</label>
        <input
          style={inputStyle}
          value={settings.flowProjectId || ''}
          onChange={(e) => setSettings((s) => ({ ...s, flowProjectId: e.target.value.trim() || undefined }))}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
        <p style={{ fontSize: '11px', color: '#6b7280', margin: '6px 0 0' }}>
          Get the UUID from the URL when you open a project in Google Flow:
          <br />
          <code style={{ color: '#a5b4fc' }}>https://flow.google.com/project/<strong>UUID-HERE</strong>/...</code>
        </p>
      </div>

      {/* Toggles */}
      <div style={sectionStyle}>
        {[
          { key: 'autoStartBridge' as const, label: 'Auto Start FlowKit with App', desc: 'Launch FlowKit bridge when Electron starts (Managed mode only)' },
          { key: 'autoOpenGoogleFlow' as const, label: 'Auto Open Google Flow in Browser', desc: 'Open flow.google.com once per session after bridge starts' }
        ].map(({ key, label, desc }) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#e5e7eb' }}>{label}</div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>{desc}</div>
            </div>
            <button
              onClick={() => setSettings((s) => ({ ...s, [key]: !s[key] }))}
              style={{
                width: '40px', height: '22px', borderRadius: '11px', border: 'none',
                cursor: 'pointer', flexShrink: 0, marginLeft: '12px', marginTop: '2px',
                background: settings[key] ? '#6366f1' : 'rgba(107,114,128,0.3)',
                position: 'relative', transition: 'background 0.2s'
              }}
            >
              <span style={{
                position: 'absolute', top: '3px',
                left: settings[key] ? '21px' : '3px',
                width: '16px', height: '16px',
                borderRadius: '50%', background: '#fff', transition: 'left 0.2s'
              }} />
            </button>
          </div>
        ))}
      </div>

      {/* Connection Status */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Connection Status</label>
          <button style={btnSecondary} onClick={handleCheckHealth} disabled={isChecking}>
            {isChecking ? 'Checking…' : 'Test Connection'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <StatusIndicator label="Bridge" value={getStatusValue(bridgeStatus?.ok, bridgeStatus !== null)} detail={bridgeStatus?.ok ? 'Online' : bridgeStatus !== null ? 'Offline' : undefined} />
          <StatusIndicator label="Extension" value={getStatusValue(bridgeStatus?.extensionConnected, bridgeStatus !== null)} detail={bridgeStatus?.extensionConnected ? 'Connected' : bridgeStatus !== null ? 'Disconnected' : undefined} />
          <StatusIndicator label="Google Flow Sign-in" value={getStatusValue(bridgeStatus?.signedIn, bridgeStatus !== null)} detail={bridgeStatus?.signedIn ? 'Signed In' : bridgeStatus !== null ? 'Not Signed In' : undefined} />
          <StatusIndicator label="Image Generation" value={getStatusValue(bridgeStatus?.imageGen, bridgeStatus !== null)} detail={bridgeStatus?.imageGen ? 'Available' : bridgeStatus !== null ? 'Unavailable' : undefined} />
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          style={{ ...btnPrimary, opacity: isSaving ? 0.7 : 1 }}
          onClick={handleSave}
          disabled={isSaving}
        >
          {saveSuccess ? '✓ Saved!' : isSaving ? 'Saving…' : '💾 Save Settings'}
        </button>

        {isManagedMode && (
          <>
            <button
              style={{ ...btnPrimary, background: canStart ? 'linear-gradient(135deg, #10b981, #059669)' : undefined, opacity: canStart ? 1 : 0.5 }}
              onClick={handleStartBridge}
              disabled={!canStart}
            >
              {isStarting ? '⟳ Starting…' : '▶ Start Bridge'}
            </button>
            {isRunning && (
              <button style={btnDanger} onClick={handleStopBridge}>
                ■ Stop Bridge
              </button>
            )}
          </>
        )}

        <button style={btnSecondary} onClick={handleOpenGoogleFlow}>
          🌐 Open Google Flow ↗
        </button>
      </div>

      {/* Runtime Log (Managed Mode) */}
      {isManagedMode && startLog.length > 0 && (
        <div style={{
          ...sectionStyle,
          fontFamily: 'monospace', fontSize: '11px', color: '#9ca3af',
          maxHeight: '140px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
        }}>
          {startLog.map((line, i) => (
            <div key={i} style={{ color: line.includes('❌') ? '#ef4444' : line.includes('✓') ? '#22c55e' : '#9ca3af' }}>
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* External Mode instructions */}
      {!isManagedMode && (
        <div style={{ ...sectionStyle, borderColor: 'rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.05)' }}>
          <p style={{ fontSize: '12px', color: '#a5b4fc', margin: 0, lineHeight: 1.6 }}>
            <strong>External Mode — manual start required:</strong>
            <br />
            1. <code>cd &lt;FlowKit folder&gt;</code>
            <br />
            2. <code>set FLOW_PROJECT_ID=&lt;your-uuid&gt;</code>
            <br />
            3. <code>python -m agent.main</code>
            <br />
            Then click <em>Test Connection</em> above.
          </p>
        </div>
      )}
    </div>
  )
}

export default GoogleFlowSettingsSection
