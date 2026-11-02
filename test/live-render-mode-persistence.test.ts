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
  updateHeartbeat,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Persistence, Heartbeat & Save Failure Tests')

function createPersistenceRun(projectDir: string, runId: string): AutoPipelineState {
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
    progress: 0.4,
    manualAiWait: {
      expected: 10,
      ready: 4,
      missingSceneIndices: [5, 6, 7, 8, 9, 10],
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
  const testRoot = freshDir('live-render-mode-persistence-tests')

  await it('Part 7.8: Heartbeat persistence never reverts an accepted live options update', async () => {
    const projDir = path.join(testRoot, 'heartbeat-safety')
    const runId = 'run-hb-safe'
    const state = createPersistenceRun(projDir, runId)
    const norm = normalizeProjectDir(projDir)

    try {
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })
      assert.strictEqual(res.success, true)
      const versionAfterUpdate = state.version

      // Simulate heartbeat tick using instance.state
      const instance = ((pipelineOrchestrator as any).activeInstances as Map<string, any>).get(norm)
      assert.strictEqual(instance.state, state)
      updateHeartbeat(instance.state)
      savePipelineStateAtomic(norm, instance.state)

      assert.ok(state.version > versionAfterUpdate)
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')
      assert.strictEqual(state.renderSettings?.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.renderSettings?.backgroundMusicMode, 'off')

      const fromDisk = loadPipelineState(projDir)
      assert.strictEqual(fromDisk?.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(fromDisk?.options.backgroundMusicMode, 'off')
      assert.strictEqual(fromDisk?.renderSettings?.assemblyMode, 'simple-assembly')
      assert.strictEqual(fromDisk?.renderSettings?.backgroundMusicMode, 'off')
    } finally {
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await it('19.18 & Part 7.9: Disk save failure returns SAVE_FAILED, reports no false success, and rolls back in-memory options', async () => {
    const projDir = path.join(testRoot, 'save-failure')
    const runId = 'run-save-fail'
    const state = createPersistenceRun(projDir, runId)
    const norm = normalizeProjectDir(projDir)
    const versionBeforeFailure = state.version

    // Make the destination path a directory so renameSync into auto-pipeline-state.json fails deterministically
    const stateFilePath = path.join(norm, 'analysis', 'auto-pipeline-state.json')
    fs.unlinkSync(stateFilePath)
    fs.mkdirSync(stateFilePath, { recursive: true })

    try {
      const res = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir: projDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })

      assert.strictEqual(res.success, false, 'Must NOT report success when disk save fails')
      assert.strictEqual(res.appliedToActiveRun, false)
      assert.strictEqual(res.errorCode, 'SAVE_FAILED')

      // In-memory state must be rolled back to prior options and version
      assert.strictEqual(state.options.assemblyMode, 'full-production')
      assert.strictEqual(state.options.backgroundMusicMode, 'auto')
      assert.strictEqual(state.renderSettings?.assemblyMode, 'full-production')
      assert.strictEqual(state.renderSettings?.backgroundMusicMode, 'auto')
      assert.strictEqual(state.version, versionBeforeFailure)
    } finally {
      fs.rmSync(stateFilePath, { recursive: true, force: true })
      ;((pipelineOrchestrator as any).activeInstances as Map<string, any>).delete(norm)
    }
  })

  await finish()
})()

