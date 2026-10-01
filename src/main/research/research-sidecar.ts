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

  private constructor() {
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

  public async pingHealth(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/health`, { timeout: 2000 }, (res) => {
        if (res.statusCode === 200) {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            try {
              const data = JSON.parse(body)
              if (data.service === 'YouTube Foreign Market Researcher' && data.status === 'online') {
                this.lastSuccessfulHealthCheck = new Date().toISOString()
                resolve(true)
              } else {
                resolve(false)
              }
            } catch {
              resolve(false)
            }
          })
        } else {
          resolve(false)
        }
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  public async start(): Promise<ResearchSidecarStatus> {
    if (this.status === 'running' && this.process) {
      return this.getStatus()
    }

    // 1. Check if already running on port 8765 (e.g. from previous instance or background)
    const isAlive = await this.pingHealth()
    if (isAlive) {
      logger.info(`[ResearchSidecar] Sidecar already responding on http://${this.host}:${this.port}/health`)
      this.status = 'running'
      this.startMonitoring()
      return this.getStatus()
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
    logger.info(`[ResearchSidecar] Spawning YouTube Research sidecar via uv...`, { uvPath, serviceDir })

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
          UV_LINK_MODE: 'copy'
        },
        windowsHide: true
      })

      if (this.process.pid) {
        const metadata = {
          pid: this.process.pid,
          port: this.port,
          startedAt: new Date().toISOString(),
          service: 'YouTube Foreign Market Researcher'
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
        logger.info(`[ResearchSidecar] Exited with code ${code}, signal ${signal}`)
        this.process = null
        if (this.status !== 'stopped') {
          this.status = 'error'
          this.lastError = `Process exited with code ${code}`
        }
      })

      // Wait up to 12s for healthcheck to respond
      let attempts = 0
      while (attempts < 24) {
        await new Promise((r) => setTimeout(r, 500))
        const healthy = await this.pingHealth()
        if (healthy) {
          this.status = 'running'
          this.lastError = undefined
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

  public async stop(): Promise<void> {
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
    await this.stop()
    await new Promise((r) => setTimeout(r, 1000))
    return await this.start()
  }

  private startMonitoring(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval)
    this.healthCheckInterval = setInterval(async () => {
      const ok = await this.pingHealth()
      if (!ok && this.status === 'running') {
        logger.warn('[ResearchSidecar] Periodic ping failed. Marking degraded.')
        this.status = 'degraded'
      } else if (ok && this.status === 'degraded') {
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

        if (oldPid && !isNaN(oldPid)) {
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
        fs.unlinkSync(this.pidFilePath)
      }
    } catch {
      /* ignore */
    }
  }
}

export const researchSidecar = ResearchSidecarManager.getInstance()
