/**
 * Manual AI Visual Director — Level A Global Visual Brief tests.
 * Tests: Global brief generation, storytelling mode, fallback when API key is missing,
 * caching & persistence, script change invalidation, and semantic script hashes.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  computeScriptHash,
  prepareManualAiVisualDirection
} from '../src/main/visual-mix/manual-ai/manual-ai-visual-director'
import {
  getManualAiVisualBriefPath
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { assert, cleanupFixtures, createRunner, makeProject, mixOf, readJson } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Visual Director Tests')

function planFor(dir: string, ai: number, stock: number, profile: 'health' | 'general') {
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
  console.log('\nManual AI Visual Director — Global Brief')

  await it('generates deterministic fallback Global Visual Brief when Gemini API key is missing', async () => {
    const dir = makeProject(20, { health: true })
    const plan = planFor(dir, 0.85, 0.15, 'health')

    const bundle = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      globalContext: {
        projectId: 'test_p',
        language: 'en',
        version: 1,
        primarySubject: 'Kidney filtration and bladder function',
        centralThesis: 'Why nighttime urine production continues',
        globalSynopsis: 'A documentary exploring overnight kidney mechanisms.',
        documentaryAngle: 'medical explainer',
        targetAudience: 'general health',
        geography: { primaryCountry: null, primaryRegion: null, secondaryLocations: [] },
        timeContext: { primaryPeriod: 'contemporary', historicalPeriods: [] },
        communities: [],
        recurringPeople: [],
        visualWorld: {
          environment: ['clinical cutaway'],
          architecture: [],
          clothing: [],
          occupations: [],
          machinery: [],
          recurringObjects: [],
          colorMood: 'cool navy',
          documentaryStyle: 'medical'
        },
        exactTopicAnchors: ['kidneys', 'bladder'],
        contextualAnchors: ['filtration', 'urine'],
        forbiddenSubstitutions: [],
        negativeKeywords: [],
        recurringVisualMotifs: ['fluid flow'],
        storyArc: []
      },
      apiKey: undefined // No API key -> must fall back gracefully
    })

    assert.ok(bundle.brief, 'brief must be present')
    assert.strictEqual(bundle.brief.profile, 'health')
    assert.strictEqual(bundle.brief.fallbackUsed, true)
    assert.strictEqual(bundle.brief.modelUsed, 'local-fallback')
    assert.strictEqual(bundle.brief.storytellingMode, 'mechanism-explainer')
    assert.ok(bundle.brief.corePromise.length > 10, 'corePromise must not be empty')
    assert.ok(bundle.brief.centralQuestion.length > 10, 'centralQuestion must not be empty')
    assert.ok(bundle.brief.visualStrategy.dominantStyle.length > 5, 'dominantStyle must not be empty')
    assert.ok(bundle.brief.visualStrategy.cameraLanguage.length > 5, 'cameraLanguage must not be empty')
    assert.ok(bundle.brief.hookStrategy.primaryHookType.length > 5, 'hookStrategy must not be empty')

    // Persisted artifact verification
    const briefPath = getManualAiVisualBriefPath(dir)
    assert.ok(fs.existsSync(briefPath), 'manual-ai-visual-brief.json must be saved')
    const saved = readJson(briefPath)
    assert.strictEqual(saved.profile, 'health')
    assert.strictEqual(saved.storytellingMode, 'mechanism-explainer')
  })

  await it('General profile generates appropriate documentary brief and does not force medical styling', async () => {
    const dir = makeProject(15)
    const plan = planFor(dir, 0.8, 0.2, 'general')

    const bundle = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'general',
      apiKey: undefined
    })

    assert.strictEqual(bundle.brief.profile, 'general')
    assert.strictEqual(bundle.brief.primaryNiche, 'editorial-documentary')
    assert.ok(!bundle.brief.visualStrategy.cameraLanguage.includes('medical-documentary'))
    assert.ok(bundle.brief.visualStrategy.dominantStyle.includes('grounded documentary'))
  })

  await it('caches Global Visual Brief and reuses it on subsequent calls (cache hit)', async () => {
    const dir = makeProject(10, { health: true })
    const plan = planFor(dir, 1, 0, 'health')

    const first = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })
    assert.strictEqual(first.metrics.cacheHit, false)

    const briefPath = getManualAiVisualBriefPath(dir)
    const mtime = fs.statSync(briefPath).mtimeMs

    const second = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })
    assert.strictEqual(second.metrics.cacheHit, true)
    assert.strictEqual(fs.statSync(briefPath).mtimeMs, mtime, 'File should not be modified on cache hit')
    assert.strictEqual(second.brief.generatedAt, first.brief.generatedAt)
  })

  await it('computeScriptHash changes when script changes, triggering re-analysis', () => {
    const h1 = computeScriptHash('Script text about kidneys filtering fluid.', 'health')
    const h2 = computeScriptHash('Script text about kidneys filtering fluid.', 'health')
    assert.strictEqual(h1, h2, 'Identical script and profile yield identical hash')

    const h3 = computeScriptHash('Script text about heart pumping blood.', 'health')
    assert.notStrictEqual(h1, h3, 'Altered script text yields different hash')

    const h4 = computeScriptHash('Script text about kidneys filtering fluid.', 'general')
    assert.notStrictEqual(h1, h4, 'Altered profile yields different hash')
  })

  cleanupFixtures()
  finish()
}

void main()
