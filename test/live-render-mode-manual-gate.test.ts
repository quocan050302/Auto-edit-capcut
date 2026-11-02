import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { manualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { getManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import {
  MANUAL_AI_PROMPT_SCHEMA_VERSION,
  getManualAiPromptJsonPath,
  getManualAiManifestPath,
  type ManualAiPromptPack,
  type ManualAiAssetsManifest
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  normalizeProjectDir,
  savePipelineStateAtomic,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Manual AI Gate & Long Project Tests')

void (async () => {
  const testRoot = freshDir('live-render-mode-manual-gate-tests')

  await it('Part 13.5: manualAiAssetGate.waitUntilReady() continues waiting across live render mode switch and resolves only when remaining scenes are imported', async () => {
    const projDir = path.join(testRoot, 'gate-continue-wait')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-gate-wait'
    fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
    const mediaDir = path.join(norm, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(mediaDir, { recursive: true })

    const totalScenes = 5
    const promptScenes: ManualAiPromptPack['scenes'] = []
    const manifestScenes: ManualAiAssetsManifest['scenes'] = {}

    for (let i = 1; i <= totalScenes; i++) {
      const hash = `gate_hash_${i}`
      promptScenes.push({
        sceneIndex: i,
        sceneId: `scene_${String(i).padStart(3, '0')}`,
        narration: `Narration ${i}`,
        visualIntent: `Intent ${i}`,
        strategy: 'ai-still',
        prompt: `Prompt ${i}`,
        promptHash: hash,
        expectedFilename: `scene_${String(i).padStart(3, '0')}.png`,
        startTime: (i - 1) * 4,
        endTime: i * 4,
        duration: 4
      })

      const filePath = path.join(mediaDir, `scene_${String(i).padStart(3, '0')}.png`)
      fs.writeFileSync(filePath, `img-data-${i}`)

      // Initially 3 of 5 ready
      if (i <= 3) {
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
      ready: 3,
      missing: 2,
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
      backgroundMusicMode: 'off'
    }

    const state = createInitialPipelineState(opts, fp, runId)
    state.overallStatus = 'running'
    state.currentStage = 'stock-search'
    state.lease = createLease(runId, 'stock-search')
    state.stages['stock-search'] = {
      status: 'running',
      progress: 0.6,
      manualAiWait: {
        expected: 5,
        ready: 3,
        missingSceneIndices: [4, 5],
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

    try {
      let gateResolved = false
      const gatePromise = manualAiAssetGate
        .waitUntilReady({
          projectDir: norm,
          pollIntervalMs: 5000,
          isReady: () => getManualAiStatus(norm).allReady
        })
        .then(() => {
          gateResolved = true
          return getManualAiStatus(norm)
        })

      // Give gate a tick to enter waiting state
      await new Promise((r) => setTimeout(r, 20))
      assert.strictEqual(gateResolved, false, 'Gate must still be waiting at 3/5 Ready')

      // Switch Final Render Mode live while gate is waiting
      const switchRes = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(switchRes.success, true)
      assert.strictEqual(switchRes.effectiveAssemblyMode, 'simple-assembly')

      await new Promise((r) => setTimeout(r, 20))
      assert.strictEqual(
        gateResolved,
        false,
        'Switching Final Render Mode must NOT prematurely resolve manualAiAssetGate'
      )

      // Now import remaining scenes 4 and 5 and notify gate
      for (const idx of [4, 5]) {
        const filePath = path.join(mediaDir, `scene_${String(idx).padStart(3, '0')}.png`)
        manifest.scenes[String(idx)] = {
          sceneIndex: idx,
          promptHash: `gate_hash_${idx}`,
          status: 'ready',
          sourcePath: filePath,
          localPath: filePath,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString()
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
      manualAiAssetGate.notify(norm)

      const resolvedStatus = await gatePromise
      assert.strictEqual(gateResolved, true)
      assert.strictEqual(resolvedStatus.allReady, true)
      assert.strictEqual(resolvedStatus.ready, 5)
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
    } finally {
      activeInstances.delete(norm)
    }
  })

  await it('19.25: Long project (>100 scenes: 131 scenes, 80 Ready, 51 Missing) updates live without prompt regeneration or media copying', async () => {
    const projDir = path.join(testRoot, 'long-project-131')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-long-131'
    fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
    const mediaDir = path.join(norm, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(mediaDir, { recursive: true })

    const totalScenes = 131
    const readyScenes = 80
    const promptScenes: ManualAiPromptPack['scenes'] = []
    const manifestScenes: ManualAiAssetsManifest['scenes'] = {}
    const missingSceneIndices: number[] = []

    for (let i = 1; i <= totalScenes; i++) {
      const hash = `long_hash_${i}`
      promptScenes.push({
        sceneIndex: i,
        sceneId: `scene_${String(i).padStart(3, '0')}`,
        narration: `Scene ${i} narration`,
        visualIntent: `Scene ${i} visual intent`,
        strategy: 'ai-still',
        prompt: `Scene ${i} prompt`,
        promptHash: hash,
        expectedFilename: `scene_${String(i).padStart(3, '0')}.png`,
        startTime: (i - 1) * 4,
        endTime: i * 4,
        duration: 4
      })

      if (i <= readyScenes) {
        const filePath = path.join(mediaDir, `scene_${String(i).padStart(3, '0')}.png`)
        fs.writeFileSync(filePath, `img-${i}`)
        manifestScenes[String(i)] = {
          sceneIndex: i,
          promptHash: hash,
          status: 'ready',
          sourcePath: filePath,
          localPath: filePath,
          width: 1920,
          height: 1080,
          importedAt: '2026-10-28T10:00:00.000Z'
        }
      } else {
        missingSceneIndices.push(i)
      }
    }

    const promptFilePath = getManualAiPromptJsonPath(norm)
    fs.writeFileSync(
      promptFilePath,
      JSON.stringify(
        {
          schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
          generatedAt: '2026-10-28T09:50:00.000Z',
          profile: 'health',
          totalProjectScenes: totalScenes,
          expectedAiImages: totalScenes,
          imageMode: 'prompt',
          outputResolution: '1080p',
          scenes: promptScenes
        },
        null,
        2
      ),
      'utf-8'
    )
    const promptStatBefore = fs.statSync(promptFilePath)

    const manifestPath = getManualAiManifestPath(norm)
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: '2026-10-28T10:00:00.000Z',
          expected: totalScenes,
          ready: readyScenes,
          missing: totalScenes - readyScenes,
          scenes: manifestScenes
        },
        null,
        2
      ),
      'utf-8'
    )
    const manifestStatBefore = fs.statSync(manifestPath)

    const scriptPath = path.join(norm, 'script.txt')
    const voiceoverPath = path.join(norm, 'vo.wav')
    fs.writeFileSync(scriptPath, 'script')
    fs.writeFileSync(voiceoverPath, 'vo')

    const state = createInitialPipelineState(
      {
        projectDir: norm,
        scriptPath,
        voiceoverPath,
        assemblyMode: 'full-production',
        backgroundMusicMode: 'auto'
      },
      { scriptPath, voiceoverPath },
      runId
    )
    state.overallStatus = 'running'
    state.currentStage = 'stock-search'
    state.lease = createLease(runId, 'stock-search')
    state.stages['stock-search'] = {
      status: 'running',
      progress: readyScenes / totalScenes,
      manualAiWait: {
        expected: totalScenes,
        ready: readyScenes,
        missingSceneIndices,
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

    try {
      const t0 = Date.now()
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      const elapsedMs = Date.now() - t0

      assert.strictEqual(res.success, true)
      assert.ok(elapsedMs < 250, `Expected fast metadata update (<250ms), took ${elapsedMs}ms`)

      const promptStatAfter = fs.statSync(promptFilePath)
      const manifestStatAfter = fs.statSync(manifestPath)
      assert.strictEqual(
        promptStatAfter.mtimeMs,
        promptStatBefore.mtimeMs,
        'Prompt pack file must NOT be rewritten'
      )
      assert.strictEqual(
        manifestStatAfter.mtimeMs,
        manifestStatBefore.mtimeMs,
        'Manual AI assets manifest must NOT be rewritten'
      )
    } finally {
      activeInstances.delete(norm)
    }
  })

  await finish()
})()

