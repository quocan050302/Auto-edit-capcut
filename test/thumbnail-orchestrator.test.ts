import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ThumbnailOrchestrator, ReadinessChecker } from '../src/main/thumbnail/thumbnail-orchestrator'
import { GoogleFlowProvider } from '../src/main/thumbnail/providers/google-flow-provider'
import { GoogleFlowClient } from '../src/main/thumbnail/google-flow-client'
import {
  saveProjectThumbnailSettings
} from '../src/main/thumbnail/thumbnail-settings-manager'
import {
  loadThumbnailJobState,
  saveThumbnailJobStateAtomic
} from '../src/main/thumbnail/thumbnail-state'
import type {
  ThumbnailGenerateRequest,
  ThumbnailGenerateResult,
  ThumbnailExportRequest,
  ThumbnailExportResult
} from '../src/main/thumbnail/providers/thumbnail-provider'
import type { ThumbnailJobState } from '../shared/types'

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING THUMBNAIL ORCHESTRATOR UNIT TESTS')
  console.log('==================================================\n')

  let passed = 0
  let failed = 0

  function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      const res = fn()
      if (res instanceof Promise) {
        return res
          .then(() => {
            console.log(`  ✓ ${name}`)
            passed++
          })
          .catch((err) => {
            console.error(`  ✗ ${name}`)
            console.error(err)
            failed++
          })
      } else {
        console.log(`  ✓ ${name}`)
        passed++
        return Promise.resolve()
      }
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(err)
      failed++
      return Promise.resolve()
    }
  }

  // 1x1 valid PNG buffer for exports with 3840x2160 dimension header
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x08, 0x70, // 3840 x 2160
    0x08, 0x02, 0x00, 0x00, 0x00
  ])

  function createTestEnvironment(prefix: string) {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const scriptPath = path.join(testDir, 'script.txt')
    fs.writeFileSync(scriptPath, 'Emergency supplies you need right now in grocery stores.')
    const renderOutputPath = path.join(testDir, 'output', 'final_video.mp4')
    fs.mkdirSync(path.dirname(renderOutputPath), { recursive: true })
    fs.writeFileSync(renderOutputPath, 'mock video binary')
    return { testDir, scriptPath, renderOutputPath }
  }

  /** Mock ReadinessChecker — always reports bridge ready. Tests validate orchestration logic, not bridge. */
  const alwaysReadyChecker: ReadinessChecker = {
    async ensureFlowReady() {
      return {
        ready: true,
        bridgeReachable: true,
        extensionConnected: true,
        flowConnected: true,
        flowProjectIdPresent: true,
        imageGenerationReady: true,
        export4kStatus: 'available' as const,
        message: 'Mock: all systems go'
      }
    },
    async isBridgeStillReachable() {
      return true
    },
    getSettings() {
      return { bridgeUrl: 'http://mock:8100' }
    }
  }

  await test('1. Generates strictly 5 candidates sequentially without concurrent Flow requests', async () => {
    const { testDir, renderOutputPath } = createTestEnvironment('orch-test-1-')
    await saveProjectThumbnailSettings(testDir, {
      enabled: true,
      autoGenerateAfterRender: true,
      selectedTemplateId: 'test-template',
      templateSnapshot: 'Prompt with {{SCRIPT}} and {{VARIANT_COUNT}}',
      templateSnapshotHash: 'mock-hash-1',
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    let concurrentRequests = 0
    let maxConcurrentSeen = 0
    const generatedOptions: string[] = []

    class MockFlowProvider1 extends GoogleFlowProvider {
      constructor() {
        super(new GoogleFlowClient('http://mock:8100'))
      }
      async generateImage(req: ThumbnailGenerateRequest): Promise<ThumbnailGenerateResult> {
        concurrentRequests++
        if (concurrentRequests > maxConcurrentSeen) maxConcurrentSeen = concurrentRequests
        generatedOptions.push(req.optionId)
        await new Promise((r) => setTimeout(r, 20))
        concurrentRequests--
        return {
          mediaId: `media-${req.optionId}`,
          projectId: 'mock-flow-proj',
          fifeUrl: 'https://mock.url/image.jpg'
        }
      }
      async exportImage(req: ThumbnailExportRequest): Promise<ThumbnailExportResult> {
        fs.mkdirSync(path.dirname(req.destinationPath), { recursive: true })
        fs.writeFileSync(req.destinationPath, pngHeader)
        return {
          filePath: req.destinationPath,
          width: 3840,
          height: 2160,
          actualQuality: 'native-4k'
        }
      }
    }

    const orchestrator = new ThumbnailOrchestrator(new MockFlowProvider1(), alwaysReadyChecker)
    orchestrator.setCooldownMs(5)

    const prebakedState: ThumbnailJobState = {
      schemaVersion: 1,
      version: 1,
      jobId: 'job-round-1',
      jobKey: 'orch-test-key-1',
      projectDir: testDir,
      renderOutputPath,
      status: 'generating',
      generationRound: 1,
      scriptHash: 'hash-s',
      templateSnapshotHash: 'hash-t',
      candidates: ['A', 'B', 'C', 'D', 'E'].map((id) => ({
        id: `cand-${id}-1`,
        optionId: id as any,
        round: 1,
        revision: 1,
        conceptName: `Concept ${id}`,
        yellowText: 'YELLOW',
        whiteText: 'WHITE',
        imagePrompt: `Prompt for ${id}`,
        titleClear: 'Clear Title',
        titleCuriosity: 'Curious Title',
        status: 'pending',
        attempts: 0
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
      errors: []
    }
    saveThumbnailJobStateAtomic(testDir, prebakedState)

    const result = await orchestrator.startJob({
      projectDir: testDir,
      renderOutputPath,
      generationRound: 1,
      cooldownMs: 5
    })

    assert.strictEqual(result.status, 'completed')
    assert.strictEqual(result.candidates.length, 5)
    assert.strictEqual(maxConcurrentSeen, 1, 'Never send parallel Flow requests')
    assert.deepStrictEqual(generatedOptions, ['A', 'B', 'C', 'D', 'E'])

    for (const opt of ['A', 'B', 'C', 'D', 'E']) {
      const p = path.join(testDir, 'output', 'thumbnails', 'round-001', `thumbnail-${opt}-master.png`)
      assert.ok(fs.existsSync(p), `Thumbnail file for option ${opt} should exist`)
    }

    const manifestPath = path.join(testDir, 'output', 'thumbnails', 'round-001', 'manifest.json')
    assert.ok(fs.existsSync(manifestPath), 'Round manifest must exist')

    fs.rmSync(testDir, { recursive: true, force: true })
  })

  await test('2. Failure of one candidate does not cancel remaining candidates and saves error', async () => {
    const { testDir, renderOutputPath } = createTestEnvironment('orch-test-2-')
    await saveProjectThumbnailSettings(testDir, {
      enabled: true,
      autoGenerateAfterRender: true,
      selectedTemplateId: 'test-template',
      templateSnapshot: 'Prompt with {{SCRIPT}} and {{VARIANT_COUNT}}',
      templateSnapshotHash: 'mock-hash-1',
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    class MockFlowProviderFail extends GoogleFlowProvider {
      constructor() {
        super(new GoogleFlowClient('http://mock:8100'))
      }
      async generateImage(req: ThumbnailGenerateRequest): Promise<ThumbnailGenerateResult> {
        if (req.optionId === 'C') {
          throw new Error('Simulated generation failure for option C')
        }
        return {
          mediaId: `media-${req.optionId}`,
          projectId: 'mock-flow-proj',
          fifeUrl: 'https://mock.url/image.jpg'
        }
      }
      async exportImage(req: ThumbnailExportRequest): Promise<ThumbnailExportResult> {
        fs.mkdirSync(path.dirname(req.destinationPath), { recursive: true })
        fs.writeFileSync(req.destinationPath, pngHeader)
        return {
          filePath: req.destinationPath,
          width: 3840,
          height: 2160,
          actualQuality: 'native-4k'
        }
      }
    }

    const orchestrator = new ThumbnailOrchestrator(new MockFlowProviderFail(), alwaysReadyChecker)
    orchestrator.setCooldownMs(5)

    const failState: ThumbnailJobState = {
      schemaVersion: 1,
      version: 1,
      jobId: 'job-round-fail',
      jobKey: 'orch-test-fail',
      projectDir: testDir,
      renderOutputPath,
      status: 'generating',
      generationRound: 1,
      scriptHash: 'hash-s',
      templateSnapshotHash: 'hash-t',
      candidates: ['A', 'B', 'C', 'D', 'E'].map((id) => ({
        id: `cand-${id}-fail`,
        optionId: id as any,
        round: 1,
        revision: 1,
        conceptName: `Concept ${id}`,
        yellowText: 'YELLOW',
        whiteText: 'WHITE',
        imagePrompt: `Prompt for ${id}`,
        titleClear: 'Clear Title',
        titleCuriosity: 'Curious Title',
        status: 'pending',
        attempts: 0
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
      errors: []
    }
    saveThumbnailJobStateAtomic(testDir, failState)

    const result = await orchestrator.startJob({
      projectDir: testDir,
      renderOutputPath,
      generationRound: 1,
      cooldownMs: 5
    })

    assert.strictEqual(result.status, 'partial', 'Overall status should be partial when some failed')
    const candC = result.candidates.find((c) => c.optionId === 'C')
    assert.ok(candC && candC.status === 'failed')
    assert.ok(candC.error && candC.error.includes('Simulated generation failure'))

    const candD = result.candidates.find((c) => c.optionId === 'D')
    assert.ok(candD && candD.status === 'completed', 'Candidate D must still be processed and completed')

    fs.rmSync(testDir, { recursive: true, force: true })
  })

  await test('3. Resumes safely after crash without re-generating completed candidates', async () => {
    const { testDir, renderOutputPath } = createTestEnvironment('orch-test-3-')
    await saveProjectThumbnailSettings(testDir, {
      enabled: true,
      autoGenerateAfterRender: true,
      selectedTemplateId: 'test-template',
      templateSnapshot: 'Prompt with {{SCRIPT}} and {{VARIANT_COUNT}}',
      templateSnapshotHash: 'mock-hash-1',
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    // Pre-create artifacts for A and B only
    const round1Dir = path.join(testDir, 'output', 'thumbnails', 'round-001')
    fs.mkdirSync(round1Dir, { recursive: true })
    fs.writeFileSync(path.join(round1Dir, 'thumbnail-A-master.png'), pngHeader)
    fs.writeFileSync(path.join(round1Dir, 'thumbnail-B-master.png'), pngHeader)

    const generatedOptions: string[] = []

    class MockFlowProviderResume extends GoogleFlowProvider {
      constructor() {
        super(new GoogleFlowClient('http://mock:8100'))
      }
      async generateImage(req: ThumbnailGenerateRequest): Promise<ThumbnailGenerateResult> {
        generatedOptions.push(req.optionId)
        return {
          mediaId: `media-${req.optionId}`,
          projectId: 'mock-flow-proj',
          fifeUrl: 'https://mock.url/image.jpg'
        }
      }
      async exportImage(req: ThumbnailExportRequest): Promise<ThumbnailExportResult> {
        fs.mkdirSync(path.dirname(req.destinationPath), { recursive: true })
        fs.writeFileSync(req.destinationPath, pngHeader)
        return {
          filePath: req.destinationPath,
          width: 3840,
          height: 2160,
          actualQuality: 'native-4k'
        }
      }
    }

    const orchestrator = new ThumbnailOrchestrator(new MockFlowProviderResume(), alwaysReadyChecker)
    orchestrator.setCooldownMs(5)

    const crashedState: ThumbnailJobState = {
      schemaVersion: 1,
      version: 2,
      jobId: 'job-crashed',
      jobKey: 'orch-crash-test',
      projectDir: testDir,
      renderOutputPath,
      status: 'generating',
      generationRound: 1,
      scriptHash: 'hash-s',
      templateSnapshotHash: 'hash-t',
      candidates: [
        {
          id: 'cand-A',
          optionId: 'A',
          round: 1,
          revision: 1,
          conceptName: 'A',
          yellowText: 'Y',
          whiteText: 'W',
          imagePrompt: 'P',
          titleClear: 'C',
          titleCuriosity: 'Q',
          status: 'completed',
          exportedImagePath: path.join(round1Dir, 'thumbnail-A-master.png'),
          attempts: 1
        },
        {
          id: 'cand-B',
          optionId: 'B',
          round: 1,
          revision: 1,
          conceptName: 'B',
          yellowText: 'Y',
          whiteText: 'W',
          imagePrompt: 'P',
          titleClear: 'C',
          titleCuriosity: 'Q',
          status: 'completed',
          exportedImagePath: path.join(round1Dir, 'thumbnail-B-master.png'),
          attempts: 1
        },
        {
          id: 'cand-C',
          optionId: 'C',
          round: 1,
          revision: 1,
          conceptName: 'C',
          yellowText: 'Y',
          whiteText: 'W',
          imagePrompt: 'P',
          titleClear: 'C',
          titleCuriosity: 'Q',
          status: 'pending',
          attempts: 0
        },
        {
          id: 'cand-D',
          optionId: 'D',
          round: 1,
          revision: 1,
          conceptName: 'D',
          yellowText: 'Y',
          whiteText: 'W',
          imagePrompt: 'P',
          titleClear: 'C',
          titleCuriosity: 'Q',
          status: 'pending',
          attempts: 0
        },
        {
          id: 'cand-E',
          optionId: 'E',
          round: 1,
          revision: 1,
          conceptName: 'E',
          yellowText: 'Y',
          whiteText: 'W',
          imagePrompt: 'P',
          titleClear: 'C',
          titleCuriosity: 'Q',
          status: 'pending',
          attempts: 0
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
      errors: []
    }
    saveThumbnailJobStateAtomic(testDir, crashedState)

    const resumed = await orchestrator.resumeJob(testDir)

    assert.strictEqual(resumed.status, 'completed')
    // A and B were already completed on disk, only C, D, E should be generated!
    assert.deepStrictEqual(generatedOptions, ['C', 'D', 'E'], 'Resumed job only runs remaining pending candidates')

    fs.rmSync(testDir, { recursive: true, force: true })
  })

  await test('4. Selecting a candidate copies image to output/thumbnails/selected/ and writes metadata', () => {
    const { testDir, renderOutputPath } = createTestEnvironment('orch-test-4-')
    const round1Dir = path.join(testDir, 'output', 'thumbnails', 'round-001')
    fs.mkdirSync(round1Dir, { recursive: true })
    const imgA = path.join(round1Dir, 'thumbnail-A-master.png')
    fs.writeFileSync(imgA, pngHeader)

    const state: ThumbnailJobState = {
      schemaVersion: 1,
      version: 1,
      jobId: 'job-select',
      jobKey: 'select-test',
      projectDir: testDir,
      renderOutputPath,
      status: 'completed',
      generationRound: 1,
      scriptHash: 'hash-s',
      templateSnapshotHash: 'hash-t',
      candidates: [
        {
          id: 'cand-A',
          optionId: 'A',
          round: 1,
          revision: 1,
          conceptName: 'Concept A',
          yellowText: 'YELLOW',
          whiteText: 'WHITE',
          imagePrompt: 'Prompt A',
          titleClear: 'Clear Title',
          titleCuriosity: 'Curiosity Title',
          status: 'completed',
          exportedImagePath: imgA,
          actualWidth: 3840,
          actualHeight: 2160,
          exportQuality: 'native-4k',
          attempts: 1
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
      errors: []
    }
    saveThumbnailJobStateAtomic(testDir, state)

    const orchestrator = new ThumbnailOrchestrator()
    const selectRes = orchestrator.selectCandidate(testDir, 'cand-A')

    assert.strictEqual(selectRes.success, true)
    const selectedPng = path.join(testDir, 'output', 'thumbnails', 'selected', 'selected-thumbnail.png')
    const selectedJson = path.join(testDir, 'output', 'thumbnails', 'selected', 'selected-thumbnail.json')

    assert.ok(fs.existsSync(selectedPng), 'Selected thumbnail PNG must exist')
    assert.ok(fs.existsSync(selectedJson), 'Selected thumbnail metadata JSON must exist')

    const meta = JSON.parse(fs.readFileSync(selectedJson, 'utf-8'))
    assert.strictEqual(meta.selectedCandidateId, 'cand-A')
    assert.strictEqual(meta.optionId, 'A')
    assert.strictEqual(meta.exportQuality, 'native-4k')

    fs.rmSync(testDir, { recursive: true, force: true })
  })

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
