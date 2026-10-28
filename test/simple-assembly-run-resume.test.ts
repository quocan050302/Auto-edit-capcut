import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import {
  savePipelineStateAtomic,
  loadPipelineState,
  createInitialPipelineState,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import { renderJobCoordinator } from '../src/main/render-cache/render-job-coordinator'
import type { AutoPipelineOptions } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Simple Assembly Run Resume & Cancellation Tests')

void (async () => {
  const testRoot = freshDir('run-resume-tests')

  await it('Section 22: Pipeline state load/save preserves assemblyMode and options across resume', () => {
    const projDir = path.join(testRoot, 'proj-resume')
    fs.mkdirSync(projDir, { recursive: true })

    const fingerprint: InputFingerprint = {
      scriptPath: path.join(projDir, 'script.txt'),
      voiceoverPath: path.join(projDir, 'vo.mp3')
    }

    const options: AutoPipelineOptions = {
      projectDir: projDir,
      scriptPath: fingerprint.scriptPath,
      voiceoverPath: fingerprint.voiceoverPath!,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    }

    const initial = createInitialPipelineState(options, fingerprint, 'run-test-123')
    initial.stages['planning'].status = 'completed'
    initial.stages['stock-search'].status = 'completed'
    initial.currentStage = 'rendering'
    initial.overallStatus = 'running'

    savePipelineStateAtomic(projDir, initial)

    const loaded = loadPipelineState(projDir)
    assert.ok(loaded, 'State must reload from disk')
    assert.strictEqual(loaded?.runId, 'run-test-123')
    assert.strictEqual(loaded?.options.assemblyMode, 'simple-assembly')
    assert.strictEqual(loaded?.options.backgroundMusicMode, 'off')
    assert.strictEqual(loaded?.stages['planning'].status, 'completed')
    assert.strictEqual(loaded?.stages['stock-search'].status, 'completed')
    assert.strictEqual(loaded?.currentStage, 'rendering')
  })

  await it('Section 19: RenderJobCoordinator deduplicates concurrent runs and propagates cancellation', async () => {
    const projDir = path.join(testRoot, 'proj-coordinator')
    fs.mkdirSync(projDir, { recursive: true })

    const abortController = new AbortController()
    let executedCount = 0

    const jobKey = `test-assembly-key-${Date.now()}`

    const { promise, attached } = renderJobCoordinator.run({
      projectDir: projDir,
      requestKey: jobKey,
      source: 'pipeline',
      externalSignal: abortController.signal,
      starter: async (sig) => {
        executedCount++
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve('done'), 1000)
          sig.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new Error('Job cancelled'))
          })
        })
      }
    })

    assert.strictEqual(attached, false, 'First run is not attached')
    assert.strictEqual(renderJobCoordinator.isActive(projDir), true, 'Job must be active')

    // Second concurrent call to same job key must deduplicate
    const second = renderJobCoordinator.run({
      projectDir: projDir,
      requestKey: jobKey,
      source: 'pipeline',
      externalSignal: abortController.signal,
      starter: async () => {
        executedCount++
        return 'duplicate'
      }
    })

    assert.strictEqual(second.attached, true, 'Second run must attach to existing promise')
    assert.strictEqual(executedCount, 1, 'Starter must only run once')

    // Abort signal cancels job
    abortController.abort()

    let caught = false
    try {
      await promise
    } catch (err) {
      caught = true
      assert.ok(String(err).includes('cancelled') || String(err).includes('aborted'))
    }
    assert.ok(caught, 'Aborted job must reject with cancellation error')
    assert.strictEqual(renderJobCoordinator.isActive(projDir), false, 'Job must become inactive after completion/cancel')
  })

  await finish()
})()
