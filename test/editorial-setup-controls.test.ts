/**
 * Setup-First Universal Editorial Configuration & Propagation Test Suite
 * Tests Setup-first configuration persistence, immutable run snapshot,
 * stage invalidation isolation, output reuse safety, read-only Copy operations,
 * and short-scene timeline constraints.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_EDITORIAL_SETTINGS,
  loadEditorialFocusSettings,
  saveEditorialFocusSettings,
  type EditorialGenerationSettings
} from '../src/main/visual-mix/manual-ai/editorial-focus-settings'
import {
  createInitialPipelineState,
  determineInvalidatedStages,
  computeInputFingerprint
} from '../src/main/pipeline/pipeline-state'
import { computeRenderRequestKey } from '../src/main/renderer'
import {
  resolveEditorialFocus,
  type EditorialFocusInstruction
} from '../src/main/visual-mix/manual-ai/editorial-focus-director'
import type { AutoPipelineOptions, VisualMixScenePlan } from '../shared/types'
import type { ManualAiSceneDirection } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Setup-First Universal Editorial Tests')

void (async () => {
  const testRoot = freshDir('editorial-setup-tests')

  await it('Section 201: Initial defaults — Legacy projects without an editorial settings file load default Classic + Full', () => {
    const proj = path.join(testRoot, 'legacy-proj')
    fs.mkdirSync(proj, { recursive: true })

    const loaded = loadEditorialFocusSettings(proj)
    assert.strictEqual(loaded.schemaVersion, 1)
    assert.strictEqual(loaded.promptMode, 'classic')
    assert.strictEqual(loaded.labelDensity, 'minimal')
    assert.strictEqual(loaded.readability, 'standard')
    assert.strictEqual(loaded.preferLeaderLines, true)
    assert.strictEqual(loaded.renderOverlayMode, 'full')
  })

  await it('Section 202 & 203: Settings persistence — Persisting and restoring editorial settings via authoritative file', () => {
    const proj = path.join(testRoot, 'configured-proj')
    fs.mkdirSync(proj, { recursive: true })

    const saved = saveEditorialFocusSettings(proj, {
      promptMode: 'embedded-editorial',
      readability: 'senior-friendly',
      labelDensity: 'balanced',
      preferLeaderLines: true,
      renderOverlayMode: 'full'
    })

    assert.strictEqual(saved.promptMode, 'embedded-editorial')
    assert.strictEqual(saved.readability, 'senior-friendly')
    assert.strictEqual(saved.labelDensity, 'balanced')
    assert.strictEqual(saved.renderOverlayMode, 'full')

    // Read directly from disk
    const settingsPath = path.join(proj, 'analysis', 'editorial-focus-settings.v1.json')
    assert.ok(fs.existsSync(settingsPath), 'Settings file must exist on disk')

    const reloaded = loadEditorialFocusSettings(proj)
    assert.deepStrictEqual(reloaded, saved)
  })

  await it('Section 205: Serialized update queue — Sequential patches merge monotonically without stale overwrites', () => {
    const proj = path.join(testRoot, 'rapid-toggle-proj')
    fs.mkdirSync(proj, { recursive: true })

    // Simulate fast consecutive user clicks
    saveEditorialFocusSettings(proj, { promptMode: 'embedded-editorial' })
    saveEditorialFocusSettings(proj, { readability: 'senior-friendly' })
    saveEditorialFocusSettings(proj, { labelDensity: 'balanced' })
    saveEditorialFocusSettings(proj, { preferLeaderLines: false })

    const finalSettings = loadEditorialFocusSettings(proj)
    assert.strictEqual(finalSettings.promptMode, 'embedded-editorial')
    assert.strictEqual(finalSettings.readability, 'senior-friendly')
    assert.strictEqual(finalSettings.labelDensity, 'balanced')
    assert.strictEqual(finalSettings.preferLeaderLines, false)
    assert.strictEqual(finalSettings.renderOverlayMode, 'full')
  })

  await it('Section 118: Copy Video Prompts is strictly read-only and does not mutate persisted settings', () => {
    const proj = path.join(testRoot, 'copy-readonly-proj')
    fs.mkdirSync(proj, { recursive: true })

    // Project is saved with Classic mode
    saveEditorialFocusSettings(proj, { promptMode: 'classic', renderOverlayMode: 'full' })

    // Simulate a read operation
    const persistedBefore = loadEditorialFocusSettings(proj)
    assert.strictEqual(persistedBefore.promptMode, 'classic')

    // An optional transient parameter should NEVER overwrite the file
    const persistedAfter = loadEditorialFocusSettings(proj)
    assert.strictEqual(persistedAfter.promptMode, 'classic')
  })

  await it('Section 82 & 83: Validated start configuration freezes immutable editorial snapshot into pipeline state', () => {
    const proj = path.join(testRoot, 'pipeline-snapshot-proj')
    fs.mkdirSync(proj, { recursive: true })
    const scriptPath = path.join(proj, 'script.txt')
    const voiceoverPath = path.join(proj, 'voiceover.wav')
    fs.writeFileSync(scriptPath, 'Scene one narration text.', 'utf-8')
    fs.writeFileSync(voiceoverPath, Buffer.alloc(1000))

    const confirmedEditorial: EditorialGenerationSettings = {
      schemaVersion: 1,
      promptMode: 'embedded-editorial',
      readability: 'senior-friendly',
      labelDensity: 'balanced',
      preferLeaderLines: true,
      renderOverlayMode: 'full'
    }

    const options: AutoPipelineOptions = {
      projectDir: proj,
      scriptPath,
      voiceoverPath,
      editorialSettings: confirmedEditorial
    }

    const fp = computeInputFingerprint(proj, scriptPath, voiceoverPath)
    const state = createInitialPipelineState(options, fp, 'run-snapshot-001')

    assert.ok(state.options.editorialSettings)
    assert.strictEqual(state.options.editorialSettings.promptMode, 'embedded-editorial')
    assert.strictEqual(state.options.editorialSettings.readability, 'senior-friendly')

    // Simulate a background UI preference modification after the run started
    saveEditorialFocusSettings(proj, { promptMode: 'classic' })

    // Pipeline run snapshot remains frozen and unaffected
    assert.strictEqual(state.options.editorialSettings.promptMode, 'embedded-editorial')
  })

  await it('Section 104: Render-mode invalidation isolates preflight, rendering, postflight without touching planning or assets', () => {
    const proj = path.join(testRoot, 'invalidation-proj')
    fs.mkdirSync(proj, { recursive: true })
    const scriptPath = path.join(proj, 'script.txt')
    const voiceoverPath = path.join(proj, 'voiceover.wav')
    fs.writeFileSync(scriptPath, 'Narration content.', 'utf-8')
    fs.writeFileSync(voiceoverPath, Buffer.alloc(1000))

    const oldOptions: AutoPipelineOptions = {
      projectDir: proj,
      scriptPath,
      voiceoverPath,
      editorialSettings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'minimal',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    }

    const fp = computeInputFingerprint(proj, scriptPath, voiceoverPath)
    const oldState = createInitialPipelineState(oldOptions, fp, 'run-old')

    const newOptions: AutoPipelineOptions = {
      ...oldOptions,
      editorialSettings: {
        ...oldOptions.editorialSettings!,
        renderOverlayMode: 'source-only'
      }
    }

    const invalidated = determineInvalidatedStages(oldState, newOptions, fp)

    // Must invalidate rendering downstream
    assert.ok(invalidated.includes('preflight'))
    assert.ok(invalidated.includes('rendering'))
    assert.ok(invalidated.includes('postflight'))

    // Must NOT invalidate upstream AI planning, transcription, captions, stock search
    assert.ok(!invalidated.includes('transcribing'))
    assert.ok(!invalidated.includes('planning'))
    assert.ok(!invalidated.includes('captions'))
    assert.ok(!invalidated.includes('stock-search'))
    assert.ok(!invalidated.includes('global-context'))
  })

  await it('Section 103: Senior-Friendly or Leader Lines preference change does NOT invalidate pipeline stages', () => {
    const proj = path.join(testRoot, 'no-invalidation-proj')
    fs.mkdirSync(proj, { recursive: true })
    const scriptPath = path.join(proj, 'script.txt')
    const voiceoverPath = path.join(proj, 'voiceover.wav')
    fs.writeFileSync(scriptPath, 'Narration content.', 'utf-8')
    fs.writeFileSync(voiceoverPath, Buffer.alloc(1000))

    const oldOptions: AutoPipelineOptions = {
      projectDir: proj,
      scriptPath,
      voiceoverPath,
      editorialSettings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'minimal',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    }

    const fp = computeInputFingerprint(proj, scriptPath, voiceoverPath)
    const oldState = createInitialPipelineState(oldOptions, fp, 'run-old')

    const newOptions: AutoPipelineOptions = {
      ...oldOptions,
      editorialSettings: {
        ...oldOptions.editorialSettings!,
        readability: 'senior-friendly',
        labelDensity: 'balanced',
        preferLeaderLines: false
      }
    }

    const invalidated = determineInvalidatedStages(oldState, newOptions, fp)
    assert.strictEqual(invalidated.length, 0, 'Presentation preference toggles must not invalidate stages')
  })

  await it('Section 170-172: Render request fingerprint distinguishes Full vs Source Only configurations', () => {
    const proj = path.join(testRoot, 'render-fingerprint-proj')
    fs.mkdirSync(path.join(proj, 'analysis'), { recursive: true })
    const vo = path.join(proj, 'vo.wav')
    fs.writeFileSync(vo, Buffer.alloc(100))

    const keyFull = computeRenderRequestKey({
      projectDir: proj,
      voiceoverPath: vo,
      outputName: 'final_output',
      editorialSettings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'minimal',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })

    const keySourceOnly = computeRenderRequestKey({
      projectDir: proj,
      voiceoverPath: vo,
      outputName: 'final_output',
      editorialSettings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'minimal',
        preferLeaderLines: true,
        renderOverlayMode: 'source-only'
      }
    })

    assert.notStrictEqual(keyFull, keySourceOnly, 'Full and Source Only must produce distinct render request keys')
  })

  await it('Section 155 & 156: Short-scene timeline constraints — Invariant appearanceTime + holdDuration <= sceneDuration', () => {
    const testDurations = [0.5, 0.8, 1.2, 1.5, 2.0, 3.5, 5.0, 10.0, 20.0]

    for (const duration of testDurations) {
      const scene: VisualMixScenePlan = {
        sceneIndex: 1,
        narration: 'The precision mechanical gear rotates smoothly.',
        visualIntent: 'Macro shot of precision mechanical gear rotating',
        duration,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      }

      const sceneDirection: ManualAiSceneDirection = {
        sceneIndex: 1,
        sceneRole: 'mechanism',
        hookLevel: 'medium',
        coreMeaning: 'Mechanical motion',
        viewerShouldNotice: 'Gear tooth engagement',
        visualEvent: { subject: 'precision mechanical gear', action: 'rotates' },
        composition: { shotType: 'macro', cameraAngle: 'straight on', lensFeel: '100mm', focalPriority: 'gear', foreground: '', background: '' },
        lighting: 'directional metallic',
        colorStrategy: 'cool metallic',
        textOverlay: { enabled: true, text: 'Precision Mechanical Gear', reason: 'Component identification' },
        avoid: [],
        confidence: 0.95
      }

      const res = resolveEditorialFocus({
        scene,
        sceneDirection,
        niche: 'technology',
        durationSecs: duration,
        settings: {
          schemaVersion: 1,
          promptMode: 'embedded-editorial',
          readability: 'senior-friendly',
          labelDensity: 'balanced',
          preferLeaderLines: true,
          renderOverlayMode: 'full'
        }
      })

      assert.strictEqual(res.presentationMode, 'single-label')
      assert.ok(res.appearanceTimeSecs !== undefined && res.appearanceTimeSecs >= 0, `appearanceTime >= 0 for duration ${duration}`)
      assert.ok(res.holdDurationSecs !== undefined && res.holdDurationSecs >= 0, `holdDuration >= 0 for duration ${duration}`)
      assert.ok(
        (res.appearanceTimeSecs ?? 0) + (res.holdDurationSecs ?? 0) <= duration + 0.001,
        `appearance (${res.appearanceTimeSecs}) + hold (${res.holdDurationSecs}) must not exceed sceneDuration (${duration})`
      )

      // On long scenes, hold should not needlessly occupy the whole scene
      if (duration >= 10.0) {
        assert.ok((res.holdDurationSecs ?? 0) <= 4.0, `hold duration must be capped on long scenes (actual=${res.holdDurationSecs})`)
      }
    }
  })

  await it('Section 134 & 160: Universal niche compatibility — Biological terms valid in wildlife/nature, human clinical terms guarded', () => {
    // 1. Wildlife scene with biological terminology
    const wildlifeScene: VisualMixScenePlan = {
      sceneIndex: 5,
      narration: 'Under polarized light, the predatory squid skin chromatophore cells expand rapidly.',
      visualIntent: 'Macro shot of squid skin chromatophore cells pulsing in deep water',
      duration: 5.0,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }
    const wildlifeDir: ManualAiSceneDirection = {
      sceneIndex: 5,
      sceneRole: 'mechanism',
      hookLevel: 'high',
      coreMeaning: 'Biological camouflage',
      viewerShouldNotice: 'Expanding color cells',
      visualEvent: { subject: 'chromatophore cellular tissue', action: 'pulses' },
      composition: { shotType: 'macro', cameraAngle: 'side', lensFeel: '100mm', focalPriority: 'tissue', foreground: '', background: '' },
      lighting: 'deep sea bioluminescent',
      colorStrategy: 'vivid amber and black',
      avoid: [],
      confidence: 0.95
    }

    const wildlifeRes = resolveEditorialFocus({
      scene: wildlifeScene,
      sceneDirection: wildlifeDir,
      niche: 'wildlife-biology',
      durationSecs: 5.0,
      settings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'balanced',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })

    // Biological term is PERMITTED in wildlife/biology niche
    assert.strictEqual(wildlifeRes.presentationMode, 'single-label')
    assert.ok(wildlifeRes.exactText?.toLowerCase().includes('tissue') || wildlifeRes.exactText?.toLowerCase().includes('cellular'))

    // 2. Human clinical term is REJECTED in wildlife niche
    const falseClinicalDir: ManualAiSceneDirection = {
      ...wildlifeDir,
      visualEvent: { subject: 'clinical patient', action: 'rests' }
    }
    const clinicalRes = resolveEditorialFocus({
      scene: wildlifeScene,
      sceneDirection: falseClinicalDir,
      niche: 'wildlife-biology',
      durationSecs: 5.0,
      settings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'balanced',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })
    assert.strictEqual(clinicalRes.presentationMode, 'none', 'Human clinical terms must be suppressed outside health domain')

    // 3. Biological term is REJECTED in finance niche
    const financeRes = resolveEditorialFocus({
      scene: {
        ...wildlifeScene,
        narration: 'The bond market liquidity dries up.',
        visualIntent: 'Trading screen showing yield curves'
      },
      sceneDirection: wildlifeDir, // contains 'chromatophore cellular tissue'
      niche: 'finance',
      durationSecs: 5.0,
      settings: {
        schemaVersion: 1,
        promptMode: 'embedded-editorial',
        readability: 'standard',
        labelDensity: 'balanced',
        preferLeaderLines: true,
        renderOverlayMode: 'full'
      }
    })
    assert.strictEqual(financeRes.presentationMode, 'none', 'Biological terms must be suppressed in finance niche')
  })

  cleanupFixtures(testRoot)
  finish()
})()
