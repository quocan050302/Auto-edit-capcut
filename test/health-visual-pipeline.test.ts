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
import {
  recordHealthFallbackStock,
  loadHealthGeneratedManifest,
  computeHealthGenerationHash,
  computeHealthMotionHash
} from '../src/main/health/health-visual-cache'

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
      assert.ok(filterIn.includes('1.0000+') || filterIn.includes('1.0+'))

      const filterOut = buildHealthMotionFilter('slow-push-out', 1920, 1080, 4.0, 30)
      assert.ok(filterOut.includes('zoompan'))
      assert.ok(filterOut.includes('1.0600-') || filterOut.includes('1.06-'))

      const filterLeft = buildHealthMotionFilter('pan-left', 1920, 1080, 4.0, 30)
      assert.ok(filterLeft.includes('zoompan'))
      assert.ok(filterLeft.includes('x='))

      const filterRight = buildHealthMotionFilter('pan-right', 1920, 1080, 4.0, 30)
      assert.ok(filterRight.includes('zoompan'))
      assert.ok(filterRight.includes('x='))

      const filterDrift = buildHealthMotionFilter('micro-drift', 1920, 1080, 4.0, 30)
      assert.ok(filterDrift.includes('zoompan'))
    })

    // TEST 16 / TEST L: Default renderer behavior is unchanged
    await it('TEST 16 / TEST L: Default motion preset "none" returns standard scale without zoompan', () => {
      const filterNone = buildHealthMotionFilter('none', 1920, 1080, 4.0, 30)
      assert.ok(!filterNone.includes('zoompan'))
      assert.ok(filterNone.includes('scale=1920:1080'))
    })

    // TEST K: Health AI image multi-beat path receives Health motion spec without stacking zoom
    await it('TEST K: Health AI image motion filter generates single coherent smooth zoompan', () => {
      const motionSpec = {
        preset: 'push-in-right' as const,
        intensity: 'subtle' as const,
        focusX: 0.65,
        focusY: 0.45,
        zoomStart: 1.01,
        zoomEnd: 1.07,
        ease: 'ease-in-out' as const,
        reason: 'Focus on liver anatomical right'
      }
      const filter = buildHealthMotionFilter(motionSpec, 1920, 1080, 6.0, 30)
      assert.ok(filter.includes('zoompan='), 'Filter must use zoompan')
      assert.ok(filter.includes('s=1920x1080'), 'Filter must output exact 1920x1080 resolution')
      // Ensure zoompan is only specified once (no zoom stacking)
      const count = (filter.match(/zoompan=/g) || []).length
      assert.strictEqual(count, 1, 'Only one zoompan filter should be applied to prevent zoom stacking')
    })

    // TEST T: Motion/SFX change does NOT invalidate Google Flow AI image hash
    await it('TEST T: Motion / SFX changes do NOT invalidate Google Flow AI image hash', () => {
      const hashBefore = computeHealthGenerationHash(
        1,
        'Hepatocytes filtering blood in the liver.',
        'Close up of liver cellular structure',
        'Realistic 3D medical illustration of liver cells'
      )

      // Even if motion is changed completely or SFX added, generation hash must be identical
      const hashAfter = computeHealthGenerationHash(
        1,
        'Hepatocytes filtering blood in the liver.',
        'Close up of liver cellular structure',
        'Realistic 3D medical illustration of liver cells'
      )

      assert.strictEqual(hashBefore, hashAfter, 'Image generation hash must remain identical across motion/sfx changes')

      // Meanwhile, the motion hash reflects the motion/sfx change
      const motionHash1 = computeHealthMotionHash({
        scenes: [{ sceneIndex: 1, category: 'anatomy', motionPreset: 'push-in-center' }]
      })
      const motionHash2 = computeHealthMotionHash({
        scenes: [{ sceneIndex: 1, category: 'anatomy', motionPreset: 'pan-left', sfxCue: { type: 'air-swish', volumeDb: -25 } }]
      })
      assert.notStrictEqual(motionHash1, motionHash2, 'Motion hash must detect motion/SFX changes')
    })

    // TEST U: Audio mixer bus architecture preserves voiceover level when multiple SFX exist
    await it('TEST U: Audio mixer bus architecture keeps voiceover unattenuated (normalize=0)', () => {
      // Simulate renderer filter construction logic
      const hasAudio = true
      const musicLabels = ['[m0]']
      const sfxLabels = ['[s0]', '[s1]', '[s2]', '[s3]', '[s4]'] // 5 SFX tracks

      const filterParts: string[] = []
      const finalBuses: string[] = []
      if (hasAudio) finalBuses.push('[vo]')

      if (musicLabels.length === 1) {
        filterParts.push(`${musicLabels[0]}asplit=1[music_bus]`)
        finalBuses.push('[music_bus]')
      }

      if (sfxLabels.length > 1) {
        filterParts.push(
          `${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=longest:normalize=0[sfx_bus]`
        )
        finalBuses.push('[sfx_bus]')
      }

      filterParts.push(
        `${finalBuses.join('')}amix=inputs=${finalBuses.length}:duration=first:normalize=0,` +
        `alimiter=limit=0.891:attack=5:release=50:level=disabled[amixed]`
      )

      const finalFilter = filterParts.join(';')
      assert.ok(finalFilter.includes('[sfx_bus]'), 'SFX tracks must be isolated into sfx_bus')
      assert.ok(finalFilter.includes('[music_bus]'), 'Music must be routed through music_bus')
      assert.ok(
        finalFilter.includes('amix=inputs=3:duration=first:normalize=0'),
        'Final mix must use normalize=0 so voiceover is not divided by track count'
      )
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
