/**
 * Manual AI Visual Director — Level B Scene Directions tests.
 * Tests: AI-owned scenes only, narrative roles, hook levels, active visible events,
 * caching & persistence, real scene numbers preservation.
 */
import * as fs from 'fs'
import {
  prepareManualAiVisualDirection
} from '../src/main/visual-mix/manual-ai/manual-ai-visual-director'
import {
  getManualAiSceneDirectionsPath
} from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { assert, cleanupFixtures, createRunner, makeProject, mixOf, readJson } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Scene Direction Tests')

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
  console.log('\nManual AI Scene Directions')

  await it('generates scene directions for AI-owned scenes ONLY (85 AI out of 100 scenes)', async () => {
    const dir = makeProject(100, { health: true })
    const plan = planFor(dir, 0.85, 0.15, 'health')
    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    const stockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

    assert.strictEqual(aiScenes.length, 85)
    assert.strictEqual(stockScenes.length, 15)

    const bundle = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })

    assert.strictEqual(bundle.sceneDirections.size, 85)
    for (const s of aiScenes) {
      assert.ok(bundle.sceneDirections.has(s.sceneIndex), `AI scene ${s.sceneIndex} must have direction`)
    }
    for (const s of stockScenes) {
      assert.ok(!bundle.sceneDirections.has(s.sceneIndex), `Stock scene ${s.sceneIndex} must not have direction`)
    }

    const artifactPath = getManualAiSceneDirectionsPath(dir)
    assert.ok(fs.existsSync(artifactPath), 'manual-ai-scene-directions.json must exist')
    const artifact = readJson(artifactPath)
    assert.strictEqual(artifact.totalAiScenes, 85)
    assert.strictEqual(artifact.directions.length, 85)
  })

  await it('classifies scene roles, hook levels, and provides active visible verbs for mechanism scenes', async () => {
    const dir = makeProject(10, {
      health: true,
      narration: (i) => {
        if (i === 1) return 'Why do your kidneys never sleep at night? The surprising truth.'
        if (i === 2) return 'Blood is continuously flowing through the renal artery under pressure.'
        if (i === 3) return 'Both kidneys actively filtering arterial blood and separating waste products.'
        if (i === 4) return 'The bladder is visibly filling as fluid descends through both ureters.'
        return `Scene ${i} describes healthy hydration habits before bedtime.`
      }
    })
    const plan = planFor(dir, 1, 0, 'health')

    const bundle = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })

    const dir1 = bundle.sceneDirections.get(1)!
    assert.strictEqual(dir1.sceneRole, 'hook')
    assert.strictEqual(dir1.hookLevel, 'high')

    const dir3 = bundle.sceneDirections.get(3)!
    assert.ok(dir3.sceneRole === 'mechanism' || dir3.sceneRole === 'cause-effect')
    assert.ok(dir3.visualEvent.action.length > 0, 'Mechanism scene must have an action')
    assert.ok(
      /\b(filtering|flowing|filling|transporting|separating)\b/i.test(dir3.visualEvent.action),
      `Expected active verb in action, got "${dir3.visualEvent.action}"`
    )

    const dir4 = bundle.sceneDirections.get(4)!
    assert.ok(dir4.visualEvent.action.length > 0)
    assert.ok(
      /\b(filling|flowing|filtering|transporting|descending)\b/i.test(dir4.visualEvent.action),
      `Expected active verb in action, got "${dir4.visualEvent.action}"`
    )
  })

  await it('scene directions are cached and reused on subsequent invocations', async () => {
    const dir = makeProject(12, { health: true })
    const plan = planFor(dir, 1, 0, 'health')

    const first = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })
    assert.strictEqual(first.metrics.cacheHit, false)

    const directionsPath = getManualAiSceneDirectionsPath(dir)
    const mtime = fs.statSync(directionsPath).mtimeMs

    const second = await prepareManualAiVisualDirection({
      projectDir: dir,
      plan,
      profile: 'health',
      apiKey: undefined
    })
    assert.strictEqual(second.metrics.cacheHit, true)
    assert.strictEqual(fs.statSync(directionsPath).mtimeMs, mtime, 'Scene directions file not modified on cache hit')
  })

  cleanupFixtures()
  finish()
}

void main()
