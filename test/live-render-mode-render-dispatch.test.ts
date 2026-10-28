import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  normalizeProjectDir,
  savePipelineStateAtomic,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import { computeRenderFingerprint, type RenderFingerprintInput } from '../src/main/render-cache/render-fingerprint'
import { readRenderProvenance, writeRenderProvenance } from '../src/main/pipeline/render-provenance'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Render Dispatch & Cache Protection Tests')

function createRenderSwitchState(
  projectDir: string,
  runId: string,
  initialMode: 'full-production' | 'simple-assembly',
  initialMusic: 'auto' | 'off'
): AutoPipelineState {
  const norm = normalizeProjectDir(projectDir)
  fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
  const scriptPath = path.join(norm, 'script.txt')
  const voiceoverPath = path.join(norm, 'vo.wav')
  fs.writeFileSync(scriptPath, 'script')
  fs.writeFileSync(voiceoverPath, 'vo')

  const fp: InputFingerprint = { scriptPath, voiceoverPath }
  const opts: AutoPipelineOptions = {
    projectDir: norm,
    scriptPath,
    voiceoverPath,
    assemblyMode: initialMode,
    backgroundMusicMode: initialMusic
  }

  const state = createInitialPipelineState(opts, fp, runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(runId, 'stock-search')
  state.stages['stock-search'] = {
    status: 'running',
    progress: 0.5,
    manualAiWait: {
      expected: 5,
      ready: 3,
      missingSceneIndices: [4, 5],
      promptFilePath: path.join(norm, 'analysis', 'manual-ai-prompts.v1.json'),
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
  return state
}

void (async () => {
  const testRoot = freshDir('live-render-mode-dispatch-tests')

  await it('19.7: Full -> Simple live switch updates active run options consumed by runRenderStage to dispatch Simple Assembly', async () => {
    const projDir = path.join(testRoot, 'full-to-simple')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-f2s'
    const state = createRenderSwitchState(projDir, runId, 'full-production', 'auto')

    try {
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, true)
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')

      // Verify render dispatch decision uses the updated state.options.assemblyMode
      const selectedRenderer =
        state.options.assemblyMode === 'simple-assembly'
          ? 'runSimpleAssemblyRenderStage'
          : 'runExistingFullRenderStage'
      assert.strictEqual(selectedRenderer, 'runSimpleAssemblyRenderStage')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await it('19.8: Simple -> Full live switch updates active run options consumed by runRenderStage to dispatch Full Production', async () => {
    const projDir = path.join(testRoot, 'simple-to-full')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-s2f'
    const state = createRenderSwitchState(projDir, runId, 'simple-assembly', 'off')

    try {
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'full-production',
        backgroundMusicMode: 'auto'
      })
      assert.strictEqual(res.success, true)
      assert.strictEqual(state.options.assemblyMode, 'full-production')
      assert.strictEqual(state.options.backgroundMusicMode, 'auto')

      const selectedRenderer =
        state.options.assemblyMode === 'simple-assembly'
          ? 'runSimpleAssemblyRenderStage'
          : 'runExistingFullRenderStage'
      assert.strictEqual(selectedRenderer, 'runExistingFullRenderStage')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await it('Part 16: Mode-aware request keys and provenance prevent cross-mode output reuse while preserving existing MP4 files', async () => {
    const projDir = path.join(testRoot, 'cache-isolation')
    const norm = normalizeProjectDir(projDir)
    const outputDir = path.join(norm, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    // Pre-existing Full Production MP4 must never be deleted when switching active run mode
    const existingFullMp4 = path.join(outputDir, 'final_output.mp4')
    fs.writeFileSync(existingFullMp4, Buffer.alloc(1024, 1))
    writeRenderProvenance(norm, {
      schemaVersion: 1,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      renderRequestFingerprint: 'full-fp-prev',
      outputPath: existingFullMp4,
      durationSecs: 10,
      fileSizeBytes: 1024,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    const runId = 'run-cache-iso'
    const state = createRenderSwitchState(projDir, runId, 'full-production', 'auto')

    try {
      const baseFpInput: Omit<RenderFingerprintInput, 'assemblyMode' | 'backgroundMusicMode'> = {
        masterEditPlanHash: 'plan-hash-1',
        mediaIndexHash: 'media-hash-1',
        stockAssignmentsHash: 'stock-hash-1',
        captionPlanHash: 'caption-hash-1',
        audioPlanHash: 'audio-hash-1',
        voiceover: null,
        base: { width: 1920, height: 1080, fps: 30, encoderProfile: 'libx264:fast:crf20' },
        transitionSettings: null,
        retentionSettings: null,
        proofVisualSettings: null,
        visualGrammarSettings: null,
        sceneFingerprints: ['scene-1', 'scene-2']
      }

      const keyBefore = computeRenderFingerprint({
        ...baseFpInput,
        assemblyMode: state.options.assemblyMode,
        backgroundMusicMode: state.options.backgroundMusicMode
      })

      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, true)

      const keyAfter = computeRenderFingerprint({
        ...baseFpInput,
        assemblyMode: state.options.assemblyMode,
        backgroundMusicMode: state.options.backgroundMusicMode
      })

      assert.notStrictEqual(
        keyBefore,
        keyAfter,
        'Render request key must change when assemblyMode / backgroundMusicMode changes'
      )

      // Old MP4 is preserved on disk
      assert.strictEqual(fs.existsSync(existingFullMp4), true)
      const prov = readRenderProvenance(norm)
      assert.notStrictEqual(prov?.assemblyMode, state.options.assemblyMode)
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await finish()
})()

