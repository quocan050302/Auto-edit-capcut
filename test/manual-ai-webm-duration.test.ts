/**
 * test/manual-ai-webm-duration.test.ts
 *
 * Comprehensive tests for WEBM duration recovery from packet timestamps and
 * low-resolution video approval workflow.
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import {
  parsePacketTimingLine,
  recoverVideoDuration
} from '../src/main/visual-mix/manual-ai/manual-ai-video-duration'
import {
  validateVideoFile,
  evaluateManualAiStatus
} from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import {
  planManualAiImport,
  commitManualAiImport
} from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import {
  loadManualAiPromptPack,
  ensureManualAiPromptPack
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  loadManualAiManifest
} from '../src/main/visual-mix/manual-ai/manual-ai-asset-store'
import {
  syncManualAiAssignments,
  buildManualAiAssignment
} from '../src/main/visual-mix/manual-ai/manual-ai-branch'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { probeMedia } from '../src/main/render-cache/ffmpeg-process'
import type { ManualAiImportRejection, ManualAiImportMapping } from '../shared/types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir,
  makeProject,
  mixOf,
  pngHeader
} from './manual-ai-test-utils'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic: string = require('ffmpeg-static')

const { it, finish } = createRunner('Manual AI WEBM Duration & Low-Res Approval Tests')

/** Helper matching createMappingFromRejection from ManualAiPromptPanel.tsx */
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
  try {
    // ─── 1. Pure packet timing line parser tests (Item 93) ───────────────────
    await it('pure parser: extracts ptsTime and durationTime correctly', () => {
      const line1 = 'pts_time=1.234567|duration_time=0.033333'
      const res1 = parsePacketTimingLine(line1)
      assert.ok(res1)
      assert.strictEqual(res1?.ptsTime, 1.234567)
      assert.strictEqual(res1?.durationTime, 0.033333)

      // Inverted order
      const line2 = 'duration_time=0.040000|pts_time=2.500000'
      const res2 = parsePacketTimingLine(line2)
      assert.ok(res2)
      assert.strictEqual(res2?.ptsTime, 2.5)
      assert.strictEqual(res2?.durationTime, 0.04)

      // Missing duration_time / N/A (typical WEBM with Matroska BlockAdditional)
      const line3 = 'pts_time=0.000000|duration_time=N/Aside_data_type=Matroska BlockAdditional'
      const res3 = parsePacketTimingLine(line3)
      assert.ok(res3)
      assert.strictEqual(res3?.ptsTime, 0)
      assert.strictEqual(res3?.durationTime, undefined)

      // Negative initial PTS
      const line4 = 'pts_time=-0.040000|duration_time=0.040000'
      const res4 = parsePacketTimingLine(line4)
      assert.ok(res4)
      assert.strictEqual(res4?.ptsTime, -0.04)
      assert.strictEqual(res4?.durationTime, 0.04)

      // N/A for both
      const line5 = 'pts_time=N/A|duration_time=N/A'
      assert.strictEqual(parsePacketTimingLine(line5), null)

      // Malformed / empty lines
      assert.strictEqual(parsePacketTimingLine(''), null)
      assert.strictEqual(parsePacketTimingLine('   '), null)
      assert.strictEqual(parsePacketTimingLine('side_data_type=Matroska BlockAdditional'), null)
      assert.strictEqual(parsePacketTimingLine('unrelated log text here'), null)
    })

    // ─── 2. Normal MP4 metadata: valid metadata duration, fallback not invoked (Item 88) ───
    await it('normal MP4 with metadata duration: probeMedia reports duration, validator succeeds', async () => {
      const dir = freshDir('mp4_meta')
      const mp4Path = path.join(dir, 'standard.mp4')
      const gen = spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=15',
        '-c:v', 'mpeg4', '-q:v', '5', mp4Path
      ], { encoding: 'utf-8', timeout: 30000 })
      assert.strictEqual(gen.status, 0, gen.stderr)

      const probe = await probeMedia(mp4Path)
      assert.ok(probe)
      assert.strictEqual(probe?.hasVideo, true)
      assert.ok((probe?.duration ?? 0) > 1.8, `Expected duration > 1.8, got ${probe?.duration}`)

      const val = await validateVideoFile(mp4Path, { width: 320, height: 180 })
      assert.strictEqual(val.ok, true)
      assert.strictEqual(val.width, 320)
      assert.strictEqual(val.height, 180)
      assert.ok((val.durationSecs ?? 0) > 1.8)
      assert.strictEqual(val.warnings.includes('DURATION_RECOVERED_FROM_PACKET_TIMESTAMPS'), false)
    })

    // ─── 3. Standard seekable WEBM with metadata duration (Item 89) ─────────
    await it('standard seekable WEBM: valid metadata duration passes through normal path', async () => {
      const dir = freshDir('webm_seekable')
      const webmPath = path.join(dir, 'seekable.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=15',
        '-c:v', 'libvpx-vp9', '-b:v', '200k', webmPath
      ], { encoding: 'utf-8', timeout: 30000 })
      assert.strictEqual(gen.status, 0, gen.stderr)

      const probe = await probeMedia(webmPath)
      assert.ok(probe)
      assert.strictEqual(probe?.hasVideo, true)

      const val = await validateVideoFile(webmPath, { width: 320, height: 180 })
      assert.strictEqual(val.ok, true)
      assert.ok((val.durationSecs ?? 0) > 1.8)
    })

    // ─── 4. WEBM with missing duration metadata (pipe output) (Items 90, 91, 92) ───
    await it('pipe-generated WEBM lacks container duration, but recovers duration via packets', async () => {
      const dir = freshDir('webm_pipe')
      const missingDurationPath = path.join(dir, 'missing-duration.webm')

      // Generate via non-seekable pipe to strip container duration metadata
      const proc = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=3',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      assert.strictEqual(proc.status, 0, proc.stderr?.toString())
      fs.writeFileSync(missingDurationPath, proc.stdout)

      // Confirm probeMedia sees 0 duration
      const probe = await probeMedia(missingDurationPath)
      assert.ok(probe)
      assert.strictEqual(probe?.hasVideo, true)
      assert.strictEqual(probe?.width, 320)
      assert.strictEqual(probe?.height, 180)
      assert.strictEqual(probe?.duration, 0, 'Container/stream duration must be 0')

      // Test recovery directly
      const rec = await recoverVideoDuration(missingDurationPath)
      assert.strictEqual(rec.ok, true)
      if (rec.ok) {
        assert.strictEqual(rec.source, 'packet-timestamps')
        assert.ok(rec.durationSecs >= 2.8 && rec.durationSecs <= 3.2, `Expected ~3.0s duration, got ${rec.durationSecs}`)
        assert.ok(rec.packetCount >= 40, `Expected ~45 packets, got ${rec.packetCount}`)
      }

      // Test validateVideoFile integration
      const val = await validateVideoFile(missingDurationPath, { width: 320, height: 180 })
      assert.strictEqual(val.ok, true)
      assert.strictEqual(val.width, 320)
      assert.strictEqual(val.height, 180)
      assert.ok((val.durationSecs ?? 0) >= 2.8 && (val.durationSecs ?? 0) <= 3.2)
      assert.ok(val.warnings.includes('DURATION_RECOVERED_FROM_PACKET_TIMESTAMPS'))
    })

    // ─── 5. Real user WEBM file fixture testing if present (Item 14, 117) ─────
    const realSample = '/Users/macbook/Downloads/an_ne_videos/SCENE 001.webm'
    if (fs.existsSync(realSample)) {
      await it('real user WEBM file (SCENE 001.webm) validates and recovers duration', async () => {
        const val = await validateVideoFile(realSample, { width: 1920, height: 1080 })
        assert.strictEqual(val.ok, true)
        assert.strictEqual(val.width, 1280)
        assert.strictEqual(val.height, 720)
        assert.strictEqual(val.lowResolution, true)
        assert.ok((val.durationSecs ?? 0) >= 3.0 && (val.durationSecs ?? 0) <= 3.3, `Duration was ${val.durationSecs}`)
        assert.ok(val.warnings.includes('DURATION_RECOVERED_FROM_PACKET_TIMESTAMPS'))
      })
    }

    // ─── 6. Invalid video files testing (Item 94) ─────────────────────────────
    await it('rejects empty, non-video, audio-only, and truncated files safely', async () => {
      const dir = freshDir('invalid')
      const target = { width: 1920, height: 1080 }

      // Empty .webm
      const emptyFile = path.join(dir, 'empty.webm')
      fs.writeFileSync(emptyFile, '')
      const resEmpty = await validateVideoFile(emptyFile, target)
      assert.strictEqual(resEmpty.ok, false)
      assert.strictEqual(resEmpty.code, 'UNREADABLE')

      // Text renamed to .webm
      const textFile = path.join(dir, 'fake.webm')
      fs.writeFileSync(textFile, 'This is plain text pretending to be webm')
      const resText = await validateVideoFile(textFile, target)
      assert.strictEqual(resText.ok, false)
      assert.strictEqual(resText.code, 'UNREADABLE')

      // Audio-only WEBM
      const audioFile = path.join(dir, 'audio_only.webm')
      spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
        '-c:a', 'libopus', audioFile
      ], { timeout: 30000 })
      if (fs.existsSync(audioFile)) {
        const resAudio = await validateVideoFile(audioFile, target)
        assert.strictEqual(resAudio.ok, false)
        assert.strictEqual(resAudio.code, 'UNREADABLE')
        assert.ok(resAudio.message?.includes('no readable video stream'))
      }

      // Truncated WEBM header without packets
      const truncFile = path.join(dir, 'truncated.webm')
      fs.writeFileSync(truncFile, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]))
      const resTrunc = await validateVideoFile(truncFile, target)
      assert.strictEqual(resTrunc.ok, false)
      assert.strictEqual(resTrunc.code, 'UNREADABLE')
    })

    // ─── 7. Subprocess error handling: startup failure, timeout, cancellation (Items 95, 96, 97) ───
    await it('handles FFprobe unavailable, timeout, and cancellation gracefully', async () => {
      const dir = freshDir('errors')
      const testFile = path.join(dir, 'clip.webm')
      fs.writeFileSync(testFile, 'dummy')

      // Unavailable binary
      const resUnavail = await recoverVideoDuration(testFile, { ffprobeBinaryOverride: '/nonexistent/ffprobe/bin' })
      assert.strictEqual(resUnavail.ok, false)
      assert.ok(resUnavail.reason === 'FFPROBE_UNAVAILABLE' || resUnavail.reason === 'FFPROBE_EXECUTION_FAILED')

      // Cancellation via AbortSignal
      const controller = new AbortController()
      controller.abort()
      const resCancelled = await recoverVideoDuration(testFile, { signal: controller.signal })
      assert.strictEqual(resCancelled.ok, false)
      assert.strictEqual(resCancelled.reason, 'CANCELLED')

      // Timeout
      const resTimeout = await recoverVideoDuration(testFile, { timeoutMs: 1 })
      assert.strictEqual(resTimeout.ok, false)
      assert.ok(resTimeout.reason === 'TIMEOUT' || resTimeout.reason === 'FFPROBE_EXECUTION_FAILED')
    })

    // ─── 8. Low-resolution single approval "Use Anyway" (Item 98) ────────────
    await it('low-resolution 720p WEBM: initially flagged LOW_RESOLUTION, accepted with Use Anyway', async () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      // Generate 720p WEBM with missing duration
      const webmFile = path.join(freshDir('lr_single'), 'SCENE 001.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15:duration=2',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      fs.writeFileSync(webmFile, gen.stdout)

      // 1. Initial plan with mediaType: 'video'
      const planned = planManualAiImport({ projectDir: dir, filePaths: [webmFile], mediaType: 'video' })
      assert.strictEqual(planned.mappings.length, 1)

      // 2. Commit without allowLowResolution -> rejected with LOW_RESOLUTION
      const rejectCommit = await commitManualAiImport({ projectDir: dir, mappings: planned.mappings })
      assert.strictEqual(rejectCommit.imported.length, 0)
      assert.strictEqual(rejectCommit.rejections.length, 1)
      assert.strictEqual(rejectCommit.rejections[0].code, 'LOW_RESOLUTION')

      // 3. User clicks "Use Anyway" (allowLowResolution: true) using createMappingFromRejection
      const mapping = createMappingFromRejection(rejectCommit.rejections[0])
      assert.ok(mapping)
      assert.strictEqual(mapping?.mediaType, 'video')

      const acceptCommit = await commitManualAiImport({ projectDir: dir, mappings: [mapping!], allowLowResolution: true })
      assert.strictEqual(acceptCommit.imported.length, 1)
      assert.strictEqual(acceptCommit.imported[0].mediaType, 'video')
      assert.strictEqual(acceptCommit.imported[0].sceneIndex, 1)
      assert.strictEqual(acceptCommit.imported[0].width, 1280)
      assert.strictEqual(acceptCommit.imported[0].height, 720)

      // Verify manifest
      const manifest = loadManualAiManifest(dir)
      assert.strictEqual(manifest.scenes['1'].mediaType, 'video')
      assert.strictEqual(manifest.scenes['1'].width, 1280)
      assert.strictEqual(manifest.scenes['1'].height, 720)
      assert.ok((manifest.scenes['1'].durationSecs ?? 0) > 1.8)
      assert.strictEqual(manifest.scenes['1'].lowResolution, true)
    })

    // ─── 9. Low-resolution bulk approval "Accept All" (Item 99) ──────────────
    await it('low-resolution bulk approval: Accept All preserves mediaType: video on all files', async () => {
      const dir = makeProject(3)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const clipsDir = freshDir('lr_bulk')
      const file1 = path.join(clipsDir, 'SCENE 001.webm')
      const file2 = path.join(clipsDir, 'SCENE 002.webm')

      for (const f of [file1, file2]) {
        const gen = spawnSync(ffmpegStatic, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15:duration=2',
          '-c:v', 'libvpx-vp9', '-b:v', '300k',
          '-f', 'webm', 'pipe:1'
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
        fs.writeFileSync(f, gen.stdout)
      }

      // Initial plan
      const planned = planManualAiImport({ projectDir: dir, filePaths: [file1, file2], mediaType: 'video' })
      assert.strictEqual(planned.mappings.length, 2)

      // Initial commit -> both rejected with LOW_RESOLUTION
      const initialCommit = await commitManualAiImport({ projectDir: dir, mappings: planned.mappings })
      assert.strictEqual(initialCommit.imported.length, 0)
      assert.strictEqual(initialCommit.rejections.length, 2)

      // Simulate Accept All mapping construction with createMappingFromRejection
      const bulkMappings = initialCommit.rejections
        .filter((r) => r.code === 'LOW_RESOLUTION')
        .map(createMappingFromRejection)
        .filter((m): m is ManualAiImportMapping => m !== null)

      assert.strictEqual(bulkMappings.length, 2)
      assert.strictEqual(bulkMappings[0].mediaType, 'video')
      assert.strictEqual(bulkMappings[1].mediaType, 'video')

      // Commit with allowLowResolution: true
      const bulkCommit = await commitManualAiImport({ projectDir: dir, mappings: bulkMappings, allowLowResolution: true })
      assert.strictEqual(bulkCommit.imported.length, 2)
      assert.strictEqual(bulkCommit.imported[0].mediaType, 'video')
      assert.strictEqual(bulkCommit.imported[1].mediaType, 'video')
      assert.strictEqual(bulkCommit.status.ready, 2)

      const manifest = loadManualAiManifest(dir)
      assert.strictEqual(manifest.scenes['1'].mediaType, 'video')
      assert.strictEqual(manifest.scenes['2'].mediaType, 'video')
      assert.ok((manifest.scenes['1'].durationSecs ?? 0) > 1.8)
      assert.ok((manifest.scenes['2'].durationSecs ?? 0) > 1.8)
    })

    // ─── 10. Mixed image and video assets (Item 100) ─────────────────────────
    await it('mixed image and video: PNG + WEBM correctly satisfy AI-owned scenes', async () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const assetsDir = freshDir('mixed')
      const img1 = path.join(assetsDir, 'SCENE 001.png')
      spawnSync(ffmpegStatic, [
        '-y', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=1:d=1',
        '-vframes', '1', img1
      ], { timeout: 30000 })

      const vid2 = path.join(assetsDir, 'SCENE 002.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=15:duration=2',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      fs.writeFileSync(vid2, gen.stdout)

      // Import Scene 1 as Image
      const planImg = planManualAiImport({ projectDir: dir, filePaths: [img1] })
      await commitManualAiImport({ projectDir: dir, mappings: planImg.mappings })

      // Import Scene 2 as Video
      const planVid = planManualAiImport({ projectDir: dir, filePaths: [vid2], mediaType: 'video' })
      await commitManualAiImport({ projectDir: dir, mappings: planVid.mappings })

      const status = evaluateManualAiStatus({ projectDir: dir, pack: loadManualAiPromptPack(dir) })
      assert.strictEqual(status.expected, 2)
      assert.strictEqual(status.ready, 2)
      assert.strictEqual(status.allReady, true)

      const s1 = status.rows.find((r) => r.sceneIndex === 1)
      const s2 = status.rows.find((r) => r.sceneIndex === 2)
      assert.strictEqual(s1?.mediaType, undefined) // Image
      assert.strictEqual(s2?.mediaType, 'video')    // Video
    })

    // ─── 11. Stock scene protection (Item 101) ──────────────────────────────
    await it('stock scene protection: attempting to import video into Stock-owned scene is rejected', async () => {
      const dir = makeProject(4)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      // 50% AI, 50% Stock
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(0.5, 0.5, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      // Find a stock-owned scene
      const stockScene = plan.scenes.find((s) => s.strategy === 'stock')
      assert.ok(stockScene, 'Project must have a Stock scene')

      const videoFile = path.join(freshDir('stock_protect'), `SCENE ${String(stockScene?.sceneIndex).padStart(3, '0')}.webm`)
      fs.writeFileSync(videoFile, 'dummy')

      const planned = planManualAiImport({ projectDir: dir, filePaths: [videoFile], mediaType: 'video' })
      assert.strictEqual(planned.mappings.length, 0)
      assert.strictEqual(planned.rejections[0].code, 'NOT_AI_OWNED')
      assert.ok(planned.rejections[0].message.includes('real footage'))
    })

    // ─── 12. Assignment synchronization (Item 103) ──────────────────────────
    await it('syncManualAiAssignments: assigns imported WEBM with provider manual-ai and mediaType video', async () => {
      const dir = makeProject(2)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const vidPath = path.join(freshDir('sync_test'), 'SCENE 001.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=15:duration=2',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      fs.writeFileSync(vidPath, gen.stdout)

      const planned = planManualAiImport({ projectDir: dir, filePaths: [vidPath], mediaType: 'video' })
      await commitManualAiImport({ projectDir: dir, mappings: planned.mappings })

      const store = new VisualAssignmentStore(dir)
      const syncResult = await syncManualAiAssignments({
        projectDir: dir,
        pack: loadManualAiPromptPack(dir)!,
        aiScenes: plan.scenes,
        store,
        isHealth: false
      })

      assert.strictEqual(syncResult.changed, true)
      const assigned = store.get(1)
      assert.ok(assigned)
      assert.strictEqual(assigned?.status, 'assigned')
      assert.strictEqual(assigned?.asset?.provider, 'manual-ai')
      assert.strictEqual(assigned?.asset?.mediaType, 'video')
      assert.strictEqual(assigned?.asset?.creator, 'Manual AI Video')
    })

    // ─── 13. Controlled video rendering verification (Item 104) ─────────────
    await it('controlled video rendering: FFmpeg successfully decodes the imported WEBM', async () => {
      const dir = makeProject(1)
      const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })

      const vidPath = path.join(freshDir('render_test'), 'SCENE 001.webm')
      const gen = spawnSync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15:duration=2',
        '-c:v', 'libvpx-vp9', '-b:v', '300k',
        '-f', 'webm', 'pipe:1'
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 })
      fs.writeFileSync(vidPath, gen.stdout)

      const planned = planManualAiImport({ projectDir: dir, filePaths: [vidPath], mediaType: 'video' })
      const res = await commitManualAiImport({ projectDir: dir, mappings: planned.mappings, allowLowResolution: true })
      assert.strictEqual(res.imported.length, 1)

      const importedFile = res.imported[0].localPath
      assert.ok(fs.existsSync(importedFile))

      // Verify that FFmpeg can decode the imported file into rawvideo / null muxer
      const decodeRun = spawnSync(ffmpegStatic, [
        '-v', 'error',
        '-i', importedFile,
        '-f', 'null', '-'
      ], { encoding: 'utf-8', timeout: 30000 })
      assert.strictEqual(decodeRun.status, 0, decodeRun.stderr)
    })
  } finally {
    cleanupFixtures()
    finish()
  }
}

void main()
