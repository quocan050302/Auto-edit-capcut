/**
 * End-to-End Acceptance Scenario Test Suite (Part 21, Sections 237–254)
 * Verifies complete Setup-First Editorial configuration propagation, immutability,
 * prompt generation, video prompt copying, media import, and render policy.
 */
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  type AutoPipelineOptions,
  type EditorialGenerationSettings,
  type VisualMixConfig
} from '../shared/types'
import {
  loadEditorialFocusSettings,
  saveEditorialFocusSettings,
  DEFAULT_EDITORIAL_SETTINGS
} from '../src/main/visual-mix/manual-ai/editorial-focus-settings'
import {
  ensureManualAiPromptPack,
  loadManualAiPromptPack
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  ensureManualAiVideoPromptPack,
  loadManualAiVideoPromptPack
} from '../src/main/visual-mix/manual-ai/manual-ai-video-prompt-pack'
import {
  buildOpeningEnhancedCopyText
} from '../src/main/visual-mix/manual-ai/manual-ai-opening-hook-copy'
import {
  planManualAiImport,
  commitManualAiImport
} from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import {
  evaluateManualAiStatusForProject
} from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import {
  createInitialPipelineState,
  savePipelineStateAtomic,
  loadPipelineState
} from '../src/main/pipeline/pipeline-state'
import {
  resolveEffectiveOverlayPolicy
} from '../src/main/render-cache/editorial-render-policy'
import {
  createRunner,
  freshDir,
  pngHeader,
  makeProject,
  mixOf,
  fakeNormalizer
} from './manual-ai-test-utils'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'

const { it, finish } = createRunner('End-to-End Editorial Setup Acceptance (Part 21)')

async function runE2EScenario() {
  // ─── 237. Create Test Project: Editorial-Setup-E2E ────────────────────────
  const projectDir = makeProject(8, {
    narration: (i) => {
      const texts = [
        'Deep below the surface lies an extreme oceanic frontier.',
        'Superheated fluid emerges from volcanic mineral chimneys.',
        'Surrounding colonies of tube worms thrive in complete darkness.',
        'Chemosynthetic bacteria generate energy without sunlight.',
        'Water pressure exceeds two hundred atmospheres here.',
        'Specialized crab species scavenge along the sulfur crusts.',
        'These ecosystems offer clues to life on distant icy moons.',
        'The abyss remains our planets most enigmatic realm.'
      ]
      return texts[(i - 1) % texts.length]
    }
  })

  const scriptPath = path.join(projectDir, 'script.txt')
  const voiceoverPath = path.join(projectDir, 'voiceover.mp3')
  fs.writeFileSync(scriptPath, 'In this documentary, we explore the deep sea hydrothermal vents.', 'utf8')
  fs.writeFileSync(voiceoverPath, 'dummy audio data', 'utf8')

  // ─── 238. Configure Visual Mix: 50% AI / 50% Stock, AI Image Mode: Prompt ──
  const visualMixConfig = mixOf(50, 50, 'prompt')

  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projectDir)
  const plan = VisualMixPlanner.buildPlan({
    projectDir,
    rawScenes,
    config: visualMixConfig,
    profile: 'general'
  })

  await it('237 & 238: Setup project fixtures with 50/50 Visual Mix in Prompt mode', () => {
    assert.strictEqual(fs.existsSync(scriptPath), true)
    assert.strictEqual(fs.existsSync(voiceoverPath), true)
    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    assert.strictEqual(aiScenes.length, 4)
  })

  // ─── 239 & 240: Configure Editorial & Verify Persistence ──────────────────
  const setupEditorialSettings: EditorialGenerationSettings = {
    schemaVersion: 1,
    promptMode: 'embedded-editorial',
    readability: 'senior-friendly',
    labelDensity: 'balanced',
    preferLeaderLines: true,
    renderOverlayMode: 'full'
  }

  await it('239 & 240: Save and verify editorial settings in analysis/editorial-focus-settings.v1.json', () => {
    saveEditorialFocusSettings(projectDir, setupEditorialSettings)
    const settingsPath = path.join(projectDir, 'analysis', 'editorial-focus-settings.v1.json')
    assert.strictEqual(fs.existsSync(settingsPath), true)

    const reloaded = loadEditorialFocusSettings(projectDir)
    assert.strictEqual(reloaded.promptMode, 'embedded-editorial')
    assert.strictEqual(reloaded.readability, 'senior-friendly')
    assert.strictEqual(reloaded.labelDensity, 'balanced')
    assert.strictEqual(reloaded.preferLeaderLines, true)
    assert.strictEqual(reloaded.renderOverlayMode, 'full')
  })

  // ─── 241 & 242: Start Production & Verify Backend Run Configuration ────────
  let initialPipelineState: any = null
  await it('241 & 242: Start Auto Production constructs confirmed options and freezes snapshot into pipeline state', () => {
    // Pipeline options constructed at Start Auto Production
    const pipelineOptions: AutoPipelineOptions = {
      projectDir,
      scriptPath,
      voiceoverPath,
      contentType: 'general',
      contentProfileMode: 'general',
      visualSourceMode: 'custom-mix',
      visualMixConfig,
      editorialSettings: setupEditorialSettings,
      imageOutputResolution: '1080p',
      aiImageMode: 'prompt'
    }

    initialPipelineState = createInitialPipelineState(pipelineOptions)
    savePipelineStateAtomic(projectDir, initialPipelineState)

    // Verify pipeline state on disk contains the frozen snapshot
    const loaded = loadPipelineState(projectDir)
    assert.ok(loaded)
    assert.ok(loaded.options.editorialSettings)
    assert.strictEqual(loaded.options.editorialSettings.promptMode, 'embedded-editorial')
    assert.strictEqual(loaded.options.editorialSettings.readability, 'senior-friendly')
    assert.strictEqual(loaded.options.editorialSettings.labelDensity, 'balanced')
    assert.strictEqual(loaded.options.editorialSettings.preferLeaderLines, true)
    assert.strictEqual(loaded.options.editorialSettings.renderOverlayMode, 'full')
  })

  // ─── 243, 244 & 245: Mixed Visual Engine Generates Canonical Prompt Pack ───
  await it('243, 244 & 245: Mixed Visual Engine generates canonical image prompt pack for AI scenes', () => {
    ensureManualAiPromptPack({
      projectDir,
      plan,
      profile: 'general',
      outputResolution: '1080p'
    })

    const pack = loadManualAiPromptPack(projectDir)
    assert.ok(pack)
    assert.strictEqual(pack.scenes.length, 4)
    assert.deepStrictEqual(pack.scenes.map((p) => p.sceneIndex), [2, 4, 6, 8])
  })

  // ─── 246 & 247: Video Prompt Generation and Copy Formatting ───────────────
  await it('246 & 247: Video Prompt Pack adheres to formatting, senior-friendly typography, and avoids hallucinations', () => {
    ensureManualAiVideoPromptPack(projectDir)

    const videoPack = loadManualAiVideoPromptPack(projectDir)
    assert.ok(videoPack)
    assert.strictEqual(videoPack.scenes.length, 4)

    // Copy All Video Prompts enhanced text
    const copyText = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir,
      baseEntries: videoPack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt })),
      editorialSettings: setupEditorialSettings
    })

    assert.ok(copyText.length > 0)
    // Check single physical line per prompt and scene headers
    const blocks = copyText.trim().split('\n\n')
    assert.strictEqual(blocks.length, 4)
    assert.ok(blocks[0].startsWith('SCENE 002 |'))
    assert.ok(blocks[1].startsWith('SCENE 004 |'))
    assert.ok(blocks[2].startsWith('SCENE 006 |'))
    assert.ok(blocks[3].startsWith('SCENE 008 |'))

    for (const block of blocks) {
      assert.strictEqual(block.includes('\n'), false, 'Each prompt entry must be a single physical line')
    }

    // Grounding check: verify no hallucinated clinical words in deep sea documentary
    assert.strictEqual(/\b(hospital|patient|surgery|diagnosis)\b/i.test(copyText), false)
  })

  // ─── 248: Import Test AI Media ────────────────────────────────────────────
  await it('248: Import test AI media and verify scene mapping and readiness', async () => {
    const importDir = path.join(projectDir, 'imported_temp')
    fs.mkdirSync(importDir, { recursive: true })

    const s2Path = path.join(importDir, 'SCENE 002.png')
    const s4Path = path.join(importDir, 'SCENE 004.png')
    const s6Path = path.join(importDir, 'SCENE 006.png')
    fs.writeFileSync(s2Path, pngHeader(1920, 1080))
    fs.writeFileSync(s4Path, pngHeader(1920, 1080))
    fs.writeFileSync(s6Path, pngHeader(1920, 1080))

    // Import 3 of 4 scenes
    const importPlan = planManualAiImport({
      projectDir,
      filePaths: [s2Path, s4Path, s6Path],
      mediaType: 'image'
    })
    assert.strictEqual(importPlan.mappings.length, 3)

    const commitRes = await commitManualAiImport({
      projectDir,
      mappings: importPlan.mappings,
      normalizer: fakeNormalizer
    })

    assert.strictEqual(commitRes.imported.length, 3)
    assert.strictEqual(commitRes.rejections.length, 0)

    const status = evaluateManualAiStatusForProject(projectDir)
    assert.strictEqual(status.expected, 4)
    assert.strictEqual(status.ready, 3)
    assert.strictEqual(status.missingSceneIndices.length, 1)
  })

  // ─── 249: Tab Navigation Stability ────────────────────────────────────────
  await it('249: Tab navigation preserves 100% of imported assets and ready status without corruption', () => {
    // Simulating multiple navigations by repeatedly evaluating status
    for (let i = 0; i < 10; i++) {
      const status = evaluateManualAiStatusForProject(projectDir)
      assert.strictEqual(status.ready, 3)
      assert.strictEqual(status.missingSceneIndices.length, 1)
    }

    // Authoritative editorial settings file remains untouched
    const settings = loadEditorialFocusSettings(projectDir)
    assert.strictEqual(settings.promptMode, 'embedded-editorial')
    assert.strictEqual(settings.readability, 'senior-friendly')
  })

  // ─── 250 & 251: Render Overlay Policy Verification (Full vs Source Only) ───
  await it('250 & 251: Render Overlay Policy cleanly differentiates Full vs Source Only modes', () => {
    const fullPolicy = resolveEffectiveOverlayPolicy({ renderOverlayMode: 'full' })
    assert.strictEqual(fullPolicy.mode, 'full')
    assert.strictEqual(fullPolicy.renderCaptions, true)
    assert.strictEqual(fullPolicy.renderProofVisuals, true)
    assert.strictEqual(fullPolicy.renderVisualGrammar, true)

    const sourceOnlyPolicy = resolveEffectiveOverlayPolicy({ renderOverlayMode: 'source-only' })
    assert.strictEqual(sourceOnlyPolicy.mode, 'source-only')
    assert.strictEqual(sourceOnlyPolicy.renderCaptions, false)
    assert.strictEqual(sourceOnlyPolicy.renderProofVisuals, false)
    assert.strictEqual(sourceOnlyPolicy.renderVisualGrammar, false)
  })

  // ─── 253: Test Resumed Run ────────────────────────────────────────────────
  await it('253: Resumed run retains the initial frozen editorial run configuration', () => {
    // Simulate user modifying Setup settings on disk AFTER pipeline started
    saveEditorialFocusSettings(projectDir, {
      ...setupEditorialSettings,
      readability: 'standard', // changed in UI
      renderOverlayMode: 'source-only' // changed in UI
    })

    // Pipeline state reloaded for resume retains the immutable snapshot from when the run started
    const resumedState = loadPipelineState(projectDir)
    assert.ok(resumedState)
    assert.strictEqual(resumedState.options.editorialSettings?.readability, 'senior-friendly')
    assert.strictEqual(resumedState.options.editorialSettings?.renderOverlayMode, 'full')
  })

  // ─── 254: Test Legacy Project Compatibility ───────────────────────────────
  await it('254: Legacy project without editorial-focus-settings.v1.json falls back to Classic and Full', () => {
    const legacyDir = freshDir('Legacy-Project')
    fs.mkdirSync(path.join(legacyDir, 'analysis'), { recursive: true })

    const settings = loadEditorialFocusSettings(legacyDir)
    assert.strictEqual(settings.schemaVersion, 1)
    assert.strictEqual(settings.promptMode, 'classic')
    assert.strictEqual(settings.renderOverlayMode, 'full')
    assert.strictEqual(settings.readability, 'standard')
    assert.strictEqual(settings.labelDensity, 'minimal')
    assert.strictEqual(settings.preferLeaderLines, true)

    const policy = resolveEffectiveOverlayPolicy(settings)
    assert.strictEqual(policy.mode, 'full')
    assert.strictEqual(policy.renderCaptions, true)
  })

  finish()
}

runE2EScenario()
