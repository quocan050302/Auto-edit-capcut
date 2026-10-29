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
  saveProductionModeSettings,
  loadProductionModeSettings
} from '../src/main/simple-assembly/production-mode-settings'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Crash Recovery & Resume Tests')

void (async () => {
  const testRoot = freshDir('live-render-mode-resume-tests')

  await it('19.19 & Part 9.2–9.4: Accepted live mode survives app close (handleAppQuit) and pipeline recovery without being overwritten by production-mode-settings.v1.json', async () => {
    const projDir = path.join(testRoot, 'reload-and-resume')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-before-close'

    fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
    const scriptPath = path.join(norm, 'script.txt')
    const voiceoverPath = path.join(norm, 'vo.wav')
    fs.writeFileSync(scriptPath, 'Sample script content')
    fs.writeFileSync(voiceoverPath, 'Sample voiceover content')

    // Write valid transcript and plan artifacts so upstream stages reconcile as completed
    fs.writeFileSync(
      path.join(norm, 'analysis', 'transcript.json'),
      JSON.stringify({
        language: 'en',
        duration: 12,
        segments: [{ id: 's1', text: 'Hello world', start: 0, end: 12, duration: 12, words: [] }],
        fullText: 'Hello world',
        wordCount: 2,
        generatedAt: new Date().toISOString()
      }),
      'utf-8'
    )
    fs.writeFileSync(
      path.join(norm, 'analysis', 'master-edit-plan.json'),
      JSON.stringify({
        chapters: [
          {
            chapterIndex: 0,
            sequences: [
              {
                sequenceIndex: 0,
                scenes: [
                  {
                    id: 'scene_1',
                    sceneIndex: 1,
                    narration: 'Hello world',
                    startTime: 0,
                    endTime: 12,
                    duration: 12,
                    searchQueries: ['nature']
                  }
                ]
              }
            ]
          }
        ]
      }),
      'utf-8'
    )
    fs.writeFileSync(
      path.join(norm, 'analysis', 'caption-plan.json'),
      JSON.stringify({
        enabled: true,
        activeRanges: [],
        phrases: []
      }),
      'utf-8'
    )
    fs.writeFileSync(
      path.join(norm, 'analysis', 'global-script-context.json'),
      JSON.stringify({
        primarySubject: 'Nature',
        overallTheme: 'Nature',
        visualStyle: 'Cinematic',
        tone: 'Calm'
      }),
      'utf-8'
    )

    // Layer A: Project defaults say Full Smart Render + Add Music
    saveProductionModeSettings(norm, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto'
    })

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
    state.stages.validating.status = 'completed'
    state.stages.transcribing.status = 'completed'
    state.stages.planning.status = 'completed'
    state.stages.captions.status = 'completed'
    state.stages['global-context'].status = 'completed'
    state.stages['stock-search'] = {
      status: 'running',
      progress: 0.6,
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

    // 1. User switches live from Full Smart Render + Add Music -> Simple Assembly + No Music
    const updateRes = await pipelineOrchestrator.updateFinalRenderOptions({
      projectDir: norm,
      runId,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })
    assert.strictEqual(updateRes.success, true)
    assert.strictEqual(updateRes.effectiveAssemblyMode, 'simple-assembly')
    assert.strictEqual(updateRes.effectiveBackgroundMusicMode, 'off')

    // 2. App closes (handleAppQuit)
    pipelineOrchestrator.handleAppQuit()
    assert.strictEqual(pipelineOrchestrator.isRunning(norm), false)

    const stateAfterQuit = loadPipelineState(norm)
    assert.strictEqual(stateAfterQuit?.overallStatus, 'interrupted')
    assert.strictEqual(stateAfterQuit?.options.assemblyMode, 'simple-assembly')
    assert.strictEqual(stateAfterQuit?.options.backgroundMusicMode, 'off')
    assert.strictEqual(stateAfterQuit?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(stateAfterQuit?.renderSettings?.backgroundMusicMode, 'off')

    // 3. App reopens and runs recoverInterruptedPipeline
    const recovery = await pipelineOrchestrator.recoverInterruptedPipeline(norm)
    assert.strictEqual(recovery.recovered, true)
    assert.strictEqual(recovery.resumable, true)
    assert.strictEqual(recovery.resumeFrom, 'stock-search')
    assert.strictEqual(recovery.snapshot?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(recovery.snapshot?.renderSettings?.backgroundMusicMode, 'off')

    const recoveredState = pipelineOrchestrator.getStatus(norm)
    assert.strictEqual(recoveredState?.options.assemblyMode, 'simple-assembly')
    assert.strictEqual(recoveredState?.options.backgroundMusicMode, 'off')
    assert.strictEqual(recoveredState?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(recoveredState?.renderSettings?.backgroundMusicMode, 'off')

    // Confirm project default file was still Full Production + Add Music and did NOT overwrite active run
    const projectDefaults = loadProductionModeSettings(norm)
    assert.strictEqual(projectDefaults.assemblyMode, 'full-production')
    assert.strictEqual(projectDefaults.backgroundMusicMode, 'auto')
  })

  await finish()
})()

