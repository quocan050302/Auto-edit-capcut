/**
 * FlowKit Runtime Manager
 *
 * Manages the lifecycle of the FlowKit Python bridge agent.
 *
 * Modes:
 *  - 'external': User runs FlowKit independently. App only polls /health.
 *  - 'managed':  App spawns FlowKit from a user-configured path.
 *
 * Key guarantees:
 *  - Only kills a process it spawned. Never touches external FlowKit.
 *  - Does not spawn a second process if one is already running.
 *  - Logs stdout/stderr in real time; broadcasts via IPC.
 *  - Polls /health up to 30 s after spawn; reports FLOWKIT_HEALTH_TIMEOUT if missed.
 *  - On unexpected child exit, marks bridge offline and broadcasts.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import { BrowserWindow, app, shell } from 'electron'
import { logger } from '../logger'
import { IPC_CHANNELS } from '../../../shared/types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type FlowKitRuntimeMode = 'external' | 'managed'

export interface FlowKitRuntimeSettings {
  mode: FlowKitRuntimeMode
  bridgeUrl: string
  flowKitPath?: string
  pythonPath?: string
  flowProjectId?: string
  autoStartBridge: boolean
  autoOpenGoogleFlow: boolean
}

export interface FlowKitRuntimeStatus {
  mode: FlowKitRuntimeMode
  bridgeRunning: boolean
  bridgeUrl: string
  managedPid?: number
  flowProjectId?: string
  lastHealthCheck?: {
    ok: boolean
    extensionConnected: boolean
    checkedAt: string
  }
  lastError?: string
}

export type FlowConnectionErrorCode =
  | 'FLOWKIT_NOT_CONFIGURED'
  | 'FLOWKIT_PATH_INVALID'
  | 'FLOWKIT_PYTHON_NOT_FOUND'
  | 'FLOWKIT_DEPENDENCIES_MISSING'
  | 'FLOWKIT_BRIDGE_OFFLINE'
  | 'FLOWKIT_START_FAILED'
  | 'FLOWKIT_HEALTH_TIMEOUT'
  | 'FLOW_EXTENSION_DISCONNECTED'
  | 'FLOW_TAB_NOT_OPEN'
  | 'FLOW_NOT_SIGNED_IN'
  | 'FLOW_PROJECT_ID_MISSING'
  | 'FLOW_PROJECT_ID_INVALID'
  | 'FLOW_PROVIDER_UNAVAILABLE'
  | 'FLOW_IMAGE_GENERATION_UNAVAILABLE'

export interface FlowReadinessResult {
  ready: boolean
  bridgeReachable: boolean
  extensionConnected: boolean
  flowConnected: boolean
  flowProjectIdPresent: boolean
  imageGenerationReady: boolean
  export4kStatus: 'available' | 'unknown' | 'unavailable'
  blockingCode?: FlowConnectionErrorCode
  message: string
  diagnostics?: Record<string, unknown>
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: FlowKitRuntimeSettings = {
  mode: 'external',
  bridgeUrl: 'http://127.0.0.1:8100',
  autoStartBridge: false,
  autoOpenGoogleFlow: false
}

const HEALTH_POLL_INTERVAL_MS = 2000
const HEALTH_START_TIMEOUT_MS = 30000
const GOOGLE_FLOW_URL = 'https://flow.google.com/'
const CONFIG_FILENAME = 'flowkit-runtime-settings.json'

// ─── Manager ─────────────────────────────────────────────────────────────────

export class FlowKitRuntimeManager {
  private settings: FlowKitRuntimeSettings = { ...DEFAULT_SETTINGS }
  private managedProcess: cp.ChildProcess | null = null
  private isStarting = false
  /** Guard: only open Google Flow browser tab once per app session */
  private hasOpenedGoogleFlowThisSession = false
  /** Reference to GoogleFlowClient for URL sync — set by initialize() */
  private googleFlowClientRef: { setBridgeUrl(url: string): void } | null = null

  // ─── Initialization ───────────────────────────────────────────────────────

  /**
   * Must be called once during app startup BEFORE any IPC handlers fire.
   * Loads persisted settings and optionally links the GoogleFlowClient for URL sync.
   */
  public initialize(googleFlowClient?: { setBridgeUrl(url: string): void }): void {
    if (googleFlowClient) {
      this.googleFlowClientRef = googleFlowClient
    }
    this.loadPersistedSettings()
    logger.info(`[FlowKitRuntime] Initialized. mode=${this.settings.mode} url=${this.settings.bridgeUrl}`)
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private getConfigPath(): string {
    try {
      return path.join(app.getPath('userData'), CONFIG_FILENAME)
    } catch {
      // In test environments app.getPath may not work
      return path.join(process.cwd(), CONFIG_FILENAME)
    }
  }

  public loadPersistedSettings(): void {
    const configPath = this.getConfigPath()
    try {
      if (!fs.existsSync(configPath)) {
        logger.info('[FlowKitRuntime] No persisted settings found. Using defaults.')
        return
      }
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<FlowKitRuntimeSettings>
      this.applySettings(parsed)
      logger.info(`[FlowKitRuntime] Loaded persisted settings from ${configPath}`)
    } catch (err) {
      logger.warn(`[FlowKitRuntime] Failed to load persisted settings (using defaults): ${err}`)
    }
  }

  public savePersistedSettings(): void {
    const configPath = this.getConfigPath()
    const tmpPath = `${configPath}.tmp`
    try {
      const data = JSON.stringify(this.settings, null, 2)
      fs.writeFileSync(tmpPath, data, 'utf-8')
      fs.renameSync(tmpPath, configPath)
      logger.info(`[FlowKitRuntime] Settings persisted to ${configPath}`)
    } catch (err) {
      logger.error(`[FlowKitRuntime] Failed to persist settings: ${err}`)
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  public getSettings(): FlowKitRuntimeSettings {
    return { ...this.settings }
  }

  public applySettings(settings: Partial<FlowKitRuntimeSettings>): void {
    const newUrl = this.normalizeBridgeUrl(settings.bridgeUrl || this.settings.bridgeUrl)
    this.settings = {
      ...this.settings,
      ...settings,
      // Normalize and sanitize
      bridgeUrl: newUrl,
      flowProjectId: (settings.flowProjectId ?? this.settings.flowProjectId ?? '').trim() || undefined,
      flowKitPath: settings.flowKitPath ?? this.settings.flowKitPath,
      pythonPath: settings.pythonPath ?? this.settings.pythonPath
    }
    // Sync bridge URL to GoogleFlowClient so health/generate/export use same URL
    if (this.googleFlowClientRef) {
      this.googleFlowClientRef.setBridgeUrl(newUrl)
    }
    logger.info(`[FlowKitRuntime] Settings applied: mode=${this.settings.mode} url=${this.settings.bridgeUrl}`)
  }

  /** Save settings and apply them atomically */
  public saveSettings(settings: Partial<FlowKitRuntimeSettings>): void {
    this.applySettings(settings)
    this.savePersistedSettings()
  }

  private normalizeBridgeUrl(url: string): string {
    const raw = (url || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, '')
    // Only allow http/https
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      return DEFAULT_SETTINGS.bridgeUrl
    }
    return raw
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  public getStatus(): FlowKitRuntimeStatus {
    return {
      mode: this.settings.mode,
      bridgeRunning: this.managedProcess !== null && !this.managedProcess.killed,
      bridgeUrl: this.settings.bridgeUrl,
      managedPid: this.managedProcess?.pid ?? undefined,
      flowProjectId: this.settings.flowProjectId
    }
  }

  // ─── Start Bridge (Managed Mode only) ─────────────────────────────────────

  public async startBridge(): Promise<{ success: boolean; error?: string; errorCode?: FlowConnectionErrorCode }> {
    if (this.settings.mode !== 'managed') {
      return { success: false, error: 'Bridge is in External mode. Start FlowKit manually.', errorCode: 'FLOWKIT_NOT_CONFIGURED' }
    }

    if (this.managedProcess && !this.managedProcess.killed) {
      logger.info('[FlowKitRuntime] Bridge already running.')
      return { success: true }
    }

    if (this.isStarting) {
      return { success: false, error: 'Bridge is already starting.' }
    }

    const flowKitPath = this.settings.flowKitPath || ''
    if (!flowKitPath || !fs.existsSync(flowKitPath)) {
      return { success: false, error: `FlowKit path not found: "${flowKitPath}"`, errorCode: 'FLOWKIT_PATH_INVALID' }
    }

    const agentMain = path.join(flowKitPath, 'agent', 'main.py')
    if (!fs.existsSync(agentMain)) {
      return {
        success: false,
        error: `agent/main.py not found in "${flowKitPath}". Is this the correct FlowKit folder?`,
        errorCode: 'FLOWKIT_PATH_INVALID'
      }
    }

    // Find Python
    const pythonExe = await this.resolvePython(flowKitPath)
    if (!pythonExe) {
      return {
        success: false,
        error: 'Python 3.10+ not found. Configure the Python path in settings or install Python.',
        errorCode: 'FLOWKIT_PYTHON_NOT_FOUND'
      }
    }

    // Parse bridge URL for port
    const bridgePort = this.parseBridgePort()
    const flowProjectId = this.settings.flowProjectId || ''

    this.isStarting = true
    this.broadcastLog(`[FlowKitRuntime] Starting FlowKit bridge...\nPython: ${pythonExe}\nCwd: ${flowKitPath}\nPort: ${bridgePort}`)

    try {
      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
        ),
        API_HOST: '127.0.0.1',
        API_PORT: String(bridgePort),
        MEDIA_PROVIDER: 'flow',
        ...(flowProjectId ? { FLOW_PROJECT_ID: flowProjectId } : {})
      }

      const child = cp.spawn(pythonExe, ['-m', 'agent.main'], {
        cwd: flowKitPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.managedProcess = child

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trimEnd()
        this.broadcastLog(`[FlowKit] ${text}`)
      })

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trimEnd()
        this.broadcastLog(`[FlowKit:err] ${text}`)
      })

      child.on('exit', (code, signal) => {
        const wasManaged = this.managedProcess === child
        if (wasManaged) {
          this.managedProcess = null
        }
        const msg = `[FlowKitRuntime] Bridge process exited (code=${code ?? signal})`
        logger.warn(msg)
        this.broadcastLog(msg)
        this.broadcastStatus()
      })

      // Poll /health until ready or timeout
      const ready = await this.pollHealth(HEALTH_START_TIMEOUT_MS)
      if (!ready) {
        // Kill the process if health never came up
        if (this.managedProcess === child && !child.killed) {
          child.kill('SIGTERM')
          this.managedProcess = null
        }
        return { success: false, error: `Bridge did not become healthy within ${HEALTH_START_TIMEOUT_MS / 1000}s.`, errorCode: 'FLOWKIT_HEALTH_TIMEOUT' }
      }

      this.broadcastLog('[FlowKitRuntime] Bridge is healthy and ready.')
      this.broadcastStatus()
      return { success: true }
    } catch (err) {
      this.managedProcess = null
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[FlowKitRuntime] Failed to start bridge: ${msg}`)
      return { success: false, error: msg, errorCode: 'FLOWKIT_START_FAILED' }
    } finally {
      this.isStarting = false
    }
  }

  // ─── Stop Bridge (Managed Mode only) ──────────────────────────────────────

  public stopBridge(): void {
    if (!this.managedProcess || this.managedProcess.killed) {
      return
    }
    logger.info('[FlowKitRuntime] Stopping managed FlowKit bridge...')
    this.managedProcess.kill('SIGTERM')
    // Force-kill after 5s if not exited
    setTimeout(() => {
      if (this.managedProcess && !this.managedProcess.killed) {
        this.managedProcess.kill('SIGKILL')
      }
    }, 5000)
    this.managedProcess = null
    this.broadcastStatus()
  }

  public handleAppQuit(): void {
    // Only stop if we own the process
    if (this.settings.mode === 'managed') {
      this.stopBridge()
    }
  }

  /**
   * Open Google Flow in the default browser.
   * Only opens once per app session regardless of how many times called.
   */
  public openGoogleFlow(force = false): void {
    if (!force && this.hasOpenedGoogleFlowThisSession) {
      logger.info('[FlowKitRuntime] Google Flow already opened this session. Skipping.')
      return
    }
    this.hasOpenedGoogleFlowThisSession = true
    shell.openExternal(GOOGLE_FLOW_URL).catch((err) => {
      logger.warn(`[FlowKitRuntime] Failed to open Google Flow: ${err}`)
    })
    logger.info(`[FlowKitRuntime] Opened Google Flow in browser: ${GOOGLE_FLOW_URL}`)
  }

  /**
   * Auto-start FlowKit in the background (non-blocking).
   * Called from app startup if mode=managed and autoStartBridge=true.
   */
  public autoStartIfConfigured(): void {
    if (this.settings.mode !== 'managed' || !this.settings.autoStartBridge) {
      return
    }
    logger.info('[FlowKitRuntime] Auto-start configured. Starting FlowKit bridge in background...')
    // Non-blocking — don't await
    this.startBridge().then((result) => {
      if (result.success) {
        logger.info('[FlowKitRuntime] Auto-start: bridge is healthy.')
        // If autoOpenGoogleFlow is enabled and extension not yet connected,
        // open browser automatically (once per session)
        if (this.settings.autoOpenGoogleFlow) {
          this.openGoogleFlow()
        }
      } else {
        logger.warn(`[FlowKitRuntime] Auto-start failed: ${result.error}`)
      }
    }).catch((err) => {
      logger.error(`[FlowKitRuntime] Auto-start error: ${err}`)
    })
  }

  // ─── Readiness Preflight ──────────────────────────────────────────────────

  /**
   * Run the full readiness preflight check.
   * MUST be called before any thumbnail generation.
   * If not ready, returns blockingCode and message.
   */
  public async ensureFlowReady(bridgeUrl?: string): Promise<FlowReadinessResult> {
    const url = this.normalizeBridgeUrl(bridgeUrl || this.settings.bridgeUrl)

    const result: FlowReadinessResult = {
      ready: false,
      bridgeReachable: false,
      extensionConnected: false,
      flowConnected: false,
      flowProjectIdPresent: Boolean(this.settings.flowProjectId),
      imageGenerationReady: false,
      export4kStatus: 'unknown',
      message: 'Checking FlowKit connection...'
    }

    // 1. Check bridge /health
    let healthData: { extension_connected?: boolean; version?: string } | null = null
    try {
      const resp = await this.fetchWithTimeout(`${url}/health`, 5000)
      if (resp.ok) {
        result.bridgeReachable = true
        healthData = await resp.json() as { extension_connected?: boolean; version?: string }
        result.extensionConnected = Boolean(healthData?.extension_connected)
      } else {
        result.blockingCode = 'FLOWKIT_BRIDGE_OFFLINE'
        result.message = `FlowKit bridge at ${url} returned HTTP ${resp.status}.`
        return result
      }
    } catch (err) {
      const errCode = this.extractNodeErrorCode(err)
      result.bridgeReachable = false
      result.extensionConnected = false
      result.blockingCode = 'FLOWKIT_BRIDGE_OFFLINE'
      result.message = this.buildBridgeOfflineMessage(url, errCode)
      result.diagnostics = { errorCode: errCode, bridgeUrl: url }
      return result
    }

    // 2. Check extension connected
    if (!result.extensionConnected) {
      result.blockingCode = 'FLOW_EXTENSION_DISCONNECTED'
      result.message = 'FlowKit bridge is online, but the Chrome extension is not connected. Open Google Flow in Chrome and reload the extension.'
      return result
    }

    // 3. Check /api/flow/status
    try {
      const flowResp = await this.fetchWithTimeout(`${url}/api/flow/status`, 10000)
      if (flowResp.ok) {
        const flowData = await flowResp.json() as {
          connected?: boolean
          flow_project_id?: string
          session_project?: { project_id?: string }
        }
        result.flowConnected = Boolean(flowData.connected)
        // Project ID from settings takes precedence over what bridge reports
        const bridgeProjectId = flowData.flow_project_id || flowData.session_project?.project_id
        if (!this.settings.flowProjectId && bridgeProjectId) {
          // Bridge already has a project, use it
          result.flowProjectIdPresent = true
        }
      }
    } catch {
      // Non-fatal: /api/flow/status may not exist on older FlowKit versions
    }

    // 4. Check /api/providers/status for image generation capability
    try {
      const provResp = await this.fetchWithTimeout(`${url}/api/providers/status`, 5000)
      if (provResp.ok) {
        const provs = await provResp.json() as Array<{ name: string; available: boolean; capabilities?: { generate_image?: boolean } }>
        const flowProv = provs.find((p) => p.name === 'flow')
        if (flowProv?.available && flowProv.capabilities?.generate_image) {
          result.imageGenerationReady = true
        }
      }
    } catch {
      // Non-fatal
    }

    // 5. Check Flow Project ID
    if (!this.settings.flowProjectId && !result.flowProjectIdPresent) {
      result.blockingCode = 'FLOW_PROJECT_ID_MISSING'
      result.message = 'Flow Project ID is not configured. Open Google Flow, create or open a project, copy the UUID from the URL, and paste it in Settings → Thumbnail Studio.'
      return result
    }

    // 6. All checks passed
    result.ready = result.bridgeReachable && result.extensionConnected && result.imageGenerationReady
    if (result.ready) {
      result.message = 'Google Flow is connected and ready for thumbnail generation.'
    } else if (!result.imageGenerationReady) {
      result.blockingCode = 'FLOW_IMAGE_GENERATION_UNAVAILABLE'
      result.message = 'FlowKit is connected but the image generation provider is unavailable. Check that Google Flow is open in Chrome.'
    }

    return result
  }

  /**
   * Lightweight bridge liveness check (no extension/project checks).
   * Use between candidates in a running batch.
   */
  public async isBridgeStillReachable(bridgeUrl?: string): Promise<boolean> {
    const url = this.normalizeBridgeUrl(bridgeUrl || this.settings.bridgeUrl)
    try {
      const resp = await this.fetchWithTimeout(`${url}/health`, 5000)
      return resp.ok
    } catch {
      return false
    }
  }

  // ─── Python resolution ─────────────────────────────────────────────────────

  public async resolvePython(flowKitPath: string): Promise<string | null> {
    const candidates: string[] = []

    if (this.settings.pythonPath) {
      candidates.push(this.settings.pythonPath)
    }

    // venv paths
    candidates.push(
      path.join(flowKitPath, '.venv', 'Scripts', 'python.exe'),
      path.join(flowKitPath, 'venv', 'Scripts', 'python.exe'),
      path.join(flowKitPath, '.venv', 'bin', 'python'),
      path.join(flowKitPath, 'venv', 'bin', 'python')
    )

    // System python
    candidates.push('py', 'python', 'python3')

    for (const py of candidates) {
      const version = await this.checkPythonVersion(py)
      if (version) {
        logger.info(`[FlowKitRuntime] Found Python: ${py} (${version})`)
        return py
      }
    }

    return null
  }

  private async checkPythonVersion(pythonExe: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const child = cp.spawn(pythonExe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
        child.on('close', (code) => {
          if (code !== 0) return resolve(null)
          const match = out.match(/Python (\d+)\.(\d+)/)
          if (!match) return resolve(null)
          const major = parseInt(match[1], 10)
          const minor = parseInt(match[2], 10)
          if (major >= 3 && minor >= 10) {
            resolve(out.trim())
          } else {
            resolve(null)
          }
        })
        child.on('error', () => resolve(null))
      } catch {
        resolve(null)
      }
    })
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async pollHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    const url = this.settings.bridgeUrl
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await this.fetchWithTimeout(`${url}/health`, 3000)
        if (resp.ok) {
          const data = await resp.json() as { status?: string }
          if (data.status === 'ok' || resp.ok) return true
        }
      } catch {
        // not yet ready
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
    }
    return false
  }

  private parseBridgePort(): number {
    try {
      const url = new URL(this.settings.bridgeUrl)
      return parseInt(url.port || '8100', 10)
    } catch {
      return 8100
    }
  }

  private extractNodeErrorCode(err: unknown): string {
    if (err && typeof err === 'object') {
      const cause = (err as { cause?: { code?: string; errno?: number; address?: string; port?: number } }).cause
      if (cause?.code) return cause.code
      const code = (err as { code?: string }).code
      if (code) return code
    }
    return 'UNKNOWN'
  }

  private buildBridgeOfflineMessage(url: string, code: string): string {
    if (code === 'ECONNREFUSED') {
      return `FlowKit bridge is not running at ${url}. Start FlowKit with: python -m agent.main`
    }
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      return `FlowKit bridge at ${url} timed out. The process may be starting or hung.`
    }
    if (code === 'ENOTFOUND') {
      return `Cannot resolve host for FlowKit at ${url}. Check the bridge URL in settings.`
    }
    return `Cannot connect to FlowKit at ${url} (${code}). Ensure FlowKit is running.`
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { signal: controller.signal })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private broadcastLog(message: string): void {
    try {
      if (typeof BrowserWindow !== 'undefined' && BrowserWindow?.getAllWindows) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.FLOWKIT_RUNTIME_LOG, { message, timestamp: new Date().toISOString() })
          }
        }
      }
    } catch {
      // headless
    }
    logger.info(message)
  }

  private broadcastStatus(): void {
    const status = this.getStatus()
    try {
      if (typeof BrowserWindow !== 'undefined' && BrowserWindow?.getAllWindows) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.FLOWKIT_RUNTIME_STATUS, status)
          }
        }
      }
    } catch {
      // headless
    }
  }
}

export const flowkitRuntimeManager = new FlowKitRuntimeManager()
