/**
 * Manual AI Visual Director — Smart Editorial Text Overlay tests.
 * Tests: selective overlay density (<=35%), max 2 consecutive overlays,
 * word count limits (2-5 words, <=28 chars), invented number rejection,
 * caption safe area positioning.
 */
import {
  applySmartOverlayPass
} from '../src/main/visual-mix/manual-ai/manual-ai-visual-director'
import type {
  ManualAiSceneDirection
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { assert, createRunner } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Smart Text Overlay Tests')

function makeMockDirection(index: number, text?: string, role: any = 'mechanism', position = 'top-right'): ManualAiSceneDirection {
  return {
    sceneIndex: index,
    sceneRole: role,
    hookLevel: 'medium',
    coreMeaning: `Scene ${index} explanation about kidney processes`,
    viewerShouldNotice: 'filtration action',
    visualEvent: {
      subject: 'kidneys',
      action: 'filtering blood'
    },
    composition: {
      shotType: 'close cutaway',
      cameraAngle: 'eye level',
      lensFeel: '85mm',
      focalPriority: 'organ',
      foreground: 'organ',
      background: 'dark navy'
    },
    lighting: 'cool rim',
    colorStrategy: 'navy and crimson',
    textOverlay: {
      enabled: !!text,
      text,
      position: position as any,
      reason: 'Editorial clarity'
    },
    avoid: [],
    confidence: 0.9
  }
}

async function main(): Promise<void> {
  console.log('\nManual AI Smart Text Overlay')

  await it('overlay density does not exceed 35% of AI-owned scenes', () => {
    // 100 scenes, all with overlay requested
    const directions: ManualAiSceneDirection[] = Array.from({ length: 100 }, (_, i) => {
      const idx = i + 1
      const role = idx === 1 ? 'hook' : idx % 5 === 0 ? 'statistic' : 'mechanism'
      return makeMockDirection(idx, `KEY TAKEAWAY ${idx}`, role)
    })

    const scriptText = 'This is a medical documentary about kidneys and fluid balance.'
    applySmartOverlayPass(directions, scriptText, 'health')

    const enabled = directions.filter((d) => d.textOverlay.enabled)
    assert.ok(enabled.length <= 35, `Overlay count ${enabled.length} must not exceed 35%`)
    assert.ok(enabled.length >= 25, `Overlay count ${enabled.length} should target 25-35%`)
  })

  await it('prevents more than 2 consecutive scenes from having overlays enabled', () => {
    // 5 scenes in a row all with overlays
    const directions: ManualAiSceneDirection[] = [
      makeMockDirection(1, 'FIRST HOOK', 'hook'),
      makeMockDirection(2, 'SECOND POINT', 'mechanism'),
      makeMockDirection(3, 'THIRD POINT', 'mechanism'),
      makeMockDirection(4, 'FOURTH POINT', 'mechanism'),
      makeMockDirection(5, 'FIFTH POINT', 'lifestyle')
    ]

    const scriptText = 'Full narration text covering points one through five.'
    applySmartOverlayPass(directions, scriptText, 'health')

    for (let i = 0; i < directions.length - 2; i++) {
      const consecutive =
        directions[i].textOverlay.enabled &&
        directions[i + 1].textOverlay.enabled &&
        directions[i + 2].textOverlay.enabled
      assert.ok(!consecutive, `Scenes ${i + 1}, ${i + 2}, ${i + 3} must not all have overlays enabled`)
    }
  })

  await it('rejects invented numbers that are NOT present in narration or script', () => {
    const directions: ManualAiSceneDirection[] = [
      makeMockDirection(1, '50% MORE URINE', 'statistic') // "50%" is NOT in script
    ]

    const scriptText = 'Narration explains that kidneys filter fluid during sleep without mentioning any statistics.'
    applySmartOverlayPass(directions, scriptText, 'health')

    assert.strictEqual(
      directions[0].textOverlay.enabled,
      false,
      'Overlay with invented number 50% must be disabled'
    )
  })

  await it('permits numbers that ARE grounded in narration or script', () => {
    const directions: ManualAiSceneDirection[] = [
      makeMockDirection(1, 'AT 2 A.M.', 'hook')
    ]

    const scriptText = 'At 2 A.M., your body experiences a shift in blood flow.'
    applySmartOverlayPass(directions, scriptText, 'health')

    assert.strictEqual(directions[0].textOverlay.enabled, true, 'Overlay with grounded number should remain enabled')
    assert.strictEqual(directions[0].textOverlay.text, 'AT 2 A.M.')
  })

  await it('enforces word count (max 5 words) and length (max 28 chars)', () => {
    const longText = 'THIS IS AN EXTREMELY LONG EDITORIAL TEXT PHRASE THAT SHOULD BE TRUNCATED'
    const directions: ManualAiSceneDirection[] = [
      makeMockDirection(1, longText, 'hook')
    ]

    applySmartOverlayPass(directions, 'script text', 'health')

    if (directions[0].textOverlay.enabled) {
      const words = directions[0].textOverlay.text!.split(/\s+/).length
      assert.ok(words <= 5, `Words must be <= 5, got ${words}`)
      assert.ok(directions[0].textOverlay.text!.length <= 28, `Length must be <= 28 chars`)
    }
  })

  await it('enforces caption-safe positioning (never bottom)', () => {
    const directions: ManualAiSceneDirection[] = [
      makeMockDirection(1, 'VALID OVERLAY', 'hook', 'bottom-center' as any)
    ]

    applySmartOverlayPass(directions, 'Valid script text', 'health')

    assert.notStrictEqual(directions[0].textOverlay.position, 'bottom-center')
    assert.ok(
      ['top-left', 'top-right', 'center-left', 'center-right'].includes(directions[0].textOverlay.position!)
    )
  })

  finish()
}

void main()
