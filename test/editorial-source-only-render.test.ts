/**
 * Source Only Render Mode & Cache Isolation — Test Suite
 * Tests effective overlay policy, Remotion skipping in Source Only mode,
 * cache fingerprint isolation, and project-scoped settings fallback.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  resolveEffectiveOverlayPolicy,
  type EffectiveOverlayPolicy
} from '../src/main/render-cache/editorial-render-policy'
import {
  loadEditorialFocusSettings,
  saveEditorialFocusSettings,
  DEFAULT_EDITORIAL_SETTINGS,
  type EditorialGenerationSettings
} from '../src/main/visual-mix/manual-ai/editorial-focus-settings'
import {
  computeRenderFingerprint,
  computeCompositeFingerprint,
  type RenderFingerprintInput,
  type VisualBaseSettings
} from '../src/main/render-cache/render-fingerprint'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Source Only Render Tests')

void (async () => {
  await it('Section 89 & 93: resolveEffectiveOverlayPolicy correctly resolves Full vs Source Only', () => {
    // 1. Full mode (default)
    const fullPolicy = resolveEffectiveOverlayPolicy({ renderOverlayMode: 'full' })
    assert.equal(fullPolicy.mode, 'full')
    assert.equal(fullPolicy.renderCaptions, true)
    assert.equal(fullPolicy.renderProofVisuals, true)
    assert.equal(fullPolicy.renderVisualGrammar, true)
    assert.equal(fullPolicy.renderOpeningGraphics, true)

    // 2. Default/null fallback
    const defaultPolicy = resolveEffectiveOverlayPolicy(null)
    assert.equal(defaultPolicy.mode, 'full')
    assert.equal(defaultPolicy.renderCaptions, true)

    // 3. Source Only mode
    const sourceOnlyPolicy = resolveEffectiveOverlayPolicy({ renderOverlayMode: 'source-only' })
    assert.equal(sourceOnlyPolicy.mode, 'source-only')
    assert.equal(sourceOnlyPolicy.renderCaptions, false)
    assert.equal(sourceOnlyPolicy.renderProofVisuals, false)
    assert.equal(sourceOnlyPolicy.renderVisualGrammar, false)
    assert.equal(sourceOnlyPolicy.renderOpeningGraphics, false)
  })

  await it('Section 98: Render fingerprint isolation guarantees distinct cache keys', () => {
    const base: VisualBaseSettings = {
      width: 1920,
      height: 1080,
      fps: 30,
      encoderProfile: 'libx264:fast:crf20'
    }

    const inputFull: RenderFingerprintInput = {
      masterEditPlanHash: 'hash-plan-123',
      mediaIndexHash: 'hash-media-456',
      stockAssignmentsHash: 'hash-stock-789',
      captionPlanHash: 'hash-captions-abc',
      audioPlanHash: 'hash-audio-def',
      voiceover: null,
      base,
      transitionSettings: null,
      retentionSettings: { enabled: true },
      proofVisualSettings: { enabled: true },
      visualGrammarSettings: {},
      sceneFingerprints: ['sc1', 'sc2'],
      renderOverlayMode: 'full'
    }

    const inputSourceOnly: RenderFingerprintInput = {
      ...inputFull,
      renderOverlayMode: 'source-only'
    }

    const fpFull = computeRenderFingerprint(inputFull)
    const fpSourceOnly = computeRenderFingerprint(inputSourceOnly)

    // Fingerprints must be strictly distinct
    assert.notEqual(fpFull, fpSourceOnly)

    // Switching Full -> Source Only -> Full returns identical original key
    const fpFullAgain = computeRenderFingerprint(inputFull)
    assert.equal(fpFull, fpFullAgain)
  })

  await it('Section 94: Composite fingerprint distinguishes overlaid composite from no-overlay audio-mixed composite', () => {
    const base: VisualBaseSettings = {
      width: 1920,
      height: 1080,
      fps: 30,
      encoderProfile: 'libx264:fast:crf20'
    }

    const compOverlaid = computeCompositeFingerprint({
      audioFingerprint: 'audio-mix-123',
      overlayBlockFingerprints: ['block-0', 'block-1'],
      base
    })

    const compNoOverlay = computeCompositeFingerprint({
      audioFingerprint: 'audio-mix-123',
      overlayBlockFingerprints: null, // No overlay branch
      base
    })

    assert.notEqual(compOverlaid, compNoOverlay)
  })

  await it('Section 116: Legacy project without editorial settings falls back to Classic and Full', () => {
    const testDir = freshDir('legacy-project-test')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    // No editorial-focus-settings.v1.json exists yet
    const loaded = loadEditorialFocusSettings(testDir)

    assert.equal(loaded.schemaVersion, 1)
    assert.equal(loaded.promptMode, 'classic')
    assert.equal(loaded.renderOverlayMode, 'full')
    assert.equal(loaded.labelDensity, 'minimal')
    assert.equal(loaded.readability, 'standard')

    cleanupFixtures(testDir)
  })

  await it('Section 75 & 76: Settings are strictly project-scoped without global config mutations', () => {
    const project1 = freshDir('project-scope-1')
    const project2 = freshDir('project-scope-2')

    fs.mkdirSync(path.join(project1, 'analysis'), { recursive: true })
    fs.mkdirSync(path.join(project2, 'analysis'), { recursive: true })

    saveEditorialFocusSettings(project1, {
      promptMode: 'embedded-editorial',
      renderOverlayMode: 'source-only',
      readability: 'senior-friendly'
    })

    const s1 = loadEditorialFocusSettings(project1)
    const s2 = loadEditorialFocusSettings(project2)

    // Project 1 has custom settings
    assert.equal(s1.promptMode, 'embedded-editorial')
    assert.equal(s1.renderOverlayMode, 'source-only')
    assert.equal(s1.readability, 'senior-friendly')

    // Project 2 remains default Classic and Full
    assert.equal(s2.promptMode, 'classic')
    assert.equal(s2.renderOverlayMode, 'full')

    cleanupFixtures(project1)
    cleanupFixtures(project2)
  })

  finish()
})()
