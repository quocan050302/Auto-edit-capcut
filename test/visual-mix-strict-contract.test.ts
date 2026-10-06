/**
 * Strict Visual Mix contract tests.
 *
 * Selected Visual Mix is a STRICT CONTRACT by default: AI failures never silently turn into
 * Pexels/Pixabay footage unless the user explicitly enabled aiFailureBehavior='stock-fallback'.
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  normalizeVisualMixConfig,
  resolveVisualMixConfig,
  type StockSceneAssignment,
  type AutoPipelineOptions,
  type VisualMixConfig,
  type AiVisualFailureStage
} from '../shared/types'
import { runMixedVisualEngine } from '../src/main/visual-mix/mixed-visual-engine'
import { FlowImagePool, type GenerationPoolItem, type GenerationItemResult } from '../src/main/visual-mix/flow-image-pool'
import { loadGeneratedAssetsManifest, recordVisualAssetQueued } from '../src/main/visual-mix/visual-mix-cache'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import {
  assertStockAllowed,
  assertFinalVisualAssignments,
  validateFinalVisualAssignments
} from '../src/main/visual-mix/visual-mix-validator'
import { checkVisualCompletion } from '../src/main/pipeline/pipeline-artifacts'

let passed = 0
let failed = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).stack || (err as Error).message}`)
    failed++
  }
}

const ROOT = path.join(__dirname, 'fixtures', 'strict-contract')
let dirCounter = 0

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 2
  return b
}

function makeProject(sceneCount: number): string {
  const dir = path.join(ROOT, `p${++dirCounter}`)
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true })
  const scenes = Array.from({ length: sceneCount }, (_, i) => ({
    sceneIndex: i + 1,
    sceneId: `scene_${i + 1}`,
    narrativeText:
      i % 2 === 0
        ? `Ancient Roman legions march across the empire frontier in scene ${i + 1}.`
        : `Crowds of people walking through the city market in scene ${i + 1}.`,
    visualIntent: i % 2 === 0 ? 'historical reconstruction of Roman legions' : 'real footage of city market',
    startTime: i * 5,
    endTime: (i + 1) * 5,
    duration: 5,
    searchQueries: [`q${i + 1}`]
  }))
  fs.writeFileSync(
    path.join(dir, 'analysis', 'master-edit-plan.json'),
    JSON.stringify({ chapters: [{ chapterIndex: 0, chapters_seq: [{ sequenceIndex: 0, scenes }] }] }),
    'utf-8'
  )
  return dir
}

function mixOf(ai: number, stock: number, behavior?: 'strict' | 'stock-fallback'): VisualMixConfig {
  return normalizeVisualMixConfig(
    { mode: 'custom-mix', aiImageRatio: ai, stockFootageRatio: stock, aiFailureBehavior: behavior },
    'custom-mix'
  )
}

function optionsFor(projectDir: string): AutoPipelineOptions {
  return { projectDir, resolution: { width: 1920, height: 1080 } } as unknown as AutoPipelineOptions
}

/** Mock pool: scenes in failSceneSet fail at the given stage; others succeed and are cached in the manifest. */
function makeMockPool(
  failSceneSet: Set<number>,
  log: { batches: number[][]; fallbackFlag: boolean[] },
  stage: AiVisualFailureStage = 'generation'
): FlowImagePool {
  const pool = {
    processBatch: async (items: GenerationPoolItem[]): Promise<GenerationItemResult[]> => {
      log.batches.push(items.map((i) => i.scene.sceneIndex))
      const out: GenerationItemResult[] = []
      for (const item of items) {
        const idx = item.scene.sceneIndex
        const stockAllowed = (item.config.aiFailureBehavior ?? 'strict') === 'stock-fallback'
        if (failSceneSet.has(idx)) {
          log.fallbackFlag.push(stockAllowed)
          out.push({
            sceneIndex: idx,
            success: false,
            fallbackToStock: stockAllowed,
            failureStage: stage,
            reason: `mock ${stage} failure`
          })
          continue
        }
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
  }
  return pool as unknown as FlowImagePool
}

interface StockLog {
  calls: Array<{ indices: number[]; isFallbackGuess: boolean }>
}

function makeMockStock(projectDir: string, log: StockLog, aiIndicesProvider: () => Set<number>) {
  return async (params: {
    targetSceneIndices?: number[]
    assignmentSink?: (a: StockSceneAssignment[]) => void | Promise<void>
  }): Promise<{ success: boolean; totalScenes: number; assignedScenes: number; failedScenes: number; assignments: StockSceneAssignment[] }> => {
    const indices = params.targetSceneIndices ?? []
    const aiSet = aiIndicesProvider()
    log.calls.push({ indices: [...indices], isFallbackGuess: indices.some((i) => aiSet.has(i)) })
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

function readAssignments(dir: string): StockSceneAssignment[] {
  return JSON.parse(fs.readFileSync(path.join(dir, 'analysis', 'stock-assignments.json'), 'utf-8'))
}

function readReport(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'analysis', 'visual-performance-report.json'), 'utf-8'))
}

async function runEngine(params: {
  dir: string
  mix: VisualMixConfig
  failScenes: (aiIndices: number[]) => number[]
  stage?: AiVisualFailureStage
}): Promise<{
  result: Awaited<ReturnType<typeof runMixedVisualEngine>>
  poolLog: { batches: number[][]; fallbackFlag: boolean[] }
  stockLog: StockLog
}> {
  const poolLog = { batches: [] as number[][], fallbackFlag: [] as boolean[] }
  const stockLog: StockLog = { calls: [] }
  const failSet = new Set<number>()
  // Wrap the pool so failure indices are derived from the first batch it receives.
  const inner = makeMockPool(failSet, poolLog, params.stage)
  const pool = {
    processBatch: async (items: GenerationPoolItem[], ...rest: unknown[]) => {
      if (failSet.size === 0) {
        for (const i of params.failScenes(items.map((x) => x.scene.sceneIndex))) failSet.add(i)
      }
      return (inner as unknown as { processBatch: (...a: unknown[]) => Promise<GenerationItemResult[]> }).processBatch(items, ...rest)
    }
  } as unknown as FlowImagePool

  const aiSetHolder = new Set<number>()
  const origProcess = pool.processBatch.bind(pool)
  ;(pool as unknown as { processBatch: unknown }).processBatch = async (items: GenerationPoolItem[], ...rest: unknown[]) => {
    for (const i of items) aiSetHolder.add(i.scene.sceneIndex)
    return origProcess(items, ...(rest as []))
  }

  const result = await runMixedVisualEngine({
    options: optionsFor(params.dir),
    profile: 'general',
    mix: params.mix,
    onProgress: () => undefined,
    flowPool: pool,
    deps: {
      skipFlowReadiness: true,
      stockRunner: makeMockStock(params.dir, stockLog, () => aiSetHolder) as never
    }
  })
  return { result, poolLog, stockLog }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING STRICT VISUAL MIX CONTRACT TESTS')
  console.log('==================================================\n')

  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })

  // ── Config defaults ───────────────────────────────────────────────
  await it('aiFailureBehavior defaults to strict for new and old Custom Mix configs', () => {
    assert.strictEqual(mixOf(1, 0).aiFailureBehavior, 'strict')
    assert.strictEqual(
      normalizeVisualMixConfig({ mode: 'custom-mix', aiImageRatio: 0.8, stockFootageRatio: 0.2 }, 'custom-mix').aiFailureBehavior,
      'strict'
    )
    const legacyProjectCfg = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: { aiImageRatio: 1, stockFootageRatio: 0 } as Partial<VisualMixConfig>
    })
    assert.strictEqual(legacyProjectCfg.aiFailureBehavior, 'strict')
    assert.strictEqual(mixOf(0.5, 0.5, 'stock-fallback').aiFailureBehavior, 'stock-fallback')
  })

  await it('UI persistence: 100/0 strict 1080p survives JSON round trip', () => {
    const saved = JSON.stringify(mixOf(1, 0, 'strict'))
    const resolved = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: JSON.parse(saved)
    })
    assert.strictEqual(resolved.aiImageRatio, 1)
    assert.strictEqual(resolved.stockFootageRatio, 0)
    assert.strictEqual(resolved.aiFailureBehavior, 'strict')
    assert.strictEqual(resolved.imageOutputResolution, '1080p')
  })

  await it('generation concurrency precedence: requested > legacy alias > default 2', () => {
    const a = normalizeVisualMixConfig({ mode: 'custom-mix', requestedGenerationConcurrency: 2, generationConcurrency: 6 } as Partial<VisualMixConfig>, 'custom-mix')
    assert.strictEqual(a.requestedGenerationConcurrency, 2)
    const b = normalizeVisualMixConfig({ mode: 'custom-mix', generationConcurrency: 4 } as Partial<VisualMixConfig>, 'custom-mix')
    assert.strictEqual(b.requestedGenerationConcurrency, 4)
    const c = normalizeVisualMixConfig({ mode: 'custom-mix' }, 'custom-mix')
    assert.strictEqual(c.requestedGenerationConcurrency, 2)
  })

  // ── Engine integration ────────────────────────────────────────────
  await it('STRICT 100/0 with 2 AI failures: zero Stock calls (initial + fallback) and Needs Attention', async () => {
    const dir = makeProject(10)
    const { result, stockLog, poolLog } = await runEngine({
      dir,
      mix: mixOf(1, 0, 'strict'),
      failScenes: (ai) => ai.slice(0, 2)
    })
    assert.strictEqual(poolLog.batches[0].length, 10, 'AI queue must receive all 10 scenes')
    assert.strictEqual(stockLog.calls.length, 0, 'Stock engine must never be invoked (initial or fallback)')
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.needsAttention, true)
    assert.ok(/AI visuals failed and Stock fallback is disabled/.test(result.error ?? ''), result.error)
    assert.strictEqual(result.stats?.failedAiScenes, 2)
    assert.strictEqual(result.stats?.aiGeneratedScenes, 8)
    assert.strictEqual(result.stats?.stockScenes, 0)

    const report = readReport(dir)
    assert.strictEqual(report.failureBehavior, 'strict')
    assert.strictEqual(report.completedAiScenes, 8)
    assert.strictEqual(report.completedStockScenes, 0)
    assert.strictEqual(report.failedAiScenes, 2)
    assert.strictEqual(report.stockEngineInvocations, 0)
    assert.strictEqual(report.pexelsSearchCalls, 0)
    assert.strictEqual(report.pixabaySearchCalls, 0)
    assert.strictEqual(report.stockDownloadCount, 0)
    assert.strictEqual(report.stockFallbackCount, 0)
    assert.strictEqual(report.strictModeBlockedStockCalls, 2)

    // Plan is USER INTENT: failed scenes stay AI-owned.
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'analysis', 'visual-mix-plan.json'), 'utf-8'))
    assert.ok(plan.scenes.every((s: { strategy: string }) => s.strategy === 'ai-still'))

    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'analysis', 'visual-input-snapshot.json'), 'utf-8'))
    assert.strictEqual(snapshot.aiFailureBehavior, 'strict')
    assert.strictEqual(snapshot.requestedAiPercent, 100)
    assert.strictEqual(snapshot.requestedStockPercent, 0)
  })

  await it('STRICT 100/0 all success: 10 AI, 0 Stock, no Stock engine, success', async () => {
    const dir = makeProject(10)
    const { result, stockLog } = await runEngine({ dir, mix: mixOf(1, 0, 'strict'), failScenes: () => [] })
    assert.strictEqual(result.success, true, result.error)
    assert.strictEqual(stockLog.calls.length, 0)
    const report = readReport(dir)
    assert.strictEqual(report.completedAiScenes, 10)
    assert.strictEqual(report.completedStockScenes, 0)
    assert.strictEqual(report.requestedStockScenes, 0)
    assert.strictEqual(report.stockFallbackCount, 0)
    assert.strictEqual(report.stockDownloadCount, 0)
    assert.strictEqual(checkVisualCompletion(dir).missingScenes, 0)
  })

  await it('STRICT 80/20 (100 scenes): initial Stock=20, fallback Stock=0, 78 AI + 20 Stock + 2 failed AI, Needs Attention', async () => {
    const dir = makeProject(100)
    const { result, stockLog, poolLog } = await runEngine({
      dir,
      mix: mixOf(0.8, 0.2, 'strict'),
      failScenes: (ai) => ai.slice(0, 2)
    })
    assert.strictEqual(poolLog.batches[0].length, 80)
    assert.strictEqual(stockLog.calls.length, 1, 'only the initial Stock branch may run')
    assert.strictEqual(stockLog.calls[0].indices.length, 20)
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.needsAttention, true)
    const report = readReport(dir)
    assert.strictEqual(report.completedAiScenes, 78)
    assert.strictEqual(report.completedStockScenes, 20)
    assert.strictEqual(report.failedAiScenes, 2)
    assert.strictEqual(report.stockFallbackCount, 0)
  })

  await it('FALLBACK-ENABLED 80/20: initial Stock=20, fallback Stock=2 (failed scenes only), 78 AI + 22 Stock, success', async () => {
    const dir = makeProject(100)
    let failed: number[] = []
    const { result, stockLog, poolLog } = await runEngine({
      dir,
      mix: mixOf(0.8, 0.2, 'stock-fallback'),
      failScenes: (ai) => {
        failed = ai.slice(0, 2)
        return failed
      }
    })
    assert.strictEqual(poolLog.fallbackFlag.every((f) => f === true), true)
    assert.strictEqual(stockLog.calls.length, 2)
    assert.strictEqual(stockLog.calls[0].indices.length, 20)
    assert.deepStrictEqual(stockLog.calls[1].indices.sort((a, b) => a - b), failed.sort((a, b) => a - b))
    assert.strictEqual(result.success, true, result.error)
    const report = readReport(dir)
    assert.strictEqual(report.completedAiScenes, 78)
    assert.strictEqual(report.completedStockScenes, 22)
    assert.strictEqual(report.stockFallbackCount, 2)
    assert.strictEqual(report.stockFallbackAllowed, true)
    assert.strictEqual(report.requestedStockScenes, 20)
    // Successful AI scenes were never Stock-searched.
    const searched = new Set(stockLog.calls.flatMap((c) => c.indices))
    assert.strictEqual(searched.size, 22)
  })

  await it('0/100 unchanged: zero Flow calls, Stock handles all scenes, strict setting irrelevant', async () => {
    const dir = makeProject(10)
    const { result, stockLog, poolLog } = await runEngine({
      dir,
      mix: mixOf(0, 1, 'strict'),
      failScenes: () => []
    })
    assert.strictEqual(poolLog.batches.length, 0, 'Flow pool must not be used')
    assert.strictEqual(stockLog.calls.length, 1)
    assert.strictEqual(stockLog.calls[0].indices.length, 10)
    assert.strictEqual(result.success, true, result.error)
  })

  await it('cache survives failure: rerun regenerates ONLY failed scenes (8 cache hits, 2 AI requests)', async () => {
    const dir = makeProject(10)
    const first = await runEngine({ dir, mix: mixOf(1, 0, 'strict'), failScenes: (ai) => ai.slice(0, 2) })
    assert.strictEqual(first.result.success, false)

    const poolLog = { batches: [] as number[][], fallbackFlag: [] as boolean[] }
    const stockLog: StockLog = { calls: [] }
    const result = await runMixedVisualEngine({
      options: optionsFor(dir),
      profile: 'general',
      mix: mixOf(1, 0, 'strict'),
      onProgress: () => undefined,
      flowPool: makeMockPool(new Set(), poolLog),
      deps: { skipFlowReadiness: true, stockRunner: makeMockStock(dir, stockLog, () => new Set()) as never }
    })
    assert.strictEqual(poolLog.batches[0].length, 2, 'only the 2 failed scenes may be requested again')
    assert.strictEqual(stockLog.calls.length, 0)
    assert.strictEqual(result.success, true, result.error)
    assert.strictEqual(readReport(dir).aiCacheHits, 8)
  })

  await it('old Pexels assignment cannot leak into a strict 100/0 AI scene', async () => {
    const dir = makeProject(10)
    const staleFile = path.join(dir, 'assets', 'stock', 'old_scene3.mp4')
    fs.mkdirSync(path.dirname(staleFile), { recursive: true })
    fs.writeFileSync(staleFile, 'x'.repeat(64))
    fs.writeFileSync(
      path.join(dir, 'analysis', 'stock-assignments.json'),
      JSON.stringify([
        {
          sceneId: 'scene_3',
          sceneIndex: 3,
          narrationText: '',
          startTime: 10,
          endTime: 15,
          visualIntent: '',
          searchQueries: [],
          usedQuery: 'q',
          score: 80,
          locked: false,
          manualOverride: false,
          status: 'assigned',
          asset: { assetId: 'old', provider: 'pexels', mediaType: 'video', localPath: staleFile }
        }
      ])
    )
    const { result, stockLog } = await runEngine({ dir, mix: mixOf(1, 0, 'strict'), failScenes: () => [3] })
    assert.strictEqual(stockLog.calls.length, 0)
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.needsAttention, true)
    const finalAssignments = readAssignments(dir)
    assert.strictEqual(
      finalAssignments.find((a) => a.sceneIndex === 3),
      undefined,
      'stale Pexels assignment must be deactivated for the AI-owned scene'
    )
    assert.ok(fs.existsSync(staleFile), 'old stock file stays on disk (cache) - only the assignment is deactivated')
  })

  // ── Validator / guards ────────────────────────────────────────────
  await it('final assignment validation: AI-owned scene backed by pexels fails with VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION', () => {
    const plan = {
      scenes: [
        { sceneIndex: 1, strategy: 'ai-still' },
        { sceneIndex: 2, strategy: 'ai-still' }
      ]
    } as never
    const assignments = [
      { sceneIndex: 1, status: 'assigned', asset: { provider: 'google-flow' } },
      { sceneIndex: 2, status: 'assigned', asset: { provider: 'pexels' } }
    ] as unknown as StockSceneAssignment[]
    assert.throws(
      () => assertFinalVisualAssignments({ plan, assignments, config: { aiFailureBehavior: 'strict' } }),
      /VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION/
    )
    // stock-fallback only tolerates it when the scene is explicitly recorded as an approved fallback
    assert.strictEqual(
      validateFinalVisualAssignments({
        plan,
        assignments,
        config: { aiFailureBehavior: 'stock-fallback' },
        approvedFallbackSceneIndices: [2]
      }).valid,
      true
    )
    assert.strictEqual(
      validateFinalVisualAssignments({
        plan,
        assignments,
        config: { aiFailureBehavior: 'stock-fallback' }
      }).valid,
      false
    )
  })

  await it('zero-stock guard: strict 100/0 Stock attempt throws VISUAL_MIX_ZERO_STOCK_VIOLATION (initial and fallback)', () => {
    const cfg = mixOf(1, 0, 'strict')
    assert.throws(() => assertStockAllowed({ config: cfg, isFallback: false, sceneIndices: [1] }), /VISUAL_MIX_ZERO_STOCK_VIOLATION/)
    assert.throws(() => assertStockAllowed({ config: cfg, isFallback: true, sceneIndices: [1, 2] }), /VISUAL_MIX_ZERO_STOCK_VIOLATION/)
    assert.doesNotThrow(() => assertStockAllowed({ config: mixOf(1, 0, 'stock-fallback'), isFallback: true, sceneIndices: [1] }))
    assert.doesNotThrow(() => assertStockAllowed({ config: mixOf(0.8, 0.2, 'strict'), isFallback: false, sceneIndices: [1] }))
    assert.doesNotThrow(() => assertStockAllowed({ config: cfg, isFallback: false, sceneIndices: [] }))
  })

  // ── FlowImagePool failure stages (real pool, mocked client) ──────────────
  type ExportMode = 'ok' | 'low-res' | 'throw' | 'needs-normalize'
  function makePoolItem(dir: string, behavior: 'strict' | 'stock-fallback'): GenerationPoolItem {
    return {
      projectDir: dir,
      profile: 'general',
      config: mixOf(1, 0, behavior),
      scene: {
        sceneIndex: 7,
        narration: 'n',
        visualIntent: 'v',
        strategy: 'ai-still',
        imagePrompt: 'prompt',
        generationHash: 'abcdef1234567890',
        startTime: 0,
        endTime: 5,
        duration: 5
      }
    }
  }
  function makeClient(opts: { genFails?: boolean; exportMode: ExportMode }): { client: never; counts: { gen: number } } {
    const counts = { gen: 0 }
    const client = {
      generateImage: async () => {
        counts.gen++
        if (opts.genFails) throw new Error('FLOW_GENERATION_FAILED: mock')
        return { mediaId: 'm1', projectId: 'p1' }
      },
      exportImage: async (req: { destinationPath: string }) => {
        if (opts.exportMode === 'throw') throw new Error('FLOW_EXPORT_FAILED: mock')
        const dims =
          opts.exportMode === 'low-res' ? [1376, 768] : opts.exportMode === 'needs-normalize' ? [2560, 1440] : [1920, 1080]
        fs.mkdirSync(path.dirname(req.destinationPath), { recursive: true })
        fs.writeFileSync(req.destinationPath, pngHeader(dims[0], dims[1]))
        return { width: dims[0], height: dims[1] }
      }
    }
    return { client: client as never, counts }
  }

  const stageCases: Array<{ label: string; genFails?: boolean; exportMode: ExportMode; stage: AiVisualFailureStage }> = [
    { label: 'quality gate (1376x768)', exportMode: 'low-res', stage: 'quality-gate' },
    { label: 'export failure', exportMode: 'throw', stage: 'export' },
    { label: 'normalization failure', exportMode: 'needs-normalize', stage: 'normalization' },
    { label: 'generation failure (both attempts)', genFails: true, exportMode: 'ok', stage: 'generation' }
  ]

  for (const c of stageCases) {
    await it(`pool ${c.label}: strict stays AI-owned (ai-failed, no stock); fallback mode flags stock eligibility`, async () => {
      for (const behavior of ['strict', 'stock-fallback'] as const) {
        const dir = makeProject(1)
        const { client, counts } = makeClient({ genFails: c.genFails, exportMode: c.exportMode })
        const pool = new FlowImagePool(client)
        const [res] = await pool.processBatch([makePoolItem(dir, behavior)])
        assert.strictEqual(res.success, false)
        assert.strictEqual(res.failureStage, c.stage)
        assert.strictEqual(res.fallbackToStock, behavior === 'stock-fallback')
        if (c.genFails) assert.strictEqual(counts.gen, 2, 'bounded retries: initial + 1 retry')

        const rec = loadGeneratedAssetsManifest(dir, 'general').scenes['7']
        assert.strictEqual(rec.strategy, 'ai-still', 'manifest must not mark strategy=stock before fallback is approved')
        assert.strictEqual(rec.status, 'ai-failed')
        assert.strictEqual(rec.failureStage, c.stage)
        assert.ok(rec.error)
      }
    })
  }

  // ── Assignment race ───────────────────────────────────────────────
  await it('assignment store: concurrent AI + Stock writers lose nothing', async () => {
    const dir = makeProject(4)
    const store = new VisualAssignmentStore(dir)
    const mk = (idx: number, provider: string): StockSceneAssignment =>
      ({
        sceneId: `scene_${idx}`,
        sceneIndex: idx,
        status: 'assigned',
        asset: { provider, localPath: path.join(dir, `f${idx}`), mediaType: 'photo' }
      }) as unknown as StockSceneAssignment
    await Promise.all([
      (async () => {
        store.set(1, mk(1, 'google-flow'))
        await store.flushAtomic()
      })(),
      (async () => {
        store.setMany([mk(2, 'pexels'), mk(3, 'pixabay')], true)
        await store.flushAtomic()
      })(),
      (async () => {
        store.set(4, mk(4, 'google-flow'))
        await store.flushAtomic()
      })()
    ])
    assert.deepStrictEqual(readAssignments(dir).map((a) => a.sceneIndex), [1, 2, 3, 4])
  })

  // ── Legacy path ───────────────────────────────────────────────────
  await it('Default Workflow stays on the legacy path (no strict Custom Mix semantics)', () => {
    const legacy = resolveVisualMixConfig({ visualSourceMode: 'legacy' })
    assert.strictEqual(legacy.mode, 'legacy')
    assert.strictEqual(legacy.aiImageRatio, 0)
    assert.strictEqual(legacy.stockFootageRatio, 1)

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pipeline', 'pipeline-stage-runners.ts'), 'utf-8')
    const stageStart = src.indexOf('export async function runStockSearchStage')
    const customIdx = src.indexOf("if (mix.mode === 'custom-mix')", stageStart)
    const legacyIdx = src.indexOf('isGlobalContextValid(options.projectDir)', customIdx)
    assert.ok(stageStart > 0 && customIdx > stageStart && legacyIdx > customIdx)
    const legacySection = src.slice(legacyIdx, legacyIdx + 4000)
    assert.ok(!legacySection.includes('runMixedVisualEngine'))
    assert.ok(!legacySection.includes('validateFinalVisualAssignments'))
    assert.ok(!legacySection.includes('assignmentSink'), 'legacy stock engine calls keep writing the assignments file themselves')
  })

  fs.rmSync(ROOT, { recursive: true, force: true })
  try {
    fs.rmdirSync(path.join(__dirname, 'fixtures'))
  } catch {
    /* not empty or missing */
  }

  console.log(`\nStrict Visual Mix Contract Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
