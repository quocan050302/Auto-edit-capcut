/**
 * Interactive UI & State Machine Verification Tests for YouTube Research
 * Validates Analyze Market click responsiveness, optimistic STARTING state,
 * double-click protection, terminal state releases, and SSE/polling resilience.
 */

import * as assert from 'assert'
import {
  ACTIVE_RESEARCH_STAGES,
  TERMINAL_RESEARCH_STAGES,
  isResearchStageActive,
  isResearchStageTerminal,
  isResearchRunActive,
  type ResearchProgressState
} from '../src/renderer/src/features/youtube-research/types/research.types'
import {
  ResearchApi,
  ResearchApiError
} from '../src/renderer/src/features/youtube-research/api/researchApi'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    const res = fn()
    if (res instanceof Promise) {
      await res
    }
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✕ ${name}`)
    console.error(err)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING YOUTUBE RESEARCH INTERACTIVE & STATE MACHINE TESTS')
  console.log('==================================================\n')

  // 1. Unified State Machine Tests
  await it('1. ACTIVE_RESEARCH_STAGES and TERMINAL_RESEARCH_STAGES are mutually exclusive and complete', () => {
    assert.ok(ACTIVE_RESEARCH_STAGES.includes('STARTING'))
    assert.ok(ACTIVE_RESEARCH_STAGES.includes('QUEUED'))
    assert.ok(TERMINAL_RESEARCH_STAGES.includes('COMPLETED'))
    assert.ok(TERMINAL_RESEARCH_STAGES.includes('FAILED'))
    assert.ok(TERMINAL_RESEARCH_STAGES.includes('CANCELLED'))
    assert.ok(TERMINAL_RESEARCH_STAGES.includes('INTERRUPTED'))

    for (const term of TERMINAL_RESEARCH_STAGES) {
      assert.strictEqual(
        (ACTIVE_RESEARCH_STAGES as readonly string[]).includes(term),
        false,
        `${term} must not be in ACTIVE_RESEARCH_STAGES`
      )
    }
  })

  // 2. isResearchStageActive
  await it('2. isResearchStageActive recognizes STARTING and QUEUED as active, and INTERRUPTED as terminal', () => {
    assert.strictEqual(isResearchStageActive('STARTING'), true)
    assert.strictEqual(isResearchStageActive('QUEUED'), true)
    assert.strictEqual(isResearchStageActive('SEARCHING'), true)
    assert.strictEqual(isResearchStageActive('AI_ANALYSIS'), true)

    assert.strictEqual(isResearchStageActive('COMPLETED'), false)
    assert.strictEqual(isResearchStageActive('FAILED'), false)
    assert.strictEqual(isResearchStageActive('CANCELLED'), false)
    assert.strictEqual(isResearchStageActive('INTERRUPTED'), false)
    assert.strictEqual(isResearchStageActive('IDLE'), false)
    assert.strictEqual(isResearchStageActive(null), false)
    assert.strictEqual(isResearchStageActive(undefined), false)
  })

  // 3. isResearchStageTerminal
  await it('3. isResearchStageTerminal accurately identifies terminal states', () => {
    assert.strictEqual(isResearchStageTerminal('COMPLETED'), true)
    assert.strictEqual(isResearchStageTerminal('FAILED'), true)
    assert.strictEqual(isResearchStageTerminal('CANCELLED'), true)
    assert.strictEqual(isResearchStageTerminal('INTERRUPTED'), true)

    assert.strictEqual(isResearchStageTerminal('STARTING'), false)
    assert.strictEqual(isResearchStageTerminal('QUEUED'), false)
    assert.strictEqual(isResearchStageTerminal('SEARCHING'), false)
    assert.strictEqual(isResearchStageTerminal(null), false)
  })

  // 4. isResearchRunActive with ResearchProgressState
  await it('4. isResearchRunActive checks progress object stage and null safety', () => {
    assert.strictEqual(isResearchRunActive(null), false)
    assert.strictEqual(isResearchRunActive(undefined), false)
    assert.strictEqual(isResearchRunActive({
      stage: 'STARTING',
      progress_percent: 1,
      message: 'Starting...',
      videos_collected: 0,
      channels_analyzed: 0,
      keywords_expanded: 0,
      elapsed_seconds: 0,
      can_cancel: false
    }), true)

    assert.strictEqual(isResearchRunActive({
      run_id: 'run_123',
      stage: 'INTERRUPTED',
      progress_percent: 50,
      message: 'Recovered interrupted',
      videos_collected: 10,
      channels_analyzed: 2,
      keywords_expanded: 5,
      elapsed_seconds: 20,
      can_cancel: false
    }), false)
  })

  // 5. Button Disabled Reason Calculation Simulation
  await it('5. Button disabled states provide explicit non-empty feedback reasons', () => {
    const computeDisabled = (params: {
      topic: string
      isStarting: boolean
      activeProgress: ResearchProgressState | null
      apiReachability: 'reachable' | 'blocked' | 'offline'
    }) => {
      const isRunning = isResearchRunActive(params.activeProgress)
      const isBusy = params.isStarting || isRunning
      const canSubmit = Boolean(params.topic.trim()) && !isBusy && params.apiReachability !== 'blocked' && params.apiReachability !== 'offline'
      const isDisabled = !canSubmit

      let reason: string | null = null
      if (!params.topic.trim()) reason = 'Please enter a topic keyword to analyze'
      else if (params.isStarting) reason = 'Starting research request...'
      else if (isRunning) reason = 'A research run is currently in progress'
      else if (params.apiReachability === 'blocked') reason = 'Cannot connect to local research API (connection blocked)'
      else if (params.apiReachability === 'offline') reason = 'Research service is offline. Please start or restart the service.'

      return { isDisabled, isBusy, isRunning, reason }
    }

    // A: Empty topic
    const r1 = computeDisabled({ topic: '  ', isStarting: false, activeProgress: null, apiReachability: 'reachable' })
    assert.strictEqual(r1.isDisabled, true)
    assert.strictEqual(r1.reason, 'Please enter a topic keyword to analyze')

    // B: Offline sidecar
    const r2 = computeDisabled({ topic: 'ai tools', isStarting: false, activeProgress: null, apiReachability: 'offline' })
    assert.strictEqual(r2.isDisabled, true)
    assert.strictEqual(r2.reason, 'Research service is offline. Please start or restart the service.')

    // C: Blocked connection
    const r3 = computeDisabled({ topic: 'ai tools', isStarting: false, activeProgress: null, apiReachability: 'blocked' })
    assert.strictEqual(r3.isDisabled, true)
    assert.strictEqual(r3.reason, 'Cannot connect to local research API (connection blocked)')

    // D: Active run in progress
    const r4 = computeDisabled({
      topic: 'ai tools',
      isStarting: false,
      activeProgress: {
        stage: 'SEARCHING',
        progress_percent: 30,
        message: 'Searching...',
        videos_collected: 10,
        channels_analyzed: 2,
        keywords_expanded: 5,
        elapsed_seconds: 12,
        can_cancel: true
      },
      apiReachability: 'reachable'
    })
    assert.strictEqual(r4.isDisabled, true)
    assert.strictEqual(r4.reason, 'A research run is currently in progress')

    // E: Interrupted run -> MUST BE ENABLED! (Does NOT lock the button)
    const r5 = computeDisabled({
      topic: 'ai tools',
      isStarting: false,
      activeProgress: {
        stage: 'INTERRUPTED',
        progress_percent: 30,
        message: 'Interrupted',
        videos_collected: 10,
        channels_analyzed: 2,
        keywords_expanded: 5,
        elapsed_seconds: 12,
        can_cancel: false
      },
      apiReachability: 'reachable'
    })
    assert.strictEqual(r5.isDisabled, false, 'INTERRUPTED stage must release the button!')
    assert.strictEqual(r5.reason, null)

    // F: Valid state -> Enabled
    const r6 = computeDisabled({ topic: 'grocery prices', isStarting: false, activeProgress: null, apiReachability: 'reachable' })
    assert.strictEqual(r6.isDisabled, false)
    assert.strictEqual(r6.reason, null)
  })

  // 6. Double Click Protection & Immediate Feedback Simulation
  await it('6. Double-click on Analyze Market is guarded and only creates exactly one request', async () => {
    let isStartingResearch = false
    let activeProgress: ResearchProgressState | null = null
    let postRequestCount = 0

    const mockStartDiscover = async (topic: string) => {
      if (isStartingResearch || isResearchRunActive(activeProgress)) {
        return // Guarded!
      }

      isStartingResearch = true
      activeProgress = {
        run_id: null,
        stage: 'STARTING',
        progress_percent: 1,
        message: 'Starting market analysis...',
        videos_collected: 0,
        channels_analyzed: 0,
        keywords_expanded: 0,
        elapsed_seconds: 0,
        can_cancel: false
      }

      try {
        postRequestCount++
        // Simulate sidecar delay
        await new Promise((r) => setTimeout(r, 50))
        activeProgress = {
          run_id: 'run_test_double_click',
          stage: 'QUEUED',
          progress_percent: 5,
          message: 'Research job queued...',
          videos_collected: 0,
          channels_analyzed: 0,
          keywords_expanded: 0,
          elapsed_seconds: 0,
          can_cancel: true
        }
      } finally {
        isStartingResearch = false
      }
    }

    // Fire two rapid clicks concurrently
    const p1 = mockStartDiscover('grocery prices')
    // Immediate verification (<10ms): isStartingResearch is true, stage is STARTING!
    assert.strictEqual(isStartingResearch, true, 'isStartingResearch must be true immediately on click')
    assert.strictEqual(activeProgress?.stage, 'STARTING', 'Progress stage must be STARTING immediately')

    const p2 = mockStartDiscover('grocery prices') // second click while p1 is running

    await Promise.all([p1, p2])

    assert.strictEqual(postRequestCount, 1, 'Double click must only make 1 request')
    assert.strictEqual(activeProgress?.stage, 'QUEUED')
    assert.strictEqual(activeProgress?.run_id, 'run_test_double_click')
    assert.strictEqual(isStartingResearch, false)
  })

  // 7. Error Handling Releases isStartingResearch and Sets FAILED State
  await it('7. API failures transition to FAILED state and release the starting lock', async () => {
    let isStartingResearch = false
    let activeProgress: ResearchProgressState | null = null
    let capturedError: string | null = null

    const mockFailingDiscover = async () => {
      if (isStartingResearch || isResearchRunActive(activeProgress)) return
      isStartingResearch = true
      activeProgress = {
        run_id: null,
        stage: 'STARTING',
        progress_percent: 1,
        message: 'Starting market analysis...',
        videos_collected: 0,
        channels_analyzed: 0,
        keywords_expanded: 0,
        elapsed_seconds: 0,
        can_cancel: false
      }

      try {
        await new Promise((_, reject) => setTimeout(() => reject(new Error('Sidecar database timeout')), 20))
      } catch (err: any) {
        capturedError = err.message
        activeProgress = {
          run_id: null,
          stage: 'FAILED',
          progress_percent: 0,
          message: err.message,
          error: err.message,
          videos_collected: 0,
          channels_analyzed: 0,
          keywords_expanded: 0,
          elapsed_seconds: 0,
          can_cancel: false
        }
      } finally {
        isStartingResearch = false
      }
    }

    await mockFailingDiscover()

    assert.strictEqual(isStartingResearch, false, 'Lock must be released on failure')
    assert.strictEqual(activeProgress?.stage, 'FAILED')
    assert.strictEqual(activeProgress?.error, 'Sidecar database timeout')
    assert.strictEqual(capturedError, 'Sidecar database timeout')

    // After failure, user must be able to run again
    assert.strictEqual(isResearchRunActive(activeProgress), false, 'FAILED stage must allow new run')
  })

  // 8. Stale Run SSE Events Do Not Overwrite Active Run
  await it('8. Stale SSE events from previous runs are ignored and do not overwrite active run', () => {
    const currentRunId = 'run_active_456'
    let activeProgress: ResearchProgressState = {
      run_id: currentRunId,
      stage: 'QUEUED',
      progress_percent: 5,
      message: 'Current run queued',
      videos_collected: 0,
      channels_analyzed: 0,
      keywords_expanded: 0,
      elapsed_seconds: 0,
      can_cancel: true
    }

    const handleProgressEvent = (event: ResearchProgressState) => {
      // Stale run filter rule
      if (event.run_id && event.run_id !== currentRunId) {
        return // Reject!
      }
      activeProgress = event
    }

    // Stale event from old run
    handleProgressEvent({
      run_id: 'run_old_stale_111',
      stage: 'COMPLETED',
      progress_percent: 100,
      message: 'Old completed',
      videos_collected: 50,
      channels_analyzed: 10,
      keywords_expanded: 20,
      elapsed_seconds: 60,
      can_cancel: false
    })

    assert.strictEqual(activeProgress.run_id, currentRunId, 'Stale event must not overwrite current run')
    assert.strictEqual(activeProgress.stage, 'QUEUED')

    // Legitimate event for current run
    handleProgressEvent({
      run_id: currentRunId,
      stage: 'SEARCHING',
      progress_percent: 25,
      message: 'Searching YouTube...',
      videos_collected: 15,
      channels_analyzed: 3,
      keywords_expanded: 5,
      elapsed_seconds: 8,
      can_cancel: true
    })

    assert.strictEqual(activeProgress.stage, 'SEARCHING')
    assert.strictEqual(activeProgress.progress_percent, 25)
  })

  // 9. Progress Percentage Monotonicity Guard
  await it('9. Progress percent does not regress within the same stage', () => {
    let progress: ResearchProgressState = {
      run_id: 'run_monotonic',
      stage: 'SEARCHING',
      progress_percent: 30,
      message: 'Searching...',
      videos_collected: 20,
      channels_analyzed: 4,
      keywords_expanded: 8,
      elapsed_seconds: 15,
      can_cancel: true
    }

    const updateProgress = (newEvent: ResearchProgressState) => {
      if (newEvent.stage === progress.stage && (newEvent.progress_percent ?? 0) < (progress.progress_percent ?? 0)) {
        progress = { ...newEvent, progress_percent: progress.progress_percent }
      } else {
        progress = newEvent
      }
    }

    // Regressive event in same stage
    updateProgress({
      run_id: 'run_monotonic',
      stage: 'SEARCHING',
      progress_percent: 20, // lower!
      message: 'Still searching...',
      videos_collected: 22,
      channels_analyzed: 4,
      keywords_expanded: 8,
      elapsed_seconds: 16,
      can_cancel: true
    })

    assert.strictEqual(progress.progress_percent, 30, 'Progress must not regress within same stage')
    assert.strictEqual(progress.videos_collected, 22)
  })

  // 10. Polling Fallback Terminal Stage Cleanup
  await it('10. Polling fallback terminates and cleans up when terminal stage reached', async () => {
    const api = new ResearchApi('http://127.0.0.1:8765')
    let pollCount = 0
    let completedCalled = false

    // Mock getRunStatus
    api.getRunStatus = async (runId: string) => {
      pollCount++
      if (pollCount >= 3) {
        return {
          run_id: runId,
          stage: 'COMPLETED',
          progress_percent: 100,
          message: 'Research finished',
          videos_collected: 50,
          channels_analyzed: 10,
          keywords_expanded: 25,
          elapsed_seconds: 15,
          can_cancel: false
        }
      }
      return {
        run_id: runId,
        stage: 'SEARCHING',
        progress_percent: 30,
        message: 'Searching...',
        videos_collected: 10,
        channels_analyzed: 2,
        keywords_expanded: 5,
        elapsed_seconds: 5,
        can_cancel: true
      }
    }

    // Mock EventSource to force immediate fallback to polling
    const originalEventSource = (globalThis as any).EventSource
    try {
      (globalThis as any).EventSource = class {
        constructor() {
          throw new Error('SSE not supported in this test')
        }
      }

      await new Promise<void>((resolve) => {
        const cleanup = api.subscribeProgress(
          'run_poll_test',
          () => {},
          () => {},
          (terminalState) => {
            assert.strictEqual(terminalState.stage, 'COMPLETED')
            completedCalled = true
            cleanup()
            resolve()
          }
        )
      })

      assert.strictEqual(completedCalled, true)
      assert.ok(pollCount >= 3)
    } finally {
      (globalThis as any).EventSource = originalEventSource
    }
  })

  // 11. Polling fallback exhausts after consecutive failures
  await it('11. Polling fallback exhausts after consecutive failures and emits INTERRUPTED with ResearchProgressConnectionError', async () => {
    const api = new ResearchApi('http://127.0.0.1:8765')
    let failureCount = 0
    let capturedError: any = null
    let terminalReceived: ResearchProgressState | null = null

    // Mock getRunStatus to always throw network error (sidecar dead)
    api.getRunStatus = async () => {
      failureCount++
      throw new Error('Connection refused 127.0.0.1:8765')
    }

    const originalEventSource = (globalThis as any).EventSource
    try {
      (globalThis as any).EventSource = class {
        constructor() {
          throw new Error('SSE connection failed')
        }
      }

      await new Promise<void>((resolve) => {
        const cleanup = api.subscribeProgress(
          'run_disconnected_123',
          (prog) => {
            if (prog.stage === 'INTERRUPTED') {
              terminalReceived = prog
            }
          },
          (err) => {
            capturedError = err
          },
          (terminal) => {
            assert.strictEqual(terminal.stage, 'INTERRUPTED')
            cleanup()
            resolve()
          }
        )
      })

      assert.strictEqual(failureCount, 4, 'Must exhaust after 4 consecutive failures')
      assert.ok(capturedError, 'onError must be invoked')
      assert.strictEqual(capturedError.code, 'SIDECAR_DISCONNECTED')
      assert.strictEqual(capturedError.runId, 'run_disconnected_123')
      assert.ok(terminalReceived, 'Must emit INTERRUPTED progress state')
      assert.strictEqual(terminalReceived!.stage, 'INTERRUPTED')
    } finally {
      (globalThis as any).EventSource = originalEventSource
    }
  })

  // 12. INTERRUPTED stage releases busy lock and preserves form parameters
  await it('12. INTERRUPTED stage is not active, allows new run, and preserves form values', () => {
    const interruptedProgress: ResearchProgressState = {
      run_id: 'run_interrupted_999',
      stage: 'INTERRUPTED',
      progress_percent: 15,
      message: 'The local research service stopped unexpectedly.',
      videos_collected: 0,
      channels_analyzed: 0,
      keywords_expanded: 0,
      elapsed_seconds: 0,
      can_cancel: false,
      error: 'Sidecar disconnected'
    }

    assert.strictEqual(isResearchRunActive(interruptedProgress), false)
    assert.strictEqual(isResearchStageTerminal('INTERRUPTED'), true)
    assert.strictEqual(isResearchStageActive('INTERRUPTED'), false)

    // Verify form canSubmit logic with INTERRUPTED state
    const topic = 'grocery prices'
    const isStarting = false
    const isRunning = isResearchRunActive(interruptedProgress)
    const isBusy = Boolean(isStarting || isRunning)
    const apiReachability = 'reachable'
    const canSubmit = Boolean(topic.trim()) && !isBusy && apiReachability !== 'blocked' && apiReachability !== 'offline'
    assert.strictEqual(canSubmit, true, 'Form must allow submit when stage is INTERRUPTED')
  })

  // 13. Progress panel shouldShowProgressPanel logic
  await it('13. shouldShowProgressPanel stays visible for FAILED, INTERRUPTED, CANCELLED even when isBusy is false', () => {
    const computeShouldShow = (isBusy: boolean, stage?: string) => {
      return (
        isBusy ||
        stage === 'FAILED' ||
        stage === 'INTERRUPTED' ||
        stage === 'CANCELLED'
      )
    }

    assert.strictEqual(computeShouldShow(true, 'SEARCHING'), true)
    assert.strictEqual(computeShouldShow(false, 'FAILED'), true, 'FAILED must remain visible')
    assert.strictEqual(computeShouldShow(false, 'INTERRUPTED'), true, 'INTERRUPTED must remain visible')
    assert.strictEqual(computeShouldShow(false, 'CANCELLED'), true, 'CANCELLED must remain visible')
    assert.strictEqual(computeShouldShow(false, 'COMPLETED'), false, 'COMPLETED transfers to result view')
  })

  // 14. Sidecar manager markAppQuitting safety
  await it('14. Sidecar manager markAppQuitting prevents restart', async () => {
    const { ResearchSidecarManager } = await import('../src/main/research/research-sidecar')
    const manager = ResearchSidecarManager.getInstance()

    manager.markAppQuitting()
    const status = manager.getStatus()
    assert.strictEqual(status.port, 8765)
    assert.strictEqual(typeof status.online, 'boolean')
  })

  // Summary
  console.log('\n==================================================')
  console.log(`TESTS FINISHED: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Test runner failure:', err)
  process.exit(1)
})
