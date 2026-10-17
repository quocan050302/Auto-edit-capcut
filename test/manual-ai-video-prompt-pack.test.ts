/**
 * Video Prompt Pack Generation, Formatting, Niche, and Immutability Tests
 * Covers Part E, F, G, H & Part J (Section 99-106)
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir,
  makeProject,
  mixOf,
  readJson
} from './manual-ai-test-utils'
import {
  buildManualSceneVideoPrompt,
  computeManualVideoPromptInputHash,
  detectVideoNiche,
  ensureManualAiVideoPromptPack,
  formatManualAiVideoPromptText,
  loadManualAiVideoPromptPack,
  readManualAiVideoPromptText,
  MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION,
  VIDEO_NICHE_DIRECTIVES
} from '../src/main/visual-mix/manual-ai/manual-ai-video-prompt-pack'
import {
  ensureManualAiPromptPack,
  readManualAiPromptText
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { IPC_CHANNELS } from '../shared/types'
import type { VisualMixScenePlan } from '../shared/types'

const { it, finish } = createRunner('Manual AI Video Prompt Pack Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Video Prompt Pack Tests ---')

  await it('Section 99: Exact text format and single-line guarantee', async () => {
    const projDir = makeProject(6)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    // 50/50 mix: 3 AI scenes, 3 Stock scenes
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(50, 50, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const pack = ensureManualAiVideoPromptPack(projDir)
    assert.equal(pack.scenes.length, 3, 'Exactly 3 video prompts generated for 3 AI scenes')
    assert.equal(pack.schemaVersion, MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION)

    const text = formatManualAiVideoPromptText(pack)
    const blocks = text.split('\n\n')
    assert.equal(blocks.length, 3, 'Exactly one empty line between prompts')

    for (let i = 0; i < blocks.length; i++) {
      const line = blocks[i]
      assert.ok(!line.includes('\n'), `Prompt block ${i + 1} must be a single physical line`)
      assert.ok(!line.includes('\r'), `No carriage returns allowed in prompt block ${i + 1}`)
      assert.ok(line.startsWith(`SCENE ${String(pack.scenes[i].sceneIndex).padStart(3, '0')} |`), 'Matches SCENE XXX | pattern')
    }

    // Check numeric scene ordering
    for (let i = 1; i < pack.scenes.length; i++) {
      assert.ok(pack.scenes[i].sceneIndex > pack.scenes[i - 1].sceneIndex, 'Strictly ascending numeric scene order')
    }
  })

  await it('Section 100: Niche-specific prompt tests across all supported niches', async () => {
    // 1. Health niche
    const healthPrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 1,
        narration: 'The nephron capillaries filter metabolic waste from the bloodstream.',
        visualIntent: 'Kidney glomerulus filtration mechanism',
        duration: 6,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'health',
      outputResolution: '1080p'
    })
    assert.ok(healthPrompt.includes('physiological'), 'Health prompt contains physiological motion')
    assert.ok(healthPrompt.includes('macro push-in') || healthPrompt.includes('macro'), 'Health prompt contains macro movement')
    assert.ok(healthPrompt.includes('Target clip duration: 6 seconds'), 'Respects scene duration of 6s')
    assert.ok(healthPrompt.includes('no fake diagnostic'), 'Contains health negative constraints')
    assert.ok(!healthPrompt.includes('\n'), 'Health prompt is single physical line')

    // 2. History niche
    const historyPrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 2,
        narration: 'During the 17th century dynasty, stonemasons constructed defensive medieval walls.',
        visualIntent: 'Historical stonemason craftsman working with era tools',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(historyPrompt.includes('historical') || historyPrompt.includes('period-authentic'), 'History prompt contains historical directives')
    assert.ok(historyPrompt.includes('lateral tracking') || historyPrompt.includes('dolly') || historyPrompt.includes('tracking'), 'Camera movement specified')
    assert.ok(historyPrompt.includes('no modern artifacts'), 'History negative constraints present')

    // 3. Hutterite / communal documentary niche
    const hutteritePrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 3,
        narration: 'Workers on the Hutterite colony communal farm prepare the morning harvest together.',
        visualIntent: 'Hutterite communal farmstead coordinated agricultural work at dawn',
        duration: 7,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(hutteritePrompt.includes('communal') || hutteritePrompt.includes('agricultural'), 'Hutterite documentary profile activated')
    assert.ok(hutteritePrompt.includes('no Amish stereotyping'), 'Hutterite respectful directives applied')
    assert.ok(hutteritePrompt.includes('Target clip duration: 7 seconds'), 'Duration 7s preserved')

    // 4. Finance niche
    const financePrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 4,
        narration: 'Global financial banking institutions analyze market liquidity and capital allocation.',
        visualIntent: 'Corporate trading floor operations',
        duration: 4,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(financePrompt.includes('financial') || financePrompt.includes('business'), 'Finance directives applied')
    assert.ok(financePrompt.includes('no floating currency symbols'), 'Finance negative constraints present')

    // 5. Food niche
    const foodPrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 5,
        narration: 'The chef carefully simmers the culinary broth as aromatic steam rises.',
        visualIntent: 'Kitchen cooking preparation and ingredients',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(foodPrompt.includes('culinary') || foodPrompt.includes('steam'), 'Food directives applied')
    assert.ok(foodPrompt.includes('no cartoonish food'), 'Food negative constraints present')

    // 6. Technology niche
    const techPrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 6,
        narration: 'Automated server robotics process high-performance neural computing tasks in the data center.',
        visualIntent: 'Data center servers and mechanical robotics',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(techPrompt.includes('technical') || techPrompt.includes('mechanical'), 'Tech directives applied')
    assert.ok(techPrompt.includes('no generic sci-fi neon grids'), 'Tech negative constraints present')

    // 7. Nature niche
    const naturePrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 7,
        narration: 'A pack of wild arctic wolves tracks migrating herds across the glacial tundra.',
        visualIntent: 'Wildlife behavior in natural arctic habitat',
        duration: 8,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(naturePrompt.includes('natural-history') || naturePrompt.includes('wildlife'), 'Nature directives applied')
    assert.ok(naturePrompt.includes('no anthropomorphized animal'), 'Nature negative constraints present')

    // 8. Travel niche
    const travelPrompt = buildManualSceneVideoPrompt({
      scene: {
        sceneIndex: 8,
        narration: 'Travelers explore scenic mountain trails overlooking the coastal horizon.',
        visualIntent: 'Scenic travel journey in rugged mountain landscape',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      profile: 'general',
      outputResolution: '1080p'
    })
    assert.ok(travelPrompt.includes('cultural geography') || travelPrompt.includes('location'), 'Travel directives applied')
    assert.ok(travelPrompt.includes('no tourist cliches'), 'Travel negative constraints present')
  })

  await it('Section 101: Prompt immutability: image prompts and hashes are 100% unchanged', async () => {
    const projDir = makeProject(4)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(75, 25, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const imageTextBefore = readManualAiPromptText(projDir)
    const imageJsonPath = path.join(projDir, 'analysis', 'manual-ai-prompts.json')
    const imageJsonBefore = fs.readFileSync(imageJsonPath, 'utf-8')

    // Now generate video prompts
    ensureManualAiVideoPromptPack(projDir)

    const imageTextAfter = readManualAiPromptText(projDir)
    const imageJsonAfter = fs.readFileSync(imageJsonPath, 'utf-8')

    assert.equal(imageTextBefore, imageTextAfter, 'Image prompt text must be byte-for-byte identical')
    assert.equal(imageJsonBefore, imageJsonAfter, 'Image prompt JSON must be byte-for-byte identical')
  })

  await it('Section 102: Asset immutability: asset manifest is unchanged by video prompt generation', async () => {
    const projDir = makeProject(3)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const manifestPath = path.join(projDir, 'analysis', 'manual-ai-assets.json')
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 3,
      ready: 1,
      missing: 2,
      scenes: {
        '1': {
          sceneIndex: 1,
          fileName: 'S0001.png',
          promptHash: 'abc123hash',
          importedAt: new Date().toISOString()
        }
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2))

    // Generate video prompts
    ensureManualAiVideoPromptPack(projDir)

    const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    assert.equal(manifestAfter.scenes['1'].promptHash, 'abc123hash', 'Existing image asset promptHash unchanged')
    assert.equal(manifestAfter.ready, 1)
  })

  await it('Section 103: Missing artifact tolerance: graceful fallback without visual-brief or scene-directions', async () => {
    const projDir = makeProject(2)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    // Verify brief and directions files do NOT exist
    assert.ok(!fs.existsSync(path.join(projDir, 'analysis', 'manual-ai-visual-brief.json')))
    assert.ok(!fs.existsSync(path.join(projDir, 'analysis', 'manual-ai-scene-directions.json')))

    const pack = ensureManualAiVideoPromptPack(projDir)
    assert.equal(pack.scenes.length, 2, 'Successfully generates video prompts from scene plans alone')
    assert.ok(pack.scenes[0].prompt.length > 50)
  })

  await it('Section 103: Clear error when no prompt pack / AI scenes exist', async () => {
    const projDir = freshDir('empty-project')
    let threw = false
    try {
      ensureManualAiVideoPromptPack(projDir)
    } catch (err: any) {
      threw = true
      assert.ok(err.message.includes('No AI-owned scenes found') || err.message.includes('No prompt pack'))
    }
    assert.ok(threw, 'Should throw descriptive error when no project plan exists')
  })

  await it('Section 104: Repeated copy produces deterministic, byte-identical output', async () => {
    const projDir = makeProject(3)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const pack1 = ensureManualAiVideoPromptPack(projDir)
    const text1 = formatManualAiVideoPromptText(pack1)

    const pack2 = ensureManualAiVideoPromptPack(projDir)
    const text2 = formatManualAiVideoPromptText(pack2)

    assert.equal(text1, text2, 'Consecutive prompt generation without input changes must be byte-identical')
  })

  await it('Section 105: Source-change updates affected scene video prompt and hash', async () => {
    const projDir = makeProject(3)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const pack1 = ensureManualAiVideoPromptPack(projDir)
    const p1Scene1Prompt = pack1.scenes[0].prompt
    const p1Scene1Hash = pack1.scenes[0].inputHash
    const p1Scene2Prompt = pack1.scenes[1].prompt
    const p1Scene2Hash = pack1.scenes[1].inputHash

    // Update scene 1 narration in visual-mix-plan.json
    const planPath = path.join(projDir, 'analysis', 'visual-mix-plan.json')
    const planData = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    planData.scenes[0].narration = 'Brand new unique narration about high-tech quantum computing.'
    fs.writeFileSync(planPath, JSON.stringify(planData, null, 2))

    // Re-run
    const pack2 = ensureManualAiVideoPromptPack(projDir)
    const p2Scene1Prompt = pack2.scenes[0].prompt
    const p2Scene1Hash = pack2.scenes[0].inputHash
    const p2Scene2Prompt = pack2.scenes[1].prompt
    const p2Scene2Hash = pack2.scenes[1].inputHash

    assert.notEqual(p1Scene1Hash, p2Scene1Hash, 'Scene 1 inputHash changed when narration changed')
    assert.notEqual(p1Scene1Prompt, p2Scene1Prompt, 'Scene 1 prompt refreshed with new narration')
    assert.equal(p1Scene2Hash, p2Scene2Hash, 'Unchanged scene 2 inputHash preserved')
    assert.equal(p1Scene2Prompt, p2Scene2Prompt, 'Unchanged scene 2 prompt preserved')
  })

  await it('Section 102: Upgrades schema version 1 cache to version 2 and regenerates stale prompts', async () => {
    const projDir = makeProject(3)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    // Simulate an existing obsolete schemaVersion 1 pack
    const v1Pack = {
      schemaVersion: 1,
      generatedAt: '2025-01-01T00:00:00.000Z',
      profile: 'general',
      scenes: [
        {
          sceneIndex: 1,
          sceneId: 'scene_1',
          prompt: 'SCENE 001 | Obsolete generic prompt without subject grounding or keywords.',
          inputHash: 'obsolete_v1_hash',
          durationSecs: 5,
          niche: 'documentary',
          expectedFilename: 'S0001.mp4'
        }
      ]
    }
    const packJsonPath = path.join(projDir, 'analysis', 'manual-ai-video-prompts.json')
    fs.writeFileSync(packJsonPath, JSON.stringify(v1Pack, null, 2))

    // Run v2 generator
    const freshPack = ensureManualAiVideoPromptPack(projDir)
    assert.equal(freshPack.schemaVersion, 2, 'Must upgrade pack to schemaVersion 2')
    assert.equal(freshPack.scenes.length, 3, 'Must regenerate all scenes')
    assert.notEqual(freshPack.scenes[0].inputHash, 'obsolete_v1_hash', 'Obsolete v1 hash must be discarded')
    assert.ok(freshPack.scenes[0].prompt.includes('Visual keywords:'), 'Prompt must now include visual keywords')
    assert.ok(freshPack.scenes[0].prompt.includes('Avoid:'), 'Prompt must now include avoid constraints')

    // Stale TXT read test (Section 85)
    const txtContent = readManualAiVideoPromptText(projDir)
    assert.ok(txtContent, 'Must read valid text from pack')
    assert.ok(txtContent!.includes('Visual keywords:'), 'TXT must reflect schemaVersion 2 prompts')
  })

  await it('Section 100 & 101: Prompt includes early identity, action verbs, keywords, avoid constraints, and respects word budget', async () => {
    const projDir = makeProject(2)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    // Provide rich Hutterite Global Context and Identity Bible
    const contextPath = path.join(projDir, 'analysis', 'global-script-context.json')
    const globalContext = {
      primarySubject: 'Hutterite communal agriculture',
      communities: [
        {
          name: 'Hutterites',
          visualIdentity: {
            clothing: ['practical collared work shirts', 'durable work trousers'],
            machinery: ['modern combines', 'tractors'],
            tools: ['workshop equipment']
          }
        }
      ],
      visualWorld: {
        environment: ['communal farmstead', 'equipment workshop'],
        architecture: ['rural equipment workshop'],
        machinery: ['modern agricultural equipment']
      },
      forbiddenSubstitutions: ['Amish stereotyping', 'horse and buggy']
    }
    fs.writeFileSync(contextPath, JSON.stringify(globalContext, null, 2))

    const pack = ensureManualAiVideoPromptPack(projDir)
    const prompt = pack.scenes[0].prompt

    // Verify single physical line
    assert.ok(!prompt.includes('\n'), 'Prompt must be a single physical line')
    assert.ok(!prompt.includes('\r'), 'No CR characters in prompt')

    // Verify early subject identity
    assert.ok(prompt.includes('Hutterite'), 'Prompt must identify Hutterite subject')

    // Verify keywords and avoid constraints formatting
    assert.ok(prompt.includes('Visual keywords:'), 'Must have Visual keywords clause')
    assert.ok(prompt.includes('Avoid:'), 'Must have Avoid clause')

    // Verify word count ceiling (hard limit 320 words)
    const wordCount = prompt.split(/\s+/).filter(Boolean).length
    assert.ok(wordCount >= 100 && wordCount <= 320, `Word count must be between 100 and 320, got ${wordCount}`)
  })

  await it('Section 81 & 83: IPC channel and preload bridge contract', async () => {
    assert.equal(IPC_CHANNELS.MANUAL_AI_GET_VIDEO_PROMPT_TEXT, 'manual-ai:get-video-prompt-text')

    const preloadPath = path.join(__dirname, '../src/preload/index.ts')
    const preloadContent = fs.readFileSync(preloadPath, 'utf-8')
    assert.ok(preloadContent.includes('getVideoPromptText:'), 'Preload must expose manualAi.getVideoPromptText')
    assert.ok(preloadContent.includes('selectVideos:'), 'Preload must expose manualAi.selectVideos')
  })

  cleanupFixtures()
  finish()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
