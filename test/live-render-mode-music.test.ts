import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import { runAudioSearchStage } from '../src/main/pipeline/pipeline-stage-runners'
import {
  createInitialPipelineState,
  createLease,
  normalizeProjectDir,
  savePipelineStateAtomic,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'
import type { AudioPlan } from '../shared/types'

const { it, finish } = createRunner('Live Final Render Mode Genuine Music Off & On Tests')

function createMusicTestRun(
  projectDir: string,
  runId: string,
  optsPatch: Partial<AutoPipelineOptions>
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
    assemblyMode: 'full-production',
    backgroundMusicMode: 'auto',
    ...optsPatch
  }

  const state = createInitialPipelineState(opts, fp, runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(runId, 'stock-search')
  state.stages['stock-search'] = {
    status: 'running',
    progress: 0.5,
    manualAiWait: {
      expected: 4,
      ready: 2,
      missingSceneIndices: [3, 4],
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
  const testRoot = freshDir('live-render-mode-music-tests')

  await it('19.9 & Part 14.1–14.3: Switching to Music Off sets requireBackgroundMusic=false, keeps existing audio-plan.json intact on disk, and produces 0 music / 0 SFX in Simple Assembly', async () => {
    const projDir = path.join(testRoot, 'music-off-genuine')
    const norm = normalizeProjectDir(projDir)
    const runId = 'run-music-off'
    const state = createMusicTestRun(projDir, runId, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      requireBackgroundMusic: true
    })

    // Write an existing approved audio-plan.json on disk
    const dummyMusicFile = path.join(norm, 'cached-music.mp3')
    fs.writeFileSync(dummyMusicFile, 'mp3-bytes')
    const audioPlanPath = path.join(norm, 'analysis', 'audio-plan.json')
    const existingAudioPlan: AudioPlan = {
      generatedAt: '2026-10-28T09:00:00.000Z',
      sections: [
        {
          sectionId: 'sec_1',
          sectionLabel: 'Intro',
          mood: 'calm',
          startTime: 0,
          endTime: 10,
          durationSecs: 10,
          sceneIndexes: [1, 2],
          musicCandidate: null,
          approved: true,
          status: 'found',
          approvedLocalPath: dummyMusicFile
        }
      ],
      sfxAssignments: []
    }
    fs.writeFileSync(audioPlanPath, JSON.stringify(existingAudioPlan, null, 2), 'utf-8')

    try {
      // Switch live to Simple Assembly + No Music
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: norm,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, true)
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')
      assert.strictEqual(state.options.requireBackgroundMusic, false)

      // Run Audio Stage with the updated state.options
      const audioRes = await runAudioSearchStage(state.options, () => {})
      assert.strictEqual(audioRes.success, true)
      assert.strictEqual(audioRes.stats?.downloadedMusicCount, 0)
      assert.strictEqual(audioRes.stats?.sfxCount, 0)
      assert.strictEqual(audioRes.stats?.backgroundMusicMode, 'off')

      // Original audio-plan.json on disk remains intact (approved: true not destroyed on disk)
      const diskPlanAfter = JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8')) as AudioPlan
      assert.strictEqual(diskPlanAfter.sections[0].approved, true)
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await it('19.10 & Part 8.1: Switching from Music Off back to Music On preserves original requireBackgroundMusic strictness without forcing true when originally false', async () => {
    const projDirFalse = path.join(testRoot, 'music-on-preserve-false')
    const normFalse = normalizeProjectDir(projDirFalse)
    const runFalse = 'run-music-false'
    const stateFalse = createMusicTestRun(projDirFalse, runFalse, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      requireBackgroundMusic: false
    })

    const projDirTrue = path.join(testRoot, 'music-on-preserve-true')
    const normTrue = normalizeProjectDir(projDirTrue)
    const runTrue = 'run-music-true'
    const stateTrue = createMusicTestRun(projDirTrue, runTrue, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      requireBackgroundMusic: true
    })

    try {
      // Toggle auto -> off -> auto when originally requireBackgroundMusic: false
      await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: normFalse,
        runId: runFalse,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(stateFalse.options.requireBackgroundMusic, false)

      await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: normFalse,
        runId: runFalse,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'auto'
      })
      assert.strictEqual(stateFalse.options.backgroundMusicMode, 'auto')
      assert.strictEqual(
        stateFalse.options.requireBackgroundMusic,
        false,
        'Must NOT force requireBackgroundMusic=true when user originally had false'
      )

      // Toggle auto -> off -> auto when originally requireBackgroundMusic: true
      await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: normTrue,
        runId: runTrue,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(stateTrue.options.requireBackgroundMusic, false)

      await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: normTrue,
        runId: runTrue,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'auto'
      })
      assert.strictEqual(stateTrue.options.backgroundMusicMode, 'auto')
      assert.strictEqual(
        stateTrue.options.requireBackgroundMusic,
        true,
        'Must restore requireBackgroundMusic=true when user originally had true'
      )
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(normFalse)
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(normTrue)
    }
  })

  await finish()
})()

