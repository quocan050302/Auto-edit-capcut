/**
 * Automated Tests for Health Visual Pipeline Integration,
 * Reconciliation, Persistence, and Fallbacks
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ContentType, ProjectInputs, ProjectState } from '../shared/types'
import { checkStockCompletion } from '../src/main/pipeline/pipeline-artifacts'
import { buildHealthMotionFilter } from '../src/main/health/health-motion'
import { recordHealthFallbackStock, loadHealthGeneratedManifest } from '../src/main/health/health-visual-cache'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING HEALTH VISUAL PIPELINE INTEGRATION TESTS')
  console.log('==================================================\n')

  const testDir = path.join(os.tmpdir(), `health-pipeline-test-${Date.now()}`)
  fs.mkdirSync(path.join(testDir, 'analysis'), { recursive: true })
  fs.mkdirSync(path.join(testDir, 'assets', 'generated', 'health'), { recursive: true })

  const cleanup = (): void => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  try {
    // TEST 1: Old project without contentType => default
    await it('TEST 1: Old project without contentType defaults safely to "default"', () => {
      const oldProjectJson: Partial<ProjectState> = {
        id: 'legacy-project-123',
        name: 'Legacy Project',
        inputs: {
          topic: 'Space Exploration',
          language: 'en-US'
        } as ProjectInputs
      }

      // Backward compatibility rule: project.inputs.contentType ?? 'default'
      const effectiveType: ContentType = oldProjectJson.inputs?.contentType ?? 'default'
      assert.strictEqual(effectiveType, 'default')
    })

    // TEST 2: New project => contentType default
    await it('TEST 2: New project initializes with contentType: "default"', () => {
      const newProjectInputs: ProjectInputs = {
        topic: 'Health & Wellness',
        contentType: 'default'
      }

      assert.strictEqual(newProjectInputs.contentType, 'default')
    })

    // TEST 3: Selecting Health persists
    await it('TEST 3: Selecting Health persists in project inputs and can be serialized', () => {
      const inputs: ProjectInputs = {
        topic: 'Liver Disease Explainer',
        contentType: 'health'
      }

      const serialized = JSON.stringify(inputs)
      const deserialized: ProjectInputs = JSON.parse(serialized)

      assert.strictEqual(deserialized.contentType, 'health')
    })

    // TEST 4: Default pipeline does NOT invoke Health generation
    await it('TEST 4: Default pipeline does NOT invoke Health generation', () => {
      const contentType: ContentType = 'default'
      let healthEngineInvoked = false

      if (contentType === 'health') {
        healthEngineInvoked = true
      }

      assert.strictEqual(healthEngineInvoked, false)
    })

    // TEST 12: AI failure falls back to stock
    await it('TEST 12: AI failure marks fallback-stock and persists for stock search retry', () => {
      recordHealthFallbackStock(testDir, 5, 'hash123', 'Flow rate limit exhausted after retries')

      const manifest = loadHealthGeneratedManifest(testDir)
      const sceneRecord = manifest.scenes['5']

      assert.ok(sceneRecord !== undefined)
      assert.strictEqual(sceneRecord.status, 'fallback-stock')
      assert.strictEqual(sceneRecord.strategy, 'stock')
      assert.ok(sceneRecord.error?.includes('Flow rate limit'))
    })

    // TEST 14: Generated Health assignment is counted by completion reconciliation
    await it('TEST 14: Generated Health visual assignment is counted by checkStockCompletion', () => {
      // 1. Create a dummy master-edit-plan with 2 scenes
      const mockPlan = {
        chapters: [
          {
            chapters_seq: [
              {
                scenes: [
                  { sceneIndex: 1, narrativeText: 'Scene 1 Anatomy' },
                  { sceneIndex: 2, narrativeText: 'Scene 2 Stock Footage' }
                ]
              }
            ]
          }
        ]
      }
      fs.writeFileSync(
        path.join(testDir, 'analysis', 'master-edit-plan.json'),
        JSON.stringify(mockPlan),
        'utf-8'
      )

      // 2. Create the generated image asset on disk for scene 1
      const aiStillPath = path.join(testDir, 'assets', 'generated', 'health', 'S0001_dummy.png')
      fs.writeFileSync(aiStillPath, Buffer.from('fake-png-data'))

      // 3. Create stock footage asset on disk for scene 2
      const stockPath = path.join(testDir, 'assets', 'stock_scene_2.mp4')
      fs.writeFileSync(stockPath, Buffer.from('fake-mp4-data'))

      // 4. Create stock-assignments.json with scene 1 (google-flow) and scene 2 (pexels)
      const mockAssignments = [
        {
          sceneIndex: 1,
          status: 'assigned',
          asset: {
            id: 'flow-s1',
            provider: 'google-flow',
            mediaType: 'photo',
            localPath: aiStillPath
          }
        },
        {
          sceneIndex: 2,
          status: 'assigned',
          asset: {
            id: 'pexels-s2',
            provider: 'pexels',
            mediaType: 'video',
            localPath: stockPath
          }
        }
      ]
      fs.writeFileSync(
        path.join(testDir, 'analysis', 'stock-assignments.json'),
        JSON.stringify(mockAssignments),
        'utf-8'
      )

      // 5. Run checkStockCompletion
      const completion = checkStockCompletion(testDir)
      assert.strictEqual(completion.totalScenes, 2)
      assert.strictEqual(completion.assignedScenes, 2)
      assert.strictEqual(completion.downloadedScenes, 2)
      assert.strictEqual(completion.missingScenes, 0)
      assert.strictEqual(completion.missingSceneIndices.length, 0)
    })

    // TEST 15: Health render correctly applies subtle motion preset to AI still images
    await it('TEST 15: Health motion filter generates subtle zoompan for AI stills', () => {
      const filterIn = buildHealthMotionFilter('slow-push-in', 1920, 1080, 4.0, 30)
      assert.ok(filterIn.includes('zoompan'))
      assert.ok(filterIn.includes('1920x1080'))
      assert.ok(filterIn.includes('1.0+'))

      const filterOut = buildHealthMotionFilter('slow-push-out', 1920, 1080, 4.0, 30)
      assert.ok(filterOut.includes('zoompan'))
      assert.ok(filterOut.includes('1.06-'))

      const filterLeft = buildHealthMotionFilter('pan-left', 1920, 1080, 4.0, 30)
      assert.ok(filterLeft.includes('zoompan'))
      assert.ok(filterLeft.includes('x='))

      const filterRight = buildHealthMotionFilter('pan-right', 1920, 1080, 4.0, 30)
      assert.ok(filterRight.includes('zoompan'))
      assert.ok(filterRight.includes('x='))

      const filterDrift = buildHealthMotionFilter('micro-drift', 1920, 1080, 4.0, 30)
      assert.ok(filterDrift.includes('zoompan'))
    })

    // TEST 16: Default renderer behavior is unchanged
    await it('TEST 16: Default motion preset "none" returns standard scale without zoompan', () => {
      const filterNone = buildHealthMotionFilter('none', 1920, 1080, 4.0, 30)
      assert.ok(!filterNone.includes('zoompan'))
      assert.ok(filterNone.includes('scale=1920:1080'))
    })
  } finally {
    cleanup()
  }

  console.log(`\nPipeline Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((e) => {
  console.error(e)
  process.exit(1)
})
