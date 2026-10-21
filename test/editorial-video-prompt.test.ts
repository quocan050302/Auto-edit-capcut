/**
 * Editorial Video Prompt Composer — Test Suite
 * Tests prompt synthesis, exact label quotation, position formatting,
 * contradictory clause replacement, and single-line guarantees.
 */
import { composeEmbeddedEditorialVideoPrompt } from '../src/main/visual-mix/manual-ai/editorial-video-prompt'
import type { EditorialFocusInstruction } from '../src/main/visual-mix/manual-ai/editorial-focus-director'
import { assert, createRunner } from './manual-ai-test-utils'

const { it, finish } = createRunner('Editorial Video Prompt Tests')

void (async () => {
  await it('Section 61 & 63: Composes prompt embedding exact quoted label and focus target', () => {
    const basePrompt =
      'Photorealistic medical documentary sequence capturing human heart structures. In the beginning, establish mitral valve. As the clip progresses, maintain smooth visible development of valve leaflets flexing while the camera executes a purposeful slow macro push-in. Framing: macro cutaway shot on a 100mm medical macro lens. Environment: dark navy medical background, illuminated by clean clinical lighting. Target clip duration: 5 seconds. Horizontal 16:9 video (1920x1080). no fake diagnostic numbers, no exaggerated disease gore, no speculative molecular diagrams, no speech, no background music, no UI text, no embedded captions, no logo, no watermark. Visual keywords: heart, valve, leaflets. Avoid: cartoon organs.'

    const instruction: EditorialFocusInstruction = {
      sceneIndex: 2,
      presentationMode: 'single-label',
      exactText: 'Mitral Valve Leaflets',
      focusTarget: 'mitral valve leaflets',
      labelPosition: 'top-left',
      leaderLine: true,
      highlightTarget: true,
      animation: 'reveal-hold',
      appearanceTimeSecs: 0.5,
      holdDurationSecs: 2.5,
      readabilityProfile: 'standard',
      confidence: 0.95,
      evidenceSource: 'test'
    }

    const output = composeEmbeddedEditorialVideoPrompt({
      basePrompt,
      instruction,
      sceneDurationSecs: 5,
      outputResolution: '1080p'
    })

    // 1. Quoted exact text must be present
    assert.ok(output.includes('Display exactly: "Mitral Valve Leaflets"'))
    // 2. Position specified
    assert.ok(output.includes('top left'))
    // 3. Leader line and highlight specified
    assert.ok(output.includes('leader line extending from the label directly to the target'))
    assert.ok(output.includes('focused bounding highlight'))
    // 4. Animation and timing specified
    assert.ok(output.includes('reveal-hold'))
    assert.ok(output.includes('0.5s'))
    assert.ok(output.includes('2.5s'))
    // 5. Contradictory text directives replaced with exception clause
    assert.ok(!output.includes('no UI text'))
    assert.ok(!output.includes('no embedded captions'))
    assert.ok(output.includes('Only the exact specified editorial label is allowed. No additional on-screen text, subtitles, UI elements, logos or watermark.'))
    // 6. Non-conflicting negative directives preserved
    assert.ok(output.includes('no fake diagnostic numbers'))
    assert.ok(output.includes('no speech'))
    assert.ok(output.includes('no background music'))
    // 7. Single physical line
    assert.ok(!output.includes('\n'))
    assert.ok(!output.includes('\r'))
  })

  await it('Section 66: Replaces contradictory negative text clauses in opening video prompts', () => {
    const openingBasePrompt =
      'Photorealistic cinematic documentary sequence capturing grain separator machinery. Opening frame (0:00): The shot opens immediately on vibrating screen mesh with golden wheat grain separation, initiating immediate physical engagement. Development: As the clip progresses, mechanical separation unfolds smoothly with the camera executing a steady lateral track. Framing: close-up shot from a three-quarter angle. Environment: colony seed cleaning mill, illuminated by morning daylight. no distorted hands, no morphing equipment, no inconsistent object geometry, no unnatural movements. Target clip duration: 5 seconds. Horizontal 16:9 video (1920x1080). No speech, no dialogue, no narration audio, no background music, no text overlays, no subtitles, no watermark, no logo.'

    const instruction: EditorialFocusInstruction = {
      sceneIndex: 1,
      presentationMode: 'single-label',
      exactText: 'Vibrating Screen Mesh',
      focusTarget: 'vibrating screen mesh',
      labelPosition: 'top-right',
      leaderLine: true,
      highlightTarget: true,
      animation: 'line-draw',
      appearanceTimeSecs: 0.3,
      holdDurationSecs: 3.0,
      readabilityProfile: 'senior-friendly',
      confidence: 0.95,
      evidenceSource: 'test'
    }

    const output = composeEmbeddedEditorialVideoPrompt({
      basePrompt: openingBasePrompt,
      instruction,
      sceneDurationSecs: 5,
      outputResolution: '1080p'
    })

    // Contradictory clauses removed
    assert.ok(!output.includes('no text overlays'))
    assert.ok(!output.includes('no subtitles'))
    // Exception clause added
    assert.ok(output.includes('Only the exact specified editorial label is allowed. No additional on-screen text, subtitles, UI elements, logos or watermark.'))
    // Senior friendly typography included
    assert.ok(output.includes('Clean, ultra-high-contrast large bold sans-serif editorial typography with crisp white lettering and dark translucent pill backing'))
    // Non-conflicting negative directives preserved
    assert.ok(/no speech/i.test(output))
    assert.ok(/no dialogue/i.test(output))
    assert.ok(/no narration audio/i.test(output))
    assert.ok(/no distorted hands/i.test(output))
  })

  await it('Section 43: Composes comparison mode with primary and secondary labels', () => {
    const basePrompt =
      'Medical documentary still sequence showing blood vessels. no text overlays, no speech, no watermark.'

    const instruction: EditorialFocusInstruction = {
      sceneIndex: 5,
      presentationMode: 'comparison',
      exactText: 'Healthy Lumen',
      secondaryText: 'Calcified Plaque',
      focusTarget: 'arterial wall',
      labelPosition: 'top-left',
      leaderLine: false,
      highlightTarget: false,
      animation: 'soft-slide',
      appearanceTimeSecs: 0.5,
      holdDurationSecs: 3.0,
      readabilityProfile: 'standard',
      confidence: 0.95,
      evidenceSource: 'test'
    }

    const output = composeEmbeddedEditorialVideoPrompt({
      basePrompt,
      instruction,
      sceneDurationSecs: 5,
      outputResolution: '1080p'
    })

    assert.ok(output.includes('Embedded editorial comparison'))
    assert.ok(output.includes('Display exactly: "Healthy Lumen"'))
    assert.ok(output.includes('alongside secondary label: "Calcified Plaque"'))
    assert.ok(output.includes('soft-slide'))
  })

  await it('Section 61: Presentation mode none returns base prompt intact', () => {
    const basePrompt =
      'Photorealistic documentary sequence. no speech, no music, no text overlays, no subtitles, no logo.'

    const instruction: EditorialFocusInstruction = {
      sceneIndex: 12,
      presentationMode: 'none',
      confidence: 1.0,
      evidenceSource: 'test'
    }

    const output = composeEmbeddedEditorialVideoPrompt({
      basePrompt,
      instruction,
      sceneDurationSecs: 5,
      outputResolution: '1080p'
    })

    assert.equal(output, basePrompt)
  })

  finish()
})()
