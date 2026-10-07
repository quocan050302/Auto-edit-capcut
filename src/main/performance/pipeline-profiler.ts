import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'

export interface ProfilerReport {
  schemaVersion: 1
  runId: string
  startedAt: string
  completedAt?: string
  totalMs: number
  stages: Record<string, { wallMs: number; cacheHit: boolean }>
  operations: Array<{ stage: string; operation: string; durationMs: number }>
  cache: { hits: number; misses: number }
  apiCalls: { gemini: number; pexels: number; pixabay: number; openverse: number }
  render: { reusedScenes: number; renderedScenes: number; reusedOverlayBlocks: number }
}

class PipelineProfiler {
  private report: ProfilerReport | null = null
  private projectDir: string = ''
  private startTimes = new Map<string, number>()
  private operationStartTimes = new Map<string, number>()

  public startRun(projectDir: string, runId: string): void {
    this.projectDir = projectDir
    this.report = {
      schemaVersion: 1,
      runId,
      startedAt: new Date().toISOString(),
      totalMs: 0,
      stages: {},
      operations: [],
      cache: { hits: 0, misses: 0 },
      apiCalls: { gemini: 0, pexels: 0, pixabay: 0, openverse: 0 },
      render: { reusedScenes: 0, renderedScenes: 0, reusedOverlayBlocks: 0 }
    }
    this.startTimes.set('overall', performance.now())
  }

  public endRun(): void {
    if (!this.report) return
    const overallStart = this.startTimes.get('overall')
    if (overallStart !== undefined) {
      this.report.totalMs = performance.now() - overallStart
    }
    this.report.completedAt = new Date().toISOString()
    this.flush()
  }

  public startStage(stageName: string): void {
    this.startTimes.set(`stage_${stageName}`, performance.now())
  }

  public endStage(stageName: string, cacheHit: boolean = false): void {
    if (!this.report) return
    const start = this.startTimes.get(`stage_${stageName}`)
    if (start !== undefined) {
      this.report.stages[stageName] = {
        wallMs: performance.now() - start,
        cacheHit
      }
    }
  }

  public startOperation(stageName: string, opName: string): void {
    this.operationStartTimes.set(`${stageName}_${opName}`, performance.now())
  }

  public endOperation(stageName: string, opName: string): void {
    if (!this.report) return
    const key = `${stageName}_${opName}`
    const start = this.operationStartTimes.get(key)
    if (start !== undefined) {
      this.report.operations.push({
        stage: stageName,
        operation: opName,
        durationMs: performance.now() - start
      })
      this.operationStartTimes.delete(key)
    }
  }

  public trackCache(type: 'hit' | 'miss'): void {
    if (!this.report) return
    if (type === 'hit') this.report.cache.hits++
    else this.report.cache.misses++
  }

  public trackApi(provider: keyof ProfilerReport['apiCalls'], count: number = 1): void {
    if (!this.report) return
    this.report.apiCalls[provider] += count
  }

  public trackRender(type: keyof ProfilerReport['render'], count: number = 1): void {
    if (!this.report) return
    this.report.render[type] += count
  }

  public flush(): void {
    if (!this.report || !this.projectDir) return
    try {
      const analysisDir = path.join(this.projectDir, 'analysis')
      if (!fs.existsSync(analysisDir)) {
        fs.mkdirSync(analysisDir, { recursive: true })
      }
      fs.writeFileSync(
        path.join(analysisDir, 'performance-report.json'),
        JSON.stringify(this.report, null, 2),
        'utf-8'
      )

      // Write summary
      const summary = `
================ PERFORMANCE SUMMARY ================
Run ID: ${this.report.runId}
Total Time: ${(this.report.totalMs / 1000).toFixed(2)}s
Cache: ${this.report.cache.hits} hits / ${this.report.cache.misses} misses
API Calls: Gemini (${this.report.apiCalls.gemini}), Pexels (${this.report.apiCalls.pexels}), Pixabay (${this.report.apiCalls.pixabay})
Render: ${this.report.render.reusedScenes} scenes reused, ${this.report.render.renderedScenes} rendered
=====================================================
`
      fs.writeFileSync(path.join(analysisDir, 'performance-summary.txt'), summary.trim(), 'utf-8')
    } catch (err) {
      logger.warn(`[PipelineProfiler] Failed to write performance report: ${err}`)
    }
  }

  public getReport(): ProfilerReport | null {
    return this.report
  }
}

export const pipelineProfiler = new PipelineProfiler()
