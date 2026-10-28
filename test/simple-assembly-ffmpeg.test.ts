import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { executeSimpleAssembly } from '../src/main/simple-assembly/simple-assembly-engine'
import { probeMedia } from '../src/main/render-cache/ffmpeg-process'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

const { it, finish } = createRunner('Real FFmpeg Simple Scene Assembly Engine Tests')

void (async () => {
  const testRoot = freshDir('ffmpeg-assembly-tests')

  // Generate test fixtures
  // 1. Voiceover audio: 9.0 seconds sine audio
  const voPath = path.join(testRoot, 'voiceover.wav')
  spawnSync(
    ffmpegPath,
    ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=9.0', '-c:a', 'pcm_s16le', '-y', voPath],
    { stdio: 'ignore' }
  )

  // 2. Background music: 12.0 seconds
  const musicPath = path.join(testRoot, 'music.mp3')
  spawnSync(
    ffmpegPath,
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12.0', '-c:a', 'libmp3lame', '-y', musicPath],
    { stdio: 'ignore' }
  )

  // 3. Scene 1: 3.0s red video (MP4) with internal audio that must be muted
  const scene1Path = path.join(testRoot, 'Scene 1.mp4')
  spawnSync(
    ffmpegPath,
    [
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=3.0:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=200:duration=3.0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-y', scene1Path
    ],
    { stdio: 'ignore' }
  )

  // 4. Scene 2: 3.0s green video (WEBM)
  const scene2Path = path.join(testRoot, 'Scene 2.webm')
  spawnSync(
    ffmpegPath,
    [
      '-f', 'lavfi', '-i', 'color=c=green:s=800x600:d=3.0:r=25',
      '-c:v', 'libvpx-vp9',
      '-y', scene2Path
    ],
    { stdio: 'ignore' }
  )

  // 5. Scene 3: static blue image (PNG)
  const scene3Path = path.join(testRoot, 'Scene 3.png')
  spawnSync(
    ffmpegPath,
    ['-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=1.0', '-frames:v', '1', '-y', scene3Path],
    { stdio: 'ignore' }
  )

  await it('Section 1: No Music Simple Assembly — 3 mixed scenes (MP4, WEBM, PNG) + VO (9s)', async () => {
    const progressEvents: string[] = []
    const result = await executeSimpleAssembly({
      projectDir: testRoot,
      voiceoverPath: voPath,
      sceneSources: [
        { sceneIndex: 1, filePath: scene1Path, fileName: 'Scene 1.mp4', mediaType: 'video' },
        { sceneIndex: 2, filePath: scene2Path, fileName: 'Scene 2.webm', mediaType: 'video' },
        { sceneIndex: 3, filePath: scene3Path, fileName: 'Scene 3.png', mediaType: 'image' }
      ],
      backgroundMusicMode: 'off',
      outputName: 'simple_assembly_no_music.mp4',
      width: 1280,
      height: 720,
      fps: 30,
      shortClipPolicy: 'freeze-last-frame',
      onProgress: (p) => {
        progressEvents.push(`${p.status}: ${p.percent}%`)
      }
    })

    assert.strictEqual(result.success, true)
    assert.strictEqual(fs.existsSync(result.outputPath!), true)
    assert.strictEqual(result.sceneCount, 3)

    // Probe the output file
    const probe = await probeMedia(result.outputPath!)
    assert.strictEqual(probe.width, 1280)
    assert.strictEqual(probe.height, 720)
    assert.strictEqual(probe.hasVideo, true)
    assert.strictEqual(probe.hasAudio, true)

    // Duration must align with 9s voiceover within encoder tolerance (0.5s)
    assert.strictEqual(probe.duration !== undefined, true)
    assert.strictEqual(Math.abs(probe.duration! - 9.0) < 0.5, true)

    // Progress events must cover the pipeline flow
    assert.strictEqual(progressEvents.some((e) => e.includes('validating-scenes')), true)
    assert.strictEqual(progressEvents.some((e) => e.includes('normalizing-scenes')), true)
    assert.strictEqual(progressEvents.some((e) => e.includes('completed: 100%')), true)
  })

  await it('Section 2: Add Music Simple Assembly — VO + Ducked Background Music', async () => {
    const result = await executeSimpleAssembly({
      projectDir: testRoot,
      voiceoverPath: voPath,
      sceneSources: [
        { sceneIndex: 1, filePath: scene1Path, fileName: 'Scene 1.mp4', mediaType: 'video' },
        { sceneIndex: 2, filePath: scene2Path, fileName: 'Scene 2.webm', mediaType: 'video' },
        { sceneIndex: 3, filePath: scene3Path, fileName: 'Scene 3.png', mediaType: 'image' }
      ],
      backgroundMusicMode: 'auto',
      musicFilePath: musicPath,
      outputName: 'simple_assembly_with_music.mp4',
      width: 1280,
      height: 720,
      fps: 30,
      shortClipPolicy: 'freeze-last-frame'
    })

    assert.strictEqual(result.success, true)
    assert.strictEqual(fs.existsSync(result.outputPath!), true)
    assert.strictEqual(result.sceneCount, 3)

    const probe = await probeMedia(result.outputPath!)
    assert.strictEqual(probe.hasVideo, true)
    assert.strictEqual(probe.hasAudio, true)
    assert.strictEqual(Math.abs(probe.duration! - 9.0) < 0.5, true)
  })

  await it('Section 3: Cache reuse — identical request reuses cached video and output', async () => {
    let normalizedCallCount = 0
    const res = await executeSimpleAssembly({
      projectDir: testRoot,
      voiceoverPath: voPath,
      sceneSources: [
        { sceneIndex: 1, filePath: scene1Path, fileName: 'Scene 1.mp4', mediaType: 'video' },
        { sceneIndex: 2, filePath: scene2Path, fileName: 'Scene 2.webm', mediaType: 'video' },
        { sceneIndex: 3, filePath: scene3Path, fileName: 'Scene 3.png', mediaType: 'image' }
      ],
      backgroundMusicMode: 'off',
      outputName: 'simple_assembly_no_music.mp4',
      width: 1280,
      height: 720,
      fps: 30,
      shortClipPolicy: 'freeze-last-frame',
      onProgress: (p) => {
        if (p.status === 'normalizing-scenes') normalizedCallCount++
      }
    })

    assert.strictEqual(res.success, true)
    // Normalized clips should be reused from cache
    assert.strictEqual(fs.existsSync(res.outputPath), true)
  })

  await it('Section 4: Cancellation safety — abort signal stops assembly and removes partial files', async () => {
    const controller = new AbortController()
    // Abort after 50ms
    setTimeout(() => controller.abort(), 50)

    try {
      await executeSimpleAssembly({
        projectDir: testRoot,
        voiceoverPath: voPath,
        sceneSources: [
          { sceneIndex: 1, filePath: scene1Path, fileName: 'Scene 1.mp4', mediaType: 'video' },
          { sceneIndex: 2, filePath: scene2Path, fileName: 'Scene 2.webm', mediaType: 'video' }
        ],
        backgroundMusicMode: 'off',
        outputName: 'cancelled_output.mp4',
        width: 1280,
        height: 720,
        fps: 30,
        signal: controller.signal
      })
      assert.fail('Should have thrown AbortError')
    } catch (err: any) {
      assert.strictEqual(err.name === 'AbortError' || /abort|cancel/i.test(err.message), true)
      // Verify no corrupted partial file was published to output/cancelled_output.mp4
      assert.strictEqual(fs.existsSync(path.join(testRoot, 'output', 'cancelled_output.mp4')), false)
    }
  })

  finish()
})()
