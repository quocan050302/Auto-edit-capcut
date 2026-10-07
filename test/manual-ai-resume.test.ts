/**
 * Manual AI (Prompt mode) — restart / resume / stale / ratio-change / render-guard tests.
 */
import * as fs from 'fs'
import * as path from 'path'
import { runMixedVisualEngine } from '../src/main/visual-mix/mixed-visual-engine'
import { manualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { commitManualAiImport, planManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { loadManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { evaluateManualAiStatusForProject, findMissingManualAiScenes } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import { getManualAiAssetsDir, getManualAiManifestPath } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import type { ManualAiWaitInfo, VisualMixConfig } from '../shared/types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  fakeNormalizer,
  freshDir,
  makeExternalImage,
  makeMockStock,
  makeProject,
  mixOf,
  optionsFor,
  readAssignments,
  readJson,
  rewriteNarration,
  sceneFileName,
  sleep,
  waitFor,
  writeProjectState,
  type StockLog
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Resume Tests')

interface Run {
  promise: Promise<Awaited<ReturnType<typeof runMixedVisualEngine>>>
  ac: AbortController
  wait: { latest: ManualAiWaitInfo | null | undefined }
  state: { done: boolean }
}

function start(dir: string, mix: VisualMixConfig, stockLog: StockLog): Run {
  const ac = new AbortController()
  const wait: Run['wait'] = { latest: undefined }
  const state = { done: false }
  const promise = runMixedVisualEngine({
    options: optionsFor(dir),
    profile: 'general',
    mix,
    signal: ac.signal,
    onProgress: (_m: string, _p: number, meta?: { manualAiWait?: ManualAiWaitInfo | null }) => {
      if (meta && 'manualAiWait' in meta) wait.latest = meta.manualAiWait
    },
    deps: { stockRunner: makeMockStock(dir, stockLog) as never, manualAiPollMs: 40 }
  })
  const done = (): void => {
    state.done = true
  }
  promise.then(done, done)
  return { promise, ac, wait, state }
}

async function importScenes(dir: string, indices: number[]): Promise<void> {
  const ext = freshDir('ext')
  const files = indices.map((i) => makeExternalImage(ext, sceneFileName(i)))
  const plan = planManualAiImport({ projectDir: dir, filePaths: files })
  assert.strictEqual(plan.rejections.length, 0, JSON.stringify(plan.rejections))
  const res = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
  assert.strictEqual(res.rejections.length, 0, JSON.stringify(res.rejections))
}

function aiOwned(dir: string): number[] {
  return VisualMixPlanner.loadPlan(dir)!
    .scenes.filter((s) => s.strategy === 'ai-still')
    .map((s) => s.sceneIndex)
    .sort((a, b) => a - b)
}

async function waitingState(dir: string): Promise<void> {
  await waitFor(() => fs.existsSync(path.join(dir, 'analysis', 'manual-ai-prompts.json')) && manualAiAssetGate.waiterCount(dir) === 1, 30000)
}

async function main(): Promise<void> {
  console.log('\nManual AI resume')

  await it('app restart: prompt pack reused, 30 images reused, Stock cache reused (no new Stock search)', async () => {
    const dir = makeProject(100)
    const mix = mixOf(0.85, 0.15, 'prompt')
    const logA: StockLog = { calls: [] }
    const runA = start(dir, mix, logA)
    await waitingState(dir)
    await waitFor(() => logA.calls.length === 1 && runA.wait.latest?.stockReady === 15)
    const ai = aiOwned(dir)
    await importScenes(dir, ai.slice(0, 30))
    await waitFor(() => runA.wait.latest?.ready === 30)
    const packBefore = loadManualAiPromptPack(dir)!
    const txtBefore = fs.readFileSync(path.join(dir, 'analysis', 'manual-ai-prompts.txt'), 'utf-8')

    // "close the app"
    runA.ac.abort()
    await assert.rejects(runA.promise, /cancelled/)
    assert.strictEqual(manualAiAssetGate.waiterCount(dir), 0)

    // "reopen tomorrow"
    const logB: StockLog = { calls: [] }
    const runB = start(dir, mix, logB)
    await waitingState(dir)
    await waitFor(() => runB.wait.latest?.ready === 30)
    const w = runB.wait.latest!
    assert.strictEqual(w.expected, 85)
    assert.strictEqual(w.ready, 30)
    assert.strictEqual(w.missingSceneIndices.length, 55)
    assert.strictEqual(w.stockExpected, 15)
    assert.strictEqual(w.stockReady, 15, 'Stock reused from the cache')
    assert.strictEqual(logB.calls.length, 0, 'Stock must NOT restart')

    const packAfter = loadManualAiPromptPack(dir)!
    assert.strictEqual(packAfter.generatedAt, packBefore.generatedAt, 'prompts not regenerated')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'analysis', 'manual-ai-prompts.txt'), 'utf-8'), txtBefore)
    assert.strictEqual(runB.state.done, false)

    // user imports the rest -> pipeline continues
    await importScenes(dir, ai.slice(30))
    const res = await runB.promise
    assert.strictEqual(res.success, true, JSON.stringify(res))
    assert.strictEqual(logB.calls.length, 0)
    const a = readAssignments(dir)
    assert.strictEqual(a.filter((x) => x.asset?.provider === 'manual-ai').length, 85)
    assert.strictEqual(a.filter((x) => x.asset?.provider === 'pexels').length, 15)
  })

  await it('status after restart is computed from disk alone (evaluateManualAiStatusForProject)', async () => {
    const dir = makeProject(40)
    const run = start(dir, mixOf(0.5, 0.5, 'prompt'), { calls: [] })
    await waitingState(dir)
    const ai = aiOwned(dir)
    await importScenes(dir, ai.slice(0, 7))
    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)
    const st = evaluateManualAiStatusForProject(dir)
    assert.strictEqual(st.expected, ai.length)
    assert.strictEqual(st.ready, 7)
    assert.strictEqual(st.missingSceneIndices.length, ai.length - 7)
    assert.ok(st.rows.every((r) => r.expectedFilename === sceneFileName(r.sceneIndex)))
  })

  await it('STALE: narration change makes the old imported image stale; it is not silently reused', async () => {
    const dir = makeProject(12)
    const mix = mixOf(1, 0, 'prompt')
    const runA = start(dir, mix, { calls: [] })
    await waitingState(dir)
    const ai = aiOwned(dir)
    assert.strictEqual(ai.length, 12)
    await importScenes(dir, ai)
    const resA = await runA.promise
    assert.strictEqual(resA.success, true, JSON.stringify(resA))

    rewriteNarration(dir, 8, 'A completely different scene about a medieval castle siege at dawn with archers on the walls.')

    const runB = start(dir, mix, { calls: [] })
    await waitingState(dir)
    await waitFor(() => runB.wait.latest !== undefined)
    const st = evaluateManualAiStatusForProject(dir)
    assert.deepStrictEqual(st.staleSceneIndices, [8], 'only scene 8 is stale')
    assert.strictEqual(st.ready, 11)
    assert.ok(st.missingSceneIndices.includes(8))
    assert.strictEqual(runB.wait.latest!.ready, 11)
    assert.ok(runB.wait.latest!.missingSceneIndices.includes(8))
    assert.strictEqual(runB.state.done, false, 'must not render the old image as current')
    const a8 = readAssignments(dir).find((x) => x.sceneIndex === 8)
    assert.ok(!a8, 'stale manual assignment must be deactivated')
    assert.ok(readAssignments(dir).filter((x) => x.asset?.provider === 'manual-ai').length === 11)
    // the old file is preserved on disk (never auto-deleted)
    assert.ok(fs.existsSync(path.join(getManualAiAssetsDir(dir), sceneFileName(8))))

    // user regenerates scene 8 -> continues
    await importScenes(dir, [8])
    const resB = await runB.promise
    assert.strictEqual(resB.success, true, JSON.stringify(resB))
  })

  await it('ratio change 85/15 -> 70/30: valid images reused, AI->Stock handled by Stock, files kept', async () => {
    const dir = makeProject(100)
    const m85 = mixOf(0.85, 0.15, 'prompt')
    const logA: StockLog = { calls: [] }
    const runA = start(dir, m85, logA)
    await waitingState(dir)
    await waitFor(() => logA.calls.length === 1)
    const ai85 = aiOwned(dir)
    const imported = ai85.slice(0, 40)
    await importScenes(dir, imported)
    await waitFor(() => runA.wait.latest?.ready === 40)
    const pack85 = loadManualAiPromptPack(dir)!
    runA.ac.abort()
    await assert.rejects(runA.promise, /cancelled/)

    const m70 = mixOf(0.7, 0.3, 'prompt')
    const logB: StockLog = { calls: [] }
    const runB = start(dir, m70, logB)
    await waitingState(dir)
    await waitFor(() => runB.wait.latest !== undefined && logB.calls.length >= 0)
    await sleep(120)
    const ai70 = aiOwned(dir)
    const plan70 = VisualMixPlanner.loadPlan(dir)!
    assert.strictEqual(ai70.length, 70)
    assert.strictEqual(plan70.targetStockScenes, 30)
    const pack70 = loadManualAiPromptPack(dir)!
    assert.strictEqual(pack70.scenes.length, 70)

    const hash85 = new Map(pack85.scenes.map((s) => [s.sceneIndex, s.promptHash]))
    const expectedReady = imported.filter((i) => ai70.includes(i) && hash85.get(i) === pack70.scenes.find((s) => s.sceneIndex === i)!.promptHash).length
    assert.strictEqual(runB.wait.latest!.ready, expectedReady, 'still-valid images are reused')
    assert.strictEqual(runB.wait.latest!.expected, 70)
    assert.strictEqual(runB.wait.latest!.stockExpected, 30)

    // no Stock-owned scene may hold a manual-ai assignment; AI-owned scenes never hold Stock
    const stock70 = new Set(plan70.stockSceneIndices)
    for (const a of readAssignments(dir)) {
      if (stock70.has(a.sceneIndex)) assert.notStrictEqual(a.asset?.provider, 'manual-ai', `scene ${a.sceneIndex}`)
      else assert.strictEqual(a.asset?.provider, 'manual-ai', `AI scene ${a.sceneIndex} must only be manual-ai`)
    }
    // Stock only for pending stock-owned scenes (never AI-owned, never all 100)
    for (const c of logB.calls) {
      assert.ok(c.indices.every((i) => stock70.has(i)))
      assert.ok(c.indices.length <= 30)
    }
    // manual images are never deleted automatically
    const files = fs.readdirSync(getManualAiAssetsDir(dir)).filter((f) => /^S\d{4}\.png$/.test(f))
    assert.strictEqual(files.length, 40)
    assert.strictEqual(readJson(getManualAiManifestPath(dir)).scenes[String(imported[0])].status, 'ready')

    runB.ac.abort()
    await assert.rejects(runB.promise, /cancelled/)
  })

  // ── Render guard (preflight): never let a missing manual image become a black placeholder ──
  await it('render guard: Prompt-mode AI scene without a valid manual image is reported (no black frame)', async () => {
    const dir = makeProject(20)
    const mix = mixOf(0.5, 0.5, 'prompt')
    writeProjectState(dir, mix)
    const run = start(dir, mix, { calls: [] })
    await waitingState(dir)
    const ai = aiOwned(dir)
    await importScenes(dir, ai.slice(0, ai.length - 2))
    await waitFor(() => run.wait.latest?.ready === ai.length - 2)
    const missing = findMissingManualAiScenes(dir)
    assert.deepStrictEqual(missing, ai.slice(-2))
    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)

    // Deleting an imported file from disk is detected as well
    fs.unlinkSync(path.join(getManualAiAssetsDir(dir), sceneFileName(ai[0])))
    assert.ok(findMissingManualAiScenes(dir).includes(ai[0]))
  })

  await it('render guard is inert for Auto mode, Default Workflow and non-Prompt projects', async () => {
    const dir = makeProject(10)
    const mix = mixOf(0.5, 0.5, 'prompt')
    writeProjectState(dir, mix)
    const run = start(dir, mix, { calls: [] })
    await waitingState(dir)
    assert.ok(findMissingManualAiScenes(dir).length > 0)
    run.ac.abort()
    await assert.rejects(run.promise, /cancelled/)

    // user switched to Auto afterwards
    writeProjectState(dir, mixOf(0.5, 0.5, 'auto'))
    assert.deepStrictEqual(findMissingManualAiScenes(dir), [])
    // user switched to Default Workflow
    writeProjectState(dir, mix, 'legacy')
    assert.deepStrictEqual(findMissingManualAiScenes(dir), [])
    // project without any Prompt snapshot
    const plain = makeProject(5)
    assert.deepStrictEqual(findMissingManualAiScenes(plain), [])
  })

  cleanupFixtures()
  finish()
}

void main()
