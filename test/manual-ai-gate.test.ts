/**
 * Manual AI (Prompt mode) — ManualAiAssetGate tests.
 * The gate must be event-driven (no busy loop), cancellable and leak-free.
 */
import { ManualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { assert, cleanupFixtures, createRunner, sleep } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Gate Tests')

async function main(): Promise<void> {
  console.log('\nManual AI gate')

  await it('resolves on notify() without any polling (poll interval is huge)', async () => {
    const gate = new ManualAiAssetGate()
    let ready = false
    let evaluations = 0
    const p = gate.waitUntilReady({
      projectDir: 'proj-a',
      pollIntervalMs: 1_000_000,
      isReady: () => {
        evaluations++
        return ready
      }
    })
    await sleep(80)
    assert.strictEqual(evaluations, 1, 'single initial evaluation only')
    assert.strictEqual(gate.waiterCount('proj-a'), 1)
    ready = true
    gate.notify('proj-a')
    await p
    assert.strictEqual(evaluations, 2)
    assert.strictEqual(gate.waiterCount('proj-a'), 0, 'listener removed once resolved')
  })

  await it('does not busy-wait: ~300ms of waiting causes only a handful of evaluations', async () => {
    const gate = new ManualAiAssetGate()
    let evaluations = 0
    const ac = new AbortController()
    const p = gate
      .waitUntilReady({
        projectDir: 'proj-b',
        pollIntervalMs: 100,
        signal: ac.signal,
        isReady: () => {
          evaluations++
          return false
        }
      })
      .catch(() => undefined)
    await sleep(320)
    ac.abort()
    await p
    assert.ok(evaluations <= 6, `expected a slow poll, got ${evaluations} evaluations`)
    assert.ok(evaluations >= 1)
  })

  await it('slow safety-net poll resolves when state changes without any notify()', async () => {
    const gate = new ManualAiAssetGate()
    let ready = false
    setTimeout(() => {
      ready = true
    }, 60)
    const keepAlive = setInterval(() => undefined, 50)
    try {
      await gate.waitUntilReady({ projectDir: 'proj-c', pollIntervalMs: 40, isReady: () => ready })
    } finally {
      clearInterval(keepAlive)
    }
    assert.strictEqual(gate.waiterCount('proj-c'), 0)
  })

  await it('abort rejects with the standard cancel message and unsubscribes', async () => {
    const gate = new ManualAiAssetGate()
    const ac = new AbortController()
    const p = gate.waitUntilReady({ projectDir: 'proj-d', pollIntervalMs: 1_000_000, signal: ac.signal, isReady: () => false })
    await sleep(30)
    assert.strictEqual(gate.waiterCount('proj-d'), 1)
    ac.abort()
    await assert.rejects(p, /Pipeline execution was cancelled\./)
    assert.strictEqual(gate.waiterCount('proj-d'), 0)
  })

  await it('already-aborted signal rejects immediately without evaluating', async () => {
    const gate = new ManualAiAssetGate()
    const ac = new AbortController()
    ac.abort()
    let evaluations = 0
    await assert.rejects(
      gate.waitUntilReady({
        projectDir: 'proj-e',
        signal: ac.signal,
        isReady: () => {
          evaluations++
          return false
        }
      }),
      /cancelled/
    )
    assert.strictEqual(evaluations, 0)
  })

  await it('notify only wakes waiters of the same project', async () => {
    const gate = new ManualAiAssetGate()
    let evalsA = 0
    let evalsB = 0
    const acA = new AbortController()
    const acB = new AbortController()
    const pa = gate.waitUntilReady({ projectDir: 'proj-f1', pollIntervalMs: 1_000_000, signal: acA.signal, isReady: () => (evalsA++, false) }).catch(() => undefined)
    const pb = gate.waitUntilReady({ projectDir: 'proj-f2', pollIntervalMs: 1_000_000, signal: acB.signal, isReady: () => (evalsB++, false) }).catch(() => undefined)
    await sleep(40)
    gate.notify('proj-f1')
    await sleep(40)
    assert.strictEqual(evalsA, 2)
    assert.strictEqual(evalsB, 1)
    acA.abort()
    acB.abort()
    await Promise.all([pa, pb])
  })

  await it('notifications during an evaluation are coalesced into exactly one re-run', async () => {
    const gate = new ManualAiAssetGate()
    let evaluations = 0
    let ready = false
    const p = gate.waitUntilReady({
      projectDir: 'proj-g',
      pollIntervalMs: 1_000_000,
      isReady: async () => {
        evaluations++
        const snapshot = ready // state observed when the evaluation starts
        await sleep(40)
        return snapshot
      }
    })
    await sleep(10)
    // burst of notifications while the first evaluation is still running
    gate.notify('proj-g')
    gate.notify('proj-g')
    gate.notify('proj-g')
    ready = true
    await p
    assert.strictEqual(evaluations, 2, `expected 2 evaluations, got ${evaluations}`)
  })

  await it('onEvaluate fires after every evaluation (progress publishing) and errors reject the wait', async () => {
    const gate = new ManualAiAssetGate()
    let published = 0
    let ready = false
    const p = gate.waitUntilReady({
      projectDir: 'proj-h',
      pollIntervalMs: 1_000_000,
      isReady: () => ready,
      onEvaluate: () => {
        published++
      }
    })
    await sleep(20)
    ready = true
    gate.notify('proj-h')
    await p
    assert.strictEqual(published, 2)

    await assert.rejects(
      gate.waitUntilReady({
        projectDir: 'proj-i',
        isReady: () => {
          throw new Error('boom')
        }
      }),
      /boom/
    )
    assert.strictEqual(gate.waiterCount('proj-i'), 0)
  })

  cleanupFixtures()
  finish()
}

void main()
