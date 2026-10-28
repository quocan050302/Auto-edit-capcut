import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import {
  resolvePreparedProductionScenes,
  assertAllProductionScenesReady
} from '../src/main/simple-assembly/simple-assembly-input-resolver'

const { it, finish } = createRunner('Simple Assembly Project Media Mapping & Timeline Order Tests')

void (async () => {
  const testRoot = freshDir('project-media-mapping-tests')

  await it('Section 11: Preserves timeline order of master edit plan without arbitrary sorting by sceneIndex', () => {
    const projDir = path.join(testRoot, 'proj-order')
    fs.mkdirSync(path.join(projDir, 'analysis'), { recursive: true })
    fs.mkdirSync(path.join(projDir, 'assets', 'manual_ai'), { recursive: true })

    // Create 3 media files
    const media1 = path.join(projDir, 'assets', 'manual_ai', 'scene_001.mp4')
    const media2 = path.join(projDir, 'assets', 'manual_ai', 'scene_002.mp4')
    const media3 = path.join(projDir, 'assets', 'manual_ai', 'scene_003.mp4')
    fs.writeFileSync(media1, 'media-1')
    fs.writeFileSync(media2, 'media-2')
    fs.writeFileSync(media3, 'media-3')

    // Canonical manual-ai-assets.json manifest
    const manifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 3,
      ready: 3,
      missing: 0,
      scenes: {
        '1': {
          sceneIndex: 1,
          sceneId: 'scene_001',
          status: 'ready',
          promptHash: 'h1',
          localPath: media1,
          sourcePath: media1,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString(),
          mediaType: 'video'
        },
        '2': {
          sceneIndex: 2,
          sceneId: 'scene_002',
          status: 'ready',
          promptHash: 'h2',
          localPath: media2,
          sourcePath: media2,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString(),
          mediaType: 'video'
        },
        '3': {
          sceneIndex: 3,
          sceneId: 'scene_003',
          status: 'ready',
          promptHash: 'h3',
          localPath: media3,
          sourcePath: media3,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString(),
          mediaType: 'video'
        }
      }
    }
    fs.writeFileSync(path.join(projDir, 'analysis', 'manual-ai-assets.json'), JSON.stringify(manifest))

    // Edit plan where scene sequence in chapters is intentionally non-ascending by sceneIndex
    // (e.g. creative editorial sequence: scene 3, scene 1, scene 2)
    const editPlan = {
      chapters: [
        {
          chapterIndex: 0,
          sequences: [
            {
              sequenceIndex: 0,
              scenes: [
                { sceneId: 'scene_003', sceneIndex: 3, duration: 4.0 },
                { sceneId: 'scene_001', sceneIndex: 1, duration: 3.5 },
                { sceneId: 'scene_002', sceneIndex: 2, duration: 5.0 }
              ]
            }
          ]
        }
      ]
    }
    fs.writeFileSync(path.join(projDir, 'analysis', 'edit-plan.json'), JSON.stringify(editPlan))

    const resolved = resolvePreparedProductionScenes(projDir)
    assert.strictEqual(resolved.expectedScenes, 3)
    assert.strictEqual(resolved.resolvedValidScenes, 3)
    assert.strictEqual(resolved.missingScenes.length, 0)

    // Authoritative timeline order must preserve: 3 -> 1 -> 2
    assert.strictEqual(resolved.scenes[0].sceneId, 'scene_003')
    assert.strictEqual(resolved.scenes[0].sceneIndex, 3)
    assert.strictEqual(resolved.scenes[1].sceneId, 'scene_001')
    assert.strictEqual(resolved.scenes[1].sceneIndex, 1)
    assert.strictEqual(resolved.scenes[2].sceneId, 'scene_002')
    assert.strictEqual(resolved.scenes[2].sceneIndex, 2)

    // assertAllProductionScenesReady succeeds
    assertAllProductionScenesReady(resolved)
  })

  await it('Section 11: Completeness assertion fails with descriptive error if any planned scene is missing media', () => {
    const projDir = path.join(testRoot, 'proj-missing')
    fs.mkdirSync(path.join(projDir, 'analysis'), { recursive: true })
    fs.mkdirSync(path.join(projDir, 'assets', 'manual_ai'), { recursive: true })

    const media1 = path.join(projDir, 'assets', 'manual_ai', 'scene_001.mp4')
    fs.writeFileSync(media1, 'media-1')

    const manifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 2,
      ready: 1,
      missing: 1,
      scenes: {
        '1': {
          sceneIndex: 1,
          sceneId: 'scene_001',
          status: 'ready',
          promptHash: 'h1',
          localPath: media1,
          sourcePath: media1,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString(),
          mediaType: 'video'
        }
      }
    }
    fs.writeFileSync(path.join(projDir, 'analysis', 'manual-ai-assets.json'), JSON.stringify(manifest))

    const editPlan = {
      chapters: [
        {
          chapterIndex: 0,
          sequences: [
            {
              sequenceIndex: 0,
              scenes: [
                { sceneId: 'scene_001', sceneIndex: 1, duration: 4.0 },
                { sceneId: 'scene_002', sceneIndex: 2, duration: 4.0 }
              ]
            }
          ]
        }
      ]
    }
    fs.writeFileSync(path.join(projDir, 'analysis', 'edit-plan.json'), JSON.stringify(editPlan))

    const resolved = resolvePreparedProductionScenes(projDir)
    assert.strictEqual(resolved.expectedScenes, 2)
    assert.strictEqual(resolved.resolvedValidScenes, 1)
    assert.strictEqual(resolved.missingScenes.length, 1)
    assert.strictEqual(resolved.missingScenes[0], 2)

    let caught = false
    try {
      assertAllProductionScenesReady(resolved)
    } catch (err) {
      caught = true
      assert.ok(String(err).includes('Missing 1 of 2 required production scene assets'))
    }
    assert.ok(caught, 'assertAllProductionScenesReady must throw on incomplete scenes')
  })

  await finish()
})()
