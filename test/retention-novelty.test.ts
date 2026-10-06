/**
 * test/retention-novelty.test.ts
 *
 * Unit tests for Visual Novelty Engine:
 * - Deterministic novelty score calculation (0.0 to 1.0)
 * - 4-scene sliding window
 * - Decreasing novelty on repetitive scenes, rebound on novel scene (Section 95)
 * - Intentional motif exception reducing penalty (Section 96)
 * - Low-novelty streak detection (Section 24)
 */

import * as assert from 'assert'
import {
  computeNoveltyScore,
  isLowNoveltyStreak,
  extractNormalizedKeywords,
  classifySubjectType,
  type SceneVisualSignature
} from '../src/main/retention/retention-novelty'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING RETENTION NOVELTY UNIT TESTS')
  console.log('==================================================\n')

  await it('TEST 1: extractNormalizedKeywords filters stop words and normalizes tokens', () => {
    const text = 'The kidney and renal glomerulus filtration system in healthy adults.'
    const kws = extractNormalizedKeywords(text)
    assert.ok(kws.includes('kidney'))
    assert.ok(kws.includes('renal'))
    assert.ok(kws.includes('glomerulus'))
    assert.ok(kws.includes('filtration'))
    assert.ok(kws.includes('healthy'))
    assert.ok(kws.includes('adults'))
    assert.ok(!kws.includes('the'))
    assert.ok(!kws.includes('and'))
    assert.ok(!kws.includes('in'))
  })

  await it('TEST 2: Four identical consecutive scenes show decreasing novelty; different 5th scene increases novelty (Section 95)', () => {
    const history: SceneVisualSignature[] = []

    // 4 consecutive identical anatomy close-up scenes
    const scores: number[] = []
    for (let i = 1; i <= 4; i++) {
      const sig: SceneVisualSignature = {
        sceneIndex: i,
        sceneId: String(i),
        visualSource: 'ai-still',
        shotType: 'close-up',
        energyLevel: 'medium',
        visualIntentKeywords: ['kidney', 'nephron', 'filtration', 'anatomy'],
        category: 'anatomy',
        subjectType: 'anatomy',
        motionPreset: 'slow-push-in',
        role: 'mechanism'
      }

      const score = computeNoveltyScore(sig, history, 4)
      scores.push(score)
      history.push(sig)
    }

    // First scene has no previous history -> maximum novelty 1.0
    assert.strictEqual(scores[0], 1.0)

    // Consecutive identical scenes should have strictly lower novelty scores
    assert.ok(scores[1] < scores[0], `Expected score[1] (${scores[1]}) < score[0] (${scores[0]})`)
    assert.ok(scores[2] < scores[1], `Expected score[2] (${scores[2]}) < score[1] (${scores[1]})`)
    assert.ok(scores[3] <= scores[2], `Expected score[3] (${scores[3]}) <= score[2] (${scores[2]})`)

    // By scene 4, novelty should be low (< 0.40)
    assert.ok(scores[3] < 0.40, `Expected score 4 to be < 0.40, got ${scores[3]}`)

    // Now introduce a very different 5th scene: Stock wide-angle human lifestyle
    const novelScene: SceneVisualSignature = {
      sceneIndex: 5,
      sceneId: '5',
      visualSource: 'stock',
      shotType: 'wide',
      energyLevel: 'high',
      visualIntentKeywords: ['athlete', 'running', 'morning', 'sunlight'],
      category: 'lifestyle',
      subjectType: 'human',
      motionPreset: 'pan-left',
      role: 'solution'
    }

    const novelScore = computeNoveltyScore(novelScene, history, 4)
    assert.ok(novelScore > scores[3], `Expected novel scene score (${novelScore}) > score[3] (${scores[3]})`)
    assert.ok(novelScore >= 0.70, `Expected novel scene score to be high (>= 0.70), got ${novelScore}`)
  })

  await it('TEST 3: Intentional motif exception reduces repetition penalty (Section 96)', () => {
    // History has 2 kidney scenes
    const history: SceneVisualSignature[] = [
      {
        sceneIndex: 1,
        sceneId: '1',
        visualSource: 'ai-still',
        shotType: 'wide',
        energyLevel: 'medium',
        visualIntentKeywords: ['kidney', 'organ', 'renal'],
        category: 'anatomy',
        subjectType: 'anatomy'
      },
      {
        sceneIndex: 2,
        sceneId: '2',
        visualSource: 'ai-still',
        shotType: 'medium',
        energyLevel: 'medium',
        visualIntentKeywords: ['kidney', 'organ', 'cortex'],
        category: 'anatomy',
        subjectType: 'anatomy'
      }
    ]

    // Candidate A: Accidental repetition (no motifId)
    const candidateA: SceneVisualSignature = {
      sceneIndex: 3,
      sceneId: '3',
      visualSource: 'ai-still',
      shotType: 'close-up',
      energyLevel: 'medium',
      visualIntentKeywords: ['kidney', 'nephron'],
      category: 'anatomy',
      subjectType: 'anatomy'
    }

    // Candidate B: Intentional recurring motif (has motifId)
    const candidateB: SceneVisualSignature = {
      ...candidateA,
      motifId: 'motif_kidney'
    }

    const scoreWithoutMotif = computeNoveltyScore(candidateA, history, 4)
    const scoreWithMotif = computeNoveltyScore(candidateB, history, 4)

    // Intentional motif should receive a higher novelty score (penalty reduced)
    assert.ok(
      scoreWithMotif > scoreWithoutMotif,
      `Expected score with motif (${scoreWithMotif}) > without motif (${scoreWithoutMotif})`
    )
  })

  await it('TEST 4: Low-novelty streak detection flags 3+ consecutive low scores (Section 24)', () => {
    // 2 low scores -> not yet a streak
    assert.strictEqual(isLowNoveltyStreak([0.35, 0.30], 3, 0.40), false)

    // 3 low scores -> streak triggered
    assert.strictEqual(isLowNoveltyStreak([0.35, 0.30, 0.28], 3, 0.40), true)

    // A rebound breaks the streak
    assert.strictEqual(isLowNoveltyStreak([0.35, 0.30, 0.75], 3, 0.40), false)

    // Streak with custom threshold
    assert.strictEqual(isLowNoveltyStreak([0.45, 0.42, 0.44], 3, 0.50), true)
  })

  console.log(`\nRetention Novelty Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
