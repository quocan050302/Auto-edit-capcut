import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { evaluateManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import {
  MANUAL_AI_PROMPT_SCHEMA_VERSION,
  type ManualAiPromptPack,
  type ManualAiAssetsManifest
} from '../src/main/visual-mix/manual-ai/manual-ai-types'

const { it, finish } = createRunner('Simple Assembly Manual AI Gate Tests')

void (async () => {
  const testRoot = freshDir('manual-ai-gate-tests')

  await it('Section 7 & 8: Manual AI Gate blocks when 130/131 scenes are imported, releases on 131/131', () => {
    const projDir = path.join(testRoot, 'proj-gate-131')
    const mediaDir = path.join(projDir, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(mediaDir, { recursive: true })

    const totalScenes = 131
    const promptPackScenes: any[] = []
    const manifestScenes: Record<string, any> = {}

    for (let i = 1; i <= totalScenes; i++) {
      const hash = `hash_${i}`
      promptPackScenes.push({
        sceneIndex: i,
        sceneId: `scene_${String(i).padStart(3, '0')}`,
        prompt: `Scene ${i} prompt`,
        promptHash: hash
      })

      // Create dummy file for scene
      const filePath = path.join(mediaDir, `scene_${String(i).padStart(3, '0')}.mp4`)
      fs.writeFileSync(filePath, `scene-content-${i}`)

      // Only populate 130 of 131 scenes in manifest
      if (i !== 39) {
        manifestScenes[String(i)] = {
          sceneIndex: i,
          promptHash: hash,
          status: 'ready',
          sourcePath: filePath,
          localPath: filePath,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString()
        }
      }
    }

    const pack: ManualAiPromptPack = {
      schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      scriptHash: 'script_hash_test',
      profile: 'health',
      visualSourceMode: 'custom-mix',
      expectedCount: totalScenes,
      scenes: promptPackScenes
    }

    const manifest130: ManualAiAssetsManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: totalScenes,
      ready: 130,
      missing: 1,
      scenes: manifestScenes
    }

    // 130 / 131 state: evaluateManualAiStatus
    const status130 = evaluateManualAiStatus({
      projectDir: projDir,
      pack,
      manifest: manifest130
    })

    assert.strictEqual(status130.expected, 131)
    assert.strictEqual(status130.ready, 130)
    assert.strictEqual(status130.allReady, false, '130/131 MUST NOT be allReady')
    assert.strictEqual(status130.missingSceneIndices.includes(39), true, 'Scene 39 must be marked missing')

    // Now import the final missing scene 39
    const file39 = path.join(mediaDir, 'scene_039.mp4')
    manifestScenes['39'] = {
      sceneIndex: 39,
      promptHash: 'hash_39',
      status: 'ready',
      sourcePath: file39,
      localPath: file39,
      width: 1920,
      height: 1080,
      importedAt: new Date().toISOString()
    }

    const manifest131: ManualAiAssetsManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: totalScenes,
      ready: 131,
      missing: 0,
      scenes: manifestScenes
    }

    const status131 = evaluateManualAiStatus({
      projectDir: projDir,
      pack,
      manifest: manifest131
    })

    assert.strictEqual(status131.expected, 131)
    assert.strictEqual(status131.ready, 131)
    assert.strictEqual(status131.allReady, true, '131/131 MUST be allReady and release the gate')
    assert.strictEqual(status131.missingSceneIndices.length, 0)
  })

  await it('Section 8: Prompt hash mismatch prevents incomplete/stale scene from passing gate', () => {
    const projDir = path.join(testRoot, 'proj-gate-hash')
    const mediaDir = path.join(projDir, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(mediaDir, { recursive: true })

    const file1 = path.join(mediaDir, 'scene_001.mp4')
    fs.writeFileSync(file1, 'scene-content-1')

    const pack: ManualAiPromptPack = {
      schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      scriptHash: 'script_hash_test',
      profile: 'health',
      visualSourceMode: 'custom-mix',
      expectedCount: 1,
      scenes: [
        {
          sceneIndex: 1,
          sceneId: 'scene_001',
          prompt: 'Scene 1 prompt',
          promptHash: 'current_valid_hash'
        }
      ]
    }

    const manifestStale: ManualAiAssetsManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 1,
      ready: 1,
      missing: 0,
      scenes: {
        '1': {
          sceneIndex: 1,
          promptHash: 'stale_old_hash', // Mismatch!
          status: 'ready',
          sourcePath: file1,
          localPath: file1,
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString()
        }
      }
    }

    const status = evaluateManualAiStatus({
      projectDir: projDir,
      pack,
      manifest: manifestStale
    })

    assert.strictEqual(status.allReady, false, 'Mismatched prompt hash must not pass gate')
    assert.strictEqual(status.staleSceneIndices.includes(1), true, 'Scene 1 must be marked stale')
  })

  await finish()
})()
