/**
 * Universal Subject Identity Grounding & Video Keywords Test Suite
 * Tests: Subject identity, scene-specific grounding, cultural substitution prevention,
 * non-Hutterite colony detection, other niches, future unknown niches, camera compatibility,
 * and semantic contamination guards.
 */
import { assert, createRunner } from './manual-ai-test-utils'
import {
  resolveVideoSubjectGrounding,
  type VideoSubjectGrounding
} from '../src/main/visual-mix/manual-ai/manual-ai-video-subject-grounding'
import {
  extractSceneVideoKeywords,
  extractSceneAvoidKeywords
} from '../src/main/visual-mix/manual-ai/manual-ai-video-keywords'
import {
  detectVideoNiche,
  resolveVideoCameraMotion,
  VIDEO_NICHE_DIRECTIVES
} from '../src/main/visual-mix/manual-ai/manual-ai-video-prompt-pack'
import type {
  GlobalScriptContext,
  VisualMixScenePlan
} from '../shared/types'
import type {
  VisualIdentityBible,
  VisualIdentityEntity
} from '../src/main/content-intelligence/visual-identity-types'
import { prepareManualAiVisualDirection } from '../src/main/visual-mix/manual-ai/manual-ai-visual-director'
import { makeProject } from './manual-ai-test-utils'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { mixOf } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Video Subject Grounding Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Video Subject Grounding Tests ---')

  const sampleHutteriteBible: VisualIdentityBible = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHash: 'test-hash-hutterite',
    contentIntelligenceHash: 'ci-hash-hutterite',
    primaryIdentityId: 'community-hutterites',
    identityMode: 'community',
    entities: [
      {
        id: 'community-hutterites',
        canonicalName: 'Hutterites',
        entityType: 'community',
        importance: 'primary',
        aliases: ['Hutterian Brethren', 'Hutterite colony members'],
        description: 'Communal Anabaptist agricultural community embracing modern agribusiness machinery',
        visualSignature: {
          clothing: ['practical collared work shirts', 'durable work trousers', 'work suspenders', 'modest dark dresses'],
          grooming: ['neat practical grooming', 'traditional head coverings for women'],
          agePresentation: ['multi-generational working adults'],
          physiquePresentation: ['physically active agricultural workers'],
          accessories: ['utilitarian work belts'],
          tools: ['industrial hand tools', 'wrenches', 'mechanical gauges'],
          behavior: ['coordinated collaborative manual labor', 'communal work discipline'],
          socialGrouping: ['cooperative working groups'],
          environment: ['rural communal colony farmstead', 'agricultural machinery yard'],
          architecture: ['utilitarian rural workshop', 'communal residential quarters', 'central dining hall'],
          machinery: ['modern high-horsepower tractors', 'combine harvesters', 'grain augers', 'hydraulic lifts'],
          recurringObjects: ['tool storage racks', 'large communal prep vessels'],
          materialCulture: ['functional agrarian craftsmanship'],
          eraMarkers: ['contemporary rural agribusiness'],
          geographicMarkers: ['North American prairies'],
          technologyLevel: ['advanced contemporary agricultural equipment']
        },
        requiredTraits: ['modest practical work clothing', 'communal cooperative activity'],
        optionalTraits: ['workshop tool racks', 'modern agricultural machinery'],
        forbiddenTraits: ['buggy', 'horse-drawn carriage', 'straw hats', 'rejection of modern machinery'],
        mustNotConfuseWith: ['generic Amish horse-and-buggy imagery', 'Old Order Amish', 'Mennonites'],
        uncertainty: [],
        evidence: [{ trait: 'Script explicit', level: 'script-explicit', confidence: 0.95 }],
        confidence: 0.95
      }
    ],
    globalRules: {
      realism: ['observational documentary realism'],
      authenticityRequirements: ['accurate contemporary agricultural context'],
      forbiddenGenericSubstitutions: ['generic farm workers without community identity'],
      forbiddenCrossIdentitySubstitutions: ['Amish horse and buggy']
    }
  }

  const sampleHutteriteGlobalContext: GlobalScriptContext = {
    projectId: 'test_hutterite',
    language: 'en',
    version: 1,
    generatedAt: new Date().toISOString(),
    modelUsed: 'test',
    primarySubject: 'Hutterite agricultural colonies and communal economy',
    secondarySubjects: ['modern agribusiness', 'land registration'],
    globalSynopsis: 'A documentary examining contemporary Hutterite communal colonies in the Canadian prairies.',
    centralThesis: 'Hutterites combine deep religious communal traditions with cutting-edge modern agricultural technology.',
    documentaryAngle: 'observational documentary',
    targetAudience: 'general public',
    geography: { primaryCountry: 'Canada', primaryRegion: 'Manitoba prairies', secondaryLocations: [] },
    timeContext: { primaryPeriod: 'contemporary', historicalPeriods: [] },
    communities: [
      {
        name: 'Hutterites',
        role: 'Primary subject',
        visualDescription: 'Communal agrarian community',
        mustNotConfuseWith: ['Amish', 'Mennonite'],
        visualIdentity: {
          clothing: ['collared work shirts', 'trousers', 'modest dresses'],
          machinery: ['modern combines', 'tractors'],
          tools: ['workshop equipment'],
          forbiddenTraits: ['horse-drawn buggy']
        }
      }
    ],
    recurringPeople: [],
    visualWorld: {
      environment: ['communal farmstead', 'prairie fields'],
      architecture: ['workshop', 'dining hall'],
      clothing: ['modest practical workwear'],
      occupations: ['farmers', 'equipment mechanics'],
      machinery: ['modern agricultural equipment'],
      recurringObjects: ['hand tools', 'ledgers'],
      colorMood: 'natural prairie daylight',
      documentaryStyle: 'observational realism'
    },
    exactTopicAnchors: ['Hutterite colony', 'Hutterian Brethren', 'communal farming'],
    contextualAnchors: ['prairie agriculture', 'land purchase'],
    forbiddenSubstitutions: ['Amish stereotyping', 'horse and buggy'],
    negativeKeywords: ['horse and buggy', 'quaint historical costume'],
    recurringVisualMotifs: ['coordinated group labor'],
    storyArc: []
  }

  // ─── Test 1: Hutterite Workshop Grounding ──────────────────────────────────
  await it('Section 91: Hutterite workshop scene grounds subject identity and practical details', () => {
    const workshopScene: VisualMixScenePlan = {
      sceneIndex: 5,
      narration: 'Inside the colony workshop, Hutterite men perform routine maintenance on their combines and hydraulic systems.',
      visualIntent: 'Group of Hutterite men maintaining workshop equipment',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const grounding = resolveVideoSubjectGrounding({
      scene: workshopScene,
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })

    assert.equal(grounding.presence, 'dominant', 'Presence must be dominant for active workshop labor')
    assert.ok(grounding.canonicalSubject.includes('Hutterite'), 'Canonical subject identifies Hutterite men')
    assert.ok(grounding.wardrobe.some((w) => w.includes('collared') || w.includes('trousers') || w.includes('work shirts')), 'Modest practical workwear identified')
    assert.ok(grounding.machinery.some((m) => m.includes('agricultural') || m.includes('housing') || m.includes('tractors')), 'Modern machinery identified')
    assert.ok(grounding.tools.some((t) => t.includes('tools') || t.includes('wrenches') || t.includes('fittings')), 'Workshop tools identified')
    assert.ok(grounding.forbiddenSubstitutions.some((f) => f.includes('Amish') || f.includes('buggy')), 'Amish stereotyping explicitly forbidden')
  })

  // ─── Test 2: Scene-Specific Differentiation ────────────────────────────────
  await it('Section 92: Differentiates workshop, courthouse, documents, kitchen, and aerial scenes', () => {
    // A: Workshop
    const workshop = resolveVideoSubjectGrounding({
      scene: {
        sceneIndex: 1,
        narration: 'Maintaining machinery in the shop.',
        visualIntent: 'Hutterite men repairing machinery in workshop',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })
    assert.equal(workshop.presence, 'dominant')
    assert.ok(workshop.architecture.some((a) => a.includes('workshop')))
    assert.ok(workshop.wardrobe.length > 0)

    // B: Courthouse exterior
    const courthouse = resolveVideoSubjectGrounding({
      scene: {
        sceneIndex: 2,
        narration: 'Legal records of colony land acquisitions are held at the federal courthouse in downtown Winnipeg.',
        visualIntent: 'Exterior of federal courthouse building with classical stone columns',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })
    assert.equal(courthouse.presence, 'context', 'Courthouse presence should be context, not dominant')
    assert.equal(courthouse.subjectType, 'architecture')
    assert.ok(courthouse.architecture.some((a) => a.includes('courthouse') || a.includes('columns') || a.includes('facade')))
    assert.equal(courthouse.wardrobe.length, 0, 'Must NOT inject farm clothing into courthouse exterior')
    assert.equal(courthouse.machinery.length, 0, 'Must NOT inject tractors into downtown courthouse')

    // C: Archival Documents
    const documents = resolveVideoSubjectGrounding({
      scene: {
        sceneIndex: 3,
        narration: 'The original 1918 land deed established the colony boundaries under federal statutory law.',
        visualIntent: 'Macro close-up of historical legal documents, deed stamps and bound register',
        duration: 4,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })
    assert.equal(documents.presence, 'context')
    assert.equal(documents.subjectType, 'product')
    assert.ok(documents.materialCulture.some((m) => m.includes('ledger') || m.includes('deed') || m.includes('document')))
    assert.equal(documents.wardrobe.length, 0, 'Must NOT inject people clothing into document macro shot')

    // D: Communal Kitchen
    const kitchen = resolveVideoSubjectGrounding({
      scene: {
        sceneIndex: 4,
        narration: 'In the communal kitchen, women prepare noon meals for more than one hundred community members.',
        visualIntent: 'Hutterite women preparing food in large communal colony kitchen',
        duration: 6,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })
    assert.equal(kitchen.presence, 'dominant')
    assert.ok(kitchen.canonicalSubject.includes('kitchen') || kitchen.canonicalSubject.includes('women'))
    assert.ok(kitchen.architecture.some((a) => a.includes('kitchen')))
    assert.ok(kitchen.wardrobe.some((w) => w.includes('dresses') || w.includes('aprons') || w.includes('head coverings')))

    // E: Aerial Farmstead
    const aerial = resolveVideoSubjectGrounding({
      scene: {
        sceneIndex: 5,
        narration: 'From above, the colony layout reveals organized residential units, workshops, and extensive crop acreage.',
        visualIntent: 'Aerial drone panoramic view of Hutterite communal farmstead and prairie fields',
        duration: 7,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })
    assert.equal(aerial.presence, 'visible')
    assert.ok(aerial.architecture.some((a) => a.includes('residential') || a.includes('silos') || a.includes('layout')))
    assert.equal(aerial.wardrobe.length, 0, 'No individual clothing details in high-altitude aerial view')
  })

  // ─── Test 3: Cultural Substitution Prevention ──────────────────────────────
  await it('Section 93: Prevents Amish stereotyping and incorporates modern agricultural machinery', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Modern agricultural machinery is essential to colony productivity.',
      visualIntent: 'Hutterite workers operating large modern combine harvesters in wheat field',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const grounding = resolveVideoSubjectGrounding({
      scene,
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })

    assert.ok(
      grounding.forbiddenSubstitutions.some((f) => f.includes('Amish') || f.includes('horse-and-buggy')),
      'Must contain forbidden Amish substitutions'
    )
    assert.ok(
      !grounding.machinery.some((m) => /\b(horse-drawn|buggy|horse-and-buggy)\b/i.test(m) || (/\bhorse\b/i.test(m) && !m.includes('horsepower'))),
      'Must NOT contain horse and buggy in machinery'
    )
  })

  // ─── Test 4: Non-Hutterite Colony ──────────────────────────────────────────
  await it('Section 95: Roman colony does NOT trigger Hutterite identity profile', () => {
    const romanScene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'The Roman colony at Augusta Emerita expanded along the Iberian trade network.',
      visualIntent: 'Roman colony settlement with classical stone buildings and aqueduct',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const romanContext: GlobalScriptContext = {
      projectId: 'roman_doc',
      language: 'en',
      version: 1,
      generatedAt: 'now',
      modelUsed: 'test',
      primarySubject: 'Ancient Roman provincial settlements',
      secondarySubjects: ['Iberian colonies'],
      globalSynopsis: 'Documentary about Roman colonies in Hispania.',
      centralThesis: 'Roman colonies served as military and administrative hubs.',
      documentaryAngle: 'historical',
      targetAudience: 'general',
      geography: { secondaryLocations: [] },
      timeContext: { primaryPeriod: 'Roman Imperial', historicalPeriods: ['1st century AD'] },
      communities: [],
      recurringPeople: [],
      visualWorld: { environment: [], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: '', documentaryStyle: '' },
      exactTopicAnchors: ['Roman colony', 'Hispania', 'aqueduct'],
      contextualAnchors: [],
      forbiddenSubstitutions: [],
      negativeKeywords: [],
      recurringVisualMotifs: [],
      storyArc: []
    }

    const detectedNiche = detectVideoNiche(
      `${romanScene.narration} ${romanScene.visualIntent}`,
      'general',
      romanContext
    )

    assert.notEqual(detectedNiche, 'hutterite-documentary', 'Roman colony must NOT be detected as hutterite-documentary')
    assert.equal(detectedNiche, 'history', 'Roman colony should be detected as history')

    const grounding = resolveVideoSubjectGrounding({
      scene: romanScene,
      globalContext: romanContext
    })

    assert.ok(!grounding.canonicalSubject.toLowerCase().includes('hutterite'), 'Roman scene subject must not include Hutterite')
    assert.ok(!grounding.wardrobe.some((w) => w.includes('suspenders') || w.includes('dresses')), 'No Hutterite clothes in Roman scene')
  })

  // ─── Test 5: Future Unknown Niche Support ───────────────────────────────────
  await it('Section 97: Resolves future unknown niche entity from VisualIdentityBible without hardcoded niche', () => {
    const futureBible: VisualIdentityBible = {
      schemaVersion: 1,
      generatedAt: 'now',
      sourceHash: 'fut-1',
      contentIntelligenceHash: 'ci-1',
      primaryIdentityId: 'martian-agronomists',
      identityMode: 'community',
      entities: [
        {
          id: 'martian-agronomists',
          canonicalName: 'Martian Hydroponics Guild',
          entityType: 'organization',
          importance: 'primary',
          aliases: ['Red Planet Cultivators'],
          description: 'Specialized botanists operating subterranean pressurized aeroponic biomes on Mars',
          visualSignature: {
            clothing: ['pressurized sealed jumpsuits with copper-mesh thermal lining', 'magnetic biome boots'],
            grooming: ['short functional hair'],
            agePresentation: [],
            physiquePresentation: [],
            accessories: ['wrist-mounted atmospheric telemetry scanners'],
            tools: ['laser pruning shears', 'nutrient nutrient-solution injectors'],
            behavior: ['calibrated microclimate inspections'],
            socialGrouping: ['botanical technician pairs'],
            environment: ['subterranean pressurized dome', 'red regolith airlock exterior'],
            architecture: ['geodesic pressurized biomes with reflective thermal shielding'],
            machinery: ['automated vertical aeroponic misting towers', 'closed-loop CO2 scrubbers'],
            recurringObjects: ['translucent hydroponic nutrient conduits'],
            materialCulture: ['titanium biome structural fittings'],
            eraMarkers: ['late 22nd century interplanetary settlement'],
            geographicMarkers: ['Mars Valles Marineris'],
            technologyLevel: ['advanced closed-loop life support']
          },
          requiredTraits: ['sealed pressurized jumpsuits', 'vertical aeroponic misting towers'],
          optionalTraits: ['wrist telemetry scanner'],
          forbiddenTraits: ['open-air farming', 'diesel tractors', 'chemical pesticides', 'space fantasy laser guns'],
          mustNotConfuseWith: ['traditional terrestrial farmers', 'space pirates'],
          uncertainty: [],
          evidence: [],
          confidence: 0.98
        }
      ],
      globalRules: {
        realism: ['hard sci-fi documentary realism'],
        authenticityRequirements: ['accurate physics of closed-loop habitats'],
        forbiddenGenericSubstitutions: [],
        forbiddenCrossIdentitySubstitutions: []
      }
    }

    const futureScene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Inside the subsurface dome, Martian agronomists calibrate the vertical aeroponic misting cycles for optimal yield.',
      visualIntent: 'Martian Hydroponics Guild technicians inspecting aeroponic misting towers',
      duration: 6,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const grounding = resolveVideoSubjectGrounding({
      scene: futureScene,
      identityBible: futureBible
    })

    assert.equal(grounding.canonicalSubject, 'Martian Hydroponics Guild')
    assert.equal(grounding.presence, 'dominant')
    assert.ok(grounding.wardrobe.some((w) => w.includes('pressurized sealed jumpsuits')))
    assert.ok(grounding.machinery.some((m) => m.includes('aeroponic misting towers')))
    assert.ok(grounding.architecture.some((a) => a.includes('geodesic pressurized biomes')))
    assert.ok(grounding.forbiddenSubstitutions.some((f) => f.includes('open-air farming')))

    const keywords = extractSceneVideoKeywords({
      scene: futureScene,
      grounding
    })

    assert.ok(keywords.length >= 8, 'Generated at least 8 keywords')
    assert.ok(keywords.some((k) => k.includes('Martian Hydroponics Guild')))
    assert.ok(keywords.some((k) => k.includes('jumpsuits') || k.includes('aeroponic')))
  })

  // ─── Test 6: Semantic Contamination Guard ──────────────────────────────────
  await it('Section 98: Non-medical documentary scene contains no biological contamination', async () => {
    const dir = makeProject(4, { health: false })
    const plan = VisualMixPlanner.buildPlan({
      projectDir: dir,
      rawScenes: VisualMixPlanner.loadScenesFromEditPlan(dir),
      config: mixOf(100, 0, 'prompt'),
      profile: 'general'
    })

    const bundle = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'general',
      apiKey: undefined
    })

    for (const [, dirEntry] of bundle.sceneDirections.entries()) {
      const cause = dirEntry.visualEvent.cause || ''
      const consequence = dirEntry.visualEvent.consequence || ''

      assert.ok(
        !cause.includes('physiological biological activity'),
        `Fallback cause must not contain physiological biological activity in general profile, got: "${cause}"`
      )
      assert.ok(
        !consequence.includes('observable biological state'),
        `Fallback consequence must not contain observable biological state in general profile, got: "${consequence}"`
      )
    }
  })

  // ─── Test 7: Physically Compatible Camera Motion ───────────────────────────
  await it('Section 99: Physically compatible camera motions for aerial, macro, and stationary scenes', () => {
    const directive = VIDEO_NICHE_DIRECTIVES['hutterite-documentary']

    // 1. Aerial drone scene
    const aerialMotion = resolveVideoCameraMotion({
      scene: {
        sceneIndex: 1,
        narration: 'From high altitude, the prairie farmstead stretches across the horizon.',
        visualIntent: 'Aerial drone panoramic view of farm colony',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      directive,
      niche: 'hutterite-documentary'
    })
    assert.ok(aerialMotion.includes('drone') || aerialMotion.includes('aerial'), `Aerial scene must have aerial camera motion, got: ${aerialMotion}`)
    assert.ok(!aerialMotion.includes('walking-speed'), 'Aerial scene must NOT have walking-speed dolly motion')

    // 2. Macro document scene
    const macroMotion = resolveVideoCameraMotion({
      scene: {
        sceneIndex: 2,
        narration: 'Inspecting the fine archival script.',
        visualIntent: 'Macro close-up of historical legal document and seal',
        duration: 4,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      directive,
      niche: 'history'
    })
    assert.ok(macroMotion.includes('slider') || macroMotion.includes('macro'), `Macro scene must have slider/macro motion, got: ${macroMotion}`)

    // 3. Stationary observation
    const staticMotion = resolveVideoCameraMotion({
      scene: {
        sceneIndex: 3,
        narration: 'The sunrise breaks across the quiet landscape.',
        visualIntent: 'Timelapse of stationary morning light across the prairie',
        duration: 6,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: ''
      },
      directive,
      niche: 'hutterite-documentary'
    })
    assert.ok(staticMotion.includes('locked-off'), `Stationary scene must have locked-off motion, got: ${staticMotion}`)
  })

  // ─── Test 8: Keywords Extraction & Avoid Constraints ───────────────────────
  await it('Section 100: Positive and avoid keywords are relevant, deduplicated, and within budget', () => {
    const scene: VisualMixScenePlan = {
      sceneIndex: 1,
      narration: 'Workers inspect and adjust mechanical components in the equipment workshop.',
      visualIntent: 'Group of Hutterite men maintaining workshop equipment',
      duration: 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const grounding = resolveVideoSubjectGrounding({
      scene,
      identityBible: sampleHutteriteBible,
      globalContext: sampleHutteriteGlobalContext
    })

    const keywords = extractSceneVideoKeywords({
      scene,
      grounding,
      globalContext: sampleHutteriteGlobalContext,
      niche: 'hutterite-documentary'
    })

    const avoids = extractSceneAvoidKeywords({
      scene,
      grounding,
      globalContext: sampleHutteriteGlobalContext,
      niche: 'hutterite-documentary'
    })

    assert.ok(keywords.length >= 8 && keywords.length <= 16, `Keywords count must be 8-16, got ${keywords.length}`)
    assert.ok(keywords.some((k) => k.toLowerCase().includes('hutterite')), 'Keywords must contain Hutterite subject')
    assert.ok(keywords.some((k) => k.toLowerCase().includes('workshop') || k.toLowerCase().includes('equipment')), 'Keywords must contain workshop context')

    // No biological terms in general niche
    for (const kw of keywords) {
      assert.ok(!/\b(kidney|glomerulus|cellular|biological|nephron)\b/i.test(kw), `Non-medical keywords must not contain biological terms, got "${kw}"`)
    }

    assert.ok(avoids.length >= 3 && avoids.length <= 8, `Avoid count must be 3-8, got ${avoids.length}`)
    assert.ok(avoids.some((a) => a.toLowerCase().includes('amish')), 'Avoid must include Amish stereotyping')
    assert.ok(avoids.some((a) => a.toLowerCase().includes('watermark') || a.toLowerCase().includes('subtitles')), 'Avoid must include technical hygiene constraints')
  })

  finish()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
