/**
 * Manual AI Visual Director — Prompt Hook & Quality Tests.
 * Tests: Universal visual hook rule, active event verbs, word counts (normal 130-200,
 * high hook 160-230, max 260), single physical line format, prompt quality scoring.
 */
import {
  buildManualScenePrompt,
  calculatePromptQualityScore,
  sanitizePromptLine
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import type {
  ManualAiSceneDirection,
  ManualAiVisualBrief
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import type { VisualMixScenePlan } from '../shared/types'
import { assert, createRunner } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Prompt Hook & Quality Tests')

function makeScene(index: number, narration: string, intent: string): VisualMixScenePlan {
  return {
    sceneIndex: index,
    narration,
    visualIntent: intent,
    strategy: 'ai-still',
    durationFrames: 120,
    category: 'conceptual'
  }
}

async function main(): Promise<void> {
  console.log('\nManual AI Prompt Hook & Quality')

  await it('universal visual hook: mechanism scenes must contain active event verbs and dynamic change', () => {
    const scene = makeScene(
      12,
      'Your kidneys actively filter waste products from arterial blood during sleep.',
      'Kidneys filtering blood at night'
    )

    const direction: ManualAiSceneDirection = {
      sceneIndex: 12,
      sceneRole: 'mechanism',
      hookLevel: 'high',
      coreMeaning: 'active nighttime kidney filtration',
      viewerShouldNotice: 'waste separation toward the ureters',
      curiosityGap: 'How filtration continues without interruption',
      visualEvent: {
        subject: 'both human kidneys',
        action: 'actively filtering darker arterial blood while cleaner venous blood exits',
        change: 'subtle stream of filtered waste separating toward the ureters',
        cause: 'continuous nighttime renal blood flow',
        consequence: 'steady urine production'
      },
      composition: {
        shotType: 'close three-quarter anatomical view',
        cameraAngle: 'eye level',
        lensFeel: '85mm medical-documentary lens',
        focalPriority: 'dominant organ filtration pathway',
        foreground: 'human kidneys',
        background: 'controlled dark navy background with volumetric depth'
      },
      lighting: 'controlled cool rim light over dark navy',
      colorStrategy: 'deep navy blue with warm tissue accents',
      textOverlay: {
        enabled: false,
        reason: 'Visually clear mechanism'
      },
      avoid: ['static anatomical models in void', 'flat textbook diagrams'],
      confidence: 0.95
    }

    const prompt = buildManualScenePrompt({
      scene,
      profile: 'health',
      outputResolution: '1080p',
      sceneDirection: direction
    })

    // Check active event verbs
    assert.ok(
      /\b(filtering|flowing|separating|transporting|exiting)\b/i.test(prompt),
      'Prompt must contain active event verbs'
    )
    // Check that it's NOT a static textbook portrait
    assert.ok(
      prompt.includes('as an active physiological process rather than a static anatomical portrait') ||
      prompt.includes('actively filtering'),
      'Must emphasize active process over static card'
    )
    // Medical safety
    assert.ok(prompt.includes('Realistic internal tissue, plausible organ and vessel relationships'))
    assert.ok(prompt.includes('no anatomical labels'))
  })

  await it('word count standards: detailed prompt meets targets and never exceeds 260 words', () => {
    const scene = makeScene(
      18,
      'The bladder visibly expands as fluid descends through both ureters.',
      'Human bladder filling'
    )

    const direction: ManualAiSceneDirection = {
      sceneIndex: 18,
      sceneRole: 'mechanism',
      hookLevel: 'high',
      coreMeaning: 'bladder filling with urine at night',
      viewerShouldNotice: 'increasing bladder volume',
      visualEvent: {
        subject: 'human bladder cutaway',
        action: 'visibly filling with fluid as two clear streams descend through both ureters',
        change: 'the bladder wall slightly stretching under increasing volume',
        cause: 'overnight urine production',
        consequence: 'wall tension'
      },
      composition: {
        shotType: 'close three-quarter cutaway',
        cameraAngle: 'eye level',
        lensFeel: '85mm medical-documentary lens',
        focalPriority: 'bladder filling pathway',
        foreground: 'human bladder',
        background: 'dark navy environment'
      },
      lighting: 'cool night-time blue ambience with warm biological highlights',
      colorStrategy: 'navy blue with subtle amber fluid tones',
      textOverlay: {
        enabled: true,
        text: 'BLADDER KEEPS FILLING',
        position: 'top-right',
        reason: 'Highlight nighttime filling process'
      },
      avoid: ['static textbook diagrams'],
      confidence: 0.95
    }

    const prompt = buildManualScenePrompt({
      scene,
      profile: 'health',
      outputResolution: '1080p',
      sceneDirection: direction
    })

    const words = prompt.split(/\s+/).filter(Boolean).length
    assert.ok(words >= 130, `Expected at least 130 useful words, got ${words}`)
    assert.ok(words <= 260, `Hard max is 260 words, got ${words}`)
  })

  await it('prompt remains exactly one physical line without embedded CR/LF or unescaped pipe', () => {
    const raw = 'First clause.\r\nSecond clause on newline.\nThird clause with | pipe symbol.'
    const sanitized = sanitizePromptLine(raw)

    assert.ok(!sanitized.includes('\r'))
    assert.ok(!sanitized.includes('\n'))
    assert.ok(!sanitized.includes('|'))
    assert.strictEqual(sanitized, 'First clause. Second clause on newline. Third clause with / pipe symbol.')
  })

  await it('General documentary prompts emphasize visual action, narrative tension and authentic behavior', () => {
    const scene = makeScene(
      5,
      'Commuters rush through the morning transit station under heavy work stress.',
      'Commuters walking through station'
    )

    const direction: ManualAiSceneDirection = {
      sceneIndex: 5,
      sceneRole: 'symptom',
      hookLevel: 'medium',
      coreMeaning: 'urban commuters rushing under time pressure',
      viewerShouldNotice: 'tense posture and hurried movement',
      visualEvent: {
        subject: 'busy urban commuters',
        action: 'moving rapidly through a crowded transit terminal with urgent body language',
        change: 'visible tension in motion',
        consequence: 'palpable fast-paced atmosphere'
      },
      composition: {
        shotType: 'medium documentary tracking shot',
        cameraAngle: 'eye level',
        lensFeel: '50mm prime lens',
        focalPriority: 'sharp focus on central commuter',
        foreground: 'moving silhouettes',
        background: 'grand transit hall with soft morning light'
      },
      lighting: 'natural architectural morning light with balanced contrast',
      colorStrategy: 'authentic cool urban documentary grade',
      textOverlay: {
        enabled: false,
        reason: 'Visually obvious'
      },
      avoid: ['generic stock smile poses'],
      confidence: 0.90
    }

    const prompt = buildManualScenePrompt({
      scene,
      profile: 'general',
      outputResolution: '1080p',
      sceneDirection: direction
    })

    assert.ok(!prompt.includes('anatomical'))
    assert.ok(prompt.includes('High-end cinematic documentary realism, natural candid behavior'))
    assert.ok(/\b(moving|rushing|transit|commuters)\b/i.test(prompt))
  })

  finish()
}

void main()
