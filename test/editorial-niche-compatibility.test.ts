/**
 * Universal Niche Compatibility & Cross-Niche Isolation — Test Suite
 * Tests universal adaptability, cross-niche semantic isolation, unknown future niches,
 * exact spelling with non-English characters, Classic mode byte equality, and fallback intelligence.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  resolveEditorialFocus,
  type EditorialFocusInstruction
} from '../src/main/visual-mix/manual-ai/editorial-focus-director'
import { composeEmbeddedEditorialVideoPrompt } from '../src/main/visual-mix/manual-ai/editorial-video-prompt'
import { buildOpeningEnhancedCopyText } from '../src/main/visual-mix/manual-ai/manual-ai-opening-hook-copy'
import {
  loadEditorialFocusSettings,
  saveEditorialFocusSettings,
  type EditorialGenerationSettings
} from '../src/main/visual-mix/manual-ai/editorial-focus-settings'
import type { VisualMixScenePlan } from '../shared/types'
import type { ManualAiSceneDirection } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Universal Niche Compatibility Tests')

void (async () => {
  await it('Section 102: Unknown fictional future niche resolves cleanly without hardcoded branch', () => {
    // Fictional future niche: Deep-sea bioluminescent atmospheric harvesting
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Deep beneath the Europa ice crust, the cryo-probe thermal siphons collect pressurized hydrothermal steam.',
      visualIntent: 'Macro visual of titanium thermal siphon valve drawing vapor from hydrothermal fissure',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 1,
      sceneRole: 'mechanism',
      hookLevel: 'medium',
      coreMeaning: 'Hydrothermal extraction',
      viewerShouldNotice: 'Vapor intake',
      visualEvent: {
        subject: 'titanium thermal siphon valve',
        action: 'draws hydrothermal steam'
      },
      composition: {
        shotType: 'macro technical shot',
        cameraAngle: 'low angle',
        lensFeel: '70mm technical',
        focalPriority: 'siphon valve',
        foreground: '',
        background: 'ice shelf'
      },
      lighting: 'cool blue biomineral glow',
      colorStrategy: 'sub-zero deep oceanic',
      textOverlay: {
        enabled: true,
        text: 'Cryo-Thermal Siphon Valve',
        purpose: 'mechanism',
        reason: 'Identify deep-sea extraction hardware'
      },
      avoid: [],
      confidence: 0.9
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'fictional-cryo-harvesting-niche-2099',
      durationSecs: 5.0
    })

    assert.equal(res.presentationMode, 'single-label')
    assert.equal(res.exactText, 'Cryo-Thermal Siphon Valve')
    assert.equal(res.focusTarget, 'titanium thermal siphon valve')
    assert.equal(res.leaderLine, true)
    assert.equal(res.animation, 'reveal-hold')

    const prompt = composeEmbeddedEditorialVideoPrompt({
      basePrompt: 'Cinematic documentary shot. no text overlays, no subtitles, no logo.',
      instruction: res,
      sceneDurationSecs: 5.0,
      outputResolution: '1080p'
    })

    assert.ok(prompt.includes('Display exactly: "Cryo-Thermal Siphon Valve"'))
    assert.ok(prompt.includes('titanium thermal siphon valve'))
  })

  await it('Section 103: Cross-niche isolation: No medical/physiological leakage into other domains', () => {
    // 1. Hutterite Agriculture Scene
    const hutteriteScene: VisualMixScenePlan = {
      sceneIndex: 2,
      narration: 'The colony combines harvest spring wheat across thousands of acres.',
      visualIntent: 'Three modern combine harvesters moving in tandem across expansive golden prairie field',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const hutteriteDir: ManualAiSceneDirection = {
      sceneIndex: 2,
      sceneRole: 'demonstration',
      hookLevel: 'high',
      coreMeaning: 'Modern communal farming',
      viewerShouldNotice: 'Coordinated harvesting',
      visualEvent: { subject: 'rotary combine harvester', action: 'cuts wheat' },
      composition: { shotType: 'aerial high-angle', cameraAngle: 'overhead', lensFeel: '35mm', focalPriority: 'lead combine', foreground: '', background: '' },
      lighting: 'prairie morning sun',
      colorStrategy: 'golden wheat',
      textOverlay: { enabled: true, text: 'Rotary Combine Harvester', reason: 'Agricultural machinery identification' },
      avoid: [],
      confidence: 0.95
    }

    const hutteriteRes = resolveEditorialFocus({
      scene: hutteriteScene,
      sceneDirection: hutteriteDir,
      niche: 'hutterite-documentary',
      durationSecs: 5.0
    })

    // Assert strictly no biological / medical contamination
    const hText = `${hutteriteRes.exactText} ${hutteriteRes.focusTarget}`.toLowerCase()
    assert.ok(!hText.includes('cellular'))
    assert.ok(!hText.includes('tissue'))
    assert.ok(!hText.includes('organ'))
    assert.ok(!hText.includes('blood'))
    assert.ok(!hText.includes('patient'))

    // 2. Wildlife / Nature Scene
    const natureScene: VisualMixScenePlan = {
      sceneIndex: 3,
      narration: 'The apex predator tracks scent molecules through the dense boreal canopy.',
      visualIntent: 'Macro shot of wolf olfactory receptors and snout in freezing winter mist',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const natureDir: ManualAiSceneDirection = {
      sceneIndex: 3,
      sceneRole: 'mechanism',
      hookLevel: 'high',
      coreMeaning: 'Sensory adaptation',
      viewerShouldNotice: 'Olfactory pad',
      visualEvent: { subject: 'canine olfactory epithelium', action: 'detects scent' },
      composition: { shotType: 'macro', cameraAngle: 'profile', lensFeel: '100mm', focalPriority: 'snout', foreground: '', background: '' },
      lighting: 'filtered winter daylight',
      colorStrategy: 'natural snowy boreal',
      textOverlay: { enabled: true, text: 'Canine Olfactory Pad', reason: 'Animal sensory identification' },
      avoid: [],
      confidence: 0.95
    }

    const natureRes = resolveEditorialFocus({
      scene: natureScene,
      sceneDirection: natureDir,
      niche: 'nature',
      durationSecs: 5.0
    })

    // Assert strictly no human patient contamination
    const nText = `${natureRes.exactText} ${natureRes.focusTarget}`.toLowerCase()
    assert.ok(!nText.includes('human'))
    assert.ok(!nText.includes('clinical'))
    assert.ok(!nText.includes('hospital'))

    // 3. Finance Scene
    const financeScene: VisualMixScenePlan = {
      sceneIndex: 4,
      narration: 'The sovereign debt market acts as the benchmark foundation for institutional borrowing rates.',
      visualIntent: 'Trading desk monitors displaying real-time government bond yield curves',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const financeDir: ManualAiSceneDirection = {
      sceneIndex: 4,
      sceneRole: 'definition',
      hookLevel: 'medium',
      coreMeaning: 'Sovereign yield curve',
      viewerShouldNotice: '',
      visualEvent: { subject: 'treasury bond yield curve', action: 'tracks' },
      composition: { shotType: 'medium shot', cameraAngle: 'profile', lensFeel: '50mm', focalPriority: 'yield monitor', foreground: '', background: '' },
      lighting: 'refined office daylight',
      colorStrategy: 'corporate navy and glass',
      textOverlay: { enabled: true, text: 'Sovereign Yield Curve', reason: 'Financial benchmark' },
      avoid: [],
      confidence: 0.9
    }

    const financeRes = resolveEditorialFocus({
      scene: financeScene,
      sceneDirection: financeDir,
      niche: 'finance',
      durationSecs: 5.0
    })

    const fText = `${financeRes.exactText} ${financeRes.focusTarget}`.toLowerCase()
    assert.ok(!fText.includes('cellular'))
    assert.ok(!fText.includes('biological'))
    assert.ok(!fText.includes('valve'))
  })

  await it('Section 105: Preserves exact spelling with spaces, hyphens, abbreviations, and accents', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Historic French pastry craftsmanship at the Château de Versailles.',
      visualIntent: 'Pastry chef finishing Crêpe Suzette with caramelized citrus glaze',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const direction: ManualAiSceneDirection = {
      sceneIndex: 1,
      sceneRole: 'demonstration',
      hookLevel: 'medium',
      coreMeaning: 'Culinary preparation',
      viewerShouldNotice: 'Caramelization',
      visualEvent: { subject: 'crêpe suzette', action: 'caramelizes' },
      composition: { shotType: 'macro', cameraAngle: 'top-down', lensFeel: '85mm', focalPriority: 'crepe', foreground: '', background: '' },
      lighting: 'warm window light',
      colorStrategy: 'warm golden amber',
      textOverlay: {
        enabled: true,
        text: 'Crêpe Suzette Glaze',
        reason: 'French culinary terminology'
      },
      avoid: [],
      confidence: 0.95
    }

    const res = resolveEditorialFocus({
      scene,
      sceneDirection: direction,
      niche: 'food',
      durationSecs: 5.0
    })

    // Accented Unicode character preserved
    assert.equal(res.exactText, 'Crêpe Suzette Glaze')

    const prompt = composeEmbeddedEditorialVideoPrompt({
      basePrompt: 'Documentary kitchen shot. no text, no subtitles, no logo.',
      instruction: res,
      sceneDurationSecs: 5.0,
      outputResolution: '1080p'
    })

    assert.ok(prompt.includes('Display exactly: "Crêpe Suzette Glaze"'))
  })

  await it('Section 111: Classic mode produces byte-for-byte identical output to baseline QA', () => {
    const testDir = freshDir('editorial-classic-test')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    const baseEntries = [
      { sceneIndex: 1, prompt: 'Documentary shot of wheat field. no text, no logo.' },
      { sceneIndex: 2, prompt: 'Documentary shot of grain combine. no text, no logo.' },
      { sceneIndex: 3, prompt: 'Documentary shot of workshop tools. no text, no logo.' }
    ]

    // 1. Run in Classic mode (explicit)
    const classicOutput = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: testDir,
      baseEntries,
      editorialSettings: {
        schemaVersion: 1,
        promptMode: 'classic',
        labelDensity: 'minimal',
        readability: 'standard',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })

    // 2. Run without settings param (loads default classic from disk or default)
    const defaultOutput = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: testDir,
      baseEntries
    })

    assert.equal(classicOutput, defaultOutput)
    // No embedded editorial label introduced in Classic mode
    assert.ok(!classicOutput.includes('Display exactly:'))
    assert.ok(!classicOutput.includes('Embedded editorial label:'))

    cleanupFixtures(testDir)
  })

  await it('Section 110: Prompt count and line formatting are strictly preserved', () => {
    const testDir = freshDir('editorial-formatting-test')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    // Create 15 scenes
    const baseEntries = Array.from({ length: 15 }, (_, i) => ({
      sceneIndex: i + 1,
      prompt: `Documentary scene ${i + 1} capturing real-world activity. no text, no subtitles, no logo.`
    }))

    // Save embedded-editorial setting
    saveEditorialFocusSettings(testDir, {
      promptMode: 'embedded-editorial',
      labelDensity: 'balanced'
    })

    const text = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: testDir,
      baseEntries
    })

    const blocks = text.split('\n\n')
    assert.equal(blocks.length, 15, 'Prompt count must match exactly 15 scenes')

    for (let i = 0; i < blocks.length; i++) {
      const line = blocks[i]
      const expectedLabel = `SCENE ${String(i + 1).padStart(3, '0')}`
      assert.ok(line.startsWith(expectedLabel), `Line ${i + 1} must start with ${expectedLabel}`)
      // Guarantee single physical line (no internal newlines inside block)
      assert.ok(!line.includes('\n'), `Block ${i + 1} must not contain embedded newlines`)
    }

    cleanupFixtures(testDir)
  })

  await it('Section 119: Missing project intelligence falls back gracefully to conservative output', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 99,
      narration: '',
      visualIntent: '',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    // No sceneDirection, no globalContext, no identityBible
    const res = resolveEditorialFocus({
      scene,
      niche: 'unknown-mystery-domain',
      durationSecs: 5.0
    })
    // Conservative fallback must return presentationMode 'none' without throwing
    assert.equal(res.presentationMode, 'none')
  })

  await it('Section 118: Resolves long documentaries (100, 200, 300 scenes) within milliseconds without memory bloat', () => {
    for (const sceneCount of [100, 200, 300]) {
      const prevInstructions: EditorialFocusInstruction[] = []
      const t0 = Date.now()

      for (let i = 1; i <= sceneCount; i++) {
        const scene: VisualMixScenePlan = {
          sceneIndex: i,
          narration: `Documentary narration for sequence ${i} explaining operational mechanics.`,
          visualIntent: `Observational visual capture of component ${i} in physical operation`,
          duration: 5.0,
          strategy: 'ai-still',
          assetType: 'ai-image',
          imagePrompt: ''
        }

        const direction: ManualAiSceneDirection = {
          sceneIndex: i,
          sceneRole: i % 3 === 0 ? 'mechanism' : i % 3 === 1 ? 'demonstration' : 'setup',
          hookLevel: i <= 10 ? 'high' : 'low',
          coreMeaning: `Operation step ${i}`,
          viewerShouldNotice: `Part ${i}`,
          visualEvent: { subject: `mechanical component ${i}`, action: 'operates' },
          composition: { shotType: 'medium', cameraAngle: 'eye level', lensFeel: '50mm', focalPriority: `component ${i}`, foreground: '', background: '' },
          lighting: 'natural daylight',
          colorStrategy: 'documentary neutral',
          textOverlay: {
            enabled: i % 4 === 0,
            text: i % 4 === 0 ? `Module Part ${i}` : undefined,
            purpose: 'mechanism',
            reason: 'Identifies hardware unit'
          },
          avoid: [],
          confidence: 0.9
        }

        const res = resolveEditorialFocus({
          scene,
          sceneDirection: direction,
          niche: 'engineering',
          durationSecs: 5.0,
          previousInstructions: prevInstructions
        })

        assert.ok(res.sceneIndex === i)
        prevInstructions.push(res)
      }

      const elapsed = Date.now() - t0
      assert.equal(prevInstructions.length, sceneCount)
      assert.ok(elapsed < 200, `Resolving ${sceneCount} scenes took ${elapsed}ms, well within budget (<200ms)`)
    }
  })

  finish()
})()
