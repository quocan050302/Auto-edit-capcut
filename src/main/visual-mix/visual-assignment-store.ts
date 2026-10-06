import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { StockSceneAssignment } from '../../../shared/types'

const AI_PROVIDERS = new Set(['google-flow', 'manual-ai'])

function isAiProvider(provider: string | undefined): boolean {
  return !!provider && AI_PROVIDERS.has(provider)
}

/**
 * Concurrency-safe, atomic Visual Assignment Store (Section 28 & 29).
 * Manages the unified visual assignments (AI stills + stock footage)
 * with serialized atomic disk writes to analysis/stock-assignments.json.
 * Prevents Stock engine from overwriting valid Google Flow AI assignments.
 */
export class VisualAssignmentStore {
  private assignments = new Map<number, StockSceneAssignment>()
  private filePath: string
  private lockPromise: Promise<void> = Promise.resolve()

  constructor(projectDir: string) {
    this.filePath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    this.load()
  }

  public load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.assignments.clear()
          for (const a of parsed) {
            if (a && typeof a.sceneIndex === 'number') {
              this.assignments.set(a.sceneIndex, a)
            }
          }
        }
      } catch (err) {
        logger.warn(`[VisualAssignmentStore] Failed to load ${this.filePath}: ${err}`)
      }
    }
  }

  public get(sceneIndex: number): StockSceneAssignment | undefined {
    return this.assignments.get(sceneIndex)
  }

  public has(sceneIndex: number): boolean {
    return this.assignments.has(sceneIndex)
  }

  /**
   * Sets or updates an assignment.
   * If called by the stock engine, enforces Section 29:
   * never overwrites a valid Google Flow AI assignment.
   */
  public set(
    sceneIndex: number,
    assignment: StockSceneAssignment,
    isStockCaller = false
  ): boolean {
    const existing = this.assignments.get(sceneIndex)

    if (
      (isStockCaller || (assignment.asset && !isAiProvider(assignment.asset.provider))) &&
      isAiProvider(existing?.asset?.provider) &&
      existing?.status === 'assigned'
    ) {
      if (existing.asset?.localPath && fs.existsSync(existing.asset.localPath)) {
        logger.info(
          `[VisualAssignmentStore] Preserving valid ${existing.asset.provider} AI assignment for scene ${sceneIndex} against stock overwrite.`
        )
        return false
      }
    }

    this.assignments.set(sceneIndex, assignment)
    return true
  }

  public setMany(assignments: StockSceneAssignment[], isStockCaller = false): void {
    for (const a of assignments) {
      this.set(a.sceneIndex, a, isStockCaller)
    }
  }

  public delete(sceneIndex: number): boolean {
    return this.assignments.delete(sceneIndex)
  }

  public getAll(): StockSceneAssignment[] {
    return Array.from(this.assignments.values()).sort((a, b) => a.sceneIndex - b.sceneIndex)
  }

  /**
   * Thread-safe atomic disk flush using a mutex queue and temporary file rename.
   */
  public async flushAtomic(): Promise<void> {
    const previousLock = this.lockPromise
    let releaseLock: () => void = () => {}
    this.lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    await previousLock

    try {
      const items = this.getAll()
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmpPath = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2)}`
      fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2), 'utf-8')
      fs.renameSync(tmpPath, this.filePath)
    } finally {
      releaseLock()
    }
  }
}
