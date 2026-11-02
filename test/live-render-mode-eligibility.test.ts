import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { isLiveRenderModeSwitchEligible } from '../shared/types'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  normalizeProjectDir,
  savePipelineStateAtomic,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Eligibility Tests')

function setupActiveState(
  projectDir: string,
  runId: string,
  mutator: (state: AutoPipelineState) => void
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
    backgroundMusicMode: 'auto'
  }

  const state = createInitialPipelineState(opts, fp, runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(runId, 'stock-search')
  state.stages['stock-search'] = {
    status: 'running',
    progress: 0.5,
    manualAiWait: {
      expected: 10,
      ready: 5,
      missingSceneIndices: [6, 7, 8, 9, 10],
      promptFilePath: path.join(norm, 'analysis', 'manual-ai-prompts.v1.json'),
      stockExpected: 0,
      stockReady: 0
    }
  }

  mutator(state)
  savePipelineStateAtomic(norm, state)

  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.set(norm, {
    runId,
    projectDir: norm,
    abortController: new AbortController(),
    stageStartTime: Date.now(),
    currentStage: state.currentStage,
    state,
    promise: new Promise<AutoPipelineState>(() => {})
  })

  return state
}

function clearActiveState(projectDir: string): void {
  const norm = normalizeProjectDir(projectDir)
  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.delete(norm)
}

void (async () => {
  const testRoot = freshDir('live-render-mode-eligibility-tests')

  await it('19.12: Audio started — rejects live update with TOO_LATE and preserves existing mode', async () => {
    const projDir = path.join(testRoot, 'audio-started')
    const runId = 'run-audio'
    const state = setupActiveState(projDir, runId, (s) => {
      s.currentStage = 'audio-search'
      s.stages['stock-search'].status = 'completed'
      delete s.stages['stock-search'].manualAiWait
      s.stages['audio-search'].status = 'running'
    })

    try {
      assert.strictEqual(isLiveRenderModeSwitchEligible(state), false)
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.appliedToActiveRun, false)
      assert.strictEqual(res.errorCode, 'TOO_LATE')
      assert.ok(res.error?.includes('passed the manual asset waiting stage'))
      assert.strictEqual(state.options.assemblyMode, 'full-production')
    } finally {
      clearActiveState(projDir)
    }
  })

  await it('19.13: Preflight started — rejects live update with TOO_LATE', async () => {
    const projDir = path.join(testRoot, 'preflight-started')
    const runId = 'run-preflight'
    const state = setupActiveState(projDir, runId, (s) => {
      s.currentStage = 'preflight'
      s.stages['stock-search'].status = 'completed'
      delete s.stages['stock-search'].manualAiWait
      s.stages['audio-search'].status = 'completed'
      s.stages.preflight.status = 'running'
    })

    try {
      assert.strictEqual(isLiveRenderModeSwitchEligible(state), false)
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.errorCode, 'TOO_LATE')
      assert.strictEqual(state.options.assemblyMode, 'full-production')
    } finally {
      clearActiveState(projDir)
    }
  })

  await it('19.14: Render started — rejects live update with TOO_LATE', async () => {
    const projDir = path.join(testRoot, 'render-started')
    const runId = 'run-render'
    const state = setupActiveState(projDir, runId, (s) => {
      s.currentStage = 'rendering'
      s.stages['stock-search'].status = 'completed'
      delete s.stages['stock-search'].manualAiWait
      s.stages['audio-search'].status = 'completed'
      s.stages.preflight.status = 'completed'
      s.stages.rendering.status = 'running'
    })

    try {
      assert.strictEqual(isLiveRenderModeSwitchEligible(state), false)
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.errorCode, 'TOO_LATE')
    } finally {
      clearActiveState(projDir)
    }
  })

  await it('19.15: Completed run — rejects live update with TOO_LATE', async () => {
    const projDir = path.join(testRoot, 'completed-run')
    const runId = 'run-completed'
    setupActiveState(projDir, runId, (s) => {
      s.overallStatus = 'completed'
      s.currentStage = 'completed'
      delete s.stages['stock-search'].manualAiWait
    })
    clearActiveState(projDir)

    const res = await pipelineOrchestrator.updateFinalRenderOptions({
      projectDir: projDir,
      runId,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })
    assert.strictEqual(res.success, false)
    assert.strictEqual(res.errorCode, 'TOO_LATE')
    assert.ok(res.error?.includes('Use the supported rerender workflow instead'))
  })

  await it('19.16: Wrong run ID — rejects update with RUN_MISMATCH', async () => {
    const projDir = path.join(testRoot, 'wrong-run-id')
    const runId = 'run-correct-123'
    const state = setupActiveState(projDir, runId, () => {})

    try {
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId: 'run-stale-999',
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.errorCode, 'RUN_MISMATCH')
      assert.strictEqual(state.options.assemblyMode, 'full-production')
    } finally {
      clearActiveState(projDir)
    }
  })

  await it('19.17: Unknown project — rejects update with RUN_NOT_FOUND without creating new project files', async () => {
    const nonExistentDir = path.join(testRoot, 'does-not-exist-project')
    assert.strictEqual(fs.existsSync(nonExistentDir), false)

    const res = await pipelineOrchestrator.updateFinalRenderOptions({
      projectDir: nonExistentDir,
      runId: 'run-any',
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })

    assert.strictEqual(res.success, false)
    assert.strictEqual(res.errorCode, 'RUN_NOT_FOUND')
    assert.strictEqual(
      fs.existsSync(nonExistentDir),
      false,
      'Must NOT create directories or files for an unknown project'
    )
  })

  await it('19.24: Stock-only project — does not display false Manual AI wait and rejects live changes', async () => {
    const projDir = path.join(testRoot, 'stock-only-project')
    const runId = 'run-stock-only'
    const state = setupActiveState(projDir, runId, (s) => {
      // Stock-only run has no manualAiWait attached
      delete s.stages['stock-search'].manualAiWait
      s.stages['stock-search'].message = 'Downloading stock clips (12/25)...'
    })

    try {
      assert.strictEqual(isLiveRenderModeSwitchEligible(state), false)
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.errorCode, 'NOT_WAITING_FOR_ASSETS')
    } finally {
      clearActiveState(projDir)
    }
  })

  await it('Part 17.7 & Part 5.2: External process lease and invalid option values are rejected safely', async () => {
    const projDir = path.join(testRoot, 'external-lease')
    const runId = 'run-external'
    setupActiveState(projDir, runId, (s) => {
      s.lease = {
        runId,
        appInstanceId: 'another-electron-process-instance-id',
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        currentStage: 'stock-search'
      }
    })

    try {
      const extRes = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(extRes.success, false)
      assert.strictEqual(extRes.errorCode, 'NOT_RUNNING')

      const badRes = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'invalid-mode' as any,
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(badRes.success, false)
      assert.strictEqual(badRes.errorCode, 'INVALID_OPTIONS')
    } finally {
      clearActiveState(projDir)
    }
  })

  await finish()
})()

