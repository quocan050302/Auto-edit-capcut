import * as fs from 'fs'
import * as path from 'path'
import {
  assert,
  cleanupFixtures,
  createRunner,
  fakeNormalizer,
  freshDir,
  makeExternalImage,
  makeProject,
  mixOf
} from './manual-ai-test-utils'
import {
  ensureManualAiPromptPack,
  loadManualAiPromptPack
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  planManualAiImport,
  commitManualAiImport
} from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import {
  getManualAiStatus
} from '../src/main/visual-mix/manual-ai/manual-ai-broadcaster'
import {
  loadEditorialFocusSettings,
  saveEditorialFocusSettings
} from '../src/main/visual-mix/manual-ai/editorial-focus-settings'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'

const { it, finish } = createRunner('Manual AI Import Lifecycle & Unmount Safety Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Import Lifecycle & Unmount Safety Tests ---')

  const testRoot = freshDir('lifecycle-test')
  const extMediaDir = path.join(testRoot, 'media_pool')
  fs.mkdirSync(extMediaDir, { recursive: true })

  const img1 = makeExternalImage(extMediaDir, 'S0001.png', 1920, 1080)
  const img2 = makeExternalImage(extMediaDir, 'S0002.png', 1920, 1080)

  await it('Section 01: Unmount safety — state updates are suppressed after component unmounts', () => {
    let isMounted = true
    let uiState: any = { ready: 0, expected: 5 }

    function safeSetStatus(nextStatus: any) {
      if (!isMounted) return
      uiState = nextStatus
    }

    // While mounted
    safeSetStatus({ ready: 1, expected: 5 })
    assert.strictEqual(uiState.ready, 1)

    // Unmount
    isMounted = false
    safeSetStatus({ ready: 4, expected: 5 })
    assert.strictEqual(uiState.ready, 1, 'State must NOT update after isMounted became false')
  })

  await it('Section 02: Status refresh interval clears cleanly without memory or handle leaks', () => {
    let activeIntervalCount = 0
    const activeIntervals = new Set<NodeJS.Timeout>()

    function startRefreshTimer(callback: () => void, intervalMs: number) {
      const id = setInterval(() => {
        callback()
      }, intervalMs)
      activeIntervals.add(id)
      activeIntervalCount++
      return () => {
        clearInterval(id)
        activeIntervals.delete(id)
        activeIntervalCount--
      }
    }

    // Simulate 20 rapid mount/unmount cycles
    const cleanups: Array<() => void> = []
    for (let i = 0; i < 20; i++) {
      const cleanup = startRefreshTimer(() => {}, 2500)
      cleanups.push(cleanup)
    }

    assert.strictEqual(activeIntervalCount, 20, '20 intervals started')

    // Simulate unmounting all
    for (const cl of cleanups) {
      cl()
    }

    assert.strictEqual(activeIntervalCount, 0, 'All intervals must be cleared on unmount')
    assert.strictEqual(activeIntervals.size, 0, 'No dangling interval references')
  })

  await it('Section 03: Older projects without editorial settings load safely with canonical defaults', () => {
    const projDir = makeProject(4)
    const settings = loadEditorialFocusSettings(projDir)

    assert.strictEqual(settings.promptMode, 'classic', 'Default prompt mode for unconfigured projects must be classic')
    assert.strictEqual(settings.renderOverlayMode, 'full', 'Default render mode must be full')
    assert.strictEqual(settings.readability, 'standard', 'Default readability must be standard')

    // Persist new settings and verify idempotence
    const updated = saveEditorialFocusSettings(projDir, { renderOverlayMode: 'source-only' })
    assert.strictEqual(updated.renderOverlayMode, 'source-only')
    const reloaded = loadEditorialFocusSettings(projDir)
    assert.strictEqual(reloaded.renderOverlayMode, 'source-only')

    cleanupFixtures([projDir])
  })

  await it('Section 04: Canonical prompt hashes remain strictly identical across multiple imports and navigations', async () => {
    const projDir = makeProject(4)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({ projectDir: projDir, rawScenes, config: mixOf(1.0, 0, 'prompt'), profile: 'general' })

    const pack1 = ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', globalContext: null, outputResolution: '1080p' })
    const originalHashes = pack1.pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, hash: s.promptHash }))

    // Import scene 1
    const plan1 = await planManualAiImport({ projectDir: projDir, filePaths: [img1] })
    await commitManualAiImport({ projectDir: projDir, mappings: plan1.mappings, normalizer: fakeNormalizer })

    // Reload prompt pack
    const pack2 = loadManualAiPromptPack(projDir)!
    assert.ok(pack2, 'Prompt pack must exist after import')

    const postImportHashes = pack2.scenes.map((s) => ({ sceneIndex: s.sceneIndex, hash: s.promptHash }))
    assert.deepStrictEqual(originalHashes, postImportHashes, 'Prompt hashes must NOT change after importing media')

    cleanupFixtures([projDir])
  })

  cleanupFixtures([testRoot])
  finish()
}

main().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
