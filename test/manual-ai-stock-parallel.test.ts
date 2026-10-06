/**
 * Manual AI (Prompt mode) — engine-level tests for the two-branch execution.
 * Covers: 85/15 exact ownership + prompts, Stock target scope (15, never 100/85), zero FlowKit
 * calls, Stock starts before any manual image exists, Stock finishing while AI waits, import-all
 * auto-continue, manual-first, partial import, cancel, 100/0, 0/100, old-Stock-leak deactivation,
 * assignment race, Auto-mode regression.
 */
import * as fs from 'fs'
import * as path from 'path'
import { runMixedVisualEngine } from '../src/main/visual-mix/mixed-visual-engine'
import { googleFlowClient } from '../src/main/thumbnail/google-flow-client'
import { flowkitRuntimeManager } from '../src/main/thumbnail/flowkit-runtime-manager'
import { manualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { commitManualAiImport, planManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { loadManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  getManualAiAssetsDir,
  getManualAiManifestPath,
  getManualAiPromptJsonPath,
  getManualAiPromptTxtPath
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import { recordVisualAssetQueued } from '../src/main/visual-mix/visual-mix-cache'
import type { FlowImagePool, GenerationItemResult, GenerationPoolItem } from '../src/main/visual-mix/flow-image-pool'
import type { ManualAiWaitInfo, StockSceneAssignment, VisualMixConfig, VisualMixProfile } from '../shared/types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  deferred,
  fakeNormalizer,
  freshDir,
  makeExternalImage,
  makeMockStock,
  makeProject,
  mixOf,
  optionsFor,
  pngHeader,
  readAssignments,
  readJson,
  rewriteNarration,
  sceneFileName,
  sleep,
  waitFor,
  writeProjectState,
  type StockLog
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Stock-Parallel Engine Tests')

// ─── Flow spies: Prompt mode must never reach FlowKit ───────────────────────
const flowCalls = { generateImage: 0, checkHealth: 0, getFlowThrottle: 0, ensureFlowReady: 0, poolBatches: 0 }

function resetFlowCalls(): void {
  flowCalls.generateImage = 0
  flowCalls.checkHealth = 0
  flowCalls.getFlowThrottle = 0
  flowCalls.ensureFlowReady = 0
  flowCalls.poolBatches = 0
}

function installFlowSpies(): void {
  const gf = googleFlowClient as unknown as Record<string, unknown>
  gf.generateImage = async () => {
    flowCalls.generateImage++
    throw new Error('FLOW generateImage must not be called in Prompt mode')
  }
  gf.checkHealth = async () => {
    flowCalls.checkHealth++
    return { reachable: false, extensionConnected: false, message: 'spy' }
  }
  gf.getFlowThrottle = async () => {
    flowCalls.getFlowThrottle++
    return { maxConcurrent: 1, minIntervalS: 3, cooldownActive: false }
  }
  const fk = flowkitRuntimeManager as unknown as Record<string, unknown>
  fk.ensureFlowReady = async () => {
    flowCalls.ensureFlowReady++
    return { ready: false, bridgeReachable: false, extensionConnected: false, flowConnected: false, message: 'spy' }
  }
}

/** Pool that counts calls. In Prompt mode it must never be invoked. */
function makeSpyPool(): FlowImagePool {
  return {
    processBatch: async (items: GenerationPoolItem[]): Promise<GenerationItemResult[]> => {
      flowCalls.poolBatches++
      const out: GenerationItemResult[] = []
      for (const item of items) {
        const idx = item.scene.sceneIndex
        const file = path.join(item.projectDir, 'assets', 'generated', 'general', `S${idx}.png`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, pngHeader(1920, 1080))
        await recordVisualAssetQueued(item.projectDir, {
          sceneIndex: idx,
          strategy: 'ai-still',
          profile: item.profile,
          promptHash: item.scene.generationHash || 'hash',
          status: 'completed',
          outputPath: file,
          width: 1920,
          height: 1080,
          generatedAt: new Date().toISOString()
        })
        out.push({ sceneIndex: idx, success: true, assetPath: file })
      }
      return out
    }
  } as unknown as FlowImagePool
}

interface EngineRun {
  promise: Promise<Awaited<ReturnType<typeof runMixedVisualEngine>>>
  ac: AbortController
  progress: Array<{ msg: string; pct: number; meta?: { manualAiWait?: ManualAiWaitInfo | null } }>
  state: { done: boolean; result?: Awaited<ReturnType<typeof runMixedVisualEngine>>; error?: Error }
}

function startEngine(params: {
  dir: string
  mix: VisualMixConfig
  stockLog: StockLog
  profile?: VisualMixProfile
  stockGate?: Promise<void>
  onStockStart?: () => void
  auto?: boolean
}): EngineRun {
  const ac = new AbortController()
  const progress: EngineRun['progress'] = []
  const state: EngineRun['state'] = { done: false }
  const promise = runMixedVisualEngine({
    options: optionsFor(params.dir),
    profile: params.profile ?? 'general',
    mix: params.mix,
    signal: ac.signal,
    onProgress: (msg: string, pct: number, meta?: { manualAiWait?: ManualAiWaitInfo | null }) => {
      progress.push({ msg, pct, meta })
    },
    flowPool: makeSpyPool(),
    deps: {
      stockRunner: makeMockStock(params.dir, params.stockLog, { gate: params.stockGate, onStart: params.onStockStart }) as never,
      // Auto mode tests skip the (spied) readiness probe like the existing strict-contract tests;
      // Prompt mode tests deliberately do NOT, which proves the probe is never used.
      skipFlowReadiness: params.auto === true,
      manualAiPollMs: 40
    }
  })
  promise.then(
    (r) => {
      state.done = true
      state.result = r
    },
    (e) => {
      state.done = true
      state.error = e as Error
    }
  )
  return { promise, ac, progress, state }
}

async function importScenes(dir: string, indices: number[], extDir?: string): Promise<void> {
  const ext = extDir ?? freshDir('ext')
  const files = indices.map((i) => makeExternalImage(ext, sceneFileName(i)))
  const plan = planManualAiImport({ projectDir: dir, filePaths: files })
  assert.strictEqual(plan.rejections.length, 0, JSON.stringify(plan.rejections))
  const res = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
  assert.strictEqual(res.rejections.length, 0, JSON.stringify(res.rejections))
}

function ownership(dir: string): { ai: number[]; stock: number[] } {
  const plan = VisualMixPlanner.loadPlan(dir)!
  return {
    ai: plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex).sort((a, b) => a - b),
    stock: plan.scenes.filter((s) => s.strategy === 'stock').map((s) => s.sceneIndex).sort((a, b) => a - b)
  }
}

/** Waits until the engine reached its waiting state (prompt pack on disk + gate subscribed). */
async function untilWaiting(dir: string, run: EngineRun): Promise<void> {
  await waitFor(() => {
    if (run.state.done) {
      throw new Error(`engine ended before reaching the waiting state: ${run.state.error?.stack ?? JSON.stringify(run.state.result)}`)
    }
    return fs.existsSync(getManualAiPromptJsonPath(dir)) && manualAiAssetGate.waiterCount(dir) === 1
  }, 30000)
}

function lastWait(run: EngineRun): ManualAiWaitInfo | null | undefined {
  for (let i = run.progress.length - 1; i >= 0; i--) {
    if (run.progress[i].meta && 'manualAiWait' in run.progress[i].meta!) return run.progress[i].meta!.manualAiWait
  }
  return undefined
}

async function main(): Promise<void> {
  console.log('\nManual AI engine (two-branch execution)')
  installFlowSpies()

  await it('85/15 Prompt: 85 prompts, Stock gets EXACTLY the 15 stock scenes, Flow calls = 0, Stock starts with 0 images', async () => {
    resetFlowCalls()
    const dir = makeProject(100)
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.85, 0.15, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await waitFor(() => stockLog.calls.length === 1)

    const own = ownership(dir)
    assert.strictEqual(own.ai.length, 85)
    assert.strictEqual(own.stock.length, 15)
    const plan = VisualMixPlanner.loadPlan(dir)!
    assert.strictEqual(plan.targetAiScenes, 85)
    assert.strictEqual(plan.targetStockScenes, 15)

    // 85 prompts, exact set, TXT matches
    const pack = loadManualAiPromptPack(dir)!
    assert.strictEqual(pack.scenes.length, 85)
    assert.deepStrictEqual(pack.scenes.map((s) => s.sceneIndex), own.ai)
    const txt = fs.readFileSync(getManualAiPromptTxtPath(dir), 'utf-8')
    assert.strictEqual(txt.split('\n').filter((l) => l.startsWith('SCENE ')).length, 85)

    // Stock engine scope = 15 stock scenes only (never 100, never 85, never an AI scene)
    assert.strictEqual(stockLog.calls.length, 1)
    assert.deepStrictEqual([...stockLog.calls[0].indices].sort((a, b) => a - b), own.stock)
    assert.strictEqual(stockLog.calls[0].indices.length, 15)
    assert.ok(stockLog.calls[0].indices.every((i) => !own.ai.includes(i)))

    // Stock started while NOTHING was imported
    const manifestPath = getManualAiManifestPath(dir)
    assert.ok(!fs.existsSync(manifestPath) || readJson(manifestPath).ready === 0)

    // Zero FlowKit usage
    assert.strictEqual(flowCalls.generateImage, 0, 'GoogleFlowClient.generateImage')
    assert.strictEqual(flowCalls.ensureFlowReady, 0, 'FlowKit readiness')
    assert.strictEqual(flowCalls.checkHealth, 0)
    assert.strictEqual(flowCalls.getFlowThrottle, 0)
    assert.strictEqual(flowCalls.poolBatches, 0, 'Flow image pool')

    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)
  })

  await it('Stock finishes while AI waits: pipeline keeps waiting, Stock persisted, NO repeated Stock search', async () => {
    resetFlowCalls()
    const dir = makeProject(100)
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.85, 0.15, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await waitFor(() => readAssignmentsSafe(dir).filter((a) => a.asset?.provider === 'pexels').length === 15)
    await sleep(250)
    assert.strictEqual(run.state.done, false, 'must remain waiting for AI images')
    assert.strictEqual(stockLog.calls.length, 1, 'Stock searched exactly once')
    const wait = lastWait(run)
    assert.ok(wait, 'wait info published')
    assert.strictEqual(wait!.expected, 85)
    assert.strictEqual(wait!.ready, 0)
    assert.strictEqual(wait!.stockExpected, 15)
    assert.strictEqual(wait!.stockReady, 15)
    assert.strictEqual(wait!.missingSceneIndices.length, 85)
    assert.ok(wait!.promptFilePath.endsWith('manual-ai-prompts.txt'))
    assert.strictEqual(flowCalls.generateImage + flowCalls.poolBatches + flowCalls.ensureFlowReady, 0)
    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)
  })

  await it('import all 85 -> gate resolves, pipeline continues automatically; 85 manual-ai + 15 stock merged', async () => {
    resetFlowCalls()
    const dir = makeProject(100)
    writeProjectState(dir, mixOf(0.85, 0.15, 'prompt'))
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.85, 0.15, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await waitFor(() => stockLog.calls.length === 1)
    const own = ownership(dir)

    // import in two chunks (partial first)
    await importScenes(dir, own.ai.slice(0, 20))
    await waitFor(() => (lastWait(run)?.ready ?? 0) === 20)
    assert.strictEqual(run.state.done, false)
    await importScenes(dir, own.ai.slice(20))
    const result = await run.promise
    assert.strictEqual(result.success, true, JSON.stringify(result))
    assert.strictEqual(manualAiAssetGate.waiterCount(dir), 0, 'gate released')

    const assignments = readAssignments(dir)
    const byScene = new Map(assignments.map((a) => [a.sceneIndex, a]))
    for (const i of own.ai) {
      const a = byScene.get(i)!
      assert.strictEqual(a.asset!.provider, 'manual-ai', `scene ${i}`)
      assert.strictEqual(a.asset!.mediaType, 'photo')
      assert.ok(a.asset!.localPath.endsWith(sceneFileName(i)))
      assert.ok(fs.existsSync(a.asset!.localPath))
    }
    for (const i of own.stock) assert.strictEqual(byScene.get(i)!.asset!.provider, 'pexels', `scene ${i}`)
    assert.strictEqual(assignments.length, 100)
    assert.strictEqual(stockLog.calls.length, 1)

    // performance report (Prompt mode metrics, labelled)
    const report = readJson(path.join(dir, 'analysis', 'visual-performance-report.json'))
    assert.strictEqual(report.aiImageMode, 'prompt')
    assert.strictEqual(report.flowCalls, 0)
    assert.strictEqual(report.providerCounts.manualAi, 85)
    assert.strictEqual(report.providerCounts.googleFlow, 0)
    assert.strictEqual(report.manualAi.promptCount, 85)
    assert.strictEqual(report.manualAi.manualExpected, 85)
    assert.strictEqual(report.manualAi.manualImported, 85)
    assert.strictEqual(report.manualAi.stockSceneCount, 15)
    assert.ok(typeof report.manualAi.promptGenerationMs === 'number')
    assert.ok(typeof report.manualAi.manualWaitDurationMs === 'number')
    assert.ok(typeof report.manualAi.stockAcquisitionMs === 'number')
    assert.strictEqual(report.stockEngineInvocations, 1)
    assert.strictEqual(report.stockSceneTargets, 15)
    assert.strictEqual(lastWait(run), null, 'wait meta cleared on completion')
    assert.strictEqual(flowCalls.generateImage + flowCalls.poolBatches + flowCalls.ensureFlowReady, 0)
  })

  await it('manual images finish FIRST: pipeline waits for Stock, then continues automatically', async () => {
    const dir = makeProject(40)
    const gate = deferred()
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.8, 0.2, 'prompt'), stockLog, stockGate: gate.promise })
    await untilWaiting(dir, run)
    await waitFor(() => stockLog.calls.length === 1)
    const own = ownership(dir)
    await importScenes(dir, own.ai)
    await waitFor(() => lastWait(run)?.ready === own.ai.length)
    await sleep(200)
    assert.strictEqual(run.state.done, false, 'Stock still running')
    assert.strictEqual(lastWait(run)?.stockReady, 0)
    gate.resolve()
    const result = await run.promise
    assert.strictEqual(result.success, true, JSON.stringify(result))
  })

  await it('partial import 30/85: no completion, no Stock fallback; cancel preserves prompts/manifest/Stock', async () => {
    const dir = makeProject(100)
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.85, 0.15, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await waitFor(() => stockLog.calls.length === 1)
    const own = ownership(dir)
    await importScenes(dir, own.ai.slice(0, 30))
    await waitFor(() => lastWait(run)?.ready === 30)
    await sleep(150)
    assert.strictEqual(run.state.done, false)
    const wait = lastWait(run)!
    assert.strictEqual(wait.ready, 30)
    assert.strictEqual(wait.missingSceneIndices.length, 55)
    assert.deepStrictEqual(wait.missingSceneIndices, own.ai.slice(30))

    // no AI-owned scene is fulfilled by anything other than manual-ai
    for (const a of readAssignments(dir)) {
      if (own.ai.includes(a.sceneIndex)) assert.strictEqual(a.asset!.provider, 'manual-ai')
    }
    const aiWithoutImage = own.ai.slice(30)
    const got = new Set(readAssignments(dir).map((a) => a.sceneIndex))
    for (const i of aiWithoutImage) assert.ok(!got.has(i), `scene ${i} must stay unassigned (no Stock fallback)`)

    // cancel
    run.ac.abort()
    await assert.rejects(run.promise, /Pipeline execution was cancelled\./)
    assert.strictEqual(manualAiAssetGate.waiterCount(dir), 0, 'waiting gate stopped')
    assert.ok(fs.existsSync(getManualAiPromptJsonPath(dir)), 'prompts preserved')
    assert.strictEqual(readJson(getManualAiManifestPath(dir)).ready, 30, 'manifest preserved')
    assert.strictEqual(fs.readdirSync(getManualAiAssetsDir(dir)).filter((f) => /^S\d{4}\.png$/.test(f)).length, 30)
    assert.strictEqual(readAssignments(dir).filter((a) => a.asset?.provider === 'pexels').length, 15, 'Stock preserved')
  })

  await it('100/0 Prompt: 100 prompts, Stock runner NEVER invoked, waits for 100 images, then completes', async () => {
    resetFlowCalls()
    const dir = makeProject(30)
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(1, 0, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await sleep(150)
    assert.strictEqual(loadManualAiPromptPack(dir)!.scenes.length, 30)
    assert.strictEqual(stockLog.calls.length, 0, 'zero Stock calls (no Pexels/Pixabay)')
    assert.strictEqual(run.state.done, false)
    await importScenes(dir, Array.from({ length: 30 }, (_, i) => i + 1))
    const res = await run.promise
    assert.strictEqual(res.success, true, JSON.stringify(res))
    assert.strictEqual(stockLog.calls.length, 0)
    const report = readJson(path.join(dir, 'analysis', 'visual-performance-report.json'))
    assert.strictEqual(report.stockEngineInvocations, 0)
    assert.strictEqual(report.pexelsSearchCalls, 0)
    assert.strictEqual(report.pixabaySearchCalls, 0)
    assert.strictEqual(flowCalls.generateImage + flowCalls.poolBatches + flowCalls.ensureFlowReady, 0)
  })

  await it('0/100 with Prompt selected: behaves as normal Stock (no prompt pack, no gate, all 100 Stock)', async () => {
    resetFlowCalls()
    const dir = makeProject(100)
    const stockLog: StockLog = { calls: [] }
    const res = await startEngine({ dir, mix: mixOf(0, 1, 'prompt'), stockLog }).promise
    assert.strictEqual(res.success, true, JSON.stringify(res))
    assert.strictEqual(stockLog.calls.length, 1)
    assert.strictEqual(stockLog.calls[0].indices.length, 100)
    assert.ok(!fs.existsSync(getManualAiPromptJsonPath(dir)))
    assert.ok(!fs.existsSync(getManualAiPromptTxtPath(dir)))
    assert.strictEqual(manualAiAssetGate.waiterCount(dir), 0)
    assert.strictEqual(flowCalls.generateImage + flowCalls.poolBatches + flowCalls.ensureFlowReady, 0)
  })

  await it('old Stock assignment on a newly AI-owned scene is deactivated (file stays cached)', async () => {
    const dir = makeProject(20)
    // Discover ownership of a 100% AI prompt run, then seed Stock assignments on those scenes.
    const stockFile = path.join(dir, 'assets', 'stock', 'old_stock_5.mp4')
    fs.mkdirSync(path.dirname(stockFile), { recursive: true })
    fs.writeFileSync(stockFile, 'x'.repeat(64))
    const seed = new VisualAssignmentStore(dir)
    seed.set(5, {
      sceneId: 'scene_5',
      sceneIndex: 5,
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
        assetId: 'px_old',
        provider: 'pexels',
        mediaType: 'video',
        localPath: stockFile,
        thumbnailUrl: '',
        downloadUrl: '',
        creator: 'x',
        searchQuery: 'q',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: 64
      }
    } as unknown as StockSceneAssignment)
    await seed.flushAtomic()

    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(1, 0, 'prompt'), stockLog })
    await untilWaiting(dir, run)
    await sleep(100)
    const a5 = readAssignments(dir).find((a) => a.sceneIndex === 5)
    assert.ok(!a5, 'old Stock assignment must not stay active on an AI-owned Prompt scene')
    assert.ok(fs.existsSync(stockFile), 'cached Stock file is kept on disk')
    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)
  })

  await it('assignment race: manual import + Stock completion at the same moment keep BOTH', async () => {
    const dir = makeProject(30)
    const gate = deferred()
    const stockLog: StockLog = { calls: [] }
    const run = startEngine({ dir, mix: mixOf(0.5, 0.5, 'prompt'), stockLog, stockGate: gate.promise })
    await untilWaiting(dir, run)
    await waitFor(() => stockLog.calls.length === 1)
    const own = ownership(dir)
    // fire both "at once"
    const ext = freshDir('ext')
    const files = own.ai.map((i) => makeExternalImage(ext, sceneFileName(i)))
    const plan = planManualAiImport({ projectDir: dir, filePaths: files })
    await Promise.all([
      commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer }),
      (async () => gate.resolve())()
    ])
    const result = await run.promise
    assert.strictEqual(result.success, true, JSON.stringify(result))
    const assignments = readAssignments(dir)
    assert.strictEqual(assignments.length, 30, 'no lost update')
    assert.strictEqual(assignments.filter((a) => a.asset?.provider === 'manual-ai').length, own.ai.length)
    assert.strictEqual(assignments.filter((a) => a.asset?.provider === 'pexels').length, own.stock.length)
  })

  await it('AUTO mode regression: Flow pool runs, manual gate is never invoked, no prompt files', async () => {
    resetFlowCalls()
    const dir = makeProject(20)
    const stockLog: StockLog = { calls: [] }
    const mix = mixOf(0.5, 0.5, 'auto')
    assert.strictEqual(mix.aiImageMode, 'auto')
    const res = await startEngine({ dir, mix, stockLog, auto: true }).promise
    assert.strictEqual(res.success, true, JSON.stringify(res))
    assert.ok(flowCalls.poolBatches >= 1, 'existing Flow generation path ran')
    assert.ok(!fs.existsSync(getManualAiPromptJsonPath(dir)))
    assert.ok(!fs.existsSync(getManualAiManifestPath(dir)))
    assert.strictEqual(manualAiAssetGate.waiterCount(dir), 0)
    const report = readJson(path.join(dir, 'analysis', 'visual-performance-report.json'))
    assert.strictEqual(report.aiImageMode, 'auto')
    assert.strictEqual(report.manualAi, undefined)
    assert.strictEqual(report.providerCounts.manualAi, 0)
    const a = readAssignments(dir)
    assert.ok(a.filter((x) => x.asset?.provider === 'google-flow').length > 0)
    assert.strictEqual(a.filter((x) => x.asset?.provider === 'manual-ai').length, 0)
  })

  await it('legacy / old config (no aiImageMode) resolves to Auto and behaves like Auto', async () => {
    resetFlowCalls()
    const dir = makeProject(10)
    const stockLog: StockLog = { calls: [] }
    const mix = mixOf(0.5, 0.5, 'auto') as VisualMixConfig & { aiImageMode?: string }
    delete mix.aiImageMode
    const res = await startEngine({ dir, mix, stockLog, auto: true }).promise
    assert.strictEqual(res.success, true, JSON.stringify(res))
    assert.ok(flowCalls.poolBatches >= 1)
    assert.ok(!fs.existsSync(getManualAiPromptJsonPath(dir)))
  })

  cleanupFixtures()
  finish()
}

function readAssignmentsSafe(dir: string): StockSceneAssignment[] {
  try {
    return readAssignments(dir)
  } catch {
    return []
  }
}

void main()
