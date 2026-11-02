import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  loadPipelineState,
  normalizeProjectDir,
  savePipelineStateAtomic,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import {
  loadProductionModeSettings,
  saveProductionModeSettings
} from '../src/main/simple-assembly/production-mode-settings'
import {
  MANUAL_AI_PROMPT_SCHEMA_VERSION,
  getManualAiPromptJsonPath,
  getManualAiManifestPath,
  type ManualAiPromptPack,
  type ManualAiAssetsManifest
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { getManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Switch — Active Run Tests')

function createWaitingActiveRun(params: {
  projectDir: string
  runId: string
  assemblyMode?: 'full-production' | 'simple-assembly'
  backgroundMusicMode?: 'auto' | 'off'
  expectedScenes?: number
  readyScenes?: number
  renderOverlayMode?: 'full' | 'source-only'
}): AutoPipelineState {
  const norm = normalizeProjectDir(params.projectDir)
  fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
  const mediaDir = path.join(norm, 'assets', 'generated', 'manual-ai')
  fs.mkdirSync(mediaDir, { recursive: true })

  const expected = params.expectedScenes ?? 131
  const ready = params.readyScenes ?? 80
  const missingSceneIndices: number[] = []
  const promptScenes: ManualAiPromptPack['scenes'] = []
  const manifestScenes: ManualAiAssetsManifest['scenes'] = {}

  for (let i = 1; i <= expected; i++) {
    const hash = `prompt_hash_${String(i).padStart(3, '0')}`
    promptScenes.push({
      sceneIndex: i,
      sceneId: `scene_${String(i).padStart(3, '0')}`,
      narration: `Narration for scene ${i}`,
      visualIntent: `Visual intent for scene ${i}`,
      strategy: 'ai-still',
      prompt: `Detailed prompt for scene ${i}`,
      promptHash: hash,
      expectedFilename: `scene_${String(i).padStart(3, '0')}.png`,
      startTime: (i - 1) * 4,
      endTime: i * 4,
      duration: 4
    })

    if (i <= ready) {
      const localPath = path.join(mediaDir, `scene_${String(i).padStart(3, '0')}.png`)
      fs.writeFileSync(localPath, `image-bytes-${i}`)
      manifestScenes[String(i)] = {
        sceneIndex: i,
        promptHash: hash,
        status: 'ready',
        sourcePath: localPath,
        localPath,
        width: 1920,
        height: 1080,
        importedAt: '2026-10-28T10:00:00.000Z'
      }
    } else {
      missingSceneIndices.push(i)
    }
  }

  const promptPackPath = getManualAiPromptJsonPath(norm)
  const promptPack: ManualAiPromptPack = {
    schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
    generatedAt: '2026-10-28T09:55:00.000Z',
    profile: 'health',
    totalProjectScenes: expected,
    expectedAiImages: expected,
    imageMode: 'prompt',
    outputResolution: '1080p',
    scenes: promptScenes
  }
  fs.writeFileSync(promptPackPath, JSON.stringify(promptPack, null, 2), 'utf-8')

  const manifestPath = getManualAiManifestPath(norm)
  const manifest: ManualAiAssetsManifest = {
    schemaVersion: 1,
    updatedAt: '2026-10-28T10:00:00.000Z',
    expected,
    ready,
    missing: expected - ready,
    scenes: manifestScenes
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  const scriptPath = path.join(norm, 'script.txt')
  const voiceoverPath = path.join(norm, 'voiceover.wav')
  fs.writeFileSync(scriptPath, 'Sample documentary script')
  fs.writeFileSync(voiceoverPath, 'Sample voiceover audio')

  const fingerprint: InputFingerprint = {
    scriptPath,
    scriptHash: 'script_hash_abc',
    voiceoverPath,
    voiceoverSize: 22,
    voiceoverMtimeMs: 1700000000000
  }

  const options: AutoPipelineOptions = {
    projectDir: norm,
    scriptPath,
    voiceoverPath,
    assemblyMode: params.assemblyMode ?? 'full-production',
    backgroundMusicMode: params.backgroundMusicMode ?? 'off',
    requireBackgroundMusic: (params.backgroundMusicMode ?? 'off') === 'off' ? false : false,
    visualSourceMode: 'custom-mix',
    visualMixConfig: {
      mode: 'custom-mix',
      aiImageRatio: 1,
      stockFootageRatio: 0,
      aiImageMode: 'prompt',
      imageOutputResolution: '1080p'
    },
    editorialSettings: {
      schemaVersion: 1,
      promptMode: 'embedded-editorial',
      labelDensity: 'balanced',
      readability: 'senior-friendly',
      preferLeaderLines: true,
      renderOverlayMode: params.renderOverlayMode ?? 'source-only'
    }
  }

  const state = createInitialPipelineState(options, fingerprint, params.runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(params.runId, 'stock-search')

  state.stages.validating.status = 'completed'
  state.stages.validating.progress = 1
  state.stages.transcribing.status = 'completed'
  state.stages.transcribing.progress = 1
  state.stages.planning.status = 'completed'
  state.stages.planning.progress = 1
  state.stages.captions.status = 'completed'
  state.stages.captions.progress = 1
  state.stages['global-context'].status = 'completed'
  state.stages['global-context'].progress = 1

  state.stages['stock-search'] = {
    status: 'running',
    progress: ready / expected,
    startedAt: '2026-10-28T09:56:00.000Z',
    message: `Waiting for ${missingSceneIndices.length} AI images (${ready}/${expected} ready)`,
    manualAiWait: {
      expected,
      ready,
      missingSceneIndices,
      promptFilePath: promptPackPath,
      stockExpected: 0,
      stockReady: 0
    }
  }

  savePipelineStateAtomic(norm, state)

  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.set(norm, {
    runId: params.runId,
    projectDir: norm,
    abortController: new AbortController(),
    stageStartTime: Date.now(),
    currentStage: 'stock-search',
    state,
    promise: new Promise<AutoPipelineState>(() => {})
  })

  return state
}

function cleanupActiveRun(projectDir: string): void {
  const norm = normalizeProjectDir(projectDir)
  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.delete(norm)
}

void (async () => {
  const testRoot = freshDir('live-render-mode-switch-tests')

  await it('19.1, 19.2, 19.3, 19.4, 19.5 & 19.6: Safe active wait switches Full -> Simple while preserving runId, stage, 80/131 ready count, prompt hashes, and without restarting pipeline', async () => {
    const projDir = path.join(testRoot, 'cell-01')
    const runId = 'run-cell-01-active'
    const initialState = createWaitingActiveRun({
      projectDir: projDir,
      runId,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'off',
      expectedScenes: 131,
      readyScenes: 80
    })

    // Save project default preference as Full Production + Add Music (Layer A)
    saveProductionModeSettings(projDir, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto'
    })

    const beforeVersion = initialState.version
    const beforeStartedAt = initialState.startedAt
    const beforeStatus = getManualAiStatus(projDir)
    const beforeHashes = beforeStatus.rows.map((r) => r.promptHash)

    let startCalled = false
    let resumeCalled = false
    const origStart = pipelineOrchestrator.startPipeline.bind(pipelineOrchestrator)
    const origResume = pipelineOrchestrator.resumePipeline.bind(pipelineOrchestrator)
    ;(pipelineOrchestrator as any).startPipeline = async (...args: any[]) => {
      startCalled = true
      return origStart(...(args as [AutoPipelineOptions]))
    }
    ;(pipelineOrchestrator as any).resumePipeline = async (...args: any[]) => {
      resumeCalled = true
      return origResume(...(args as [string]))
    }

    try {
      const result = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })

      // 19.1 Safe active wait -> success
      assert.strictEqual(result.success, true)
      assert.strictEqual(result.appliedToActiveRun, true)
      assert.strictEqual(result.effectiveAssemblyMode, 'simple-assembly')
      assert.strictEqual(result.effectiveBackgroundMusicMode, 'off')

      // 19.2 Run ID preservation
      assert.strictEqual(result.runId, runId)
      assert.strictEqual(initialState.runId, runId)

      // 19.3 Stage preservation
      assert.strictEqual(initialState.currentStage, 'stock-search')
      assert.strictEqual(initialState.overallStatus, 'running')
      assert.strictEqual(initialState.stages['stock-search'].status, 'running')
      assert.strictEqual(initialState.startedAt, beforeStartedAt)

      // 19.4 Ready preservation (80/131)
      const waitAfter = initialState.stages['stock-search'].manualAiWait
      assert.ok(waitAfter, 'manualAiWait must remain attached')
      assert.strictEqual(waitAfter?.expected, 131)
      assert.strictEqual(waitAfter?.ready, 80)
      assert.strictEqual(waitAfter?.missingSceneIndices.length, 51)

      // 19.5 Prompt hash preservation
      const afterStatus = getManualAiStatus(projDir)
      assert.strictEqual(afterStatus.expected, 131)
      assert.strictEqual(afterStatus.ready, 80)
      assert.deepStrictEqual(
        afterStatus.rows.map((r) => r.promptHash),
        beforeHashes,
        'All 131 canonical prompt hashes must remain identical'
      )

      // 19.6 No restart
      assert.strictEqual(startCalled, false, 'startPipeline() must NOT be called')
      assert.strictEqual(resumeCalled, false, 'resumePipeline() must NOT be called')

      // Upstream stages remain completed
      assert.strictEqual(initialState.stages.validating.status, 'completed')
      assert.strictEqual(initialState.stages.transcribing.status, 'completed')
      assert.strictEqual(initialState.stages.planning.status, 'completed')
      assert.strictEqual(initialState.stages.captions.status, 'completed')
      assert.strictEqual(initialState.stages['global-context'].status, 'completed')

      // Downstream stages remain pending
      assert.strictEqual(initialState.stages['audio-search'].status, 'pending')
      assert.strictEqual(initialState.stages.preflight.status, 'pending')
      assert.strictEqual(initialState.stages.rendering.status, 'pending')
      assert.strictEqual(initialState.stages.postflight.status, 'pending')

      // Version advanced monotonically and state persisted
      assert.ok(initialState.version > beforeVersion)
      const persisted = loadPipelineState(projDir)
      assert.ok(persisted)
      assert.strictEqual(persisted?.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(persisted?.options.backgroundMusicMode, 'off')
      assert.strictEqual(persisted?.renderSettings?.assemblyMode, 'simple-assembly')
      assert.strictEqual(persisted?.renderSettings?.backgroundMusicMode, 'off')

      // Layer A (production-mode-settings.v1.json) must NOT be mutated
      const defaultPrefs = loadProductionModeSettings(projDir)
      assert.strictEqual(defaultPrefs.assemblyMode, 'full-production')
      assert.strictEqual(defaultPrefs.backgroundMusicMode, 'auto')
    } finally {
      ;(pipelineOrchestrator as any).startPipeline = origStart
      ;(pipelineOrchestrator as any).resumePipeline = origResume
      cleanupActiveRun(projDir)
    }
  })

  await it('19.23: Source Only independence — updating Assembly Mode does not reset editorialSettings.renderOverlayMode', async () => {
    const projDir = path.join(testRoot, 'source-only-preserve')
    const runId = 'run-source-only'
    const state = createWaitingActiveRun({
      projectDir: projDir,
      runId,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      expectedScenes: 10,
      readyScenes: 4,
      renderOverlayMode: 'source-only'
    })

    try {
      const res1 = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res1.success, true)
      assert.strictEqual(state.options.editorialSettings?.renderOverlayMode, 'source-only')
      assert.strictEqual(state.options.editorialSettings?.promptMode, 'embedded-editorial')

      // Switch back to Full Smart Render -> Source Only is still intact
      const res2 = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'full-production',
        backgroundMusicMode: 'auto'
      })
      assert.strictEqual(res2.success, true)
      assert.strictEqual(state.options.editorialSettings?.renderOverlayMode, 'source-only')
    } finally {
      cleanupActiveRun(projDir)
    }
  })

  await it('Part 7.10: Idempotency — applying the same settings twice returns current effective configuration without extra state mutations', async () => {
    const projDir = path.join(testRoot, 'idempotent-apply')
    const runId = 'run-idempotent'
    const state = createWaitingActiveRun({
      projectDir: projDir,
      runId,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      expectedScenes: 12,
      readyScenes: 5
    })

    try {
      const first = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(first.success, true)
      const versionAfterFirst = state.version

      const second = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(second.success, true)
      assert.strictEqual(second.appliedToActiveRun, true)
      assert.strictEqual(second.effectiveAssemblyMode, 'simple-assembly')
      assert.strictEqual(second.effectiveBackgroundMusicMode, 'off')
      assert.strictEqual(state.version, versionAfterFirst)
    } finally {
      cleanupActiveRun(projDir)
    }
  })

  await finish()
})()

