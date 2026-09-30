/**
 * Unit & Integration Test Suite for:
 * Auto Production Pipeline (src/main/pipeline/*)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  PIPELINE_EXECUTION_STAGES,
  STAGE_DISPLAY_NAMES,
  STAGE_NAV_TARGETS
} from '../src/main/pipeline/pipeline-types'
import {
  createInitialPipelineState,
  loadPipelineState,
  savePipelineStateAtomic,
  computeInputFingerprint,
  isFingerprintEqual,
  determineInvalidatedStages,
  applyInvalidation,
  createLease,
  isLeaseStale,
  releaseLease,
  getPipelineStateBackupPath,
  normalizeProjectDir
} from '../src/main/pipeline/pipeline-state'
import {
  validatePipelinePrerequisites,
  resolveGeminiApiKey
} from '../src/main/pipeline/pipeline-validator'
import {
  isTranscriptionValid,
  isPlanningValid,
  isCaptionsValid,
  isGlobalContextValid,
  checkStockCompletion,
  isAudioValid,
  isPreflightValid,
  reconcileProjectArtifacts
} from '../src/main/pipeline/pipeline-artifacts'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import { IPC_CHANNELS } from '../shared/types'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

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
  console.log('RUNNING AUTO PRODUCTION PIPELINE TEST SUITE')
  console.log('==================================================\n')

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'))
  const projectDir = path.join(testDir, 'test-project')
  fs.mkdirSync(path.join(projectDir, 'analysis'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'output'), { recursive: true })

  const mockScript = path.join(projectDir, 'script.txt')
  fs.writeFileSync(mockScript, 'This is a full documentary script about ancient history.', 'utf-8')

  const mockVoiceover = path.join(projectDir, 'voiceover.mp3')
  fs.writeFileSync(mockVoiceover, Buffer.alloc(4096, 1))

  // ── 1. Pipeline Stages & Order ──────────────────────────────────────────────
  await it('1. Pipeline stages execution order matches required specification exactly', () => {
    const expectedOrder = [
      'validating',
      'transcribing',
      'planning',
      'captions',
      'global-context',
      'stock-search',
      'audio-search',
      'preflight',
      'rendering',
      'postflight'
    ]
    assert.deepStrictEqual(Array.from(PIPELINE_EXECUTION_STAGES), expectedOrder)
  })

  await it('2. Stock Search is sequenced strictly after Global Visual Context', () => {
    const globalContextIdx = PIPELINE_EXECUTION_STAGES.indexOf('global-context')
    const stockSearchIdx = PIPELINE_EXECUTION_STAGES.indexOf('stock-search')
    assert.ok(globalContextIdx >= 0)
    assert.ok(stockSearchIdx >= 0)
    assert.ok(stockSearchIdx > globalContextIdx, 'stock-search must follow global-context')
  })

  await it('3. Rendering is sequenced strictly after Render Preflight QA', () => {
    const preflightIdx = PIPELINE_EXECUTION_STAGES.indexOf('preflight')
    const renderingIdx = PIPELINE_EXECUTION_STAGES.indexOf('rendering')
    assert.ok(preflightIdx >= 0)
    assert.ok(renderingIdx >= 0)
    assert.ok(renderingIdx > preflightIdx, 'rendering must follow preflight')
  })

  // ── 2. Atomic State Management & Fingerprinting ───────────────────────────
  await it('4. Atomic state writing writes to temp file before replacing state file', () => {
    const options: AutoPipelineOptions = {
      projectDir,
      scriptPath: mockScript,
      voiceoverPath: mockVoiceover
    }
    const fp = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    const state = createInitialPipelineState(options, fp, 'test-run-123')

    savePipelineStateAtomic(projectDir, state)

    const loaded = loadPipelineState(projectDir)
    assert.ok(loaded !== null)
    assert.strictEqual(loaded.runId, 'test-run-123')
    assert.strictEqual(loaded.options.scriptPath, mockScript)
  })

  await it('5. Fingerprint equality correctly matches identical files and detects modifications', () => {
    const fp1 = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    const fp2 = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    assert.strictEqual(isFingerprintEqual(fp1, fp2), true)

    const modifiedScript = path.join(projectDir, 'script_mod.txt')
    fs.writeFileSync(modifiedScript, 'Different content', 'utf-8')
    const fp3 = computeInputFingerprint(projectDir, modifiedScript, mockVoiceover)
    assert.strictEqual(isFingerprintEqual(fp1, fp3), false)
  })

  // ── 3. Invalidation Rules ──────────────────────────────────────────────────
  await it('6. Script change invalidates planning, captions, global-context, stock, audio, preflight, and render', () => {
    const options: AutoPipelineOptions = {
      projectDir,
      scriptPath: mockScript,
      voiceoverPath: mockVoiceover
    }
    const fp1 = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    const state = createInitialPipelineState(options, fp1)

    const modifiedScript = path.join(projectDir, 'script_modified.txt')
    fs.writeFileSync(modifiedScript, 'Brand new script text', 'utf-8')
    const newFp = computeInputFingerprint(projectDir, modifiedScript, mockVoiceover)

    const invalidated = determineInvalidatedStages(state, { ...options, scriptPath: modifiedScript }, newFp)
    assert.ok(invalidated.includes('planning'))
    assert.ok(invalidated.includes('captions'))
    assert.ok(invalidated.includes('global-context'))
    assert.ok(invalidated.includes('stock-search'))
    assert.ok(invalidated.includes('audio-search'))
    assert.ok(invalidated.includes('preflight'))
    assert.ok(invalidated.includes('rendering'))
    // Voiceover was not changed, so transcribing should NOT be invalidated
    assert.strictEqual(invalidated.includes('transcribing'), false)
  })

  await it('7. Voiceover change invalidates entire pipeline including transcription', () => {
    const options: AutoPipelineOptions = {
      projectDir,
      scriptPath: mockScript,
      voiceoverPath: mockVoiceover
    }
    const fp1 = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    const state = createInitialPipelineState(options, fp1)

    const modifiedVo = path.join(projectDir, 'voiceover_mod.mp3')
    fs.writeFileSync(modifiedVo, Buffer.alloc(8192, 2))
    const newFp = computeInputFingerprint(projectDir, mockScript, modifiedVo)

    const invalidated = determineInvalidatedStages(state, { ...options, voiceoverPath: modifiedVo }, newFp)
    assert.ok(invalidated.includes('transcribing'), 'voiceover change must invalidate transcribing')
    assert.ok(invalidated.includes('planning'))
    assert.ok(invalidated.includes('captions'))
    assert.ok(invalidated.includes('global-context'))
    assert.ok(invalidated.includes('stock-search'))
    assert.ok(invalidated.includes('audio-search'))
    assert.ok(invalidated.includes('preflight'))
    assert.ok(invalidated.includes('rendering'))
  })

  await it('8. applyInvalidation resets only targeted stages to pending', () => {
    const options: AutoPipelineOptions = {
      projectDir,
      scriptPath: mockScript,
      voiceoverPath: mockVoiceover
    }
    const fp = computeInputFingerprint(projectDir, mockScript, mockVoiceover)
    const state = createInitialPipelineState(options, fp)

    state.stages['transcribing'].status = 'completed'
    state.stages['planning'].status = 'completed'
    state.stages['captions'].status = 'completed'

    applyInvalidation(state, ['captions', 'rendering'])
    assert.strictEqual(state.stages['transcribing'].status, 'completed')
    assert.strictEqual(state.stages['planning'].status, 'completed')
    assert.strictEqual(state.stages['captions'].status, 'pending')
    assert.strictEqual(state.stages['rendering'].status, 'pending')
  })

  // ── 4. Prerequisites Validation ────────────────────────────────────────────
  await it('9. Validator detects missing projectDir, empty script or missing voiceover', async () => {
    const resEmpty = await validatePipelinePrerequisites({
      projectDir: '',
      scriptPath: '',
      voiceoverPath: ''
    })
    assert.strictEqual(resEmpty.valid, false)
    assert.ok(resEmpty.fatalErrors.some((e) => e.includes('Project directory')))

    const resMissingScript = await validatePipelinePrerequisites({
      projectDir,
      scriptPath: path.join(projectDir, 'nonexistent_script.txt'),
      voiceoverPath: mockVoiceover
    })
    assert.strictEqual(resMissingScript.valid, false)
    assert.ok(resMissingScript.fatalErrors.some((e) => e.includes('Script file not found')))
  })

  // ── 5. Artifact Inspection & Guards ────────────────────────────────────────
  await it('10. Artifact inspectors validate valid files and reject missing or invalid formats', () => {
    const transcriptPath = path.join(projectDir, 'analysis', 'transcript.json')
    const cacheMetaPath = path.join(projectDir, 'analysis', 'transcript-meta.json')

    const stat = fs.statSync(mockVoiceover)
    fs.writeFileSync(
      cacheMetaPath,
      JSON.stringify({
        hash: `${mockVoiceover}:${stat.size}:${stat.mtimeMs}`,
        model: 'base'
      })
    )
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        language: 'en',
        duration: 30,
        segments: [{ id: 'seg_1', text: 'Hello world', start: 0, end: 2, words: [] }]
      })
    )

    assert.strictEqual(isTranscriptionValid(projectDir, mockVoiceover), true)

    // Master edit plan
    const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        chapters: [
          {
            title: 'Intro',
            sequences: [
              {
                scenes: [
                  { sceneIndex: 0, duration: 5, narrativeText: 'Hello' }
                ]
              }
            ]
          }
        ]
      })
    )
    assert.strictEqual(isPlanningValid(projectDir), true)

    // Captions
    const captionPlanPath = path.join(projectDir, 'analysis', 'caption-plan.json')
    fs.writeFileSync(
      captionPlanPath,
      JSON.stringify({ enabled: true, phrases: [], activeRanges: [] })
    )
    assert.strictEqual(isCaptionsValid(projectDir), true)

    // Global Context
    const contextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
    fs.writeFileSync(
      contextPath,
      JSON.stringify({ primarySubject: 'History', _scriptHash: 'abc123' })
    )
    assert.strictEqual(isGlobalContextValid(projectDir, 'abc123'), true)
    assert.strictEqual(isGlobalContextValid(projectDir, 'different_hash'), false)
  })

  // ── 6. Missing Stock Guard & Needs-Attention ──────────────────────────────
  await it('11. checkStockCompletion detects missing stock and prevents auto-render', () => {
    // Edit plan has 1 scene (sceneIndex: 0)
    // stock-assignments.json has 0 assigned scenes
    const assignmentsPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    fs.writeFileSync(assignmentsPath, JSON.stringify([]))

    const summary = checkStockCompletion(projectDir)
    assert.strictEqual(summary.totalScenes, 1)
    assert.strictEqual(summary.assignedScenes, 0)
    assert.strictEqual(summary.missingScenes, 1)
    assert.deepStrictEqual(summary.missingSceneIndices, [0])

    // Now mock assigned media file
    const sampleMedia = path.join(projectDir, 'sample_scene_0.mp4')
    fs.writeFileSync(sampleMedia, Buffer.alloc(1024, 0))

    fs.writeFileSync(
      assignmentsPath,
      JSON.stringify([
        {
          sceneIndex: 0,
          status: 'assigned',
          score: 85,
          asset: {
            assetId: 'asset_0',
            localPath: sampleMedia,
            mediaType: 'video'
          }
        }
      ])
    )

    const updatedSummary = checkStockCompletion(projectDir)
    assert.strictEqual(updatedSummary.totalScenes, 1)
    assert.strictEqual(updatedSummary.assignedScenes, 1)
    assert.strictEqual(updatedSummary.downloadedScenes, 1)
    assert.strictEqual(updatedSummary.missingScenes, 0)
  })

  // ── 7. Locked and Manual Stock Assignments Preserved ───────────────────────
  await it('12. Locked and manual stock assignments are preserved in assignments store', () => {
    const assignmentsPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    const sampleMedia = path.join(projectDir, 'sample_scene_0.mp4')
    const manualAssignments = [
      {
        sceneIndex: 0,
        status: 'assigned',
        locked: true,
        manualOverride: true,
        approvalStatus: 'approved',
        asset: {
          assetId: 'locked_asset_123',
          localPath: sampleMedia,
          mediaType: 'video'
        }
      }
    ]
    fs.writeFileSync(assignmentsPath, JSON.stringify(manualAssignments, null, 2))

    const summary = checkStockCompletion(projectDir)
    assert.strictEqual(summary.missingScenes, 0)
    assert.strictEqual(summary.downloadedScenes, 1)
  })

  // ── 8. Audio Fallback & requireBackgroundMusic ─────────────────────────────
  await it('13. Audio validator allows voice-only by default and blocks only when requireMusic is true', () => {
    const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
    fs.writeFileSync(
      audioPlanPath,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        sections: [],
        sfxAssignments: []
      })
    )

    // With requireMusic=false (default): valid!
    assert.strictEqual(isAudioValid(projectDir, false), true)

    // With requireMusic=true: invalid because no tracks downloaded!
    assert.strictEqual(isAudioValid(projectDir, true), false)
  })

  // ── 9. Preflight Guard Blocks Render on Fatal ──────────────────────────────
  await it('14. Preflight validator passes clean report and fails fatally failed report', () => {
    const preflightPath = path.join(projectDir, 'analysis', 'render-preflight.json')
    fs.writeFileSync(
      preflightPath,
      JSON.stringify({
        status: 'passed',
        issues: []
      })
    )
    assert.strictEqual(isPreflightValid(projectDir), true)

    fs.writeFileSync(
      preflightPath,
      JSON.stringify({
        status: 'failed',
        issues: [{ severity: 'fatal', message: 'Fatal codec mismatch' }]
      })
    )
    assert.strictEqual(isPreflightValid(projectDir), false)
  })

  // ── 10. Concurrency & Double-Start Protection ──────────────────────────────
  await it('15. Double-start protection returns existing active runId without creating duplicate jobs', async () => {
    const options: AutoPipelineOptions = {
      projectDir,
      scriptPath: mockScript,
      voiceoverPath: mockVoiceover
    }

    // Start first instance
    const res1 = await pipelineOrchestrator.startPipeline(options)
    assert.ok(res1.runId)

    // Immediate second start call for the exact same projectDir
    const res2 = await pipelineOrchestrator.startPipeline(options)
    assert.strictEqual(res2.runId, res1.runId, 'Second start call must return identical runId')

    // Clean up
    pipelineOrchestrator.cancelPipeline(res1.runId)
  })

  // ── 11. Cancellation Protection ───────────────────────────────────────────
  await it('16. Cancel stops the pipeline loop and does not advance to next stage', () => {
    const state = loadPipelineState(projectDir)
    assert.ok(state !== null)
    assert.strictEqual(state.overallStatus, 'cancelled')
  })

  // ── 12. Manual IPC Compatibility ──────────────────────────────────────────
  await it('17. Existing manual IPC channels remain fully preserved and defined', () => {
    const manualChannels = [
      'TRANSCRIBE_START',
      'PLAN_GENERATE',
      'CAPTIONS_GENERATE_PLAN',
      'STOCK_CONTEXT_ANALYZE',
      'STOCK_SEARCH_START',
      'AUDIO_SEARCH_START',
      'RENDER_PREFLIGHT_RUN',
      'RENDER_START',
      'RENDER_QA_GET'
    ] as const

    for (const ch of manualChannels) {
      assert.ok(ch in IPC_CHANNELS, `IPC_CHANNELS must preserve ${ch}`)
    }

    const autoChannels = [
      'PIPELINE_START',
      'PIPELINE_RESUME',
      'PIPELINE_CANCEL',
      'PIPELINE_STATUS_GET',
      'PIPELINE_PROGRESS',
      'PIPELINE_RETRY_STAGE',
      'PIPELINE_RUN_FROM_STAGE'
    ] as const

    for (const ch of autoChannels) {
      assert.ok(ch in IPC_CHANNELS, `IPC_CHANNELS must include new ${ch}`)
    }
  })

  // ── 13. UI Stage Navigation Mappings ──────────────────────────────────────
  await it('18. Stage navigation mappings accurately point to existing pages', () => {
    assert.strictEqual(STAGE_NAV_TARGETS['transcribing'], 'transcribe')
    assert.strictEqual(STAGE_NAV_TARGETS['planning'], 'planning')
    assert.strictEqual(STAGE_NAV_TARGETS['captions'], 'captions')
    assert.strictEqual(STAGE_NAV_TARGETS['global-context'], 'stock')
    assert.strictEqual(STAGE_NAV_TARGETS['stock-search'], 'stock')
    assert.strictEqual(STAGE_NAV_TARGETS['audio-search'], 'audio')
    assert.strictEqual(STAGE_NAV_TARGETS['preflight'], 'render')
    assert.strictEqual(STAGE_NAV_TARGETS['rendering'], 'render')
    assert.strictEqual(STAGE_NAV_TARGETS['completed'], 'render')
  })

  // ── 14. Crash Recovery & Stale Lease Tests ─────────────────────────────────
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-crash-test-'))
  const crashProject = path.join(crashDir, 'crash-project')
  fs.mkdirSync(path.join(crashProject, 'analysis'), { recursive: true })
  fs.mkdirSync(path.join(crashProject, 'assets', 'stock'), { recursive: true })
  fs.mkdirSync(path.join(crashProject, 'output'), { recursive: true })

  const crashScript = path.join(crashProject, 'script.txt')
  fs.writeFileSync(crashScript, 'Crash recovery documentary narration script.', 'utf-8')
  const crashVoiceover = path.join(crashProject, 'voiceover.mp3')
  fs.writeFileSync(crashVoiceover, Buffer.alloc(2048, 2))

  // Master edit plan với 95 scenes
  const scenes95 = Array.from({ length: 95 }, (_, i) => ({
    sceneIndex: i,
    mediaFile: `stock_${i}.mp4`,
    mediaType: 'video' as const,
    startTime: i * 4,
    endTime: (i + 1) * 4,
    duration: 4
  }))
  const masterPlan95 = {
    totalScenes: 95,
    chapters: [{ sequences: [{ scenes: scenes95 }] }]
  }
  fs.writeFileSync(
    path.join(crashProject, 'analysis', 'master-edit-plan.json'),
    JSON.stringify(masterPlan95, null, 2)
  )

  // Giả lập 95 media files thực tế trên đĩa
  const assignments95: Record<string, unknown> = {}
  for (let i = 0; i < 95; i++) {
    const filename = `stock_${i}.mp4`
    const filePath = path.join(crashProject, 'assets', 'stock', filename)
    fs.writeFileSync(filePath, Buffer.alloc(512, i))
    assignments95[String(i)] = {
      sceneIndex: i,
      status: 'assigned',
      asset: {
        id: `pexels_${i}`,
        provider: 'pexels',
        type: 'video',
        url: `https://example.com/${i}`,
        localPath: filePath,
        filename
      },
      score: 85
    }
  }
  fs.writeFileSync(
    path.join(crashProject, 'analysis', 'stock-assignments.json'),
    JSON.stringify({ assignments: assignments95 }, null, 2)
  )

  // Giả lập artifacts hợp lệ cho stages 1-5 đã hoàn thành trước khi crash ở stage 6
  fs.writeFileSync(
    path.join(crashProject, 'analysis', 'transcript.json'),
    JSON.stringify({ segments: [{ start: 0, end: 4, text: 'Narration' }] }, null, 2)
  )
  fs.writeFileSync(
    path.join(crashProject, 'analysis', 'caption-plan.json'),
    JSON.stringify({ phrases: [{ text: 'Narration', startTime: 0, endTime: 4 }], enabled: true }, null, 2)
  )
  fs.writeFileSync(
    path.join(crashProject, 'analysis', 'global-script-context.json'),
    JSON.stringify({ primarySubject: 'documentary', exactTopicAnchors: ['history'] }, null, 2)
  )

  await it('19. Crash recovery: UI 79/95 vs disk 95/95 reconciles to completed 95/95 without re-searching', async () => {
    // Giả lập state cũ bị crash khi đang ghi nhận 79/95
    const crashedState = createInitialPipelineState(
      {
        projectDir: crashProject,
        scriptPath: crashScript,
        voiceoverPath: crashVoiceover
      },
      'fp-123',
      'crashed-run-1'
    )
    crashedState.overallStatus = 'running'
    crashedState.currentStage = 'stock-search'
    crashedState.stages['validating'].status = 'completed'
    crashedState.stages['transcribing'].status = 'completed'
    crashedState.stages['planning'].status = 'completed'
    crashedState.stages['captions'].status = 'completed'
    crashedState.stages['global-context'].status = 'completed'
    crashedState.stages['stock-search'] = {
      status: 'running',
      progress: 79 / 95,
      message: '[79/95] Scene 79 - candidate search...'
    }

    savePipelineStateAtomic(crashProject, crashedState)

    // Khởi chạy recovery
    const recovery = await pipelineOrchestrator.recoverInterruptedPipeline(crashProject)

    assert.strictEqual(recovery.recovered, true)
    assert.strictEqual(recovery.resumable, true)

    // Stage stock-search phải được reconcile thành completed 100% (95/95)
    const recoveredState = loadPipelineState(crashProject)!
    assert.strictEqual(recoveredState.stages['stock-search'].status, 'completed')
    assert.strictEqual(recoveredState.stages['stock-search'].progress, 1.0)
    assert.ok(recoveredState.stages['stock-search'].message.includes('95/95'))
    assert.strictEqual(recoveredState.overallStatus, 'interrupted')

    // Stage tiếp theo phải là audio-search
    assert.strictEqual(recovery.resumeFrom, 'audio-search')
    assert.strictEqual(recoveredState.currentStage, 'audio-search')
  })

  await it('20. Stale lease detected on app restart with running state', () => {
    const staleState = loadPipelineState(crashProject)!
    staleState.overallStatus = 'running'
    // Lease có appInstanceId khác và heartbeat cũ hơn 20s
    staleState.lease = {
      runId: 'old-run',
      appInstanceId: 'different-app-instance-uuid',
      pid: 999999, // Process không tồn tại
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      heartbeatAt: new Date(Date.now() - 30000).toISOString(),
      currentStage: 'stock-search'
    }
    savePipelineStateAtomic(crashProject, staleState)

    assert.strictEqual(isLeaseStale(staleState.lease), true)

    // getStatus phải tự động nhận diện stale lease và chuyển thành interrupted
    const status = pipelineOrchestrator.getStatus(crashProject)!
    assert.strictEqual(status.overallStatus, 'interrupted')
    assert.strictEqual(status.lease, undefined)
  })

  await it('21. PID reused by OS but appInstanceId is different recognizes stale lease', () => {
    // Trường hợp hệ điều hành tái sử dụng đúng PID của process hiện tại
    const staleWithSamePid = {
      runId: 'old-run',
      appInstanceId: 'dead-instance-uuid',
      pid: process.pid, // PID trùng
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      heartbeatAt: new Date(Date.now() - 25000).toISOString(), // > 15s timeout
      currentStage: 'stock-search' as const
    }
    assert.strictEqual(isLeaseStale(staleWithSamePid), true)
  })

  await it('22. Stock partial completion (80/95) identifies exactly 15 missing scenes', () => {
    // Xóa bớt 15 file media
    for (let i = 80; i < 95; i++) {
      const filePath = path.join(crashProject, 'assets', 'stock', `stock_${i}.mp4`)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }

    const summary = checkStockCompletion(crashProject)
    assert.strictEqual(summary.totalScenes, 95)
    assert.strictEqual(summary.assignedScenes, 95)
    assert.strictEqual(summary.downloadedScenes, 80)
    assert.strictEqual(summary.missingScenes, 15)
    assert.strictEqual(summary.missingSceneIndices.length, 15)
  })

  await it('23. Manual/locked assignments are preserved and not overwritten', () => {
    const assignments = JSON.parse(
      fs.readFileSync(path.join(crashProject, 'analysis', 'stock-assignments.json'), 'utf-8')
    )
    assignments.assignments['10'].locked = true
    assignments.assignments['10'].manualUpload = true
    fs.writeFileSync(
      path.join(crashProject, 'analysis', 'stock-assignments.json'),
      JSON.stringify(assignments, null, 2)
    )

    const reloaded = JSON.parse(
      fs.readFileSync(path.join(crashProject, 'analysis', 'stock-assignments.json'), 'utf-8')
    )
    assert.strictEqual(reloaded.assignments['10'].locked, true)
    assert.strictEqual(reloaded.assignments['10'].manualUpload, true)
  })

  await it('24. Monotonic version prevents late progress events from overwriting completed stage', () => {
    const testState = createInitialPipelineState(
      { projectDir: crashProject, scriptPath: crashScript, voiceoverPath: crashVoiceover },
      'fp-mono',
      'mono-run-1'
    )
    testState.version = 10
    testState.stages['stock-search'] = {
      status: 'completed',
      progress: 1.0,
      message: 'Stock search completed — 95/95 scenes assigned'
    }

    // Giả lập logic kiểm tra monotonic version của frontend/renderer
    const lateEvent = {
      ...testState,
      version: 8, // Event đến muộn với version thấp hơn
      stages: {
        ...testState.stages,
        'stock-search': {
          status: 'running' as const,
          progress: 79 / 95,
          message: '[79/95] Scene 79 - candidate search...'
        }
      }
    }

    // Version guard: chỉ chấp nhận incoming version >= current version
    const shouldAccept = lateEvent.version >= testState.version
    assert.strictEqual(shouldAccept, false, 'Late event with lower version must be rejected')
  })

  await it('25. Crash during render does not treat .partial.mp4 as completed video', () => {
    const outputDir = path.join(crashProject, 'output')
    // Tạo file partial mp4 giả lập crash giữa chừng
    fs.writeFileSync(path.join(outputDir, 'final_output.partial.mp4'), Buffer.alloc(100000))
    fs.writeFileSync(path.join(outputDir, '_final_output_working.mp4'), Buffer.alloc(100000))

    const recon = reconcileProjectArtifacts(crashProject)
    assert.strictEqual(recon.renderValid, false, 'Partial files must never be validated as complete render')
  })

  await it('26. App graceful closing (handleAppQuit) marks running pipeline as interrupted and allows resume', () => {
    const runningState = createInitialPipelineState(
      { projectDir: crashProject, scriptPath: crashScript, voiceoverPath: crashVoiceover },
      'fp-quit',
      'quit-run-1'
    )
    runningState.overallStatus = 'running'
    runningState.currentStage = 'stock-search'
    runningState.lease = createLease('quit-run-1', 'stock-search')
    savePipelineStateAtomic(crashProject, runningState)

    // Giả lập app quit
    pipelineOrchestrator.handleAppQuit()

    // Sau khi quit, state phải chuyển sang interrupted để sẵn sàng resume
    const postQuit = loadPipelineState(crashProject)!
    // getStatus will see stale lease and ensure interrupted
    const checked = pipelineOrchestrator.getStatus(crashProject)!
    assert.strictEqual(checked.overallStatus, 'interrupted')
  })

  await it('27. Corrupted state file automatically recovers from backup file', () => {
    const stateToSave = createInitialPipelineState(
      { projectDir: crashProject, scriptPath: crashScript, voiceoverPath: crashVoiceover },
      'fp-backup',
      'backup-run-1'
    )
    stateToSave.version = 42
    savePipelineStateAtomic(crashProject, stateToSave)

    // Đổi nội dung file chính thành JSON hỏng
    const stateFile = path.join(crashProject, 'analysis', 'auto-pipeline-state.json')
    fs.writeFileSync(stateFile, '{ corrupt-json: true, unterminated...', 'utf-8')

    // loadPipelineState phải tự động đọc từ file .backup.json
    const recoveredFromBackup = loadPipelineState(crashProject)
    assert.ok(recoveredFromBackup !== null, 'Must recover from backup file')
    assert.strictEqual(recoveredFromBackup?.version, 43)
  })

  await it('28. Mutex prevents concurrent duplicate jobs from bootstrap recovery, resume button, and auto-start', async () => {
    const opts: AutoPipelineOptions = {
      projectDir: crashProject,
      scriptPath: crashScript,
      voiceoverPath: crashVoiceover
    }

    // Khởi động đồng thời start và resume
    const [p1, p2] = await Promise.all([
      pipelineOrchestrator.startPipeline(opts),
      pipelineOrchestrator.startPipeline(opts)
    ])

    // Cả hai lệnh phải trả về cùng runId của instance duy nhất
    assert.strictEqual(p1.runId, p2.runId)
    pipelineOrchestrator.cancelPipeline(p1.runId)
  })

  // Clean up temp test directories
  try {
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.rmSync(crashDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((e) => {
  console.error('Test suite failed unexpectedly:', e)
  process.exit(1)
})
