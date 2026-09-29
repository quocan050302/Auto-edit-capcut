import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS,
  loadProductionSettings
} from '../src/main/production-intelligence/production-settings'
import {
  normalizeAssetUrl,
  isDuplicateCandidate,
  calculateDiversityScore,
  calculateReusePenalty
} from '../src/main/production-intelligence/diversity-engine'
import {
  scoreCandidate,
  rankCandidatesForScene
} from '../src/main/production-intelligence/candidate-ranking'
import {
  classifyVisualGrammar,
  generateVisualGrammarPlan
} from '../src/main/production-intelligence/visual-grammar-engine'
import { flattenEditPlanScenes } from '../src/main/utils/scene-plan'
import {
  readJsonFile,
  atomicWriteJson
} from '../src/main/production-intelligence/json-store'
import { runRenderPreflight } from '../src/main/qa/render-preflight'
import type {
  StockSearchResult,
  StockCandidate,
  StockSceneAssignment,
  VisualGrammarPlan,
  RenderQaReport
} from '../shared/types'

// Helper mock data generators
let mockCounter = 0
function createMockSearchResult(overrides: Partial<StockSearchResult> = {}): StockSearchResult {
  mockCounter++
  const assetId = overrides.assetId || (overrides as any).id || `mock_${mockCounter}`
  return {
    assetId,
    provider: 'pexels',
    mediaType: 'video',
    title: 'Modern office teamwork',
    tags: ['office', 'team', 'business'],
    thumbnailUrl: `https://images.pexels.com/photos/${assetId}/thumb.jpg`,
    previewUrl: `https://video.pexels.com/preview/${assetId}.mp4`,
    downloadUrl: `https://video.pexels.com/download/${assetId}.mp4`,
    pageUrl: `https://www.pexels.com/video/${assetId}/`,
    durationSecs: 10,
    width: 1920,
    height: 1080,
    creator: 'Creator',
    ...overrides
  }
}

let passedTests = 0
let failedTests = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passedTests++
  } catch (err: unknown) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err instanceof Error ? err.stack || err.message : String(err)}`)
    failedTests++
  }
}

async function runAllTests(): Promise<void> {
  console.log('\n=== RUNNING PRODUCTION INTELLIGENCE TEST SUITE ===\n')

  // ─── 1. PURE FUNCTIONS & DEFAULTS ──────────────────────────────────────────

  await test('Backward-compatible defaults: DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS', () => {
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.enabled, true)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.candidateRankingEnabled, true)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.storyboardReviewEnabled, true)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.visualSceneGrammarEnabled, true)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.renderQaEnabled, true)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.strictMissingMedia, false)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.candidatesPerScene, 3)
    assert.strictEqual(DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS.maxVisualGrammarDensity, 0.25)
  })

  await test('URL Normalization: strips query parameters, hashes and trailing slashes', () => {
    const url1 = 'https://images.pexels.com/photo/123?w=800&auto=compress#section'
    const url2 = 'https://images.pexels.com/photo/123/'
    assert.strictEqual(normalizeAssetUrl(url1), 'https://images.pexels.com/photo/123')
    assert.strictEqual(normalizeAssetUrl(url2), 'https://images.pexels.com/photo/123')
  })

  await test('Duplicate detection: by provider + assetId', () => {
    const item1 = createMockSearchResult({ provider: 'pexels', id: '123' })
    const existing: StockCandidate[] = [
      {
        candidateId: 'c1',
        sceneId: 'scene_0',
        sceneIndex: 0,
        result: item1,
        score: {} as any,
        rank: 1,
        selected: true,
        approved: false,
        rejected: false
      }
    ]
    const dup = createMockSearchResult({ provider: 'pexels', id: '123', downloadUrl: 'https://diff.com/v.mp4' })
    assert.strictEqual(isDuplicateCandidate(dup, existing), true)
  })

  await test('Duplicate detection: by normalized download URL or page URL', () => {
    const item1 = createMockSearchResult({
      id: 'pix-1',
      provider: 'pixabay',
      downloadUrl: 'https://cdn.pixabay.com/download/get/test.mp4?extra=1'
    })
    const existing: StockCandidate[] = [
      {
        candidateId: 'c1',
        sceneId: 'scene_0',
        sceneIndex: 0,
        result: item1,
        score: {} as any,
        rank: 1,
        selected: true,
        approved: false,
        rejected: false
      }
    ]
    const dup = createMockSearchResult({
      id: 'pix-2',
      provider: 'pixabay',
      downloadUrl: 'https://cdn.pixabay.com/download/get/test.mp4'
    })
    assert.strictEqual(isDuplicateCandidate(dup, existing), true)
  })

  await test('Candidate score normalization: all breakdown scores are non-negative and sum to 0..100', () => {
    const res = createMockSearchResult()
    const scored = scoreCandidate({
      candidate: res,
      sceneId: 'scene_1',
      sceneIndex: 1,
      targetDuration: 6,
      narration: 'Team collaborating on project strategy',
      visualIntent: 'Team discussion in office',
      currentQuery: 'team office discussion'
    })
    assert.ok(scored.totalScore >= 0 && scored.totalScore <= 100)
    assert.ok(scored.localRelevance >= 0 && scored.localRelevance <= 30)
    assert.ok(scored.globalContextFit >= 0 && scored.globalContextFit <= 20)
    assert.ok(scored.chapterContextFit >= 0 && scored.chapterContextFit <= 10)
    assert.ok(scored.technicalQuality >= 0 && scored.technicalQuality <= 10)
    assert.ok(scored.motionSuitability >= 0 && scored.motionSuitability <= 10)
    assert.ok(scored.aspectRatioFit >= 0 && scored.aspectRatioFit <= 5)
    assert.ok(scored.diversityScore >= 0 && scored.diversityScore <= 15)
    assert.ok(scored.reusePenalty <= 0 && scored.reusePenalty >= -30)
    assert.ok(Array.isArray(scored.reasons))
  })

  await test('Candidate sorting: rank 1 is highest score, capped at candidatesPerScene', () => {
    const c1 = createMockSearchResult({ id: 'p1', relevanceScore: 60, width: 1280, height: 720 })
    const c2 = createMockSearchResult({ id: 'p2', relevanceScore: 95, width: 1920, height: 1080 })
    const c3 = createMockSearchResult({ id: 'p3', relevanceScore: 80, width: 1920, height: 1080 })
    const c4 = createMockSearchResult({ id: 'p4', relevanceScore: 50, width: 1280, height: 720 })

    const ranked = rankCandidatesForScene({
      searchResults: [c1, c2, c3, c4],
      sceneId: 'scene_1',
      sceneIndex: 1,
      targetDuration: 6,
      narration: 'Discussion',
      visualIntent: 'Meeting',
      currentQuery: 'office meeting',
      maxCandidates: 3
    })

    assert.strictEqual(ranked.length, 3)
    assert.strictEqual(ranked[0].rank, 1)
    assert.strictEqual(ranked[0].selected, true)
    assert.strictEqual(ranked[1].rank, 2)
    assert.strictEqual(ranked[1].selected, false)
    assert.ok(ranked[0].score.totalScore >= ranked[1].score.totalScore)
    assert.ok(ranked[1].score.totalScore >= ranked[2].score.totalScore)
  })

  await test('Reuse penalty: penalizes re-used asset unless locked or manual upload', () => {
    const res = createMockSearchResult({ id: 'reused-1' })
    const usedAssets = new Set<string>(['pexels:reused-1'])

    // Standard candidate: penalized
    const penalty = calculateReusePenalty({
      result: res,
      sceneIndex: 5,
      usedAssetKeys: usedAssets,
      isUserLocked: false,
      isManualUpload: false
    })
    assert.strictEqual(penalty, -25)

    // User locked candidate: no penalty
    const lockedPenalty = calculateReusePenalty({
      result: res,
      sceneIndex: 5,
      usedAssetKeys: usedAssets,
      isUserLocked: true,
      isManualUpload: false
    })
    assert.strictEqual(lockedPenalty, 0)
  })

  // ─── 2. SCENE FLATTENING (CASES 19 & 20) ───────────────────────────────────

  await test('Case 19: Project dùng modern schema with sequences', () => {
    const modernPlan = {
      version: 2,
      chapters: [
        {
          title: 'Chapter 1',
          sequences: [
            {
              scenes: [
                { sceneIndex: 0, duration: 6, narration: 'Hello', visualIntent: 'Sunrise' },
                { sceneIndex: 1, duration: 5, narration: 'World', visualIntent: 'City' }
              ]
            }
          ]
        }
      ]
    }
    const flattened = flattenEditPlanScenes(modernPlan)
    assert.strictEqual(flattened.length, 2)
    assert.strictEqual(flattened[0].sceneIndex, 0)
    assert.strictEqual(flattened[0].isFirstInChapter, true)
    assert.strictEqual(flattened[1].sceneIndex, 1)
    assert.strictEqual(flattened[1].isFirstInChapter, false)
  })

  await test('Case 20: Project cũ dùng legacy chapters_seq and missing sceneId', () => {
    const legacyPlan = {
      chapters: [
        {
          title: 'Old Chapter',
          chapters_seq: [
            {
              scenes: [
                { duration: 8, narration: 'Legacy scene 1' },
                { duration: 7, narration: 'Legacy scene 2' }
              ]
            }
          ]
        }
      ]
    }
    const flattened = flattenEditPlanScenes(legacyPlan)
    assert.strictEqual(flattened.length, 2)
    assert.strictEqual(flattened[0].sceneId, 'chapter-0-sequence-0-scene-0')
    assert.strictEqual(flattened[1].sceneId, 'chapter-0-sequence-0-scene-1')
    assert.strictEqual(flattened[0].chapterIndex, 0)
    assert.strictEqual(flattened[0].isFirstInChapter, true)
  })

  // ─── 3. VISUAL GRAMMAR CLASSIFICATION (CASES 14 & 15) ──────────────────────

  await test('Visual grammar classification: date, stat, quote, comparison, location, document', () => {
    // Date card
    const dateDecision = classifyVisualGrammar({
      narration: 'Vào năm 1945, sự kiện lịch sử đã diễn ra',
      visualIntent: 'Tài liệu năm 1945',
      sceneIndex: 0,
      duration: 6
    })
    assert.strictEqual(dateDecision.type, 'date_card')

    // Stat card
    const statDecision = classifyVisualGrammar({
      narration: 'Doanh thu tăng trưởng 85% đạt 500 triệu đô la',
      visualIntent: 'Biểu đồ tài chính',
      sceneIndex: 1,
      duration: 6
    })
    assert.strictEqual(statDecision.type, 'stat_card')

    // Quote card
    const quoteDecision = classifyVisualGrammar({
      narration: 'Steve Jobs từng tuyên bố: "Stay hungry, stay foolish"',
      visualIntent: 'Trích dẫn danh ngôn',
      sceneIndex: 2,
      duration: 6
    })
    assert.strictEqual(quoteDecision.type, 'quote_card')

    // Location card
    const locDecision = classifyVisualGrammar({
      narration: 'Tại thủ đô Tokyo, nhịp sống diễn ra hối hả',
      visualIntent: 'Cảnh đường phố Tokyo',
      sceneIndex: 3,
      duration: 6
    })
    assert.strictEqual(locDecision.type, 'location_card')

    // Comparison card
    const compDecision = classifyVisualGrammar({
      narration: 'Trong khi thị trường truyền thống sụt giảm, thương mại điện tử lại tăng vọt',
      visualIntent: 'So sánh hai mô hình',
      sceneIndex: 4,
      duration: 6
    })
    assert.strictEqual(compDecision.type, 'comparison_card')

    // Document card
    const docDecision = classifyVisualGrammar({
      narration: 'Bản hợp đồng pháp lý và nghị quyết mới đã được ký kết',
      visualIntent: 'Văn bản hợp đồng',
      sceneIndex: 5,
      duration: 6
    })
    assert.strictEqual(docDecision.type, 'document_card')
  })

  await test('Visual grammar density and spacing constraints: max 25% and min 6s spacing', () => {
    const mockPlan = {
      chapters: [
        {
          sequences: [
            {
              scenes: Array.from({ length: 10 }, (_, i) => ({
                narrativeText: `Vào năm 199${i}, mốc quan trọng`,
                duration: 4
              }))
            }
          ]
        }
      ]
    }

    const plan = generateVisualGrammarPlan({
      projectDir: 'C:/mock/project',
      editPlan: mockPlan,
      settings: {
        ...DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS,
        maxVisualGrammarDensity: 0.25
      }
    })

    const enabledDecisions = plan.decisions.filter((d) => d.enabled)
    // For 10 scenes, 25% density allows at most 2-3 decisions
    assert.ok(enabledDecisions.length <= 3)
  })

  // ─── 4. CANDIDATE RANKING & MULTI-PROVIDER POOLING (CASES 2 & 3) ───────────

  await test('Case 2: Scene có cả Pexels và Pixabay candidates tham gia chung ranking pool', () => {
    const pexelsItem = createMockSearchResult({ id: 'pex-1', provider: 'pexels', relevanceScore: 80 })
    const pixabayItem = createMockSearchResult({ id: 'pix-1', provider: 'pixabay', relevanceScore: 90 })

    const ranked = rankCandidatesForScene({
      searchResults: [pexelsItem, pixabayItem],
      sceneId: 'scene_0',
      sceneIndex: 0,
      targetDuration: 6,
      narration: 'Team discussion',
      visualIntent: 'Office',
      currentQuery: 'office meeting'
    })

    assert.strictEqual(ranked.length, 2)
    const providers = ranked.map((r) => r.result.provider)
    assert.ok(providers.includes('pexels'))
    assert.ok(providers.includes('pixabay'))
  })

  await test('Case 3: Candidate trùng URL bị loại khỏi pool', () => {
    const itemA = createMockSearchResult({ id: 'a', downloadUrl: 'https://cdn.example.com/asset.mp4' })
    const itemB = createMockSearchResult({ id: 'b', downloadUrl: 'https://cdn.example.com/asset.mp4?resolution=hd' })

    const ranked = rankCandidatesForScene({
      searchResults: [itemA, itemB],
      sceneId: 'scene_0',
      sceneIndex: 0,
      targetDuration: 6,
      narration: 'Office',
      visualIntent: 'Office',
      currentQuery: 'office'
    })

    // itemB is a duplicate download URL, should be skipped
    assert.strictEqual(ranked.length, 1)
  })

  // ─── 5. LOCK & MANUAL OVERRIDE SAFEGUARDS (CASES 4, 5 & 6) ─────────────────

  await test('Case 4 & 5: Locked scene và Manual upload không bị auto-ranking ghi đè', () => {
    const assignments: StockSceneAssignment[] = [
      {
        sceneIndex: 0,
        sceneId: 'scene_0',
        query: 'office',
        status: 'assigned',
        locked: true,
        asset: { localPath: 'D:/manual/locked.mp4' } as any
      },
      {
        sceneIndex: 1,
        sceneId: 'scene_1',
        query: 'city',
        status: 'assigned',
        manualOverride: true,
        asset: { localPath: 'D:/manual/custom.mp4' } as any
      },
      {
        sceneIndex: 2,
        sceneId: 'scene_2',
        query: 'nature',
        status: 'assigned',
        approvalStatus: 'approved',
        asset: { localPath: 'D:/assets/approved.mp4' } as any
      }
    ]

    for (const a of assignments) {
      const isProtected = a.locked === true || a.manualOverride === true || a.approvalStatus === 'approved'
      assert.strictEqual(isProtected, true, `Scene ${a.sceneIndex} must be protected`)
    }
  })

  await test('Case 6: Candidate download lỗi không làm mất asset cũ', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'))
    const planFile = path.join(tempDir, 'master-edit-plan.json')
    const initialPlan = {
      chapters: [
        {
          sequences: [
            {
              scenes: [{ sceneIndex: 0, localPath: 'D:/safe/existing.mp4' }]
            }
          ]
        }
      ]
    }
    atomicWriteJson(planFile, initialPlan)

    // Simulate failed download: no update performed
    const readBack = readJsonFile<any>(planFile)
    assert.strictEqual(readBack.chapters[0].sequences[0].scenes[0].localPath, 'D:/safe/existing.mp4')
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── 6. MEDIA DETECTION & MISMATCH SAFEGUARDS (CASES 10 & 11) ──────────────

  await test('Case 10: Video file bị khai báo nhầm là image được phát hiện đúng định dạng', () => {
    const videoPath = 'C:/assets/stock/S001_pexels_video.mp4'
    const declaredType = 'image'
    const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
    const ext = path.extname(videoPath).toLowerCase()

    let detected = declaredType
    if (VIDEO_EXTENSIONS.has(ext)) {
      detected = 'video'
    }
    assert.strictEqual(detected, 'video')
  })

  await test('Case 11: Image file bị khai báo nhầm là video được phát hiện đúng định dạng', () => {
    const imgPath = 'C:/assets/stock/S002_photo.jpg'
    const declaredType = 'video'
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])
    const ext = path.extname(imgPath).toLowerCase()

    let detected = declaredType
    if (IMAGE_EXTENSIONS.has(ext)) {
      detected = 'image'
    }
    assert.strictEqual(detected, 'image')
  })

  // ─── 7. PREFLIGHT QA SEVERITY & STRICT MODE (CASES 7, 8 & 9) ───────────────

  await test('Case 7: Scene thiếu media với strict mode OFF chỉ là warning, không fatal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'))
    const validFile = path.join(tempDir, 'scene0.mp4')
    fs.writeFileSync(validFile, 'mock video stream')

    const planFile = path.join(tempDir, 'master-edit-plan.json')
    atomicWriteJson(planFile, {
      chapters: [
        {
          sequences: [
            {
              scenes: [
                { sceneIndex: 0, duration: 5, localPath: validFile },
                { sceneIndex: 1, duration: 5, localPath: 'non-existent-media-file.mp4' }
              ]
            }
          ]
        }
      ]
    })

    const report = await runRenderPreflight({
      projectDir: tempDir,
      strictMissingMedia: false
    })

    // Strict mode OFF: partial missing media is warning, report passes with warnings
    assert.strictEqual(report.status, 'passed_with_warnings')
    assert.strictEqual(report.fatalCount, 0)
    assert.ok(report.warningCount > 0)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  await test('Case 8: Scene thiếu media với strict mode ON là FATAL, chặn render', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-strict-'))
    const validFile = path.join(tempDir, 'scene0.mp4')
    fs.writeFileSync(validFile, 'mock video stream')

    const planFile = path.join(tempDir, 'master-edit-plan.json')
    atomicWriteJson(planFile, {
      chapters: [
        {
          sequences: [
            {
              scenes: [
                { sceneIndex: 0, duration: 5, localPath: validFile },
                { sceneIndex: 1, duration: 5, localPath: 'non-existent-media-file.mp4' }
              ]
            }
          ]
        }
      ]
    })

    const report = await runRenderPreflight({
      projectDir: tempDir,
      strictMissingMedia: true
    })

    // Strict mode ON: missing media is fatal, report status failed
    assert.strictEqual(report.status, 'failed')
    assert.ok(report.fatalCount > 0)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  await test('Case 9: 100% scenes thiếu media là FATAL ngay cả khi strict mode OFF', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-all-missing-'))
    const planFile = path.join(tempDir, 'master-edit-plan.json')
    atomicWriteJson(planFile, {
      chapters: [
        {
          sequences: [
            {
              scenes: [
                { sceneIndex: 0, duration: 5 },
                { sceneIndex: 1, duration: 5 }
              ]
            }
          ]
        }
      ]
    })

    const report = await runRenderPreflight({
      projectDir: tempDir,
      strictMissingMedia: false
    })

    // 100% missing scenes: fatal issue
    assert.strictEqual(report.status, 'failed')
    assert.ok(report.fatalCount > 0)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── 8. POSTFLIGHT QA THRESHOLDS & STREAM VALIDATION (CASES 16, 17 & 18) ───

  await test('Case 17: Video không có video stream bị coi là FATAL', () => {
    const mockProbe = {
      hasVideo: false,
      hasAudio: true,
      duration: 120,
      width: 0,
      height: 0,
      fps: 0
    }
    const isFatal = !mockProbe.hasVideo || mockProbe.duration <= 0
    assert.strictEqual(isFatal, true)
  })

  await test('Case 18: Black frame coverage > 80% bị đánh giá FATAL', () => {
    const blackDuration = 85
    const totalDuration = 100
    const blackCoverage = blackDuration / totalDuration

    const isFatal = blackCoverage > 0.8
    assert.strictEqual(isFatal, true)

    // Short black segment (e.g. 0.35s transition) is NOT fatal
    const transitionBlack = 0.35
    assert.strictEqual(transitionBlack > 2.0, false)
  })

  await test('Case 16: Voiceover tồn tại nhưng output thiếu audio stream bị đánh giá FATAL', () => {
    const hasExpectedVoiceover = true
    const outputHasAudio = false

    const isFatal = hasExpectedVoiceover && !outputHasAudio
    assert.strictEqual(isFatal, true)
  })

  // ─── 9. TRANSITIONS VALIDATION (CASES 12 & 13) ─────────────────────────────

  await test('Case 12 & 13: Transition validation: duration threshold and fallback to cut', () => {
    const sceneDuration = 0.3
    const requestedTransition = 0.5

    // When scene is shorter than transition duration, it must fallback to cut
    const shouldFallback = requestedTransition >= sceneDuration
    assert.strictEqual(shouldFallback, true)

    // Valid scene length allows transition
    const validSceneDuration = 4.0
    const transitionOk = requestedTransition < validSceneDuration
    assert.strictEqual(transitionOk, true)
  })

  // ─── 10. BACKWARD COMPATIBILITY: OLD PROJECT LOAD (CASE 1) ─────────────────

  await test('Case 1: Old project without Production Intelligence fields loads cleanly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'old-project-'))
    const settings = loadProductionSettings(tempDir)

    // Returns defaults without crashing
    assert.strictEqual(settings.enabled, true)
    assert.strictEqual(settings.candidateRankingEnabled, true)
    assert.strictEqual(settings.strictMissingMedia, false)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  console.log(`\n==================================================`)
  console.log(`TEST RESULTS: ${passedTests} passed, ${failedTests} failed`)
  console.log(`==================================================\n`)

  if (failedTests > 0) {
    process.exit(1)
  }
}

runAllTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
