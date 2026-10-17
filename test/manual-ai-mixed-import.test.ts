/**
 * test/manual-ai-mixed-import.test.ts
 *
 * End-to-end integration and scale tests for Safe Mixed Media Import V1.
 * Covers Part E, G, H, and Part I (Sections 91, 92, 97-108).
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir,
  makeProject,
  mixOf,
  fakeNormalizer
} from './manual-ai-test-utils'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { ensureManualAiPromptPack, loadManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { planManualAiImport, commitManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { loadManualAiManifest } from '../src/main/visual-mix/manual-ai/manual-ai-asset-store'
import { evaluateManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import { syncManualAiAssignments } from '../src/main/visual-mix/manual-ai/manual-ai-branch'
import type { ManualAiImportMapping, ManualAiImportRejection } from '../shared/types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic: string = require('ffmpeg-static')

const { it, finish } = createRunner('Manual AI Mixed Media Import Tests')

function createMappingFromRejection(r: ManualAiImportRejection): ManualAiImportMapping | null {
  if (r.sceneIndex === undefined) return null
  const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(r.filePath)
  return {
    filePath: r.filePath,
    fileName: r.fileName,
    sceneIndex: r.sceneIndex,
    via: 'filename',
    ...(isVideo ? { mediaType: 'video' as const } : {})
  }
}

async function main(): Promise<void> {
  console.log('\n--- Manual AI Mixed Media Import Tests ---')

  try {
    // ─── 1. Regression: image-only import unchanged (Section 91) ─────────────
    await it('Section 91: image-only import regression (omitted mediaType behaves identically)', () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const fImg = path.join(freshDir('reg-img'), 'SCENE 001.png')
      fs.writeFileSync(fImg, 'dummy')
      const fVid = path.join(freshDir('reg-vid'), 'SCENE 002.mp4')
      fs.writeFileSync(fVid, 'dummy')

      const imgPlan = planManualAiImport({ projectDir: dir, filePaths: [fImg, fVid] })
      assert.strictEqual(imgPlan.mappings.length, 1)
      assert.strictEqual(imgPlan.mappings[0].fileName, 'SCENE 001.png')
      assert.strictEqual(imgPlan.mappings[0].mediaType, undefined)
      assert.strictEqual(imgPlan.rejections.length, 1)
      assert.strictEqual(imgPlan.rejections[0].code, 'UNSUPPORTED_TYPE')
    })

    // ─── 2. Regression: video-only import unchanged (Section 92) ─────────────
    await it('Section 92: video-only import regression (mediaType: video behaves identically)', () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const fImg = path.join(freshDir('reg-img2'), 'SCENE 001.png')
      fs.writeFileSync(fImg, 'dummy')
      const fVid = path.join(freshDir('reg-vid2'), 'SCENE 002.mp4')
      fs.writeFileSync(fVid, 'dummy')

      const vidPlan = planManualAiImport({ projectDir: dir, filePaths: [fImg, fVid], mediaType: 'video' })
      assert.strictEqual(vidPlan.mappings.length, 1)
      assert.strictEqual(vidPlan.mappings[0].fileName, 'SCENE 002.mp4')
      assert.strictEqual(vidPlan.mappings[0].mediaType, 'video')
      assert.strictEqual(vidPlan.rejections.length, 1)
      assert.strictEqual(vidPlan.rejections[0].code, 'UNSUPPORTED_TYPE')
    })

    // ─── 3. Mixed scene mapping (Section 97) ─────────────────────────────────
    await it('Section 97: mixed import maps filenames to original scene numbers without renumbering', () => {
      const dir = makeProject(4)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const mediaDir = freshDir('mixed-map')
      const files = [
        path.join(mediaDir, 'SCENE 001.jpg'),
        path.join(mediaDir, 'SCENE 002.webm'),
        path.join(mediaDir, 'scene-003.png'),
        path.join(mediaDir, 'S0004.mp4')
      ]
      for (const f of files) fs.writeFileSync(f, 'd')

      const mixedPlan = planManualAiImport({ projectDir: dir, filePaths: files, mediaType: 'mixed' })
      assert.strictEqual(mixedPlan.mappings.length, 4)
      assert.strictEqual(mixedPlan.rejections.length, 0)

      assert.strictEqual(mixedPlan.mappings[0].sceneIndex, 1)
      assert.strictEqual(mixedPlan.mappings[0].mediaType, undefined) // image
      assert.strictEqual(mixedPlan.mappings[1].sceneIndex, 2)
      assert.strictEqual(mixedPlan.mappings[1].mediaType, 'video')   // video
      assert.strictEqual(mixedPlan.mappings[2].sceneIndex, 3)
      assert.strictEqual(mixedPlan.mappings[2].mediaType, undefined) // image
      assert.strictEqual(mixedPlan.mappings[3].sceneIndex, 4)
      assert.strictEqual(mixedPlan.mappings[3].mediaType, 'video')   // video
    })

    // ─── 4. Image/Video duplicates (Section 98) ──────────────────────────────
    await it('Section 98: duplicate scenes (image + video targeting same scene) are rejected as DUPLICATE_SCENE', () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const dupDir = freshDir('mixed-dup')
      const img1 = path.join(dupDir, 'scene_001.jpg')
      const vid1 = path.join(dupDir, 'scene_001.webm')
      fs.writeFileSync(img1, 'd')
      fs.writeFileSync(vid1, 'd')

      const dupPlan = planManualAiImport({ projectDir: dir, filePaths: [img1, vid1], mediaType: 'mixed' })
      assert.strictEqual(dupPlan.mappings.length, 0)
      assert.strictEqual(dupPlan.rejections.length, 2)
      assert.strictEqual(dupPlan.rejections[0].code, 'DUPLICATE_SCENE')
      assert.strictEqual(dupPlan.rejections[1].code, 'DUPLICATE_SCENE')
      assert.ok(dupPlan.rejections[0].message.includes('Scene 1 has 2 files'))
    })

    // ─── 5. Stock-owned scene rejection (Section 99) ─────────────────────────
    await it('Section 99: Stock-owned scenes reject mixed imports with NOT_AI_OWNED without modifying Stock', () => {
      const dir = makeProject(4)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      // 50/50: 2 AI, 2 Stock
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(0.5, 0.5, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const stockScene = plan.scenes.find((s) => s.strategy === 'stock')!
      assert.ok(stockScene)

      const dirFiles = freshDir('stock-reject')
      const stockFile = path.join(dirFiles, `scene_${String(stockScene.sceneIndex).padStart(3, '0')}.webm`)
      fs.writeFileSync(stockFile, 'd')

      const planned = planManualAiImport({ projectDir: dir, filePaths: [stockFile], mediaType: 'mixed' })
      assert.strictEqual(planned.mappings.length, 0)
      assert.strictEqual(planned.rejections.length, 1)
      assert.strictEqual(planned.rejections[0].code, 'NOT_AI_OWNED')
      assert.ok(planned.rejections[0].message.includes('real footage'))
    })

    // ─── 6. Asset replacement protection (Section 100) ───────────────────────
    await it('Section 100: replacing a Ready image with a video requires explicit replacement approval', async () => {
      const dir = makeProject(1)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const assetsDir = freshDir('mixed-replace')
      const imgFile = path.join(assetsDir, 'SCENE 001.png')
      spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=1:d=1',
        '-vframes', '1', imgFile
      ], { timeout: 30000 })

      // Initial import as Image
      const plan1 = planManualAiImport({ projectDir: dir, filePaths: [imgFile], mediaType: 'mixed' })
      const res1 = await commitManualAiImport({ projectDir: dir, mappings: plan1.mappings })
      assert.strictEqual(res1.imported.length, 1)
      assert.strictEqual(res1.status.ready, 1)

      // Try importing a video for Scene 1 without replaceExisting -> ALREADY_IMPORTED
      const vidFile = path.join(assetsDir, 'SCENE 001.mp4')
      spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=15',
        '-c:v', 'mpeg4', vidFile
      ], { timeout: 30000 })

      const plan2 = planManualAiImport({ projectDir: dir, filePaths: [vidFile], mediaType: 'mixed' })
      assert.strictEqual(plan2.mappings.length, 0)
      assert.strictEqual(plan2.rejections.length, 1)
      assert.strictEqual(plan2.rejections[0].code, 'ALREADY_IMPORTED')

      // With replaceExisting: true -> succeeds and replaces with video
      const plan3 = planManualAiImport({ projectDir: dir, filePaths: [vidFile], mediaType: 'mixed', replaceExisting: true })
      assert.strictEqual(plan3.mappings.length, 1)
      const res3 = await commitManualAiImport({ projectDir: dir, mappings: plan3.mappings, replaceExisting: true })
      assert.strictEqual(res3.imported.length, 1)
      assert.strictEqual(res3.imported[0].mediaType, 'video')

      const manifest = loadManualAiManifest(dir)
      assert.strictEqual(manifest.scenes['1'].mediaType, 'video')
    })

    // ─── 7. Low-resolution mixed batch & WEBM duration recovery (Sections 101, 102, 103) ───
    await it('Sections 101, 102, 103: mixed batch with 1080p JPG and 720p WEBM (missing duration metadata)', async () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const assetsDir = freshDir('mixed-lowres')
      const img1080 = path.join(assetsDir, 'SCENE 001.jpg')
      spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=1:d=1',
        '-vframes', '1', img1080
      ], { timeout: 30000 })

      // Generate 720p WEBM with missing container duration via pipe
      const vid720 = path.join(assetsDir, 'SCENE 002.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15:duration=2',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      fs.writeFileSync(vid720, gen.stdout)

      // Plan mixed import
      const planned = planManualAiImport({ projectDir: dir, filePaths: [img1080, vid720], mediaType: 'mixed' })
      assert.strictEqual(planned.mappings.length, 2)

      // Initial commit without allowLowResolution:
      // Scene 1 (1080p image) succeeds.
      // Scene 2 (720p WEBM with recovered duration) is rejected as LOW_RESOLUTION.
      const initialCommit = await commitManualAiImport({ projectDir: dir, mappings: planned.mappings })
      assert.strictEqual(initialCommit.imported.length, 1)
      assert.strictEqual(initialCommit.imported[0].sceneIndex, 1)
      assert.strictEqual(initialCommit.imported[0].mediaType, undefined)
      assert.strictEqual(initialCommit.rejections.length, 1)
      assert.strictEqual(initialCommit.rejections[0].code, 'LOW_RESOLUTION')

      // Use Accept All via createMappingFromRejection
      const approved = initialCommit.rejections
        .filter((r) => r.code === 'LOW_RESOLUTION')
        .map(createMappingFromRejection)
        .filter((m): m is ManualAiImportMapping => m !== null)

      assert.strictEqual(approved.length, 1)
      assert.strictEqual(approved[0].mediaType, 'video')

      // Commit low-res video
      const bulkCommit = await commitManualAiImport({ projectDir: dir, mappings: approved, allowLowResolution: true })
      assert.strictEqual(bulkCommit.imported.length, 1)
      assert.strictEqual(bulkCommit.imported[0].mediaType, 'video')
      assert.strictEqual(bulkCommit.imported[0].sceneIndex, 2)

      // Manifest checks
      const manifest = loadManualAiManifest(dir)
      assert.strictEqual(manifest.ready, 2)
      assert.strictEqual(manifest.scenes['1'].mediaType, undefined)
      assert.strictEqual(manifest.scenes['2'].mediaType, 'video')
      assert.strictEqual(manifest.scenes['2'].lowResolution, true)
      assert.ok((manifest.scenes['2'].durationSecs ?? 0) > 1.8)
    })

    // ─── 8. Partial failure in mixed batch (Section 104) ──────────────────────
    await it('Section 104: partial failure in mixed batch imports valid media and reports corrupt file', async () => {
      const dir = makeProject(3)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const dirFiles = freshDir('mixed-partial')
      const img1 = path.join(dirFiles, 'SCENE 001.png')
      spawnSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=1:d=1', '-vframes', '1', img1], { timeout: 30000 })

      const vid2 = path.join(dirFiles, 'SCENE 002.mp4')
      spawnSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=15', '-c:v', 'mpeg4', vid2], { timeout: 30000 })

      const corruptVid = path.join(dirFiles, 'SCENE 003.webm')
      fs.writeFileSync(corruptVid, 'completely-invalid-media-data')

      const planned = planManualAiImport({ projectDir: dir, filePaths: [img1, vid2, corruptVid], mediaType: 'mixed' })
      assert.strictEqual(planned.mappings.length, 3)

      const res = await commitManualAiImport({ projectDir: dir, mappings: planned.mappings })
      assert.strictEqual(res.imported.length, 2)
      assert.strictEqual(res.rejections.length, 1)
      assert.strictEqual(res.rejections[0].code, 'UNREADABLE')
      assert.strictEqual(res.status.ready, 2)
      assert.strictEqual(res.status.missingSceneIndices.length, 1)
      assert.strictEqual(res.status.missingSceneIndices[0], 3)
    })

    // ─── 9. Project HUTT-34 scale fixture: 145 scenes, 131 AI, 14 Stock (Sections 05, 105, 119) ─
    await it('Section 105: 145 scene project scale with 131 AI scenes and 14 Stock scenes', async () => {
      const TOTAL_SCENES = 145
      const EXPECTED_AI = 131
      const EXPECTED_STOCK = 14

      const dir = makeProject(TOTAL_SCENES)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)

      // Ratio configured to yield exactly 131 AI and 14 Stock scenes
      const plan = VisualMixPlanner.buildPlan({
        projectDir: dir,
        rawScenes,
        config: mixOf(EXPECTED_AI / TOTAL_SCENES, EXPECTED_STOCK / TOTAL_SCENES, 'prompt'),
        profile: 'general'
      })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const aiScenes = plan.scenes.filter((s) => s.strategy.startsWith('ai'))
      const stockScenes = plan.scenes.filter((s) => s.strategy === 'stock')
      assert.strictEqual(aiScenes.length, EXPECTED_AI, `Expected ${EXPECTED_AI} AI scenes, got ${aiScenes.length}`)
      assert.strictEqual(stockScenes.length, EXPECTED_STOCK, `Expected ${EXPECTED_STOCK} Stock scenes, got ${stockScenes.length}`)

      // Populate pre-existing stock assignments
      const store = new VisualAssignmentStore(dir)
      for (const s of stockScenes) {
        store.set(s.sceneIndex, {
          sceneId: s.sceneId,
          sceneIndex: s.sceneIndex,
          narrationText: s.narration,
          startTime: s.startTime,
          endTime: s.endTime,
          visualIntent: s.visualIntent,
          searchQueries: [],
          usedQuery: 'Stock clip',
          score: 90,
          locked: false,
          manualOverride: false,
          status: 'assigned',
          asset: {
            id: `stock_${s.sceneIndex}`,
            provider: 'pexels',
            mediaType: 'video',
            localPath: `/tmp/fake_stock_${s.sceneIndex}.mp4`,
            thumbnailUrl: '',
            downloadUrl: '',
            creator: 'Stock Provider',
            searchQuery: 'stock',
            downloadedAt: new Date().toISOString(),
            fileSizeBytes: 1000
          }
        })
      }
      await store.flushAtomic()

      // Generate 131 mixed files (half images, half videos)
      const batchDir = freshDir('hutt34-scale')
      const files: string[] = []

      // Generate a reusable template image and template video to keep test execution fast
      const templateImg = path.join(batchDir, 'template.png')
      spawnSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'color=c=purple:s=1920x1080:r=1:d=1', '-vframes', '1', templateImg], { timeout: 30000 })
      const templateVid = path.join(batchDir, 'template.mp4')
      spawnSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=15', '-c:v', 'mpeg4', templateVid], { timeout: 30000 })

      for (let i = 0; i < aiScenes.length; i++) {
        const sceneNum = aiScenes[i].sceneIndex
        const isVideo = i % 2 === 1
        const ext = isVideo ? '.mp4' : '.png'
        const filename = `SCENE ${String(sceneNum).padStart(3, '0')}${ext}`
        const filePath = path.join(batchDir, filename)
        if (isVideo) {
          fs.copyFileSync(templateVid, filePath)
        } else {
          fs.copyFileSync(templateImg, filePath)
        }
        files.push(filePath)
      }

      assert.strictEqual(files.length, 131)

      // 1. Plan mixed import
      const planned = planManualAiImport({ projectDir: dir, filePaths: files, mediaType: 'mixed' })
      assert.strictEqual(planned.mappings.length, 131)
      assert.strictEqual(planned.rejections.length, 0)

      // 2. Commit all 131 files using fast normalizer for scale test
      const commitRes = await commitManualAiImport({
        projectDir: dir,
        mappings: planned.mappings,
        normalizer: fakeNormalizer
      })

      assert.strictEqual(commitRes.imported.length, 131)
      assert.strictEqual(commitRes.rejections.length, 0)
      assert.strictEqual(commitRes.status.ready, 131)
      assert.strictEqual(commitRes.status.expected, 131)
      assert.strictEqual(commitRes.status.allReady, true)
      assert.strictEqual(commitRes.status.missingSceneIndices.length, 0)

      // 3. Verify manifest
      const manifest = loadManualAiManifest(dir)
      assert.strictEqual(manifest.ready, 131)
      assert.strictEqual(Object.keys(manifest.scenes).length, 131)

      // 4. Verify Stock assignments remain 100% untouched
      const storeAfter = new VisualAssignmentStore(dir)
      for (const s of stockScenes) {
        const a = storeAfter.get(s.sceneIndex)
        assert.ok(a)
        assert.strictEqual(a?.asset?.provider, 'pexels')
        assert.strictEqual(a?.asset?.mediaType, 'video')
      }

      // 5. Sync manual AI assignments
      const syncRes = await syncManualAiAssignments({
        projectDir: dir,
        pack: loadManualAiPromptPack(dir)!,
        aiScenes: plan.scenes,
        store: storeAfter,
        isHealth: false
      })
      assert.strictEqual(syncRes.changed, true)

      // Verify AI scenes are assigned provider 'manual-ai'
      let aiImagesAssigned = 0
      let aiVideosAssigned = 0
      for (const s of aiScenes) {
        const a = storeAfter.get(s.sceneIndex)
        assert.ok(a)
        assert.strictEqual(a?.asset?.provider, 'manual-ai')
        if (a?.asset?.mediaType === 'video') aiVideosAssigned++
        else if (a?.asset?.mediaType === 'photo') aiImagesAssigned++
      }
      assert.strictEqual(aiImagesAssigned + aiVideosAssigned, 131)
      assert.ok(aiImagesAssigned > 0 && aiVideosAssigned > 0)
    })
  } finally {
    cleanupFixtures()
    finish()
  }
}

void main()
