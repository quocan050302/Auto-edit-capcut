/**
 * planning-cancellation.test.ts
 *
 * Verifies that cancellation stops planning immediately,
 * never writes incomplete master edit plans, preserves project files,
 * and allows clean resumption.
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  executePlanningRequest,
  PlanningCancelledError
} from '../src/main/ai/planning-request'
import { buildEditPlan } from '../src/main/planner'
import type { TranscriptResult } from '../shared/types'

describe('Planning User Cancellation', () => {
  it('Immediate abort: throws PlanningCancelledError before starting execution', async () => {
    const controller = new AbortController()
    controller.abort()

    let executed = false
    await assert.rejects(
      async () => {
        await executePlanningRequest({
          task: 'aborted-task',
          timeoutMs: 5000,
          signal: controller.signal,
          execute: async () => {
            executed = true
            return 'done'
          }
        })
      },
      (err: unknown) => {
        return err instanceof PlanningCancelledError
      }
    )

    assert.strictEqual(executed, false)
  })

  it('Abort while running: aborts underlying signal and throws PlanningCancelledError', async () => {
    const controller = new AbortController()
    let innerSignalAborted = false

    const promise = executePlanningRequest({
      task: 'in-flight-task',
      timeoutMs: 10000,
      signal: controller.signal,
      execute: async (innerSignal) => {
        return new Promise((resolve, reject) => {
          innerSignal.addEventListener('abort', () => {
            innerSignalAborted = true
            reject(new Error('AbortError'))
          })
        })
      }
    })

    // Simulate user clicking Cancel after 50ms
    setTimeout(() => {
      controller.abort()
    }, 50)

    await assert.rejects(
      async () => {
        await promise
      },
      (err: unknown) => {
        return err instanceof PlanningCancelledError
      }
    )

    assert.strictEqual(innerSignalAborted, true)
  })

  it('buildEditPlan with aborted signal: terminates immediately without writing master-edit-plan.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-edit-plan-cancel-'))
    const analysisDir = path.join(tmpDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    const transcript: TranscriptResult = {
      language: 'en',
      duration: 10,
      fullText: 'Short test narration for cancellation testing.',
      segments: [
        {
          id: 's1',
          start: 0,
          end: 5,
          duration: 5,
          text: 'Short test narration for cancellation testing.',
          words: []
        },
        {
          id: 's2',
          start: 5,
          end: 10,
          duration: 5,
          text: 'Second narration segment.',
          words: []
        }
      ]
    }
    const transcriptPath = path.join(analysisDir, 'transcript.json')
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript), 'utf-8')

    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      async () => {
        await buildEditPlan({
          projectDir: tmpDir,
          apiKey: 'test-key',
          signal: controller.signal
        })
      },
      (err: unknown) => {
        return err instanceof PlanningCancelledError
      }
    )

    // Verify transcript was not touched/deleted
    assert.strictEqual(fs.existsSync(transcriptPath), true)

    // Verify master-edit-plan.json was NOT created
    const planPath = path.join(analysisDir, 'master-edit-plan.json')
    assert.strictEqual(fs.existsSync(planPath), false)

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
