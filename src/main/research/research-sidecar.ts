import { spawn, ChildProcess, execSync } from 'child_process'
import { join } from 'path'
import * as fs from 'fs'
import * as http from 'http'
import { app } from 'electron'
import { logger } from '../logger'
import { getUvPath } from '../transcriber'
import type { ResearchSidecarStatus } from '../../../shared/types'

export class ResearchSidecarManager {
  private static instance: ResearchSidecarManager
  private process: ChildProcess | null = null
  private port: number = 8765
  private host: string = '127.0.0.1'
  private status: 'stopped' | 'starting' | 'running' | 'error' | 'degraded' = 'stopped'
  private lastError?: string
  private healthCheckInterval: NodeJS.Timeout | null = null
  private pidFilePath: string
  private lastSuccessfulHealthCheck: string | null = null

  private buildId: string
  private expectedStopReason: 'none' | 'manual' | 'restart' | 'app_quit' | 'unexpected' = 'none'

  private isAppQuitting: boolean = false
  private restartAttempts: number = 0
  private restartTimer: NodeJS.Timeout | null = null
  private isRestarting: boolean = false

  private constructor() {
    this.buildId = `dev_${Date.now()}_${Math.random().toString(36).substring(7)}`
    this.pidFilePath = join(
      app && typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd(),
      'youtube-research-sidecar.pid'
    )
  }

  public static getInstance(): ResearchSidecarManager {
    if (!ResearchSidecarManager.instance) {
      ResearchSidecarManager.instance = new ResearchSidecarManager()
    }
    return ResearchSidecarManager.instance
  }

  public markAppQuitting(): void {
    this.isAppQuitting = true
    this.clearRestartTimer()
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  public getStatus(): ResearchSidecarStatus {
    return {
      online: this.status === 'running',
      port: this.port,
      pid: this.process?.pid,
      url: `http://${this.host}:${this.port}`,
      version: '1.0.0',
      status: this.status,
      error: this.lastError,
      lastHealthCheck: this.lastSuccessfulHealthCheck || undefined
    }
  }

  public async pingHealth(): Promise<{ isAlive: boolean, buildIdMatch: boolean, pid?: number }> {
    return new Promise<{ isAlive: boolean, buildIdMatch: boolean, pid?: number }>((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/health`, { timeout: 2000 }, (res) => {
        if (res.statusCode === 200) {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            try {
              const data = JSON.parse(body)
              if (data.service === 'YouTube Foreign Market Researcher' && data.status === 'online') {
                this.lastSuccessfulHealthCheck = new Date().toISOString()
                const isPackaged = app && app.isPackaged
                // In production, we can reuse any healthy sidecar. In dev, build ID must match to ensure new source is loaded.
                const buildIdMatch = isPackaged ? true : (data.build_id === this.buildId)
                resolve({ isAlive: true, buildIdMatch, pid: data.parent_pid })
              } else {
                resolve({ isAlive: false, buildIdMatch: false })
              }
            } catch {
              resolve({ isAlive: false, buildIdMatch: false })
            }
          })
        } else {
          resolve({ isAlive: false, buildIdMatch: false })
        }
      })
      req.on('error', () => resolve({ isAlive: false, buildIdMatch: false }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ isAlive: false, buildIdMatch: false })
      })
    })
  }

  public async start(): Promise<ResearchSidecarStatus> {
    if (this.isAppQuitting) {
      return this.getStatus()
    }

    this.clearRestartTimer()

    if (this.status === 'running' && this.process) {
      return this.getStatus()
    }

    // 1. Check if already running on port 8765
    const health = await this.pingHealth()
    if (health.isAlive) {
      if (health.buildIdMatch) {
        logger.info(`[ResearchSidecar] Sidecar already responding on http://${this.host}:${this.port}/health`)
        logger.info(`[ResearchSidecar] spawn.success pid=${this.process?.pid ?? 'existing'} (reusing alive process)`)
        this.status = 'running'
        this.lastError = undefined
        this.restartAttempts = 0
        this.startMonitoring()
        return this.getStatus()
      } else {
        logger.info(`[ResearchSidecar] Found stale dev sidecar (build ID mismatch). Stopping it...`)
        this.cleanupStaleProcess()
        
        // Also forcibly kill anything on 8765 just in case
        try {
          if (process.platform === 'win32') {
            const out = execSync('netstat -ano | findstr :8765').toString()
            const match = out.match(/\s+(\d+)\s*$/m)
            if (match && match[1]) {
              execSync(`taskkill /pid ${match[1]} /T /F`, { stdio: 'ignore' })
            }
          }
        } catch { /* ignore */ }
        
        await new Promise(r => setTimeout(r, 1500))
      }
    }

    // 2. Cleanup any stale PID from crash
    this.cleanupStaleProcess()

    // 3. Locate uv executable and services directory
    const uvPath = getUvPath()
    const serviceDir = app && !app.isPackaged
      ? join(process.cwd(), 'services', 'youtube-research')
      : join(process.resourcesPath, 'services', 'youtube-research')

    if (!fs.existsSync(serviceDir)) {
      this.status = 'error'
      this.lastError = `YouTube Research service directory not found at: ${serviceDir}`
      logger.warn(`[ResearchSidecar] ${this.lastError}`)
      return this.getStatus()
    }

    this.status = 'starting'
    logger.info(`[ResearchSidecar] spawn.start via uv...`, { uvPath, serviceDir })

    try {
      const args = [
        'run',
        'uvicorn',
        'main:app',
        '--host', this.host,
        '--port', String(this.port),
        '--log-level', 'info'
      ]

      this.process = spawn(uvPath, args, {
        cwd: serviceDir,
        env: {
          ...process.env,
          PYTHONPATH: serviceDir,
          UV_LINK_MODE: 'copy',
          RESEARCH_SIDECAR_BUILD_ID: this.buildId,
          RESEARCH_SIDECAR_PARENT_PID: process.pid.toString()
        },
        windowsHide: true
      })

      if (this.process.pid) {
        logger.info(`[ResearchSidecar] spawn.success pid=${this.process.pid} build_id=${this.buildId}`)
        const metadata = {
          pid: this.process.pid,
          port: this.port,
          startedAt: new Date().toISOString(),
          service: 'YouTube Foreign Market Researcher',
          buildId: this.buildId
        }
        fs.writeFileSync(this.pidFilePath, JSON.stringify(metadata, null, 2), 'utf-8')
      }

      this.process.stdout?.on('data', (data) => {
        const line = data.toString().trim()
        if (line) logger.debug(`[ResearchSidecar:stdout] ${line}`)
      })

      this.process.stderr?.on('data', (data) => {
        const line = data.toString().trim()
        if (line) logger.info(`[ResearchSidecar:stderr] ${line}`)
      })

      this.process.on('error', (err) => {
        logger.warn(`[ResearchSidecar] Child process error: ${err.message}`)
        this.status = 'error'
        this.lastError = err.message
      })

      this.process.on('exit', (code, signal) => {
        const isExpected = this.expectedStopReason === 'manual' || 
                           this.expectedStopReason === 'restart' || 
                           this.expectedStopReason === 'app_quit' || 
                           this.isAppQuitting
                           
        logger.info(`[ResearchSidecar] process.exit code=${code} signal=${signal} expected=${isExpected} reason=${this.expectedStopReason}`)
        this.process = null
        if (!isExpected) {
          this.expectedStopReason = 'unexpected'
          this.handleUnexpectedExit()
        } else {
          this.status = 'stopped'
        }
      })

      // Wait up to 12s for healthcheck to respond
      let attempts = 0
      while (attempts < 24) {
        await new Promise((r) => setTimeout(r, 500))
        const { isAlive, buildIdMatch } = await this.pingHealth()
        if (isAlive && buildIdMatch) {
          this.status = 'running'
          this.lastError = undefined
          this.restartAttempts = 0
          logger.info(`[ResearchSidecar] Successfully connected on http://${this.host}:${this.port}`)
          this.startMonitoring()
          return this.getStatus()
        }
        attempts++
      }

      this.status = 'degraded'
      this.lastError = 'Sidecar started but health check timed out after 12s'
      logger.warn(`[ResearchSidecar] ${this.lastError}`)
      return this.getStatus()

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.status = 'error'
      this.lastError = msg
      logger.warn(`[ResearchSidecar] Failed to spawn sidecar: ${msg}`)
      return this.getStatus()
    }
  }

  private handleUnexpectedExit(): void {
    if (this.isAppQuitting || this.expectedStopReason === 'manual') {
      this.status = 'stopped'
      return
    }

    if (this.restartAttempts < 3) {
      this.restartAttempts++
      const delayMs = Math.pow(2, this.restartAttempts - 1) * 1000 // 1s, 2s, 4s
      logger.warn(`[ResearchSidecar] restart.scheduled attempt=${this.restartAttempts} delay_ms=${delayMs}`)
      this.status = 'starting'
      this.clearRestartTimer()
      this.restartTimer = setTimeout(async () => {
        this.restartTimer = null
        if (this.isAppQuitting || this.expectedStopReason === 'manual') return
        try {
          this.isRestarting = true
          const status = await this.start()
          if (status.online) {
            logger.info(`[ResearchSidecar] restart.success pid=${status.pid}`)
          } else {
            logger.warn(`[ResearchSidecar] restart attempt ${this.restartAttempts} did not come online`)
          }
        } catch (err: any) {
          logger.warn(`[ResearchSidecar] restart attempt ${this.restartAttempts} failed: ${err?.message || err}`)
        } finally {
          this.isRestarting = false
        }
      }, delayMs)
    } else {
      logger.error('[ResearchSidecar] restart.exhausted max attempts reached (3)')
      this.status = 'error'
      this.lastError = 'Research sidecar exited unexpectedly and failed all auto-restart attempts'
    }
  }

  public async stop(isManual: boolean = false): Promise<void> {
    this.clearRestartTimer()
    if (this.isAppQuitting) {
      this.expectedStopReason = 'app_quit'
      logger.info('[ResearchSidecar] stop.app_quit')
    } else if (isManual) {
      this.expectedStopReason = 'manual'
      logger.info('[ResearchSidecar] stop.manual')
    } else {
      logger.info('[ResearchSidecar] stop.internal (expectedReason=' + this.expectedStopReason + ')')
    }

    this.status = 'stopped'
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }

    if (this.process && this.process.pid) {
      logger.info(`[ResearchSidecar] Stopping sidecar PID ${this.process.pid}`)
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' })
        } else {
          this.process.kill('SIGTERM')
        }
      } catch {
        /* ignore */
      }
      this.process = null
    }

    this.cleanupStaleProcess()
  }

  public async restart(): Promise<ResearchSidecarStatus> {
    if (this.isRestarting) {
      logger.warn('[ResearchSidecar] Restart already in progress.')
      return this.getStatus()
    }
    
    try {
      this.isRestarting = true
      this.clearRestartTimer()
      this.restartAttempts = 0
      this.expectedStopReason = 'restart'
      
      await this.stop(false)
      
      // Wait for process to exit and port to be released
      let waitTime = 0
      while (this.process !== null && waitTime < 5000) {
        await new Promise(r => setTimeout(r, 200))
        waitTime += 200
      }
      
      this.expectedStopReason = 'none'
      return await this.start()
    } finally {
      this.isRestarting = false
    }
  }

  private startMonitoring(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval)
    this.healthCheckInterval = setInterval(async () => {
      const health = await this.pingHealth()
      if (!health.isAlive && this.status === 'running') {
        logger.warn('[ResearchSidecar] Periodic ping failed. Marking degraded.')
        this.status = 'degraded'
      } else if (health.isAlive && this.status === 'degraded') {
        this.status = 'running'
      }
    }, 15000)
  }

  private cleanupStaleProcess(): void {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        const content = fs.readFileSync(this.pidFilePath, 'utf-8').trim()
        let oldPid: number | null = null
        try {
          const parsed = JSON.parse(content)
          if (parsed && parsed.service === 'YouTube Foreign Market Researcher' && typeof parsed.pid === 'number') {
            oldPid = parsed.pid
          }
        } catch {
          const numeric = parseInt(content, 10)
          if (!isNaN(numeric)) oldPid = numeric
        }

        if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
          if (process.platform === 'win32') {
            try {
              execSync(`taskkill /pid ${oldPid} /T /F`, { stdio: 'ignore' })
            } catch {
              /* ignore if process already terminated */
            }
          } else {
            try {
              process.kill(oldPid, 'SIGTERM')
            } catch {
              /* ignore */
            }
          }
        }
        if (fs.existsSync(this.pidFilePath)) {
          fs.unlinkSync(this.pidFilePath)
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export const researchSidecar = ResearchSidecarManager.getInstance()
