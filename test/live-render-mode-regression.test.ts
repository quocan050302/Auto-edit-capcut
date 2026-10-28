import * as path from 'path'
import * as fs from 'fs'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import {
  IPC_CHANNELS,
  getActiveRunRenderSettings,
  resolveVideoAssemblyMode,
  resolveBackgroundMusicMode
} from '../shared/types'
import { registerPipelineHandlers } from '../src/main/ipc/pipeline.ipc'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  normalizeProjectDir,
  savePipelineStateAtomic,
  toSnapshot,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Regression & Legacy Compatibility Tests')

void (async () => {
  const testRoot = freshDir('live-render-mode-regression-tests')

  await it('19.22: Legacy projects without assemblyMode or backgroundMusicMode default to Full Production + Add Music unless explicitly changed', () => {
    const legacyOptions: AutoPipelineOptions = {
      projectDir: 'C:/legacy/proj',
      scriptPath: 'C:/legacy/script.txt',
      voiceoverPath: 'C:/legacy/vo.wav'
    }
    const fp: InputFingerprint = {
      scriptPath: legacyOptions.scriptPath,
      voiceoverPath: legacyOptions.voiceoverPath
    }

    const state = createInitialPipelineState(legacyOptions, fp, 'run-legacy')
    const snapshot = toSnapshot(state)

    assert.strictEqual(resolveVideoAssemblyMode(state.options), 'full-production')
    assert.strictEqual(resolveBackgroundMusicMode(state.options), 'auto')
    assert.deepStrictEqual(getActiveRunRenderSettings(state.options), {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto'
    })
    assert.deepStrictEqual(snapshot.renderSettings, {
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto'
    })
  })

  await it('Part 5.1–5.3: IPC handler registers PIPELINE_UPDATE_FINAL_RENDER_OPTIONS and delegates to pipelineOrchestrator.updateFinalRenderOptions', async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<any>>()
    const fakeIpcMain = {
      handle: (channel: string, listener: (...args: any[]) => Promise<any>) => {
        handlers.set(channel, listener)
      }
    } as any

    registerPipelineHandlers(fakeIpcMain)
    const updateHandler = handlers.get(IPC_CHANNELS.PIPELINE_UPDATE_FINAL_RENDER_OPTIONS)
    assert.ok(
      updateHandler,
      'PIPELINE_UPDATE_FINAL_RENDER_OPTIONS handler must be registered in registerPipelineHandlers'
    )

    const projDir = path.join(testRoot, 'ipc-delegation')
    const norm = normalizeProjectDir(projDir)
    fs.mkdirSync(path.join(norm, 'analysis'), { recursive: true })
    const scriptPath = path.join(norm, 'script.txt')
    const voiceoverPath = path.join(norm, 'vo.wav')
    fs.writeFileSync(scriptPath, 'script')
    fs.writeFileSync(voiceoverPath, 'vo')

    const runId = 'run-ipc-test'
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
      progress: 0.25,
      manualAiWait: {
        expected: 8,
        ready: 2,
        missingSceneIndices: [3, 4, 5, 6, 7, 8],
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

    try {
      const ipcResult = await updateHandler!(
        {},
        {
          projectDir: norm,
          runId,
          assemblyMode: 'simple-assembly',
          backgroundMusicMode: 'off'
        }
      )
      assert.strictEqual(ipcResult.success, true)
      assert.strictEqual(ipcResult.appliedToActiveRun, true)
      assert.strictEqual(ipcResult.effectiveAssemblyMode, 'simple-assembly')
      assert.strictEqual(ipcResult.effectiveBackgroundMusicMode, 'off')
      assert.strictEqual(state.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(state.options.backgroundMusicMode, 'off')
    } finally {
      activeInstances.delete(norm)
    }
  })

  await finish()
})()

