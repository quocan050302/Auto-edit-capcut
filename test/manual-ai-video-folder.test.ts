/**
 * Video Folder Discovery and Import Tests
 * Covers Part D & Part J (Section 97-98)
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
  listVideosInFolder,
  MAX_DISCOVERED_VIDEOS,
  MAX_VIDEO_FOLDER_DEPTH
} from '../src/main/ipc/manual-ai.ipc'
import { planManualAiImport, commitManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { ensureManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'

const { it, finish } = createRunner('Manual AI Video Folder Discovery & Import Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Video Folder Tests ---')

  await it('Discovers single MP4 file in root folder', async () => {
    const dir = freshDir('video-single-mp4')
    fs.writeFileSync(path.join(dir, 'S0001.mp4'), 'fake-video-data')

    const discovered = listVideosInFolder(dir)
    assert.equal(discovered.length, 1)
    assert.equal(path.basename(discovered[0]), 'S0001.mp4')
  })

  await it('Discovers multiple formats case-insensitively (.mp4, .mov, .webm, .mkv, .MP4, .MOV)', async () => {
    const dir = freshDir('video-formats')
    fs.writeFileSync(path.join(dir, 'S0001.mp4'), 'data')
    fs.writeFileSync(path.join(dir, 'S0002.MOV'), 'data')
    fs.writeFileSync(path.join(dir, 'S0003.webm'), 'data')
    fs.writeFileSync(path.join(dir, 'S0004.MKV'), 'data')
    fs.writeFileSync(path.join(dir, 'S0005.mov'), 'data')
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'text')
    fs.writeFileSync(path.join(dir, 'photo.jpg'), 'image')
    fs.writeFileSync(path.join(dir, 'image.png'), 'image')

    const discovered = listVideosInFolder(dir)
    assert.equal(discovered.length, 5)
    const baseNames = discovered.map((f) => path.basename(f))
    assert.ok(baseNames.includes('S0001.mp4'))
    assert.ok(baseNames.includes('S0002.MOV'))
    assert.ok(baseNames.includes('S0003.webm'))
    assert.ok(baseNames.includes('S0004.MKV'))
    assert.ok(baseNames.includes('S0005.mov'))
    assert.ok(!baseNames.includes('ignore.txt'))
    assert.ok(!baseNames.includes('photo.jpg'))
  })

  await it('Recursively discovers video files in nested subdirectories up to maxDepth (3)', async () => {
    const root = freshDir('video-nested')
    // Level 0
    fs.writeFileSync(path.join(root, 'S0001.mp4'), 'data')
    // Level 1
    const l1 = path.join(root, 'sub1')
    fs.mkdirSync(l1)
    fs.writeFileSync(path.join(l1, 'S0002.mov'), 'data')
    // Level 2
    const l2 = path.join(l1, 'sub2')
    fs.mkdirSync(l2)
    fs.writeFileSync(path.join(l2, 'S0003.webm'), 'data')
    // Level 3
    const l3 = path.join(l2, 'sub3')
    fs.mkdirSync(l3)
    fs.writeFileSync(path.join(l3, 'S0004.mkv'), 'data')
    // Level 4 (exceeds maxDepth = 3)
    const l4 = path.join(l3, 'sub4')
    fs.mkdirSync(l4)
    fs.writeFileSync(path.join(l4, 'S0005.mp4'), 'data')

    const discovered = listVideosInFolder(root, 3)
    assert.equal(discovered.length, 4)
    const baseNames = discovered.map((f) => path.basename(f))
    assert.ok(baseNames.includes('S0001.mp4'))
    assert.ok(baseNames.includes('S0002.mov'))
    assert.ok(baseNames.includes('S0003.webm'))
    assert.ok(baseNames.includes('S0004.mkv'))
    assert.ok(!baseNames.includes('S0005.mp4'), 'Level 4 exceeds maxDepth and should not be discovered')
  })

  await it('Skips hidden folders and files (.git, .DS_Store)', async () => {
    const root = freshDir('video-hidden')
    fs.writeFileSync(path.join(root, 'S0001.mp4'), 'data')

    const hiddenDir = path.join(root, '.hidden_dir')
    fs.mkdirSync(hiddenDir)
    fs.writeFileSync(path.join(hiddenDir, 'S0002.mp4'), 'data')

    const gitDir = path.join(root, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'S0003.mp4'), 'data')

    const discovered = listVideosInFolder(root)
    assert.equal(discovered.length, 1)
    assert.equal(path.basename(discovered[0]), 'S0001.mp4')
  })

  await it('Sorts discovered files in natural alphanumeric order', async () => {
    const dir = freshDir('video-sorting')
    fs.writeFileSync(path.join(dir, 'S10.mp4'), 'data')
    fs.writeFileSync(path.join(dir, 'S1.mp4'), 'data')
    fs.writeFileSync(path.join(dir, 'S2.mp4'), 'data')
    fs.writeFileSync(path.join(dir, 'S20.mp4'), 'data')

    const discovered = listVideosInFolder(dir)
    const basenames = discovered.map((f) => path.basename(f))
    assert.deepEqual(basenames, ['S1.mp4', 'S2.mp4', 'S10.mp4', 'S20.mp4'])
  })

  await it('Handles empty directory gracefully', async () => {
    const dir = freshDir('video-empty')
    const discovered = listVideosInFolder(dir)
    assert.equal(discovered.length, 0)
  })

  await it('Enforces file count safety limit (250) and emits warning', async () => {
    const dir = freshDir('video-limit')
    for (let i = 1; i <= 260; i++) {
      fs.writeFileSync(path.join(dir, `clip_${String(i).padStart(4, '0')}.mp4`), 'd')
    }

    const warnings: string[] = []
    const discovered = listVideosInFolder(dir, 3, warnings)
    assert.equal(discovered.length, MAX_DISCOVERED_VIDEOS)
    assert.ok(warnings.length > 0, 'Warning should be recorded when safety limit is reached')
    assert.ok(warnings[0].includes('250'))
  })

  await it('Throws descriptive error when directory does not exist or is a regular file', async () => {
    const nonExistent = '/path/that/does/not/exist_xyz_123'
    let threw = false
    try {
      listVideosInFolder(nonExistent)
    } catch (err: any) {
      threw = true
      assert.ok(err.message.includes('Folder does not exist'))
    }
    assert.ok(threw)

    const dir = freshDir('not-a-dir')
    const file = path.join(dir, 'plain.txt')
    fs.writeFileSync(file, 'hello')
    let threwNotDir = false
    try {
      listVideosInFolder(file)
    } catch (err: any) {
      threwNotDir = true
      assert.ok(err.message.includes('Path is not a directory'))
    }
    assert.ok(threwNotDir)
  })

  await it('Plans video folder import targeting AI scenes and rejecting Stock scenes', async () => {
    const projDir = makeProject(5)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    // Scenes 1, 2, 4 are AI; Scenes 3, 5 are Stock
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(60, 40, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const videoDir = freshDir('videos-for-import')
    fs.writeFileSync(path.join(videoDir, 'S0001.mp4'), 'd')
    fs.writeFileSync(path.join(videoDir, 'S0002.mov'), 'd')
    fs.writeFileSync(path.join(videoDir, 'S0003.mp4'), 'd') // scene 3 is Stock!
    fs.writeFileSync(path.join(videoDir, 'S0099.webm'), 'd') // scene 99 does not exist!

    const discovered = listVideosInFolder(videoDir)
    const planned = planManualAiImport({
      projectDir: projDir,
      filePaths: discovered,
      mediaType: 'video'
    })

    assert.equal(planned.mappings.length, 2, 'Scenes 1 and 2 should be mapped')
    assert.equal(planned.mappings[0].sceneIndex, 1)
    assert.equal(planned.mappings[0].mediaType, 'video')
    assert.equal(planned.mappings[1].sceneIndex, 2)
    assert.equal(planned.mappings[1].mediaType, 'video')

    assert.ok(planned.rejections.some((r) => r.fileName === 'S0003.mp4' && r.code === 'NOT_AI_OWNED'), 'Stock scene rejected')
    assert.ok(planned.rejections.some((r) => r.fileName === 'S0099.webm' && r.code === 'UNKNOWN_SCENE'), 'Unknown scene rejected')
  })

  await it('Handles unnumbered video files with natural-sort fallback and needsConfirmation', async () => {
    const projDir = makeProject(2)
    const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projDir)
    const plan = VisualMixPlanner.buildPlan({
      projectDir: projDir,
      rawScenes,
      config: mixOf(100, 0, 'prompt', '1080p'),
      profile: 'general'
    })
    ensureManualAiPromptPack({ projectDir: projDir, plan, profile: 'general', outputResolution: '1080p' })

    const videoDir = freshDir('unnumbered-videos')
    fs.writeFileSync(path.join(videoDir, 'alpha.mp4'), 'd')
    fs.writeFileSync(path.join(videoDir, 'beta.mov'), 'd')

    const discovered = listVideosInFolder(videoDir)
    const planned = planManualAiImport({
      projectDir: projDir,
      filePaths: discovered,
      mediaType: 'video'
    })

    assert.equal(planned.mappings.length, 2)
    assert.ok(planned.needsConfirmation, 'Unnumbered files mapping requires explicit user confirmation')
    assert.equal(planned.mappings[0].fileName, 'alpha.mp4')
    assert.equal(planned.mappings[0].sceneIndex, 1)
    assert.equal(planned.mappings[0].via, 'natural-sort')
    assert.equal(planned.mappings[1].fileName, 'beta.mov')
    assert.equal(planned.mappings[1].sceneIndex, 2)
    assert.equal(planned.mappings[1].via, 'natural-sort')
  })

  await it('Section 106: Mixed media readiness calculation (imported images + videos satisfy distinct scenes)', async () => {
    const projDir = makeProject(4)
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

    const assetDir = path.join(projDir, 'assets', 'generated', 'manual-ai')
    fs.mkdirSync(assetDir, { recursive: true })
    const photoPath = path.join(assetDir, 'S0001.png')
    const videoPath = path.join(assetDir, 'S0002.mp4')
    fs.writeFileSync(photoPath, 'dummy-photo')
    fs.writeFileSync(videoPath, 'dummy-video')

    // Simulate Scene 1 satisfied by imported photo, Scene 2 satisfied by imported video
    const manifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      expected: 4,
      ready: 2,
      missing: 2,
      scenes: {
        '1': {
          sceneIndex: 1,
          fileName: 'S0001.png',
          localPath: 'assets/generated/manual-ai/S0001.png',
          promptHash: 'photoHash1',
          width: 1920,
          height: 1080,
          importedAt: new Date().toISOString()
        },
        '2': {
          sceneIndex: 2,
          fileName: 'S0002.mp4',
          localPath: 'assets/generated/manual-ai/S0002.mp4',
          promptHash: 'videoHash2',
          width: 1920,
          height: 1080,
          mediaType: 'video' as const,
          importedAt: new Date().toISOString()
        }
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // Import videos targeting scene 3 & 4
    const videoDir = freshDir('more-videos')
    fs.writeFileSync(path.join(videoDir, 'S0003.mp4'), 'data')
    fs.writeFileSync(path.join(videoDir, 'S0004.mov'), 'data')
    const discovered = listVideosInFolder(videoDir)
    const planned = planManualAiImport({
      projectDir: projDir,
      filePaths: discovered,
      mediaType: 'video'
    })

    assert.equal(planned.mappings.length, 2)
    assert.equal(planned.mappings[0].sceneIndex, 3)
    assert.equal(planned.mappings[1].sceneIndex, 4)
  })

  cleanupFixtures()
  finish()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
