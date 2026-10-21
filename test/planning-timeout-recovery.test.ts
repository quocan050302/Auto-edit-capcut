/**
 * planning-timeout-recovery.test.ts
 *
 * Verifies bounded API execution, timeouts, hanging requests,
 * and defensive fallback routing under network degradation.
 */

import { describe, it, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import {
  executePlanningRequest,
  PlanningTimeoutError,
  PlanningCancelledError,
  computeBatchTimeoutMs,
  computeOutputTokenBudget
} from '../src/main/ai/planning-request'
import {
  recordModelSuccess,
  recordModelFailure,
  isModelAvailable,
  resetModelHealth,
  getModelHealthState
} from '../src/main/ai/model-health'
import { classifyGeminiErrorKind } from '../src/main/utils/gemini-fallback'
import { getAvailableModelsForTask } from '../src/main/ai/model-router'

describe('Planning Request Timeout & Recovery', () => {
  beforeEach(() => {
    resetModelHealth()
  })

  it('Fast response: completes normally within budget', async () => {
    const res = await executePlanningRequest({
      task: 'fast-task',
      timeoutMs: 1000,
      execute: async () => {
        return { success: true, data: [1, 2, 3] }
      }
    })

    assert.strictEqual(res.success, true)
    assert.deepStrictEqual(res.data, [1, 2, 3])
  })

  it('Slow response: times out deterministically when exceeding deadline', async () => {
    const t0 = Date.now()
    let threw = false

    try {
      await executePlanningRequest({
        task: 'slow-task',
        timeoutMs: 80,
        execute: async (signal) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve('finished late'), 500)
            signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('AbortError'))
            })
          })
        }
      })
    } catch (err: unknown) {
      threw = true
      const elapsed = Date.now() - t0
      assert.ok(err instanceof PlanningTimeoutError || (err as any)?.isTimeout)
      assert.ok(elapsed >= 70 && elapsed < 350, `Elapsed ${elapsed}ms was not bounded`)
    }

    assert.strictEqual(threw, true, 'Expected slow task to throw timeout error')
  })

  it('Hanging request: never blocks indefinitely and aborts underlying signal', async () => {
    let underlyingSignalAborted = false

    await assert.rejects(
      async () => {
        await executePlanningRequest({
          task: 'hanging-task',
          timeoutMs: 50,
          execute: async (signal) => {
            return new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                underlyingSignalAborted = true
                reject(new Error('AbortError'))
              })
            })
          }
        })
      },
      (err: unknown) => {
        return err instanceof PlanningTimeoutError
      }
    )

    assert.strictEqual(underlyingSignalAborted, true)
  })

  it('Adaptive timeout calculation scales proportionally with batch size', () => {
    const t1 = computeBatchTimeoutMs(1)
    const t5 = computeBatchTimeoutMs(5)
    const t10 = computeBatchTimeoutMs(10)
    const t20 = computeBatchTimeoutMs(20)

    assert.strictEqual(t1, 35000)
    assert.strictEqual(t5, 45000)
    assert.strictEqual(t10, 60000)
    assert.ok(t20 >= 75000 && t20 <= 85000)
  })

  it('Adaptive output token budget scales safely with batch size', () => {
    const b1 = computeOutputTokenBudget(1)
    const b5 = computeOutputTokenBudget(5)
    const b20 = computeOutputTokenBudget(20)

    assert.strictEqual(b1, 1024)
    assert.strictEqual(b5, 1750)
    assert.strictEqual(b20, 7000)
  })

  it('Cancellation does not poison model health', () => {
    const model = 'gemini-3.8-flash'
    recordModelFailure(model, 'CANCELLED')

    assert.strictEqual(isModelAvailable(model), true)
    const state = getModelHealthState(model)
    assert.strictEqual(state?.consecutiveFailures ?? 0, 0)
  })

  it('Consecutive timeouts trip circuit breaker after 2 failures', () => {
    const model = 'gemini-3.8-flash'

    recordModelFailure(model, 'TIMEOUT')
    assert.strictEqual(isModelAvailable(model), true)

    recordModelFailure(model, 'TIMEOUT')
    assert.strictEqual(isModelAvailable(model), false)
  })

  it('Model router skips unavailable models and preserves healthy fallbacks', () => {
    const primary = 'gemini-3.8-flash'
    recordModelFailure(primary, 'RATE_LIMIT')

    const available = getAvailableModelsForTask('planning', primary)
    assert.ok(!available.includes(primary), 'Should skip rate-limited primary model')
    assert.ok(available.includes('gemini-3.5-flash'), 'Should fall back to healthy 3.5-flash')
  })
})
