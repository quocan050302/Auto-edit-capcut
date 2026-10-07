/**
 * Automated Unit Tests for Visual Mix Planner
 * (src/main/visual-mix/visual-mix-planner.ts)
 */

import * as assert from 'assert'
import {
  VisualMixPlanner,
  classifyGeneralSceneSuitability
} from '../src/main/visual-mix/visual-mix-planner'
import { MasterEditPlan, MasterScene } from '../shared/types'

let passed = 0
let failed = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).stack || (err as Error).message}`)
    failed++
  }
}

function createMockMasterPlan(sceneDefs: Array<{ text: string; visualIntent?: string }>): MasterEditPlan {
  const scenes: MasterScene[] = sceneDefs.map((def, idx) => ({
    sceneId: `scene_${idx + 1}`,
    sequenceId: 'seq_1',
    chapterId: 'chap_1',
    scriptSegmentId: `seg_${idx + 1}`,
    start: idx * 5,
    end: (idx + 1) * 5,
    duration: 5,
    narrationText: def.text,
    visualIntent: def.visualIntent ?? 'Documentary explanation',
    transitionAfter: 'none'
  }))

  return {
    schemaVersion: 1,
    chapters: [],
    sequences: [],
    scenes
  }
}

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL MIX PLANNER UNIT TESTS')
  console.log('==================================================\n')

  // 1. General scene suitability classification
  it('1. classifyGeneralSceneSuitability prefers AI for abstract, historical, and conceptual topics', () => {
    const historical = classifyGeneralSceneSuitability(
      'In ancient Rome during 44 BC, senators gathered on the marble steps plotting the assassination.',
      'Historical reconstruction of ancient Roman Senate'
    )
    assert.ok(historical.aiSuitabilityScore > historical.stockSuitabilityScore, 'Historical should favor AI')
    assert.strictEqual(historical.category, 'historical')

    const conceptual = classifyGeneralSceneSuitability(
      'Quantum entanglement implies that two particles remain interconnected across vast distances instantaneously.',
      'Abstract quantum physics visualization of entangled photons'
    )
    assert.ok(conceptual.aiSuitabilityScore > historical.stockSuitabilityScore, 'Conceptual should favor AI')
    assert.strictEqual(conceptual.category, 'conceptual')
  })

  it('2. classifyGeneralSceneSuitability prefers Stock for real-world activity, crowds, nature, lifestyle', () => {
    const people = classifyGeneralSceneSuitability(
      'People walking across a busy downtown intersection during evening rush hour in Tokyo.',
      'City street activity with bustling crowds and traffic'
    )
    assert.ok(people.stockSuitabilityScore > people.aiSuitabilityScore, 'Crowd/street should favor stock')
    assert.strictEqual(people.category, 'lifestyle')

    const nature = classifyGeneralSceneSuitability(
      'Waves crashing against rocky coastal cliffs under the golden setting sun.',
      'Cinematic aerial view of ocean waves hitting cliffs'
    )
    assert.ok(nature.stockSuitabilityScore > nature.aiSuitabilityScore, 'Nature should favor stock')
    assert.strictEqual(nature.category, 'nature')
  })

  // 2. Global Target Ratio Matching
  it('3. General 70/30 targets exactly 7 AI + 3 Stock on 10 scenes', () => {
    const planner = new VisualMixPlanner()
    const scenes = [
      { text: 'In ancient Egypt, pharaohs built the great pyramids.' }, // historical (AI)
      { text: 'People walking in modern Cairo streets today.' }, // lifestyle (Stock)
      { text: 'The mathematical proportions of the pyramid alignment.' }, // conceptual (AI)
      { text: 'Astronomical alignments with Orion constellation.' }, // tech/science (AI)
      { text: 'Tourists riding camels around Giza plateau.' }, // lifestyle (Stock)
      { text: 'Hieroglyphs carved deep into stone sarcophagi.' }, // historical (AI)
      { text: 'How bronze chisels were forged in antiquity.' }, // technology (AI)
      { text: 'Microscopic sand grains under polarized light.' }, // conceptual (AI)
      { text: 'A busy market in Cairo selling spices and textiles.' }, // lifestyle (Stock)
      { text: 'Symbolic representation of the solar barque.' } // symbolic (AI)
    ]
    const plan = planner.planVisualMix({
      profile: 'general',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 0.7,
        stockFootageRatio: 0.3,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      masterPlan: createMockMasterPlan(scenes)
    })

    assert.strictEqual(plan.totalScenes, 10)
    assert.strictEqual(plan.targetAiScenes, 7)
    assert.strictEqual(plan.targetStockScenes, 3)

    const aiCount = plan.scenes.filter((s) => s.strategy === 'ai-still').length
    const stockCount = plan.scenes.filter((s) => s.strategy === 'stock').length

    assert.strictEqual(aiCount, 7, 'Exact 7 AI scenes allocated')
    assert.strictEqual(stockCount, 3, 'Exact 3 stock scenes allocated')
  })

  it('4. Health 60/40 targets exactly 6 AI + 4 Stock on 10 scenes', () => {
    const planner = new VisualMixPlanner()
    const scenes = [
      { text: 'Inside the liver, hepatocytes metabolize lipids and toxins.' }, // anatomy
      { text: 'A runner jogging through the park during early morning.' }, // lifestyle
      { text: 'Cellular mitochondria generating adenosine triphosphate.' }, // mechanism
      { text: 'A patient consulting with a physician in a clinic.' }, // clinical
      { text: 'Glucose transporters shifting across cell membranes.' }, // mechanism
      { text: 'Fresh vegetables and fruits being prepared in a kitchen.' }, // food
      { text: 'Endothelial inflammation spreading along arterial walls.' }, // pathology
      { text: 'A person meditating peacefully by a calm lake.' }, // lifestyle
      { text: 'Receptor binding triggering an intracellular cascade.' }, // mechanism
      { text: 'An athlete stretching muscles after a vigorous workout.' } // exercise
    ]
    const plan = planner.planVisualMix({
      profile: 'health',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 0.6,
        stockFootageRatio: 0.4,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      masterPlan: createMockMasterPlan(scenes)
    })

    assert.strictEqual(plan.totalScenes, 10)
    assert.strictEqual(plan.targetAiScenes, 6)
    assert.strictEqual(plan.targetStockScenes, 4)

    const aiCount = plan.scenes.filter((s) => s.strategy === 'ai-still').length
    const stockCount = plan.scenes.filter((s) => s.strategy === 'stock').length

    assert.strictEqual(aiCount, 6, 'Must allocate 6 AI scenes')
    assert.strictEqual(stockCount, 4, 'Must allocate 4 Stock scenes')
  })

  it('5. 100/0 Custom Mix allocates 100% AI stills', () => {
    const planner = new VisualMixPlanner()
    const scenes = [
      { text: 'Scene 1 narration.' },
      { text: 'Scene 2 narration.' },
      { text: 'Scene 3 narration.' },
      { text: 'Scene 4 narration.' },
      { text: 'Scene 5 narration.' }
    ]
    const plan = planner.planVisualMix({
      profile: 'general',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 1,
        stockFootageRatio: 0,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      masterPlan: createMockMasterPlan(scenes)
    })

    assert.strictEqual(plan.targetAiScenes, 5)
    assert.strictEqual(plan.targetStockScenes, 0)
    assert.ok(plan.scenes.every((s) => s.strategy === 'ai-still'))
  })

  it('6. 0/100 Custom Mix allocates 100% stock footage', () => {
    const planner = new VisualMixPlanner()
    const scenes = [
      { text: 'Scene 1 narration.' },
      { text: 'Scene 2 narration.' },
      { text: 'Scene 3 narration.' }
    ]
    const plan = planner.planVisualMix({
      profile: 'general',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 0,
        stockFootageRatio: 1,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      masterPlan: createMockMasterPlan(scenes)
    })

    assert.strictEqual(plan.targetAiScenes, 0)
    assert.strictEqual(plan.targetStockScenes, 3)
    assert.ok(plan.scenes.every((s) => s.strategy === 'stock'))
  })

  // 3. Determinism
  it('7. VisualMixPlanner is completely deterministic across repeated runs', () => {
    const planner = new VisualMixPlanner()
    const scenes = [
      { text: 'Quantum fluctuations in the early cosmic inflation period.' },
      { text: 'People watching the solar eclipse in a city park.' },
      { text: 'Gravitational lensing bending spacetime around galaxy clusters.' },
      { text: 'Telescope operators adjusting mirrors in an observatory.' },
      { text: 'Dark matter filament networks spanning across the universe.' },
      { text: 'Students looking through amateur backyard telescopes.' }
    ]
    const masterPlan = createMockMasterPlan(scenes)
    const config = {
      mode: 'custom-mix' as const,
      aiImageRatio: 0.5,
      stockFootageRatio: 0.5,
      width: 1920,
      height: 1080,
      motionEnabled: true,
      generationConcurrency: 6,
      postProcessConcurrency: 2
    }

    const run1 = planner.planVisualMix({ profile: 'general', config, masterPlan })
    const run2 = planner.planVisualMix({ profile: 'general', config, masterPlan })

    for (let i = 0; i < scenes.length; i++) {
      assert.strictEqual(
        run1.scenes[i].strategy,
        run2.scenes[i].strategy,
        `Scene ${i + 1} strategy must be identical`
      )
      assert.strictEqual(
        run1.scenes[i].prompt,
        run2.scenes[i].prompt,
        `Scene ${i + 1} prompt must be identical`
      )
      assert.strictEqual(
        run1.scenes[i].motionPreset,
        run2.scenes[i].motionPreset,
        `Scene ${i + 1} motionPreset must be identical`
      )
    }
  })

  // 4. Pacing Rules
  it('8. Pacing smoothing prevents excessive runs of AI stills', () => {
    const planner = new VisualMixPlanner()
    // 12 abstract scenes with 75% AI (target 9 AI, 3 stock)
    const scenes = Array.from({ length: 12 }, (_, i) => ({
      text: `Abstract concept chapter ${i + 1} explaining mathematical logic.`
    }))
    const plan = planner.planVisualMix({
      profile: 'general',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 0.75,
        stockFootageRatio: 0.25,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      masterPlan: createMockMasterPlan(scenes)
    })

    let maxConsecutiveAi = 0
    let currentAiRun = 0
    for (const sc of plan.scenes) {
      if (sc.strategy === 'ai-still') {
        currentAiRun++
        if (currentAiRun > maxConsecutiveAi) maxConsecutiveAi = currentAiRun
      } else {
        currentAiRun = 0
      }
    }

    assert.ok(maxConsecutiveAi <= 5, `Max consecutive AI was ${maxConsecutiveAi}, expected <= 5`)
  })

  console.log(`\nVisual Mix Planner Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
