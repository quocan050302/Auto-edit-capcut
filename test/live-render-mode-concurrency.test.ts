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
  MANUAL_AI_PROMPT_SCHEMA_VERSION,
  getManualAiPromptJsonPath,
  getManualAiManifestPath,
  type ManualAiPromptPack,
  type ManualAiAssetsManifest
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Concurrency & Race Protection Tests')

function create130Of131Project(projectDir: string, runId: string): {
  state: AutoPipelineState
  commitScene131AndAdvance: () => void
} {
  const norm = normalizeProjectDir(projectDir)
  fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
  const mediaDir = path.join(norm, 'assets', 'generated', 'manual-ai')
  fs.mkdirSync(mediaDir, { recursive: true })

  const totalScenes = 131
  const promptScenes: ManualAiPromptPack['scenes'] = []
  const manifestScenes: ManualAiAssetsManifest['scenes'] = {}

  for (let i = 1; i <= totalScenes; i++) {
    const hash = `race_hash_${i}`
    promptScenes.push({
      sceneIndex: i,
      sceneId: `scene_${String(i).padStart(3, '0')}`,
      narration: `Scene ${i}`,
      visualIntent: `Intent ${i}`,
      strategy: 'ai-still',
      prompt: `Prompt ${i}`,
      promptHash: hash,
      expectedFilename: `scene_${String(i).padStart(3, '0')}.png`,
      startTime: (i - 1) * 3,
      endTime: i * 3,
      duration: 3
    })

    const filePath = path.join(mediaDir, `scene_${String(i).padStart(3, '0')}.png`)
    fs.writeFileSync(filePath, `img-${i}`)

    if (i < 131) {
      manifestScenes[String(i)] = {
        sceneIndex: i,
        promptHash: hash,
        status: 'ready',
        sourcePath: filePath,
        localPath: filePath,
        width: 1920,
        height: 1080,
        importedAt: new Date().toISOString()
      }
    }
  }

  const promptFilePath = getManualAiPromptJsonPath(norm)
  const pack: ManualAiPromptPack = {
    schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    profile: 'health',
    totalProjectScenes: totalScenes,
    expectedAiImages: totalScenes,
    imageMode: 'prompt',
    outputResolution: '1080p',
    scenes: promptScenes
  }
  fs.writeFileSync(promptFilePath, JSON.stringify(pack, null, 2), 'utf-8')

  const manifestPath = getManualAiManifestPath(norm)
  const manifest: ManualAiAssetsManifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    expected: totalScenes,
    ready: 130,
    missing: 1,
    scenes: manifestScenes
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  const scriptPath = path.join(norm, 'script.txt')
  const voiceoverPath = path.join(norm, 'vo.wav')
  fs.writeFileSync(scriptPath, 'script')
  fs.writeFileSync(voiceoverPath, 'vo')

  const fp: InputFingerprint = { scriptPath, voiceoverPath }
  const opts: AutoPipelineOptions = {
    projectDir: norm,
    scriptPath,
    voiceoverPath,
    assemblyMode: 'full-production',
    backgroundMusicMode: 'auto'
  }

  const state = createInitialPipelineState(opts, fp, runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(runId, 'stock-search')
  state.stages['stock-search'] = {
    status: 'running',
    progress: 130 / 131,
    manualAiWait: {
      expected: 131,
      ready: 130,
      missingSceneIndices: [131],
      promptFilePath,
      stockExpected: 0,
      stockReady: 0
    }
  }
  savePipelineStateAtomic(norm, state)

  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.set(norm, {
    runId,
    projectDir: norm,
    abortController: new AbortController(),
    stageStartTime: Date.now(),
    currentStage: 'stock-search',
    state,
    promise: new Promise<AutoPipelineState>(() => {})
  })

  const commitScene131AndAdvance = (): void => {
    const file131 = path.join(mediaDir, 'scene_131.png')
    manifest.scenes['131'] = {
      sceneIndex: 131,
      promptHash: 'race_hash_131',
      status: 'ready',
      sourcePath: file131,
      localPath: file131,
      width: 1920,
      height: 1080,
      importedAt: new Date().toISOString()
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    delete state.stages['stock-search'].manualAiWait
    state.stages['stock-search'].stats = {
      ...(state.stages['stock-search'].stats || {}),
      manualAiWaitCompleted: true
    }
    state.stages['stock-search'].status = 'completed'
    state.currentStage = 'audio-search'
    state.stages['audio-search'].status = 'running'
    savePipelineStateAtomic(norm, state)
  }

  return { state, commitScene131AndAdvance }
}

void (async () => {
  const testRoot = freshDir('live-render-mode-concurrency-tests')

  await it('19.11: Last scene race (Outcome A — Apply wins before Scene 131 import finishes)', async () => {
    const projDir = path.join(testRoot, 'race-outcome-a')
    const runId = 'run-race-a'
    const { state, commitScene131AndAdvance } = create130Of131Project(projDir, runId)

    try {
      // Apply wins while 130/131 ready
      const applyPromise = pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      const applyRes = await applyPromise
      commitScene131AndAdvance()

      assert.strictEqual(applyRes.success, true)
      assert.strictEqual(applyRes.appliedToActiveRun, true)
      assert.strictEqual(applyRes.effectiveAssemblyMode, 'simple-assembly')
      assert.strictEqual(applyRes.effectiveBackgroundMusicMode, 'off')

      // Downstream stage consumes the committed Simple Assembly + No Music options
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')
      assert.strictEqual(state.options.requireBackgroundMusic, false)

      const persisted = loadPipelineState(projDir)
      assert.strictEqual(persisted?.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(persisted?.options.backgroundMusicMode, 'off')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(
        normalizeProjectDir(projDir)
      )
    }
  })

  await it('19.11: Last scene race (Outcome B — Scene 131 import finishes first, Apply rejected with TOO_LATE)', async () => {
    const projDir = path.join(testRoot, 'race-outcome-b')
    const runId = 'run-race-b'
    const { state, commitScene131AndAdvance } = create130Of131Project(projDir, runId)

    try {
      // Scene 131 import completes first
      commitScene131AndAdvance()

      const applyRes = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })

      assert.strictEqual(applyRes.success, false)
      assert.strictEqual(applyRes.appliedToActiveRun, false)
      assert.strictEqual(applyRes.errorCode, 'TOO_LATE')
      assert.strictEqual(applyRes.effectiveAssemblyMode, 'full-production')
      assert.strictEqual(applyRes.effectiveBackgroundMusicMode, 'auto')

      // Never partially applied
      assert.strictEqual(state.options.assemblyMode, 'full-production')
      assert.strictEqual(state.options.backgroundMusicMode, 'auto')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(
        normalizeProjectDir(projDir)
      )
    }
  })

  await it('19.11: Repeated competing events (10 iterations) always produce linearizable Outcome A or Outcome B', async () => {
    for (let iter = 1; iter <= 10; iter++) {
      const projDir = path.join(testRoot, `race-iter-${iter}`)
      const runId = `run-iter-${iter}`
      const { state, commitScene131AndAdvance } = create130Of131Project(projDir, runId)

      try {
        let applyResPromise: Promise<any>
        if (iter % 2 === 0) {
          applyResPromise = pipelineOrchestrator.updateFinalRenderOptions({
            projectDir: projDir,
            runId,
            assemblyMode: 'simple-assembly',
            backgroundMusicMode: 'off'
          })
          await Promise.resolve()
          commitScene131AndAdvance()
        } else {
          commitScene131AndAdvance()
          applyResPromise = pipelineOrchestrator.updateFinalRenderOptions({
            projectDir: projDir,
            runId,
            assemblyMode: 'simple-assembly',
            backgroundMusicMode: 'off'
          })
        }

        const res = await applyResPromise
        if (res.success) {
          // Outcome A: both fields updated coherently
          assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
          assert.strictEqual(state.options.backgroundMusicMode, 'off')
          assert.strictEqual(res.effectiveAssemblyMode, 'simple-assembly')
          assert.strictEqual(res.effectiveBackgroundMusicMode, 'off')
        } else {
          // Outcome B: rejected as TOO_LATE, original fields intact
          assert.strictEqual(res.errorCode, 'TOO_LATE')
          assert.strictEqual(state.options.assemblyMode, 'full-production')
          assert.strictEqual(state.options.backgroundMusicMode, 'auto')
        }
      } finally {
        ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(
          normalizeProjectDir(projDir)
        )
      }
    }
  })

  await it('Part 17.8: Stale expectedStateVersion does not overwrite a newer accepted setting', async () => {
    const projDir = path.join(testRoot, 'stale-version-check')
    const runId = 'run-stale-ver'
    const { state } = create130Of131Project(projDir, runId)

    try {
      const initialVersion = state.version

      // Newer update succeeds and advances version
      const firstUpdate = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off',
        expectedStateVersion: initialVersion
      })
      assert.strictEqual(firstUpdate.success, true)
      assert.ok(state.version > initialVersion)

      // Stale request referencing initialVersion with conflicting mode is rejected
      const staleAttempt = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'full-production',
        backgroundMusicMode: 'auto',
        expectedStateVersion: initialVersion
      })
      assert.strictEqual(staleAttempt.success, false)
      assert.strictEqual(staleAttempt.errorCode, 'STALE_REQUEST')
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(
        normalizeProjectDir(projDir)
      )
    }
  })

  await finish()
})()

