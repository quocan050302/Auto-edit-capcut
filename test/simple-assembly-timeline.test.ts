import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { resolveAssemblyTimeline } from '../src/main/simple-assembly/simple-assembly-timeline'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

const { it, finish } = createRunner('Simple Assembly Timeline & Frame Allocation Tests')

void (async () => {
  const testRoot = freshDir('timeline-tests')
  const vo30Path = path.join(testRoot, 'vo-30s.wav')

  // Generate 30.0s dummy voiceover
  spawnSync(ffmpegPath, ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '30', '-y', vo30Path], {
    stdio: 'ignore'
  })

  await it('Section 1: Frame-accurate equal distribution — 6 scenes over 30s at 30 FPS', async () => {
    const scenes = [
      { sceneIndex: 1, filePath: 's1.mp4', fileName: 's1.mp4', mediaType: 'video' as const },
      { sceneIndex: 2, filePath: 's2.mp4', fileName: 's2.mp4', mediaType: 'video' as const },
      { sceneIndex: 3, filePath: 's3.mp4', fileName: 's3.mp4', mediaType: 'video' as const },
      { sceneIndex: 4, filePath: 's4.mp4', fileName: 's4.mp4', mediaType: 'video' as const },
      { sceneIndex: 5, filePath: 's5.mp4', fileName: 's5.mp4', mediaType: 'video' as const },
      { sceneIndex: 6, filePath: 's6.mp4', fileName: 's6.mp4', mediaType: 'video' as const }
    ]

    const res = await resolveAssemblyTimeline({
      scenes,
      voiceoverPath: vo30Path,
      fps: 30
    })

    assert.strictEqual(res.allocationMethod, 'equal-distribution')
    assert.strictEqual(res.fps, 30)
    // 30s * 30fps = 900 frames
    assert.strictEqual(res.targetTotalFrames, 900)

    const sumFrames = res.scenes.reduce((acc, s) => acc + s.targetFrames, 0)
    assert.strictEqual(sumFrames, 900)

    // Each scene gets exactly 150 frames (5.0s)
    for (const sc of res.scenes) {
      assert.strictEqual(sc.targetFrames, 150)
      assert.strictEqual(Math.round(sc.durationSecs), 5)
    }
  })

  await it('Section 2: Deterministic remainder distribution — 7 scenes over 900 frames (900 / 7 = 128 r 4)', async () => {
    const scenes = Array.from({ length: 7 }, (_, i) => ({
      sceneIndex: i + 1,
      filePath: `s${i + 1}.mp4`,
      fileName: `s${i + 1}.mp4`,
      mediaType: 'video' as const
    }))

    const res = await resolveAssemblyTimeline({
      scenes,
      voiceoverPath: vo30Path,
      fps: 30
    })

    assert.strictEqual(res.targetTotalFrames, 900)
    const sumFrames = res.scenes.reduce((acc, s) => acc + s.targetFrames, 0)
    assert.strictEqual(sumFrames, 900)

    // 900 = 128 * 7 + 4. First 4 scenes get 129 frames, last 3 get 128 frames.
    assert.strictEqual(res.scenes[0].targetFrames, 129)
    assert.strictEqual(res.scenes[1].targetFrames, 129)
    assert.strictEqual(res.scenes[2].targetFrames, 129)
    assert.strictEqual(res.scenes[3].targetFrames, 129)
    assert.strictEqual(res.scenes[4].targetFrames, 128)
    assert.strictEqual(res.scenes[5].targetFrames, 128)
    assert.strictEqual(res.scenes[6].targetFrames, 128)
  })

  await it('Section 3: Large scale frame allocation — 100 scenes without drift', async () => {
    const scenes = Array.from({ length: 100 }, (_, i) => ({
      sceneIndex: i + 1,
      filePath: `s${i + 1}.mp4`,
      fileName: `s${i + 1}.mp4`,
      mediaType: 'video' as const
    }))

    const res = await resolveAssemblyTimeline({
      scenes,
      voiceoverPath: vo30Path,
      fps: 30
    })

    assert.strictEqual(res.scenes.length, 100)
    assert.strictEqual(res.targetTotalFrames, 900)
    const sumFrames = res.scenes.reduce((acc, s) => acc + s.targetFrames, 0)
    assert.strictEqual(sumFrames, 900)
  })

  await it('Section 4: Priority 1 Edit Plan timing alignment', async () => {
    // 3 scenes with explicit durations summing to 30.0s
    const scenes = [
      { sceneIndex: 1, filePath: 's1.mp4', fileName: 's1.mp4', mediaType: 'video' as const, duration: 10.0 },
      { sceneIndex: 2, filePath: 's2.mp4', fileName: 's2.mp4', mediaType: 'video' as const, duration: 12.0 },
      { sceneIndex: 3, filePath: 's3.mp4', fileName: 's3.mp4', mediaType: 'video' as const, duration: 8.0 }
    ]

    const res = await resolveAssemblyTimeline({
      scenes,
      voiceoverPath: vo30Path,
      fps: 30
    })

    assert.strictEqual(res.allocationMethod, 'edit-plan')
    assert.strictEqual(res.scenes[0].targetFrames, 300) // 10s * 30
    assert.strictEqual(res.scenes[1].targetFrames, 360) // 12s * 30
    assert.strictEqual(res.scenes[2].targetFrames, 240) // 8s * 30
    const sumFrames = res.scenes.reduce((acc, s) => acc + s.targetFrames, 0)
    assert.strictEqual(sumFrames, 900)
  })

  finish()
})()
