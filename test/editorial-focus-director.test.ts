/**
 * Editorial Focus Director — Test Suite
 * Tests universal scene-specific editorial intelligence, grounded text resolution,
 * animation selection, senior-friendly readability, and irrelevant label suppression.
 */
import {
  resolveEditorialFocus,
  type EditorialFocusInstruction
} from '../src/main/visual-mix/manual-ai/editorial-focus-director'
import type { VisualMixScenePlan } from '../shared/types'
import type { ManualAiSceneDirection } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { assert, createRunner } from './manual-ai-test-utils'

const { it, finish } = createRunner('Editorial Focus Director Tests')

void (async () => {
  await it('Section 28 & 29: Resolves grounded editorial focus instruction deterministically', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Deep inside the engine, the high-pressure fuel injector atomizes diesel into the combustion chamber.',
      visualIntent: 'Macro cutaway of high-pressure fuel injector nozzle releasing fine spray',
      duration: 5.5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 1,
      sceneRole: 'mechanism',
      hookLevel: 'medium',
      coreMeaning: 'Demonstrating diesel atomization',
      viewerShouldNotice: 'Spray dispersion pattern',
      visualEvent: {
        subject: 'fuel injector nozzle',
        action: 'atomizes diesel droplets'
      },
      composition: {
        shotType: 'macro cutaway shot',
        cameraAngle: 'level profile',
        lensFeel: '100mm macro',
        focalPriority: 'fuel injector nozzle',
        foreground: 'clear',
        background: 'combustion chamber wall'
      },
      lighting: 'cool industrial rim light',
      colorStrategy: 'high contrast mechanical',
      textOverlay: {
        enabled: true,
        text: 'Fuel Injector Nozzle',
        purpose: 'mechanism',
        position: 'top-left',
        emphasis: 'high',
        reason: 'Identify primary physical component'
      },
      avoid: [],
      confidence: 0.95
    }

    const res1 = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'technology',
      durationSecs: 5.5
    })

    const res2 = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'technology',
      durationSecs: 5.5
    })

    assert.equal(res1.presentationMode, 'single-label')
    assert.equal(res1.exactText, 'Fuel Injector Nozzle')
    assert.equal(res1.focusTarget, 'fuel injector nozzle')
    assert.equal(res1.labelPosition, 'top-left')
    assert.equal(res1.leaderLine, true)
    assert.equal(res1.highlightTarget, true)
    assert.equal(res1.animation, 'reveal-hold')
    assert.equal(res1.appearanceTimeSecs, 0.3)
    assert.ok(res1.holdDurationSecs && res1.holdDurationSecs <= 5.5)
    // Determinism test
    assert.deepStrictEqual(res1, res2)
  })

  await it('Section 05 & 104: Irrelevant label suppression returns presentationMode none', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 15,
      narration: 'And so life continues peacefully across the surrounding countryside.',
      visualIntent: 'Wide panoramic establishing view of distant hills at sunset with soft breeze',
      duration: 4.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const res = resolveEditorialFocus({
      scene,
      niche: 'travel',
      durationSecs: 4.0
    })

    assert.equal(res.presentationMode, 'none')
    assert.equal(res.exactText, undefined)
  })

  await it('Section 41: Rejects invented numerical claims not grounded in narration', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 8,
      narration: 'The system regulates overall liquid flow rate automatically.',
      visualIntent: 'Digital pressure sensor monitoring fluid line',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 8,
      sceneRole: 'mechanism',
      hookLevel: 'low',
      coreMeaning: 'Fluid pressure control',
      viewerShouldNotice: 'Flow regulation',
      visualEvent: { subject: 'flow valve', action: 'regulates pressure' },
      composition: { shotType: 'close-up', cameraAngle: 'straight', lensFeel: '50mm', focalPriority: 'valve', foreground: '', background: '' },
      lighting: 'ambient',
      colorStrategy: 'neutral',
      textOverlay: {
        enabled: true,
        text: '94.6% Efficiency Rate', // Invented statistic! Not in narration!
        purpose: 'stat',
        reason: 'Fabricated performance claim'
      },
      avoid: [],
      confidence: 0.9
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'technology',
      durationSecs: 5.0
    })

    // Invented number must be suppressed
    assert.equal(res.presentationMode, 'none')
    assert.ok(res.warnings.some((w) => w.includes('Suppressed invented numerical text')))
  })

  await it('Section 41: Permits grounded numbers that ARE present in narration', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 9,
      narration: 'Operating at over 400 degrees Celsius, the furnace transforms silica into glass.',
      visualIntent: 'Glowing furnace interior at 400C melting silica sand',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 9,
      sceneRole: 'mechanism',
      hookLevel: 'medium',
      coreMeaning: 'Thermal processing',
      viewerShouldNotice: 'Melting point',
      visualEvent: { subject: 'thermal furnace', action: 'melts silica' },
      composition: { shotType: 'macro', cameraAngle: 'profile', lensFeel: '85mm', focalPriority: 'furnace', foreground: '', background: '' },
      lighting: 'fiery orange core glow',
      colorStrategy: 'warm furnace',
      textOverlay: {
        enabled: true,
        text: '400°C Thermal Core',
        purpose: 'stat',
        reason: 'Temperature explicitly verified in narration'
      },
      avoid: [],
      confidence: 0.95
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'technology',
      durationSecs: 5.0
    })

    assert.equal(res.presentationMode, 'single-label')
    assert.ok(res.exactText?.includes('400'))
  })

  await it('Section 42: Prevents duplicate consecutive explanations', () => {
    const scene1: VisualMixScenePlan = {
      sceneIndex: 4,
      narration: 'The turbine rotor spins at maximum velocity.',
      visualIntent: 'Close-up of turbine rotor',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const direction1: ManualAiSceneDirection = {
      sceneIndex: 4,
      sceneRole: 'mechanism',
      hookLevel: 'medium',
      coreMeaning: '',
      viewerShouldNotice: '',
      visualEvent: { subject: 'turbine rotor', action: 'spins' },
      composition: { shotType: '', cameraAngle: '', lensFeel: '', focalPriority: '', foreground: '', background: '' },
      lighting: '',
      colorStrategy: '',
      textOverlay: { enabled: true, text: 'Turbine Rotor', reason: '' },
      avoid: [],
      confidence: 0.9
    }

    const res1 = resolveEditorialFocus({
      scene: scene1,
      sceneDirection: direction1,
      niche: 'technology',
      durationSecs: 5.0
    })

    const scene2: VisualMixScenePlan = {
      sceneIndex: 5,
      narration: 'As the turbine rotor maintains steady kinetic motion.',
      visualIntent: 'Another view of turbine rotor',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const direction2: ManualAiSceneDirection = {
      sceneIndex: 5,
      sceneRole: 'mechanism',
      hookLevel: 'medium',
      coreMeaning: '',
      viewerShouldNotice: '',
      visualEvent: { subject: 'turbine rotor', action: 'rotates' },
      composition: { shotType: '', cameraAngle: '', lensFeel: '', focalPriority: '', foreground: '', background: '' },
      lighting: '',
      colorStrategy: '',
      textOverlay: { enabled: true, text: 'Turbine Rotor', reason: '' },
      avoid: [],
      confidence: 0.9
    }

    const res2 = resolveEditorialFocus({
      scene: scene2,
      sceneDirection: direction2,
      niche: 'technology',
      durationSecs: 5.0,
      previousInstructions: [res1]
    })

    // The second scene must be suppressed due to consecutive duplicate label
    assert.equal(res1.presentationMode, 'single-label')
    assert.equal(res2.presentationMode, 'none')
    assert.equal(res2.evidenceSource, 'deduplication')
  })

  await it('Section 45: Avoids pointing leader lines at abstract concepts', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 7,
      narration: 'Compound interest accelerates wealth accumulation over multi-decade horizons.',
      visualIntent: 'Editorial visual representation of long-term compound growth',
      duration: 6.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 7,
      sceneRole: 'definition',
      hookLevel: 'medium',
      coreMeaning: 'Compound growth principle',
      viewerShouldNotice: '',
      visualEvent: { subject: 'growth concept', action: 'compounds' },
      composition: { shotType: 'medium', cameraAngle: 'eye level', lensFeel: '50mm', focalPriority: 'concept', foreground: '', background: '' },
      lighting: '',
      colorStrategy: '',
      textOverlay: { enabled: true, text: 'Compound Growth', reason: 'Educational financial terminology' },
      avoid: [],
      confidence: 0.9
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'finance',
      durationSecs: 6.0
    })

    assert.equal(res.presentationMode, 'single-label')
    assert.equal(res.exactText, 'Compound Growth')
    // Leader line must be false for abstract concepts
    assert.equal(res.leaderLine, false)
  })

  await it('Section 37 & 107: Senior-friendly readability emphasizes high-contrast & steady animation', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 3,
      narration: 'The mitral valve prevents blood from flowing backward into the left atrium.',
      visualIntent: 'Anatomical cross section of heart mitral valve leaflets flexing under ventricular pressure',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 3,
      sceneRole: 'mechanism',
      hookLevel: 'high',
      coreMeaning: 'Valvular mechanics',
      viewerShouldNotice: 'Valve leaflets closing',
      visualEvent: { subject: 'mitral valve leaflets', action: 'flex and seal' },
      composition: { shotType: 'macro cutaway', cameraAngle: 'three-quarter', lensFeel: '100mm macro', focalPriority: 'mitral valve', foreground: '', background: '' },
      lighting: 'clinical blue rim',
      colorStrategy: 'anatomical medical',
      textOverlay: { enabled: true, text: 'Mitral Valve', reason: 'Anatomical callout' },
      avoid: [],
      confidence: 0.95
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'health',
      durationSecs: 5.0,
      settings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        labelDensity: 'minimal',
        readability: 'senior-friendly',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })

    assert.equal(res.presentationMode, 'single-label')
    assert.equal(res.readabilityProfile, 'senior-friendly')
    // Senior friendly prefers line-draw or fade-in over rapid focus-pop or bouncy movement
    assert.equal(res.animation, 'line-draw')
  })

  await it('Section 43: Resolves comparison mode with primary and secondary labels', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 6,
      narration: 'Comparing healthy arterial lining with calcified arterial plaque accumulation.',
      visualIntent: 'Split cross section showing clear elastic vessel lumen vs stenotic calcified plaque lumen',
      duration: 6.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 6,
      sceneRole: 'comparison',
      hookLevel: 'high',
      coreMeaning: 'Vessel comparison',
      viewerShouldNotice: 'Lumen constriction',
      visualEvent: { subject: 'arterial wall', action: 'narrows' },
      composition: { shotType: 'side-by-side macro', cameraAngle: 'straight cross section', lensFeel: '100mm', focalPriority: 'artery', foreground: '', background: '' },
      lighting: '',
      colorStrategy: '',
      textOverlay: {
        enabled: true,
        text: 'Healthy Lumen vs Calcified Plaque',
        purpose: 'comparison',
        reason: 'Direct physiological comparative analysis'
      },
      avoid: [],
      confidence: 0.95
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'health',
      durationSecs: 6.0
    })

    assert.equal(res.presentationMode, 'comparison')
    assert.equal(res.exactText, 'Healthy Lumen')
    assert.equal(res.secondaryText, 'Calcified Plaque')
    assert.equal(res.animation, 'soft-slide')
  })

  finish()
})()
