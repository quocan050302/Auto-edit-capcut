process.env.NODE_ENV = 'test'

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  computeCombinedVisualTruthScore,
  generateVerificationCacheKey,
  sanitizeVisualTruthVerification,
  rerankShortlistedCandidates
} from '../src/main/production-intelligence/visual-truth-reranker'
import {
  extractClaimsRuleBased,
  addEvidenceSource,
  linkSourceToClaim,
  unlinkSourceFromClaim,
  updateClaimStatus,
  exportClaimManifests,
  escapeCsvField,
  getClaimLedgerPath
} from '../src/main/production-intelligence/claim-evidence-ledger'
import {
  checkSceneIdentityPreserved,
  assertSceneIdentityPreserved
} from '../src/main/production-intelligence/scene-invariants'
import { atomicWriteJson } from '../src/main/production-intelligence/json-store'
import {
  DEFAULT_VISUAL_TRUTH_WEIGHTS,
  type VisualTruthVerification,
  type StockCandidate,
  type MasterEditPlan,
  type EvidenceSource,
  type ClaimEvidenceLedger
} from '../shared/types'

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

function createDummyScene(id: string, narration: string, start = 0, end = 5, sceneIndex = 0): any {
  return {
    id,
    sceneId: id,
    sceneIndex,
    sequenceId: 'seq_1',
    chapterId: 'ch_1',
    narration,
    narrationText: narration,
    visualIntent: 'test visual intent',
    searchKeywords: ['test'],
    duration: end - start,
    startTime: start,
    endTime: end,
    captionPhrases: [
      { text: narration, startTime: start, endTime: end, words: [{ word: narration, start, end }] }
    ]
  }
}

async function runAllTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL TRUTH & CLAIM LEDGER TEST SUITE')
  console.log('==================================================\n')

  // ─────────────────────────────────────────────────────────────
  // 1. VISUAL TRUTH RERANKER UNIT TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Visual Truth Reranker Unit Tests ---')

  await test('Score calculation: Normalizes weights to 0-100 scale', () => {
    const verification: VisualTruthVerification = {
      candidateId: 'cand_1',
      sceneId: 'scene_1',
      actualSubjects: ['person'],
      actualActions: ['reading'],
      visibleObjects: ['book'],
      possibleLocations: ['library'],
      possibleTimePeriods: ['modern'],
      subjectMatch: 80,
      actionMatch: 70,
      objectMatch: 75,
      geographyMatch: 60,
      timePeriodMatch: 90,
      narrationMatch: 80,
      visualIntentMatch: 85,
      documentaryEvidenceValue: 60,
      sequenceContinuity: 70,
      genericStockRisk: 20,
      contradictionRisk: 10,
      technicalQuality: 85,
      truthLabel: 'CONTEXTUAL_MATCH',
      positiveReasons: ['Good contextual fit'],
      negativeReasons: [],
      contradictionReasons: [],
      confidence: 85,
      approved: true,
      requiresReview: false,
      analyzedAt: new Date().toISOString(),
      analysisVersion: '1.0.0'
    }

    const metadataScore = 75
    const { finalScore } = computeCombinedVisualTruthScore(metadataScore, verification, DEFAULT_VISUAL_TRUTH_WEIGHTS)
    assert(finalScore >= 0 && finalScore <= 100, `Combined score ${finalScore} out of range [0, 100]`)
    assert(finalScore >= 65 && finalScore <= 85, `Expected score ~75, got ${finalScore}`)
  })

  await test('Contradiction penalty: Heavily penalizes candidate with high contradiction risk', () => {
    const verificationNormal: VisualTruthVerification = {
      candidateId: 'cand_1',
      sceneId: 'scene_1',
      actualSubjects: ['person'],
      actualActions: ['reading'],
      visibleObjects: [],
      possibleLocations: [],
      possibleTimePeriods: [],
      subjectMatch: 80,
      actionMatch: 80,
      objectMatch: 80,
      geographyMatch: 80,
      timePeriodMatch: 80,
      narrationMatch: 80,
      visualIntentMatch: 80,
      documentaryEvidenceValue: 80,
      sequenceContinuity: 80,
      genericStockRisk: 10,
      contradictionRisk: 0,
      technicalQuality: 80,
      truthLabel: 'EXACT_SUBJECT',
      positiveReasons: [],
      negativeReasons: [],
      contradictionReasons: [],
      confidence: 90,
      approved: true,
      requiresReview: false,
      analyzedAt: new Date().toISOString(),
      analysisVersion: '1.0.0'
    }

    const verificationContradictory: VisualTruthVerification = {
      ...verificationNormal,
      contradictionRisk: 90,
      truthLabel: 'CONTRADICTORY',
      contradictionReasons: ['Wrong historical era (smartphone in 1800s)']
    }

    const { finalScore: scoreNormal } = computeCombinedVisualTruthScore(80, verificationNormal)
    const { finalScore: scoreContradictory } = computeCombinedVisualTruthScore(80, verificationContradictory)

    assert(
      scoreNormal - scoreContradictory >= 35,
      `Contradiction penalty too low: normal=${scoreNormal}, contradictory=${scoreContradictory}`
    )
  })

  await test('Generic stock penalty: Deducts score from generic stock candidates', () => {
    const verificationNormal: VisualTruthVerification = {
      candidateId: 'cand_1',
      sceneId: 'scene_1',
      actualSubjects: ['person'],
      actualActions: ['walking'],
      visibleObjects: [],
      possibleLocations: [],
      possibleTimePeriods: [],
      subjectMatch: 70,
      actionMatch: 70,
      objectMatch: 70,
      geographyMatch: 70,
      timePeriodMatch: 70,
      narrationMatch: 70,
      visualIntentMatch: 70,
      documentaryEvidenceValue: 70,
      sequenceContinuity: 70,
      genericStockRisk: 10,
      contradictionRisk: 0,
      technicalQuality: 80,
      truthLabel: 'ILLUSTRATIVE',
      positiveReasons: [],
      negativeReasons: [],
      contradictionReasons: [],
      confidence: 85,
      approved: true,
      requiresReview: false,
      analyzedAt: new Date().toISOString(),
      analysisVersion: '1.0.0'
    }

    const verificationGeneric: VisualTruthVerification = {
      ...verificationNormal,
      genericStockRisk: 85,
      truthLabel: 'GENERIC_STOCK'
    }

    const { finalScore: normal } = computeCombinedVisualTruthScore(70, verificationNormal)
    const { finalScore: generic } = computeCombinedVisualTruthScore(70, verificationGeneric)

    assert(normal > generic, `Generic stock was not penalized: normal=${normal}, generic=${generic}`)
  })

  await test('Low-confidence fallback: Marks candidate as UNKNOWN and requires review when confidence is low', () => {
    const raw = {
      candidateId: 'cand_low',
      truthLabel: 'EXACT_SUBJECT',
      confidence: 25, // Below 50 min confidence
      subjectMatch: 80
    }

    const sanitized = sanitizeVisualTruthVerification(raw, 'cand_low', 'scene_1', 50)
    assert.strictEqual(sanitized.truthLabel, 'UNKNOWN')
    assert.strictEqual(sanitized.requiresReview, true)
    assert.strictEqual(sanitized.confidence, 25)
  })

  await test('Cache key generation: Depends on candidate ID, intent hash, and context hash', () => {
    const key1 = generateVerificationCacheKey('asset_100', 'intent_abc', 'ctx_123', 'v1')
    const key2 = generateVerificationCacheKey('asset_100', 'intent_abc', 'ctx_123', 'v1')
    const keyDiffIntent = generateVerificationCacheKey('asset_100', 'intent_xyz', 'ctx_123', 'v1')
    const keyDiffContext = generateVerificationCacheKey('asset_100', 'intent_abc', 'ctx_456', 'v1')

    assert.strictEqual(key1, key2, 'Same inputs should yield identical cache keys')
    assert.notStrictEqual(key1, keyDiffIntent, 'Different intent should yield different cache key')
    assert.notStrictEqual(key1, keyDiffContext, 'Different context should yield different cache key')
  })

  await test('Invalid AI response: Sanitizes out of range values and missing fields cleanly', () => {
    const malformed = {
      subjectMatch: 250, // Out of bounds
      actionMatch: -50,  // Out of bounds
      confidence: 'invalid',
      truthLabel: 'RANDOM_LABEL'
    }

    const sanitized = sanitizeVisualTruthVerification(malformed, 'cand_m', 'scene_m', 50)
    assert.strictEqual(sanitized.subjectMatch, 100, 'Score above 100 should be clamped to 100')
    assert.strictEqual(sanitized.actionMatch, 0, 'Score below 0 should be clamped to 0')
    assert.strictEqual(sanitized.confidence, 0, 'Invalid confidence should fall back to 0')
    assert.strictEqual(sanitized.truthLabel, 'UNKNOWN', 'Invalid label should fall back to UNKNOWN')
  })

  await test('Feature disabled: rerankShortlistedCandidates returns original order when enabled=false', async () => {
    const candidates: StockCandidate[] = [
      { id: 'c1', assetId: 'a1', score: 85, provider: 'pexels', mediaType: 'video', title: 'one', tags: [], thumbnailUrl: '', previewUrl: '', downloadUrl: '', pageUrl: '', durationSecs: 5, width: 1920, height: 1080 },
      { id: 'c2', assetId: 'a2', score: 70, provider: 'pexels', mediaType: 'video', title: 'two', tags: [], thumbnailUrl: '', previewUrl: '', downloadUrl: '', pageUrl: '', durationSecs: 5, width: 1920, height: 1080 }
    ]

    const result = await rerankShortlistedCandidates({
      projectDir: '/tmp/dummy-project',
      sceneId: 'scene_1',
      candidates,
      narration: 'Narration text',
      visualIntent: 'Visual intent',
      settings: { enabled: false, visualTruthEnabled: false } as any
    })

    assert.strictEqual(result.usedFallback, true)
    assert.strictEqual(result.candidates[0].id, 'c1')
    assert.strictEqual(result.candidates[1].id, 'c2')
  })

  // ─────────────────────────────────────────────────────────────
  // 2. CLAIM & EVIDENCE LEDGER UNIT TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Claim & Evidence Ledger Unit Tests ---')

  await test('Rule-based fallback extracts STATISTIC, MONEY, and DATE claims with scene mapping', () => {
    const scenes = [
      createDummyScene('s1', 'In 2022, inflation reached 8.5 percent across the nation.', 0, 5, 0),
      createDummyScene('s2', 'The acquisition was finalized for 45 billion dollars by the board.', 5, 10, 1),
      createDummyScene('s3', 'A customer compares unit prices on supermarket shelf labels.', 10, 15, 2)
    ]

    const ledger = extractClaimsRuleBased(scenes, 'scriptHash', 'ctxHash')
    const claims = ledger.claims
    assert(claims.length >= 2, `Expected at least 2 claims, got ${claims.length}`)

    const statClaim = claims.find((c) => c.type === 'STATISTIC')
    assert(statClaim, 'STATISTIC claim not found')
    assert.deepStrictEqual(statClaim?.sceneIds, ['s1'])

    const moneyClaim = claims.find((c) => c.type === 'MONEY')
    assert(moneyClaim, 'MONEY claim not found')
    assert.deepStrictEqual(moneyClaim?.sceneIds, ['s2'])

    // Scene 3 is narrative action, not a factual claim needing citation
    const s3Claims = claims.filter((c) => c.sceneIds.includes('s3'))
    assert.strictEqual(s3Claims.length, 0, 'Narrative scene 3 should not have extracted factual claims')
  })

  await test('Anti-hallucination: Claims default to UNSOURCED and have zero fabricated URL/author fields', () => {
    const scenes = [
      createDummyScene('s1', 'The national debt exceeded 34 trillion dollars in December 2023.', 0, 5, 0)
    ]

    const ledger = extractClaimsRuleBased(scenes, 'scriptHash', 'ctxHash')
    const claims = ledger.claims
    assert.strictEqual(claims.length, 1)
    const claim = claims[0]

    assert.strictEqual(claim.verificationStatus, 'UNSOURCED')
    assert.strictEqual(claim.evidenceSourceIds.length, 0)
    assert(claim.warnings.length > 0, 'Should include warning that source is required')
  })

  await test('Source management: Adds source, links to claim, updates status, and unlinks cleanly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-crud-test-'))
    try {
      const ledgerPath = getClaimLedgerPath(tempDir)
      const ledger: ClaimEvidenceLedger = {
        projectId: 'proj_test',
        scriptHash: 'hash_123',
        globalContextHash: 'ctx_123',
        claims: [
          {
            id: 'claim_1',
            scriptText: 'Inflation rose 8.5%',
            normalizedClaim: 'Inflation rate 8.5%',
            type: 'STATISTIC',
            sceneIds: ['s1'],
            importance: 'HIGH',
            confidence: 90,
            verificationStatus: 'UNSOURCED',
            evidenceSourceIds: [],
            proofVisualRecommended: true,
            proofVisualType: 'STAT_CARD',
            warnings: ['Needs source'],
            extractionVersion: '1.0.0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        sources: [],
        summary: {
          totalClaims: 1,
          verified: 0,
          partiallyVerified: 0,
          unsourced: 1,
          contradicted: 0,
          criticalUnsourced: 1
        },
        generatedAt: new Date().toISOString(),
        version: '1.0.0'
      }

      atomicWriteJson(ledgerPath, ledger)

      // 1. Add source
      const addRes = addEvidenceSource(tempDir, {
        type: 'REPORT',
        title: 'Bureau of Labor Statistics Annual CPI Report',
        publisher: 'US Dept of Labor',
        url: 'https://bls.gov/cpi/report-2022'
      })

      assert.strictEqual(addRes.success, true)
      assert(addRes.source?.id)
      assert.strictEqual(addRes.source?.manuallyAdded, true)
      const sourceId = addRes.source.id

      // 2. Link source to claim
      const linkRes = linkSourceToClaim(tempDir, 'claim_1', sourceId)
      assert.strictEqual(linkRes.success, true)
      assert(linkRes.claim?.evidenceSourceIds.includes(sourceId))
      assert.strictEqual(linkRes.claim?.verificationStatus, 'VERIFIED')

      // 3. Update status manually
      const updateRes = updateClaimStatus(tempDir, 'claim_1', 'PARTIALLY_VERIFIED')
      assert.strictEqual(updateRes.success, true)
      assert.strictEqual(updateRes.claim?.verificationStatus, 'PARTIALLY_VERIFIED')

      // 4. Unlink source
      const unlinkRes = unlinkSourceFromClaim(tempDir, 'claim_1', sourceId)
      assert.strictEqual(unlinkRes.success, true)
      assert.strictEqual(unlinkRes.claim?.evidenceSourceIds.length, 0)
      assert.strictEqual(unlinkRes.claim?.verificationStatus, 'UNSOURCED')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await test('Export CSV escaping: Escapes quotes, commas, and linebreaks properly', () => {
    assert.strictEqual(escapeCsvField('normal'), '"normal"')
    assert.strictEqual(escapeCsvField('has, comma'), '"has, comma"')
    assert.strictEqual(escapeCsvField('has "quotes"'), '"has ""quotes"""')
    assert.strictEqual(escapeCsvField('line\nbreak'), '"line\nbreak"')
  })

  await test('Export manifests: Generates claim-evidence-ledger.json, sources.csv, and licenses.json', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-export-test-'))
    try {
      const ledgerPath = getClaimLedgerPath(tempDir)
      const ledger: ClaimEvidenceLedger = {
        projectId: 'test_proj',
        scriptHash: 'shash',
        globalContextHash: 'ghash',
        claims: [
          {
            id: 'c1',
            scriptText: 'Test claim text with "quote" and , comma',
            normalizedClaim: 'Test claim',
            type: 'STATISTIC',
            sceneIds: ['s1', 's2'],
            importance: 'HIGH',
            confidence: 88,
            verificationStatus: 'VERIFIED',
            evidenceSourceIds: ['src_1'],
            proofVisualRecommended: true,
            warnings: [],
            extractionVersion: '1.0.0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        sources: [
          {
            id: 'src_1',
            type: 'REPORT',
            title: 'Sample Economic Report',
            publisher: 'Government Dept',
            license: 'Public Domain',
            manuallyAdded: true
          }
        ],
        summary: {
          totalClaims: 1,
          verified: 1,
          partiallyVerified: 0,
          unsourced: 0,
          contradicted: 0,
          criticalUnsourced: 0
        },
        generatedAt: new Date().toISOString(),
        version: '1.0.0'
      }

      atomicWriteJson(ledgerPath, ledger)

      const files = exportClaimManifests(tempDir)
      assert.strictEqual(files.success, true)
      assert(files.jsonPath && fs.existsSync(files.jsonPath), 'claim-evidence-ledger.json missing')
      assert(files.csvPath && fs.existsSync(files.csvPath), 'sources.csv missing')
      assert(files.licensesPath && fs.existsSync(files.licensesPath), 'licenses.json missing')

      const csvContent = fs.readFileSync(files.csvPath, 'utf-8')
      assert(csvContent.includes('Test claim text with ""quote"" and , comma'), 'CSV escaping failed')
      assert(csvContent.includes('s1;s2'), 'Scene IDs not joined in CSV')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // ─────────────────────────────────────────────────────────────
  // 3. SCENE PRESERVATION INVARIANT TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Scene Identity Preservation Invariant Tests ---')

  await test('Invariant passes on identical scenes array', () => {
    const scenes = [
      createDummyScene('s1', 'First scene narration', 0, 4, 0),
      createDummyScene('s2', 'Second scene narration', 4, 9, 1)
    ]
    const scenesCopy = JSON.parse(JSON.stringify(scenes))

    const result = checkSceneIdentityPreserved(scenes, scenesCopy)
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.errors.length, 0)
    assert.doesNotThrow(() => assertSceneIdentityPreserved(scenes, scenesCopy, true))
  })

  await test('Invariant detects dropped scene', () => {
    const before = [
      createDummyScene('s1', 'Scene 1', 0, 5, 0),
      createDummyScene('s2', 'Scene 2', 5, 10, 1)
    ]
    const after = [createDummyScene('s1', 'Scene 1', 0, 5, 0)]

    const result = checkSceneIdentityPreserved(before, after)
    assert.strictEqual(result.valid, false)
    assert(result.errors.some((e) => e.includes('Scene count mismatch')))
    assert.throws(() => assertSceneIdentityPreserved(before, after, true))
  })

  await test('Invariant detects reordered scene sequence', () => {
    const s1 = createDummyScene('s1', 'Scene 1', 0, 5, 0)
    const s2 = createDummyScene('s2', 'Scene 2', 5, 10, 1)

    const before = [s1, s2]
    const after = [s2, s1] // Swapped order

    const result = checkSceneIdentityPreserved(before, after)
    assert.strictEqual(result.valid, false)
    assert(result.errors.some((e) => e.includes('Scene order corrupted') || e.includes('Scene ID mutated')))
    assert.throws(() => assertSceneIdentityPreserved(before, after, true))
  })

  await test('Invariant detects mutated narration text', () => {
    const before = [createDummyScene('s1', 'Original narration text', 0, 5, 0)]
    const after = [createDummyScene('s1', 'Paraphrased narration text', 0, 5, 0)]

    const result = checkSceneIdentityPreserved(before, after)
    assert.strictEqual(result.valid, false)
    assert(result.errors.some((e) => e.includes('Narration text altered')))
    assert.throws(() => assertSceneIdentityPreserved(before, after, true))
  })

  await test('Invariant detects modified start/end timing', () => {
    const before = [createDummyScene('s1', 'Narration text', 0, 5, 0)]
    const after = [createDummyScene('s1', 'Narration text', 0, 8, 0)] // Changed end time

    const result = checkSceneIdentityPreserved(before, after)
    assert.strictEqual(result.valid, false)
    assert(result.errors.some((e) => e.includes('Timing shifted')))
    assert.throws(() => assertSceneIdentityPreserved(before, after, true))
  })

  // ─────────────────────────────────────────────────────────────
  // 4. INTEGRATION FIXTURE TEST
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Full Fixture Integration Test ---')

  await test('Fixture: 2 Chapters, 2 Sequences, 8 Scenes with Claims and Reranking', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'))
    try {
      // 1. Create 8-scene edit plan fixture
      const fixtureScenes = [
        // Chapter 1 / Seq 1
        createDummyScene('scene_1', 'In 2022, consumer prices surged by 8.5 percent.', 0, 4, 0),
        createDummyScene('scene_2', 'Shoppers examined shelf tags trying to make ends meet.', 4, 8, 1),
        // Chapter 1 / Seq 2
        createDummyScene('scene_3', 'Walmart captured over 25 percent of the grocery market.', 8, 13, 2),
        createDummyScene('scene_4', 'The company spent 45 billion dollars to modernize logistics.', 13, 18, 3),
        // Chapter 2 / Seq 3
        createDummyScene('scene_5', 'On October 29, 1929, the stock market crashed abruptly.', 18, 22, 4),
        createDummyScene('scene_6', 'Crowds gathered outside bank branches across Manhattan.', 22, 27, 5),
        // Chapter 2 / Seq 4
        createDummyScene('scene_7', 'Economists debate whether monetary policy worsened the crisis.', 27, 32, 6),
        createDummyScene('scene_8', 'History reveals deep lessons about resilience and financial reform.', 32, 38, 7)
      ]

      const editPlan: MasterEditPlan = {
        chapters: [
          {
            id: 'ch_1',
            title: 'Modern Inflation',
            purpose: 'Analyze modern price pressures',
            startTime: 0,
            endTime: 18,
            sequences: [
              { id: 'seq_1', title: 'The Shock', startTime: 0, endTime: 8, scenes: [fixtureScenes[0], fixtureScenes[1]] },
              { id: 'seq_2', title: 'Market Giants', startTime: 8, endTime: 18, scenes: [fixtureScenes[2], fixtureScenes[3]] }
            ]
          },
          {
            id: 'ch_2',
            title: 'Historical Parallels',
            purpose: 'Compare with past crises',
            startTime: 18,
            endTime: 38,
            sequences: [
              { id: 'seq_3', title: 'Black Tuesday', startTime: 18, endTime: 27, scenes: [fixtureScenes[4], fixtureScenes[5]] },
              { id: 'seq_4', title: 'Lessons Learned', startTime: 27, endTime: 38, scenes: [fixtureScenes[6], fixtureScenes[7]] }
            ]
          }
        ]
      }

      // 2. Extract Claim Ledger
      const fixtureLedger = extractClaimsRuleBased(fixtureScenes, 'shash_1', 'ghash_1')
      const claims = fixtureLedger.claims
      assert(claims.length >= 4, `Expected at least 4 claims from fixture, got ${claims.length}`)

      const statClaim = claims.find((c) => c.type === 'STATISTIC')
      const moneyClaim = claims.find((c) => c.type === 'MONEY')
      const dateClaim = claims.find((c) => c.type === 'DATE')
      assert(statClaim && moneyClaim && dateClaim, 'Expected statistic, money, and date claims')

      // Ensure zero hallucinated source URLs
      for (const cl of claims) {
        assert.strictEqual(cl.evidenceSourceIds.length, 0)
        assert.strictEqual(cl.verificationStatus, 'UNSOURCED')
      }

      // 3. Test Candidate Reranking with simulated candidate types
      // Candidate A: Exact proof / contextual match
      // Candidate B: Generic stock
      // Candidate C: Contradictory
      const mockCandidates: StockCandidate[] = [
        {
          id: 'cand_exact',
          assetId: 'a_exact',
          score: 75,
          provider: 'pexels',
          mediaType: 'video',
          title: 'Grocery price shelf tags',
          tags: ['grocery', 'shelf', 'label'],
          thumbnailUrl: '',
          previewUrl: '',
          downloadUrl: '',
          pageUrl: '',
          durationSecs: 6,
          width: 1920,
          height: 1080
        },
        {
          id: 'cand_generic',
          assetId: 'a_generic',
          score: 80, // higher initial metadata score
          provider: 'pixabay',
          mediaType: 'video',
          title: 'Happy family dancing in meadow',
          tags: ['happy', 'summer'],
          thumbnailUrl: '',
          previewUrl: '',
          downloadUrl: '',
          pageUrl: '',
          durationSecs: 6,
          width: 1920,
          height: 1080
        },
        {
          id: 'cand_contradictory',
          assetId: 'a_contra',
          score: 85, // highest metadata score
          provider: 'pexels',
          mediaType: 'video',
          title: 'Modern futuristic spaceship CGI',
          tags: ['spaceship', 'cgi'],
          thumbnailUrl: '',
          previewUrl: '',
          downloadUrl: '',
          pageUrl: '',
          durationSecs: 6,
          width: 1920,
          height: 1080
        }
      ]

      // Verification for candidates
      const verifications: Record<string, VisualTruthVerification> = {
        cand_exact: {
          candidateId: 'cand_exact',
          sceneId: 'scene_1',
          actualSubjects: ['shelf tag', 'supermarket aisle'],
          actualActions: ['viewing price label'],
          visibleObjects: ['price label', 'canned food'],
          possibleLocations: ['grocery store'],
          possibleTimePeriods: ['modern'],
          subjectMatch: 90,
          actionMatch: 85,
          objectMatch: 95,
          geographyMatch: 80,
          timePeriodMatch: 90,
          narrationMatch: 90,
          visualIntentMatch: 92,
          documentaryEvidenceValue: 88,
          sequenceContinuity: 80,
          genericStockRisk: 10,
          contradictionRisk: 0,
          technicalQuality: 85,
          truthLabel: 'EXACT_SUBJECT',
          positiveReasons: ['Exact shelf tags visible'],
          negativeReasons: [],
          contradictionReasons: [],
          confidence: 90,
          approved: true,
          requiresReview: false,
          analyzedAt: new Date().toISOString(),
          analysisVersion: '1.0.0'
        },
        cand_generic: {
          candidateId: 'cand_generic',
          sceneId: 'scene_1',
          actualSubjects: ['family in meadow'],
          actualActions: ['dancing'],
          visibleObjects: ['grass'],
          possibleLocations: ['outdoor'],
          possibleTimePeriods: ['modern'],
          subjectMatch: 20,
          actionMatch: 10,
          objectMatch: 10,
          geographyMatch: 50,
          timePeriodMatch: 70,
          narrationMatch: 20,
          visualIntentMatch: 25,
          documentaryEvidenceValue: 10,
          sequenceContinuity: 30,
          genericStockRisk: 90,
          contradictionRisk: 20,
          technicalQuality: 80,
          truthLabel: 'GENERIC_STOCK',
          positiveReasons: [],
          negativeReasons: ['Irrelevant to inflation and prices'],
          contradictionReasons: [],
          confidence: 85,
          approved: false,
          requiresReview: true,
          analyzedAt: new Date().toISOString(),
          analysisVersion: '1.0.0'
        },
        cand_contradictory: {
          candidateId: 'cand_contradictory',
          sceneId: 'scene_1',
          actualSubjects: ['spaceship CGI'],
          actualActions: ['flying in space'],
          visibleObjects: ['spaceship'],
          possibleLocations: ['outer space'],
          possibleTimePeriods: ['sci-fi future'],
          subjectMatch: 5,
          actionMatch: 0,
          objectMatch: 0,
          geographyMatch: 0,
          timePeriodMatch: 0,
          narrationMatch: 0,
          visualIntentMatch: 0,
          documentaryEvidenceValue: 0,
          sequenceContinuity: 10,
          genericStockRisk: 10,
          contradictionRisk: 95,
          technicalQuality: 80,
          truthLabel: 'CONTRADICTORY',
          positiveReasons: [],
          negativeReasons: [],
          contradictionReasons: ['Sci-fi CGI directly contradicts economic documentary narration'],
          confidence: 95,
          approved: false,
          requiresReview: true,
          analyzedAt: new Date().toISOString(),
          analysisVersion: '1.0.0'
        }
      }

      // Compute combined scores for each
      const { finalScore: scoreExact } = computeCombinedVisualTruthScore(mockCandidates[0].score, verifications.cand_exact)
      const { finalScore: scoreGeneric } = computeCombinedVisualTruthScore(mockCandidates[1].score, verifications.cand_generic)
      const { finalScore: scoreContra } = computeCombinedVisualTruthScore(mockCandidates[2].score, verifications.cand_contradictory)

      assert(scoreExact > scoreGeneric, `Exact match (${scoreExact}) should beat generic stock (${scoreGeneric})`)
      assert(scoreGeneric > scoreContra, `Generic stock (${scoreGeneric}) should beat contradictory candidate (${scoreContra})`)
      assert(scoreContra < 40, `Contradictory candidate score should be below 40, got ${scoreContra}`)

      // 4. Verify Scene Identity Invariant across the full pipeline fixture
      const scenesAfter = JSON.parse(JSON.stringify(fixtureScenes))
      assertSceneIdentityPreserved(fixtureScenes, scenesAfter, true)
      assert.strictEqual(fixtureScenes.length, scenesAfter.length)
      assert.strictEqual(fixtureScenes.length, 8)

      // 5. Verify Manifest Export
      const ledgerPath = getClaimLedgerPath(tempDir)
      const ledger: ClaimEvidenceLedger = {
        projectId: 'fixture_project',
        scriptHash: 'shash_1',
        globalContextHash: 'ghash_1',
        claims,
        sources: [],
        summary: {
          totalClaims: claims.length,
          verified: 0,
          partiallyVerified: 0,
          unsourced: claims.length,
          contradicted: 0,
          criticalUnsourced: claims.filter((c) => c.importance === 'HIGH' || c.importance === 'CRITICAL').length
        },
        generatedAt: new Date().toISOString(),
        version: '1.0.0'
      }

      atomicWriteJson(ledgerPath, ledger)

      const exported = exportClaimManifests(tempDir)
      assert.strictEqual(exported.success, true)
      assert(exported.jsonPath && fs.existsSync(exported.jsonPath))
      assert(exported.csvPath && fs.existsSync(exported.csvPath))
      assert(exported.licensesPath && fs.existsSync(exported.licensesPath))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passedTests} passed, ${failedTests} failed`)
  console.log('==================================================\n')

  if (failedTests > 0) {
    process.exit(1)
  }
}

runAllTests().catch((err) => {
  console.error('Fatal error during test run:', err)
  process.exit(1)
})
