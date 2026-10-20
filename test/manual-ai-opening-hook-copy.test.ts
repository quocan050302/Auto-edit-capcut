/**
 * Opening Visual Hook Director V3 — Test Suite
 * Tests universal opening visual hook enhancement across image & video copy operations.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  buildOpeningEnhancedCopyText,
  composeOpeningImagePrompt,
  composeOpeningVideoPrompt,
  resolveOpeningVisualHook,
  scoreOpeningVisualHook,
  type OpeningVisualHookBlueprint
} from '../src/main/visual-mix/manual-ai/manual-ai-opening-hook-copy'
import {
  buildManualAiPromptPack,
  ensureManualAiPromptPack,
  loadManualAiPromptPack,
  formatManualAiPromptText
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  ensureManualAiVideoPromptPack,
  loadManualAiVideoPromptPack,
  formatManualAiVideoPromptText
} from '../src/main/visual-mix/manual-ai/manual-ai-video-prompt-pack'
import { getManualAiManifestPath } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { getManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-broadcaster'
import type { VisualMixScenePlan } from '../shared/types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir,
  makeProject,
  mixOf
} from './manual-ai-test-utils'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'

const { it, finish } = createRunner('Manual AI Opening Hook Copy Tests')

function planFor(dir: string, ai: number, stock: number, profile: 'health' | 'general' = 'general') {
  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
  return VisualMixPlanner.buildPlan({
    projectDir: dir,
    rawScenes,
    config: mixOf(ai, stock, 'prompt'),
    profile,
    globalContext: undefined
  })
}

async function main(): Promise<void> {
  console.log('\n--- Manual AI Opening Hook Director V3 Tests ---')

  await it('Section 102: selects exactly the first 10 AI-owned prompts when scene numbers are non-consecutive', () => {
    const dir = freshDir('nonconsec')
    // Create project where scenes 3, 6, 12 are stock-owned, AI scenes: 1, 2, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15
    const baseEntries: Array<{ sceneIndex: number; prompt: string }> = [
      { sceneIndex: 1, prompt: 'Scene 1 canonical baseline prompt about communal kitchen bread prep' },
      { sceneIndex: 2, prompt: 'Scene 2 canonical baseline prompt about prairie frost water supply' },
      { sceneIndex: 4, prompt: 'Scene 4 canonical baseline prompt about heavy combine harvester maintenance' },
      { sceneIndex: 5, prompt: 'Scene 5 canonical baseline prompt about community schoolhouse German script records' },
      { sceneIndex: 7, prompt: 'Scene 7 canonical baseline prompt about blacksmith forge implement repair' },
      { sceneIndex: 8, prompt: 'Scene 8 canonical baseline prompt about collective cattle barn feeding system' },
      { sceneIndex: 9, prompt: 'Scene 9 canonical baseline prompt about grain elevator auger loading wheat' },
      { sceneIndex: 10, prompt: 'Scene 10 canonical baseline prompt about evening communal dining hall gathering' },
      { sceneIndex: 11, prompt: 'Scene 11 canonical baseline prompt about colony machine shop lathe calibration' },
      { sceneIndex: 13, prompt: 'Scene 13 canonical baseline prompt about subzero winter heating boiler check' },
      { sceneIndex: 14, prompt: 'Scene 14 canonical baseline prompt about spring seed drill setup' },
      { sceneIndex: 15, prompt: 'Scene 15 canonical baseline prompt about colony governance council meeting' }
    ]

    const copiedText = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries
    })

    const lines = copiedText.split('\n\n')
    assert.strictEqual(lines.length, 12, '12 scenes in -> 12 scenes out')

    const first10Indices = [1, 2, 4, 5, 7, 8, 9, 10, 11, 13]
    for (let i = 0; i < 10; i++) {
      const idx = first10Indices[i]
      const line = lines[i]
      assert.ok(line.startsWith(`SCENE ${String(idx).padStart(3, '0')} |`), `Line ${i} must be SCENE ${idx}`)
      // First 10 are enhanced
      assert.ok(
        line.includes('opening visual hook') || line.includes('Composition:'),
        `Scene ${idx} should have enhanced hook content`
      )
    }

    // Scenes 14 and 15 (ranks 11 and 12) must remain byte-for-byte identical to baseline
    assert.strictEqual(
      lines[10],
      `SCENE 014 | ${baseEntries[10].prompt}`,
      'Scene 14 (rank 11) must remain untouched'
    )
    assert.strictEqual(
      lines[11],
      `SCENE 015 | ${baseEntries[11].prompt}`,
      'Scene 15 (rank 12) must remain untouched'
    )
  })

  await it('Section 103: preserves exact count (131 AI prompts in -> 131 prompts out, no duplicates, no missing)', () => {
    const dir = freshDir('count131')
    const baseEntries: Array<{ sceneIndex: number; prompt: string }> = Array.from({ length: 131 }, (_, i) => ({
      sceneIndex: i + 1,
      prompt: `Standard baseline canonical prompt for documentary scene ${i + 1} detailing narrative progression`
    }))

    const copiedText = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries
    })

    const lines = copiedText.split('\n\n')
    assert.strictEqual(lines.length, 131, 'Must return exactly 131 prompts')

    const sceneNumbers = lines.map((l) => {
      const match = l.match(/^SCENE (\d{3}) \|/)
      assert.ok(match, `Line must match SCENE format: ${l.slice(0, 20)}`)
      return parseInt(match[1], 10)
    })

    assert.strictEqual(new Set(sceneNumbers).size, 131, 'All 131 scene numbers must be unique')
    assert.strictEqual(sceneNumbers[0], 1)
    assert.strictEqual(sceneNumbers[130], 131)
  })

  await it('Section 104: image hook specificity delivers concrete visual focal instructions and freezes a moment', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'The colony faces subzero winter temperatures as water pipes freeze across the farmstead.',
      visualIntent: 'Extreme winter weather impacting farm operations',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: 'Standard establishing shot of a cold farm with snowy buildings.'
    }

    const blueprint = resolveOpeningVisualHook({
      scene,
      openingRank: 1,
      previousHooks: []
    })

    assert.strictEqual(blueprint.openingRank, 1)
    assert.ok(blueprint.visualFocalPoint.length > 10, 'Focal point must be concrete')
    assert.ok(blueprint.strikingDetail.length > 10, 'Striking detail must be concrete')

    const imagePrompt = composeOpeningImagePrompt({
      basePrompt: scene.imagePrompt,
      blueprint,
      scene,
      outputResolution: '1080p'
    })

    assert.ok(imagePrompt.includes('frozen in a decisive instant'), 'Must describe a frozen moment')
    assert.ok(imagePrompt.includes('Composition:'), 'Must specify composition')
    assert.ok(imagePrompt.includes('focal priority'), 'Must specify focal priority')
    assert.ok(!imagePrompt.includes('\n'), 'Must be a single physical line')
    assert.ok(imagePrompt.includes('16:9 horizontal frame (1920x1080)'), 'Must include 16:9 1080p resolution')
    assert.ok(!imagePrompt.includes('Epic') && !imagePrompt.includes('Ultra cinematic'), 'No hyperbolic filler adjectives')
  })

  await it('Section 105: video motion specificity specifies immediate opening frame action and non-uniform camera movement', () => {
    const scenes: VisualMixScenePlan[] = [
      {
        sceneIndex: 1,
        narration: 'Deep winter subzero frost creates severe challenges for the outdoor livestock water valves.',
        visualIntent: 'Frozen water coupling in subzero cold',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      {
        sceneIndex: 2,
        narration: 'Inside the massive communal kitchen, morning preparations begin with industrial dough mixing.',
        visualIntent: 'Communal kitchen dough preparation',
        duration: 6,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      {
        sceneIndex: 3,
        narration: 'In the repair workshop, colony machinists rebuild complex combine hydraulic systems.',
        visualIntent: 'Machinist calibrating hydraulic piston',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      }
    ]

    const videoPrompts: string[] = []
    const blueprints: OpeningVisualHookBlueprint[] = []

    for (let i = 0; i < scenes.length; i++) {
      const bp = resolveOpeningVisualHook({
        scene: scenes[i],
        openingRank: i + 1,
        previousHooks: blueprints
      })
      blueprints.push(bp)

      const vp = composeOpeningVideoPrompt({
        basePrompt: 'Generic baseline video prompt',
        blueprint: bp,
        scene: scenes[i],
        durationSecs: scenes[i].duration || 5,
        niche: bp.niche
      })
      videoPrompts.push(vp)
    }

    for (let i = 0; i < videoPrompts.length; i++) {
      const vp = videoPrompts[i]
      assert.ok(vp.includes('Opening frame (0:00):'), `Video prompt ${i + 1} must include immediate opening frame action`)
      assert.ok(vp.includes('Development:'), `Video prompt ${i + 1} must include temporal development`)
      assert.ok(vp.includes('no distorted hands'), `Video prompt ${i + 1} must include anti-motion artifact directives`)
      assert.ok(!vp.includes('\n'), 'Must be a single physical line')
    }

    // Camera movements must not all be identical
    const cameraMotions = blueprints.map((b) => b.shotType)
    assert.ok(new Set(cameraMotions).size >= 2, 'Camera movements and shot types across scenes must vary')
  })

  await it('Section 106: novelty control introduces variation and avoids consecutive archetype or shot repetition', () => {
    // 10 scenes with superficially similar general themes
    const scenes: VisualMixScenePlan[] = Array.from({ length: 10 }, (_, i) => ({
      sceneIndex: i + 1,
      narration: `Documentary examination of agricultural infrastructure and operations stage ${i + 1}`,
      visualIntent: `Working environment stage ${i + 1}`,
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }))

    const blueprints: OpeningVisualHookBlueprint[] = []
    for (let i = 0; i < 10; i++) {
      const bp = resolveOpeningVisualHook({
        scene: scenes[i],
        openingRank: i + 1,
        previousHooks: blueprints
      })
      blueprints.push(bp)
    }

    assert.strictEqual(blueprints.length, 10)

    // Check no 2 consecutive scenes have identical archetype
    for (let i = 1; i < blueprints.length; i++) {
      assert.notStrictEqual(
        blueprints[i].hookArchetype,
        blueprints[i - 1].hookArchetype,
        `Consecutive archetypes at rank ${i} and ${i + 1} must differ`
      )
    }

    // Check shot types vary across the 10 scenes
    const shotTypes = blueprints.map((b) => b.shotType)
    assert.ok(new Set(shotTypes).size >= 4, 'Must have at least 4 distinct shot types across first 10 scenes')
  })

  await it('Section 107: Hutterite niche fixtures ground modern agricultural scale and prevent Amish stereotyping', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'The Hutterite colony operates large-scale modern combine harvesters across thousands of communal prairie acres.',
      visualIntent: 'Harvesting wheat with modern combine fleet',
      duration: 6,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const bp = resolveOpeningVisualHook({
      scene,
      openingRank: 1,
      previousHooks: []
    })

    assert.strictEqual(bp.niche, 'hutterite-documentary')

    const imagePrompt = composeOpeningImagePrompt({
      basePrompt: '',
      blueprint: bp,
      scene,
      outputResolution: '1080p'
    })

    const videoPrompt = composeOpeningVideoPrompt({
      basePrompt: '',
      blueprint: bp,
      scene,
      durationSecs: 6,
      niche: bp.niche
    })

    // Verify modern agricultural details
    assert.ok(
      imagePrompt.includes('combine') || imagePrompt.includes('threshing') || imagePrompt.includes('harvester'),
      'Must contain modern harvesting details'
    )

    // Verify Amish stereotyping is forbidden
    assert.ok(!imagePrompt.toLowerCase().includes('horse and buggy'), 'Must not substitute Amish buggies')
    assert.ok(imagePrompt.includes('no Amish horse and buggy') || imagePrompt.includes('Strictly authentic'), 'Must specify anti-Amish negative constraint')
    assert.ok(!videoPrompt.toLowerCase().includes('quaint buggy'), 'Video prompt must avoid quaint buggies')
  })

  await it('Section 108: supports multiple niches (Healthcare, History, Finance, Food, Tech, Nature, Travel)', () => {
    const testCases: Array<{ niche: string; narration: string; expectedKeyword: string }> = [
      {
        niche: 'health',
        narration: 'The renal glomerulus acts as a microscopic biological filter removing metabolic waste from blood plasma.',
        expectedKeyword: 'glomerul'
      },
      {
        niche: 'history',
        narration: 'An authentic 18th-century diplomatic treaty bearing royal wax seals and handwritten quill script.',
        expectedKeyword: 'parchment'
      },
      {
        niche: 'finance',
        narration: 'High-frequency institutional trading terminals process millions of transaction ledger entries in milliseconds.',
        expectedKeyword: 'trading'
      },
      {
        niche: 'food',
        narration: 'Artisan bakers score sourdough crust as intense steam vaporises from the commercial hearth oven.',
        expectedKeyword: 'steam'
      },
      {
        niche: 'technology',
        narration: 'Precision automated stepper motors position micro-actuators along advanced semiconductor fabrication rails.',
        expectedKeyword: 'micro-actuator'
      },
      {
        niche: 'nature',
        narration: 'A predatory bird grips a frost-coated pine branch, its plumage ruffled by subarctic winds.',
        expectedKeyword: 'branch'
      },
      {
        niche: 'travel',
        narration: 'Historic weathered cobblestones along a narrow mountain village incline show centuries of trade passage.',
        expectedKeyword: 'cobblestone'
      }
    ]

    for (const tc of testCases) {
      const scene: VisualMixScenePlan = {
        sceneIndex: 1,
        narration: tc.narration,
        visualIntent: tc.narration,
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      }

      const bp = resolveOpeningVisualHook({ scene, openingRank: 1, previousHooks: [] })
      const img = composeOpeningImagePrompt({ basePrompt: '', blueprint: bp, scene, outputResolution: '1080p' })
      const evalRes = scoreOpeningVisualHook({ blueprint: bp, generatedPrompt: img, priorHooks: [] })

      assert.ok(evalRes.passed, `Niche ${tc.niche} should pass quality evaluation with score ${evalRes.score}`)
      assert.ok(evalRes.score >= 70, `Niche ${tc.niche} score should be >= 70 (actual: ${evalRes.score})`)
    }
  })

  await it('Section 109: prevents invented drama (does not invent explosions, fires, medical collapse or disasters)', () => {
    const ordinaryScene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'The accountants complete the annual inventory audit of farm equipment and warehouse supplies.',
      visualIntent: 'Warehouse inventory review',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const bp = resolveOpeningVisualHook({ scene: ordinaryScene, openingRank: 1, previousHooks: [] })
    const imgPrompt = composeOpeningImagePrompt({ basePrompt: '', blueprint: bp, scene: ordinaryScene, outputResolution: '1080p' })
    const vidPrompt = composeOpeningVideoPrompt({ basePrompt: '', blueprint: bp, scene: ordinaryScene, durationSecs: 5, niche: bp.niche })

    const forbiddenDisasters = ['explosion', 'fire', 'catastrophe', 'blood', 'collapse', 'injured', 'deadly', 'fraud']
    for (const d of forbiddenDisasters) {
      assert.ok(!imgPrompt.toLowerCase().includes(d), `Image prompt must not invent disaster keyword "${d}"`)
      assert.ok(!vidPrompt.toLowerCase().includes(d), `Video prompt must not invent disaster keyword "${d}"`)
    }
  })

  await it('Section 110: image/video alignment preserves subject identity and visual meaning while differentiating structure', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'A colony technician tests a newly machined hydraulic cylinder on the workshop test bench.',
      visualIntent: 'Hydraulic cylinder pressure testing',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const bp = resolveOpeningVisualHook({ scene, openingRank: 1, previousHooks: [] })
    const img = composeOpeningImagePrompt({ basePrompt: '', blueprint: bp, scene, outputResolution: '1080p' })
    const vid = composeOpeningVideoPrompt({ basePrompt: '', blueprint: bp, scene, durationSecs: 5, niche: bp.niche })

    // Both preserve hydraulic cylinder and workshop testing
    assert.ok(img.includes('hydraulic') || img.includes('cylinder'), 'Image prompt preserves core subject')
    assert.ok(vid.includes('hydraulic') || vid.includes('cylinder'), 'Video prompt preserves core subject')

    // Image is frozen decisive moment
    assert.ok(img.includes('frozen in a decisive instant'), 'Image describes a frozen moment')

    // Video is temporal progression
    assert.ok(vid.includes('Opening frame (0:00):'), 'Video describes opening frame')
    assert.ok(vid.includes('Development:'), 'Video describes development')
  })

  await it('Section 111 & 112: prompt hashes and asset manifest remain 100% unchanged during copy operations', () => {
    const dir = makeProject(15)
    const plan = planFor(dir, 0.85, 0.15, 'general')
    const pack = ensureManualAiPromptPack({
      projectDir: dir,
      plan,
      profile: 'general',
      outputResolution: '1080p'
    }).pack

    // Record canonical hashes before copy
    const initialHashes = pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, hash: s.promptHash }))

    // Create manifest file
    const manifestPath = getManualAiManifestPath(dir)
    const initialManifest = { schemaVersion: 1, importedAssets: [] }
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), 'utf-8')

    // Perform image copy operation
    const copiedImageText = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
    })

    // Perform video copy operation
    const copiedVideoText = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: dir,
      baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
    })

    assert.ok(copiedImageText.length > 100)
    assert.ok(copiedVideoText.length > 100)

    // Reload pack from disk
    const reloadedPack = loadManualAiPromptPack(dir)
    assert.ok(reloadedPack, 'Pack must still exist on disk')

    // Verify all canonical hashes remain 100% unchanged
    for (let i = 0; i < initialHashes.length; i++) {
      assert.strictEqual(
        reloadedPack.scenes[i].promptHash,
        initialHashes[i].hash,
        `Scene ${initialHashes[i].sceneIndex} canonical promptHash must remain unchanged`
      )
    }

    // Verify manifest is untouched
    const afterManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    assert.deepStrictEqual(afterManifest, initialManifest, 'Manifest must not be modified by copy operations')
  })

  await it('Section 113: preserves Ready asset state across copy calls (130/131 Ready stays 130/131 Ready)', () => {
    const dir = makeProject(131)
    const plan = planFor(dir, 1.0, 0.0, 'general')
    const pack = ensureManualAiPromptPack({
      projectDir: dir,
      plan,
      profile: 'general',
      outputResolution: '1080p'
    }).pack

    // Simulate 130 ready assets in the manifest
    const genDir = path.join(dir, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(genDir, { recursive: true })

    const manifestPath = getManualAiManifestPath(dir)
    const scenesRecord: Record<string, any> = {}
    for (const s of pack.scenes.slice(0, 130)) {
      const relPath = path.join('assets', 'generated', 'manual-ai', s.expectedFilename)
      const absPath = path.join(dir, relPath)
      fs.writeFileSync(absPath, 'valid-image-bytes')
      scenesRecord[String(s.sceneIndex)] = {
        sceneIndex: s.sceneIndex,
        promptHash: s.promptHash,
        status: 'ready',
        sourcePath: `s${s.sceneIndex}.jpg`,
        localPath: relPath,
        width: 1920,
        height: 1080,
        importedAt: new Date().toISOString()
      }
    }

    const manifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 131,
      ready: 130,
      missing: 1,
      scenes: scenesRecord
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

    // Check status before copy
    const statusBefore = getManualAiStatus(dir)
    assert.strictEqual(statusBefore.ready, 130, 'Should have 130 ready images initially')
    assert.strictEqual(statusBefore.missingSceneIndices.length, 1, 'Should have 1 missing image initially')

    // Invoke copy operations
    buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
    })

    buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: dir,
      baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
    })

    // Check status after copy
    const statusAfter = getManualAiStatus(dir)
    assert.strictEqual(statusAfter.ready, 130, 'Must still have 130 ready images after copy operations')
    assert.strictEqual(statusAfter.missingSceneIndices.length, 1, 'Must still have 1 missing image after copy operations')
    assert.strictEqual(statusAfter.staleSceneIndices.length, 0, 'No images should become stale')
  })

  await it('Section 114: video cache preservation (canonical video pack and input hashes are unchanged)', () => {
    const dir = makeProject(15)
    const plan = planFor(dir, 0.85, 0.15, 'general')
    ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

    const canonicalVideoPack = ensureManualAiVideoPromptPack(dir)
    const initialInputHashes = canonicalVideoPack.scenes.map((s) => s.inputHash)

    // Invoke copy
    buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: dir,
      baseEntries: canonicalVideoPack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
    })

    // Reload canonical video pack from disk
    const reloadedVideoPack = loadManualAiVideoPromptPack(dir)
    assert.ok(reloadedVideoPack, 'Video pack must exist')
    for (let i = 0; i < canonicalVideoPack.scenes.length; i++) {
      assert.strictEqual(
        reloadedVideoPack.scenes[i].inputHash,
        initialInputHashes[i],
        `Scene ${canonicalVideoPack.scenes[i].sceneIndex} video inputHash must not change`
      )
    }
  })

  await it('Section 115 & 116: non-opening prompts (11+) are byte-for-byte identical, and formatting is exact', () => {
    const dir = freshDir('formatting')
    const baseEntries = Array.from({ length: 20 }, (_, i) => ({
      sceneIndex: i + 1,
      prompt: `Exact canonical prompt content for scene ${i + 1} with specific detail and no trailing space.`
    }))

    const copiedText = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries
    })

    const lines = copiedText.split('\n\n')
    assert.strictEqual(lines.length, 20)

    // Check format: SCENE NNN | prompt text (single physical line, no embedded newlines)
    for (let i = 0; i < lines.length; i++) {
      assert.ok(!lines[i].includes('\n'), `Line ${i + 1} must not contain embedded newlines`)
      assert.ok(lines[i].startsWith(`SCENE ${String(i + 1).padStart(3, '0')} |`), `Line ${i + 1} format check`)
    }

    // Prompts 11 through 20 must be byte-for-byte identical to baseline formatted prompt
    for (let i = 10; i < 20; i++) {
      const expected = `SCENE ${String(i + 1).padStart(3, '0')} | ${baseEntries[i].prompt}`
      assert.strictEqual(lines[i], expected, `Scene ${i + 1} must be byte-for-byte identical to base prompt`)
    }
  })

  await it('Section 117: determinism guarantees identical text across repeated copy invocations', () => {
    const dir = freshDir('determ')
    const baseEntries = Array.from({ length: 15 }, (_, i) => ({
      sceneIndex: i + 1,
      prompt: `Deterministic baseline prompt for scene ${i + 1}`
    }))

    const firstRun = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries
    })

    const secondRun = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: dir,
      baseEntries
    })

    assert.strictEqual(firstRun, secondRun, 'Repeated copy operations must produce byte-identical text')
  })

  await it('Section 118: missing project intelligence degrades gracefully without throwing', () => {
    const emptyDir = freshDir('empty_intelligence')
    const baseEntries = [
      { sceneIndex: 1, prompt: 'Baseline prompt without any analysis artifacts present' },
      { sceneIndex: 2, prompt: 'Second baseline prompt in completely empty project folder' }
    ]

    // Must not throw even when visual-mix-plan, retention-plan, etc. do not exist
    const imageCopy = buildOpeningEnhancedCopyText({
      mode: 'image',
      projectDir: emptyDir,
      baseEntries
    })

    const videoCopy = buildOpeningEnhancedCopyText({
      mode: 'video',
      projectDir: emptyDir,
      baseEntries
    })

    assert.ok(imageCopy.length > 50, 'Image copy must generate valid text')
    assert.ok(videoCopy.length > 50, 'Video copy must generate valid text')
  })

  finish()
  cleanupFixtures()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
