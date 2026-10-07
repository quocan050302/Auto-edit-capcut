/**
 * Shared helpers for the manual-ai (Prompt mode) tests.
 */
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  normalizeVisualMixConfig,
  type AiImageMode,
  type AutoPipelineOptions,
  type StockSceneAssignment,
  type VisualMixConfig
} from '../shared/types'
import type { ImageNormalizer } from '../src/main/visual-mix/manual-ai/manual-ai-importer'

export { assert }

export function createRunner(label: string): {
  it: (name: string, fn: () => Promise<void> | void) => Promise<void>
  finish: () => void
} {
  let passed = 0
  let failed = 0
  return {
    async it(name, fn) {
      try {
        await fn()
        console.log(`  \u2713 ${name}`)
        passed++
      } catch (err) {
        console.error(`  \u2717 ${name}`)
        console.error(`    ${(err as Error).stack || (err as Error).message}`)
        failed++
      }
    },
    finish() {
      console.log(`\n${label}: ${passed} passed, ${failed} failed.\n`)
      if (failed > 0) process.exit(1)
    }
  }
}

export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 2
  return b
}

/** Minimal JPEG header with a SOF0 marker (enough for header-based dimension probing). */
export function jpegHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  b[3] = 0xc0
  b.writeUInt16BE(17, 4)
  b[6] = 8
  b.writeUInt16BE(height, 7)
  b.writeUInt16BE(width, 9)
  return b
}

const ROOT = path.join(__dirname, 'fixtures', 'manual-ai')
let dirCounter = 0

export function freshDir(prefix = 'p'): string {
  const dir = path.join(ROOT, `${prefix}${process.pid}_${++dirCounter}_${Date.now() % 100000}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanupFixtures(): void {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export interface MakeProjectOptions {
  /** Narration generator override. */
  narration?: (i: number) => string
  /** Health flavoured narration/intents. */
  health?: boolean
}

export function makeProject(sceneCount: number, opts: MakeProjectOptions = {}): string {
  const dir = freshDir('proj')
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true })
  const scenes = Array.from({ length: sceneCount }, (_, i) => {
    const n = i + 1
    const narration = opts.narration
      ? opts.narration(n)
      : opts.health
        ? `Deep sleep lets the brain clear waste while the heart rate slows down in scene ${n}.`
        : n % 2 === 0
          ? `Ancient Roman legions march across the empire frontier in scene ${n}.`
          : `Crowds of people walking through the city market in scene ${n}.`
    return {
      sceneIndex: n,
      sceneId: `scene_${n}`,
      narrativeText: narration,
      visualIntent: opts.health ? 'brain and heart during deep sleep' : n % 2 === 0 ? 'historical reconstruction of Roman legions' : 'real footage of city market',
      startTime: i * 5,
      endTime: (i + 1) * 5,
      duration: 5,
      searchQueries: [`q${n}`]
    }
  })
  fs.writeFileSync(
    path.join(dir, 'analysis', 'master-edit-plan.json'),
    JSON.stringify({ chapters: [{ chapterIndex: 0, chapters_seq: [{ sequenceIndex: 0, scenes }] }] }),
    'utf-8'
  )
  return dir
}

export function rewriteNarration(dir: string, sceneIndex: number, text: string): void {
  const p = path.join(dir, 'analysis', 'master-edit-plan.json')
  const plan = JSON.parse(fs.readFileSync(p, 'utf-8'))
  for (const sc of plan.chapters[0].chapters_seq[0].scenes) {
    if (sc.sceneIndex === sceneIndex) sc.narrativeText = text
  }
  fs.writeFileSync(p, JSON.stringify(plan), 'utf-8')
}

export function mixOf(
  ai: number,
  stock: number,
  aiImageMode: AiImageMode = 'prompt',
  resolution: '1080p' | '2k' | '4k' = '1080p'
): VisualMixConfig {
  return normalizeVisualMixConfig(
    { mode: 'custom-mix', aiImageRatio: ai, stockFootageRatio: stock, aiImageMode, imageOutputResolution: resolution },
    'custom-mix'
  )
}

export function optionsFor(projectDir: string): AutoPipelineOptions {
  return { projectDir, resolution: { width: 1920, height: 1080 } } as unknown as AutoPipelineOptions
}

/** Writes project-state.json the same way the app stores inputs (used by the engine config check / render guard). */
export function writeProjectState(dir: string, mix: VisualMixConfig, visualSourceMode: 'custom-mix' | 'legacy' = 'custom-mix'): void {
  fs.writeFileSync(
    path.join(dir, 'project-state.json'),
    JSON.stringify({ inputs: { visualSourceMode, visualMixConfig: mix } }),
    'utf-8'
  )
}

/** Fast normalizer for tests: produces a header-only PNG of the requested size. */
export const fakeNormalizer: ImageNormalizer = async (_src, dest, width, height) => {
  fs.writeFileSync(dest, pngHeader(width, height))
}

/** Creates an importable external image file. */
export function makeExternalImage(dir: string, fileName: string, width = 1920, height = 1080): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, fileName)
  const ext = path.extname(fileName).toLowerCase()
  fs.writeFileSync(p, ext === '.jpg' || ext === '.jpeg' ? jpegHeader(width, height) : pngHeader(width, height))
  return p
}

export function sceneFileName(sceneIndex: number, ext = '.png'): string {
  return `S${String(sceneIndex).padStart(4, '0')}${ext}`
}

export interface StockLog {
  calls: Array<{ indices: number[] }>
}

export function makeMockStock(
  projectDir: string,
  log: StockLog,
  opts: { gate?: Promise<void>; onStart?: () => void } = {}
) {
  return async (params: {
    targetSceneIndices?: number[]
    assignmentSink?: (a: StockSceneAssignment[]) => void | Promise<void>
  }): Promise<{ success: boolean; totalScenes: number; assignedScenes: number; failedScenes: number; assignments: StockSceneAssignment[] }> => {
    const indices = params.targetSceneIndices ?? []
    log.calls.push({ indices: [...indices] })
    opts.onStart?.()
    if (opts.gate) await opts.gate
    const assignments: StockSceneAssignment[] = indices.map((idx) => {
      const file = path.join(projectDir, 'assets', 'stock', `stock_${idx}.mp4`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'x'.repeat(64))
      return {
        sceneId: `scene_${idx}`,
        sceneIndex: idx,
        narrationText: '',
        startTime: 0,
        endTime: 5,
        visualIntent: '',
        searchQueries: [],
        usedQuery: 'q',
        score: 80,
        locked: false,
        manualOverride: false,
        status: 'assigned',
        asset: {
          assetId: `px_${idx}`,
          provider: 'pexels',
          mediaType: 'video',
          localPath: file,
          thumbnailUrl: '',
          downloadUrl: '',
          creator: 'x',
          searchQuery: 'q',
          downloadedAt: new Date().toISOString(),
          fileSizeBytes: 64
        }
      } as unknown as StockSceneAssignment
    })
    if (params.assignmentSink) await params.assignmentSink(assignments)
    return { success: true, totalScenes: indices.length, assignedScenes: indices.length, failedScenes: 0, assignments }
  }
}

export function readAssignments(dir: string): StockSceneAssignment[] {
  return JSON.parse(fs.readFileSync(path.join(dir, 'analysis', 'stock-assignments.json'), 'utf-8'))
}

export function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out')
    await sleep(stepMs)
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
