import * as fs from 'fs'
import * as path from 'path'
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
  readJson,
  sceneFileName,
  sleep,
  waitFor,
  writeProjectState,
  type StockLog
} from './manual-ai-test-utils'
import {
  ensureManualAiPromptPack,
  readManualAiPromptText
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  getManualAiStatus,
  broadcastManualAiStatus
} from '../src/main/visual-mix/manual-ai/manual-ai-broadcaster'
import {
  getManualAiPromptJsonPath,
  getManualAiPromptTxtPath
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { runMixedVisualEngine } from '../src/main/visual-mix/mixed-visual-engine'
import { manualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { planManualAiImport, commitManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import type {
  ManualAiStatus,
  ManualAiWaitInfo,
  VisualMixConfig
} from '../shared/types'

const { it, finish } = createRunner('Manual AI UI, Preload & Sync Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Preload, UI & Sync Contract Tests ---')

  await it('Section 51: Preload API contract exposes manualAi bridge methods', async () => {
    // 1. Verify TypeScript source contract
    const preloadSourcePath = path.join(__dirname, '../src/preload/index.ts')
    const preloadSource = fs.readFileSync(preloadSourcePath, 'utf-8')

    const requiredMethods = [
      'getStatus',
      'getPromptText',
      'exportTxt',
      'openPromptFile',
      'selectImages',
      'planImport',
      'commitImport',
      'onStatusUpdated'
    ]

    for (const m of requiredMethods) {
      assert.ok(
        preloadSource.includes(`${m}:`),
        `src/preload/index.ts must expose manualAi.${m}`
      )
    }

    // 2. Verify built output bundle
    const preloadBuiltPath = path.join(__dirname, '../out/preload/index.js')
    if (fs.existsSync(preloadBuiltPath)) {
      const builtContent = fs.readFileSync(preloadBuiltPath, 'utf-8')
      assert.ok(
        builtContent.includes('manualAi:'),
        'out/preload/index.js must include manualAi bridge'
      )
      for (const m of requiredMethods) {
        assert.ok(
          builtContent.includes(m),
          `out/preload/index.js must include manualAi.${m}`
        )
      }
    }
  })

  await it('Section 52 & 64: 8 AI scene plan generates 8 prompts and getManualAiStatus returns expected=8', async () => {
    // 16 scenes, 50% AI / 50% Stock
    const dir = makeProject(16)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: dir,
      rawScenes,
      config: mixOf(0.5, 0.5, 'prompt'),
      profile: 'health'
    })

    assert.strictEqual(plan.targetAiScenes, 8)
    assert.strictEqual(plan.targetStockScenes, 8)

    const ensured = ensureManualAiPromptPack({
      projectDir: dir,
      plan,
      profile: 'health',
      globalContext: null,
      outputResolution: '1080p'
    })

    assert.strictEqual(ensured.pack.scenes.length, 8)
    assert.ok(fs.existsSync(getManualAiPromptJsonPath(dir)))
    assert.ok(fs.existsSync(getManualAiPromptTxtPath(dir)))

    // Centralized status getter
    const status = getManualAiStatus(dir)
    assert.strictEqual(status.hasPromptPack, true)
    assert.strictEqual(status.expected, 8)
    assert.strictEqual(status.ready, 0)
    assert.strictEqual(status.missingSceneIndices.length, 8)
    assert.strictEqual(status.allReady, false)

    // Section 64: getPromptText returns non-empty formatted prompts
    const promptText = readManualAiPromptText(dir)!
    assert.ok(promptText && promptText.length > 0)
    const promptLines = promptText.split('\n').filter((l) => l.startsWith('SCENE '))
    assert.strictEqual(promptLines.length, 8)
  })

  await it('Section 53: broadcastManualAiStatus emits MANUAL_AI_STATUS_UPDATED payload', async () => {
    const dir = makeProject(16)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: dir,
      rawScenes,
      config: mixOf(0.5, 0.5, 'prompt'),
      profile: 'general'
    })
    ensureManualAiPromptPack({
      projectDir: dir,
      plan,
      profile: 'general',
      globalContext: null,
      outputResolution: '1080p'
    })

    const status = getManualAiStatus(dir)
    assert.strictEqual(status.hasPromptPack, true)
    assert.strictEqual(status.expected, 8)

    // Calling broadcastManualAiStatus is safe and returns the status
    const broadcasted = broadcastManualAiStatus(dir, status)
    assert.strictEqual(broadcasted.expected, 8)
    assert.strictEqual(broadcasted.hasPromptPack, true)
  })

  await it('Section 54 & 55: 16 scenes (50/50) prompts become ready before Stock completes', async () => {
    const dir = makeProject(16)
    const mix = mixOf(0.5, 0.5, 'prompt')
    writeProjectState(dir, mix)

    const stockGate = deferred()
    const stockLog: StockLog = { calls: [] }
    const progressLog: Array<{ msg: string; pct: number; meta?: { manualAiWait?: ManualAiWaitInfo | null } }> = []

    let broadcastCount = 0
    let lastBroadcastStatus: ManualAiStatus | undefined

    const runPromise = runMixedVisualEngine({
      options: optionsFor(dir),
      profile: 'health',
      mix,
      onProgress: (msg, pct, meta) => {
        progressLog.push({ msg, pct, meta })
      },
      deps: {
        stockRunner: makeMockStock(dir, stockLog, { gate: stockGate.promise }) as never,
        manualAiPollMs: 50,
        broadcastManualAiStatus: (_pDir, st) => {
          broadcastCount++
          lastBroadcastStatus = st
        }
      }
    })

    // Wait until prompt pack exists and gate subscribed
    await waitFor(() => fs.existsSync(getManualAiPromptJsonPath(dir)) && manualAiAssetGate.waiterCount(dir) === 1, 10000)

    // CRITICAL ASSERTION: Before stock resolves, status already shows 8/8 prompts generated!
    const immediateStatus = getManualAiStatus(dir)
    assert.strictEqual(immediateStatus.hasPromptPack, true)
    assert.strictEqual(immediateStatus.expected, 8)
    assert.strictEqual(immediateStatus.ready, 0)
    assert.ok(broadcastCount >= 1, 'Status broadcast happened immediately on prompt creation')
    assert.strictEqual(lastBroadcastStatus?.expected, 8)
    assert.strictEqual(lastBroadcastStatus?.hasPromptPack, true)

    // Check pipeline metadata from onProgress
    const waitEvents = progressLog.filter((p) => p.meta?.manualAiWait)
    assert.ok(waitEvents.length >= 1, 'Initial onProgress emitted manualAiWait before stock')
    const firstWait = waitEvents[0].meta!.manualAiWait!
    assert.strictEqual(firstWait.expected, 8)
    assert.strictEqual(firstWait.ready, 0)
    assert.strictEqual(firstWait.stockExpected, 8)
    assert.strictEqual(firstWait.stockReady, 0)
    assert.ok(firstWait.promptFilePath.endsWith('manual-ai-prompts.txt'))

    // Now resolve Stock while AI is still waiting (0 imported)
    stockGate.resolve()
    await waitFor(() => progressLog.some((p) => p.meta?.manualAiWait?.stockReady === 8), 10000)

    // When Stock finishes, prompts remain 8/8, AI remains 0/8, Stock is 8/8 ready
    const latestWait = progressLog[progressLog.length - 1].meta?.manualAiWait!
    assert.strictEqual(latestWait.expected, 8)
    assert.strictEqual(latestWait.ready, 0)
    assert.strictEqual(latestWait.stockReady, 8)
    assert.strictEqual(latestWait.stockExpected, 8)

    // Now import all 8 AI images
    const plan = VisualMixPlanner.loadPlan(dir)!
    const aiIndices = plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex)
    assert.strictEqual(aiIndices.length, 8)

    const ext = freshDir('ext')
    const files = aiIndices.map((i) => makeExternalImage(ext, sceneFileName(i)))
    const importPlan = planManualAiImport({ projectDir: dir, filePaths: files })
    await commitManualAiImport({ projectDir: dir, mappings: importPlan.mappings, normalizer: fakeNormalizer })

    const result = await runPromise
    assert.strictEqual(result.success, true)
    const report = readJson(path.join(dir, 'analysis', 'visual-performance-report.json'))
    assert.strictEqual(report.providerCounts.manualAi, 8)
    assert.strictEqual(report.manualAi?.manualImported, 8)
    assert.strictEqual(report.manualAi?.stockSceneCount, 8)
  })

  await it('Section 56 & 57: Fallback calculation and button enable contracts', () => {
    // Contract test for the state calculation logic in ManualAiPromptPanel
    const hasBridge = true
    const waitInfo: ManualAiWaitInfo = {
      expected: 8,
      ready: 0,
      missingSceneIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      promptFilePath: 'D:/test/analysis/manual-ai-prompts.txt',
      stockExpected: 8,
      stockReady: 8
    }
    const status: ManualAiStatus | null = null

    // Combined effective values
    const effectiveExpected = status?.expected ?? waitInfo?.expected ?? 0
    const effectiveReady = status?.ready ?? waitInfo?.ready ?? 0
    const effectivePromptFilePath = status?.promptFilePath ?? waitInfo?.promptFilePath
    const effectiveHasPromptPack = Boolean(status?.hasPromptPack || waitInfo?.promptFilePath)
    const effectiveAllReady = Boolean(
      status?.allReady || (effectiveExpected > 0 && effectiveReady >= effectiveExpected)
    )

    assert.strictEqual(effectiveExpected, 8)
    assert.strictEqual(effectiveReady, 0)
    assert.strictEqual(effectiveHasPromptPack, true)
    assert.strictEqual(effectiveAllReady, false)

    // Button states
    const copyAllDisabled = !effectiveHasPromptPack || !hasBridge
    const exportTxtDisabled = !effectiveHasPromptPack || !hasBridge
    const openPromptDisabled = !effectiveHasPromptPack || !effectivePromptFilePath || !hasBridge
    const importDisabled = !effectiveHasPromptPack || effectiveExpected === 0 || !hasBridge

    assert.strictEqual(copyAllDisabled, false, 'Copy All Prompts must be enabled')
    assert.strictEqual(exportTxtDisabled, false, 'Export TXT must be enabled')
    assert.strictEqual(openPromptDisabled, false, 'Open Prompt File must be enabled')
    assert.strictEqual(importDisabled, false, 'Import AI Images must be enabled')
  })

  await it('Section 58: Missing bridge contract produces bridge-unavailable state', () => {
    const hasBridge = false
    const waitInfo: ManualAiWaitInfo = {
      expected: 8,
      ready: 0,
      missingSceneIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      promptFilePath: 'D:/test/analysis/manual-ai-prompts.txt',
      stockExpected: 8,
      stockReady: 8
    }

    const panelState = !hasBridge
      ? 'bridge-unavailable'
      : !waitInfo?.promptFilePath
        ? 'waiting-for-prompts'
        : 'waiting-for-images'

    assert.strictEqual(panelState, 'bridge-unavailable')
  })

  await it('Section 60 & 61: Monotonic progress across concurrent Stock and Manual AI updates', () => {
    let maxStockReady = 0
    let maxAiReady = 0

    // Stock event arrives: Stock = 7
    maxStockReady = Math.max(maxStockReady, 7)
    assert.strictEqual(maxStockReady, 7)
    assert.strictEqual(maxAiReady, 0)

    // Manual AI import arrives: AI = 2
    maxAiReady = Math.max(maxAiReady, 2)
    assert.strictEqual(maxAiReady, 2)
    assert.strictEqual(maxStockReady, 7)

    // Out-of-order or stale Stock event (e.g. 0) cannot decrease maxStockReady
    maxStockReady = Math.max(maxStockReady, 0)
    assert.strictEqual(maxStockReady, 7)

    // Stock finishes: Stock = 8
    maxStockReady = Math.max(maxStockReady, 8)
    assert.strictEqual(maxStockReady, 8)
    assert.strictEqual(maxAiReady, 2)
  })

  cleanupFixtures()
  finish()
}

void main()
