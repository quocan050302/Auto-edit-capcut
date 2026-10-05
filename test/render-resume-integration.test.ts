/**
 * Integration test — Resumable Render Engine V2 on a full-length project.
 *
 *  - 120 scenes, 20-minute timeline (low resolution so it runs on a laptop)
 *  - captions, voiceover + music + SFX, transitions, narrative text (Proof Visual),
 *    Visual Scene Grammar + Render QA enabled
 *  - REAL crashes: a child process running renderVideo() is SIGKILLed mid-scene and
 *    again mid-overlay; the parent reconciles and resumes from the checkpoints
 *  - final output probed (duration / resolution / fps / audio) + blackdetect
 *  - resumed output compared to an uninterrupted render (PSNR)
 *  - segmented assembly compared to the legacy single-graph assembly (PSNR)
 *  - real Remotion: block renders (frameRange) compared to one continuous render
 *
 * Set SKIP_REMOTION=1 to skip the Chromium part.
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, spawnSync, execFileSync } from 'child_process'
import { createRenderFixture, makeFakeOverlayRenderer, type RenderFixture } from './helpers/render-fixture'
import { renderVideo, setOverlayRendererForTests, prepareRenderPlan } from '../src/main/renderer'
import { readActiveRender, getRenderCacheRoot } from '../src/main/render-cache/render-cache-manager'
import { readManifest } from '../src/main/render-cache/render-manifest'
import { inspectRenderRecovery } from '../src/main/render-cache/render-recovery'
import { getFfmpegBinary, probeMedia } from '../src/main/render-cache/ffmpeg-process'
import { setRenderPreferencesPathForTests } from '../src/main/render-cache/render-preferences'
import { softwareEncoder } from '../src/main/render-cache/video-encoder'
import { concatSceneClipsWithTransitions } from '../src/main/transitions/scene-transition-engine'
import type { RenderTransitionSettings } from '../shared/types'

let passed = 0
let failed = 0
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  if (process.env.ONLY_REMOTION === '1' && !name.includes('Remotion')) return
  const t0 = Date.now()
  try {
    await fn()
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    passed++
  } catch (err) {
    console.error(`  ✕ ${name}`)
    console.error(err)
    failed++
  }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rv2-int-'))
const PREFS = path.join(ROOT, 'render-preferences.json')
setRenderPreferencesPathForTests(PREFS)
setOverlayRendererForTests(makeFakeOverlayRenderer([]) as never)

const W = 192
const H = 108
const FPS = 5
const SCENES = 120
const SCENE_SECS = 10
const TOTAL = SCENES * SCENE_SECS
const TRANSITIONS = { enabled: true, mode: 'smart', defaultDuration: 0.4, chapterDuration: 0.8 } as unknown as RenderTransitionSettings
const TSX = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')

function makeProject(name: string): RenderFixture {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return createRenderFixture(dir, {
    scenes: SCENES, sceneDuration: SCENE_SECS, width: W, height: H, fps: FPS,
    withMusic: true, withSfx: true, withNarrative: true, captionEverySecs: 9,
    productionSettings: { enabled: true, visualSceneGrammarEnabled: true, renderQaEnabled: true }
  })
}

/** Runs the render in a child process and SIGKILLs it when `killWhen(stage)` is true. */
function renderInChildAndKill(fx: RenderFixture, killWhen: (stage: string) => boolean): Promise<{ killedAt: string; childPid: number }> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({
      projectDir: fx.projectDir, voiceoverPath: fx.voiceoverPath, width: W, height: H, fps: FPS,
      captionPlanPath: path.join(fx.projectDir, 'analysis', 'caption-plan.json'),
      transitions: TRANSITIONS, prefsPath: PREFS, source: 'pipeline'
    })
    const child = spawn(TSX, [path.join('test', 'helpers', 'render-child.ts'), args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let killedAt = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: { stage?: string; done?: boolean; error?: string }
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.error) return reject(new Error(`child failed: ${msg.error}`))
        if (msg.done) return reject(new Error('child finished before the crash point'))
        if (msg.stage && !killedAt && killWhen(msg.stage)) {
          killedAt = msg.stage
          // tsx spawns node as a grandchild: kill the actual render process (hard crash)
          for (const pid of descendants(child.pid!)) {
            try { if (isNode(pid)) process.kill(pid, 'SIGKILL') } catch { /* gone */ }
          }
          try { process.kill(child.pid!, 'SIGKILL') } catch { /* gone */ }
        }
      }
    })
    child.on('exit', () => (killedAt ? resolve({ killedAt, childPid: child.pid! }) : reject(new Error('child exited without reaching the crash point'))))
  })
}

function descendants(pid: number): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
  const kids = new Map<number, number[]>()
  for (const l of out.trim().split('\n')) {
    const [p, pp] = l.trim().split(/\s+/).map(Number)
    if (!kids.has(pp)) kids.set(pp, [])
    kids.get(pp)!.push(p)
  }
  const res: number[] = []
  const stack = [...(kids.get(pid) ?? [])]
  while (stack.length) {
    const p = stack.pop()!
    res.push(p)
    stack.push(...(kids.get(p) ?? []))
  }
  return res
}

function isNode(pid: number): boolean {
  try { return /node|tsx/i.test(execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' })) } catch { return false }
}

async function waitForOrphans(projectDir: string, timeoutMs = 15000): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const r = spawnSync('pgrep', ['-f', projectDir], { encoding: 'utf-8' })
    const pids = (r.stdout || '').trim().split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid)
    if (pids.length === 0) return 0
    if (Date.now() - t0 > timeoutMs) {
      pids.forEach((p) => { try { process.kill(p, 'SIGKILL') } catch { /* ignore */ } })
      return pids.length
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

function psnr(a: string, b: string, extra: string[] = []): number {
  const r = spawnSync(getFfmpegBinary(), ['-hide_banner', '-nostats', ...extra, '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf-8' })
  const m = /average:(inf|[\d.]+)/.exec(r.stderr)
  assert.ok(m, `psnr failed: ${r.stderr.slice(-400)}`)
  return m![1] === 'inf' ? Infinity : Number(m![1])
}

function blackSegments(file: string): Array<{ start: number; dur: number }> {
  const r = spawnSync(getFfmpegBinary(), ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=1.0:pix_th=0.08', '-an', '-f', 'null', '-'], { encoding: 'utf-8' })
  const segs: Array<{ start: number; dur: number }> = []
  for (const m of r.stderr.matchAll(/black_start:([\d.]+) black_end:[\d.]+ black_duration:([\d.]+)/g)) segs.push({ start: Number(m[1]), dur: Number(m[2]) })
  return segs
}

async function main(): Promise<void> {
  console.log(`\n=== Render resume integration (${SCENES} scenes, ${TOTAL / 60} min, ${W}x${H}@${FPS}) ===\n`)
  const fx = makeProject('main')
  let firstKill = ''
  let secondKill = ''
  let resumed: Awaited<ReturnType<typeof renderVideo>> | undefined
  const timings: Record<string, number> = {}

  await it('crash #1: SIGKILL during scene rendering → reconcile detects crash, scenes kept', async () => {
    const t0 = Date.now()
    const { killedAt } = await renderInChildAndKill(fx, (s) => s.startsWith('Rendering scene 61/'))
    timings.untilCrash1 = Date.now() - t0
    firstKill = killedAt
    const orphans = await waitForOrphans(fx.projectDir)
    const info = inspectRenderRecovery(fx.projectDir)
    assert.strictEqual(info.interruptionReason, 'crashed')
    assert.strictEqual(info.status, 'available')
    assert.strictEqual(info.canAutoResume, true)
    assert.ok(info.completedScenes >= 59 && info.completedScenes <= 60, `completed ${info.completedScenes}`)
    console.log(`    killed at "${killedAt}", orphans force-killed=${orphans}, cached=${info.completedScenes}/${info.totalScenes}, saved≈${info.estimatedWorkSavedPct}%`)
  })

  await it('crash #2: resume in a new process, SIGKILL during overlay blocks', async () => {
    let blocks = 0
    const t0 = Date.now()
    const seen: string[] = []
    const { killedAt } = await renderInChildAndKill(fx, (s) => {
      seen.push(s)
      const m = /^Rendering overlay block (\d+)\/(\d+)$/.exec(s)
      if (!m) return false
      blocks = Number(m[2])
      return Number(m[1]) === Math.max(2, Math.ceil(blocks * 0.6))
    })
    timings.resume1UntilCrash2 = Date.now() - t0
    secondKill = killedAt
    assert.ok(seen.some((s) => s.startsWith('Reusing cached scene')), 'resume must reuse cached scenes')
    await waitForOrphans(fx.projectDir)
    const info = inspectRenderRecovery(fx.projectDir)
    assert.strictEqual(info.completedScenes, SCENES)
    assert.strictEqual(info.assemblyStatus, 'completed')
    assert.strictEqual(info.audioMixStatus, 'completed')
    assert.ok(info.completedOverlayBlocks >= 1)
    console.log(`    killed at "${killedAt}", overlay ${info.completedOverlayBlocks}/${info.totalOverlayBlocks} cached, saved≈${info.estimatedWorkSavedPct}%`)
  })

  await it('final resume completes from the last checkpoint', async () => {
    const t0 = Date.now()
    resumed = await renderVideo({
      projectDir: fx.projectDir, voiceoverPath: fx.voiceoverPath, resolution: { width: W, height: H }, fps: FPS,
      captionPlan: fx.captionPlan, transitionSettings: TRANSITIONS, source: 'pipeline'
    })
    timings.finalResume = Date.now() - t0
    const c = resumed.cache!
    assert.strictEqual(c.reusedScenes, SCENES)
    assert.strictEqual(c.reusedAssembly, true)
    assert.strictEqual(c.reusedAudioMix, true)
    assert.ok(c.reusedOverlayBlocks >= 1 && c.reusedOverlayBlocks < c.totalOverlayBlocks)
    assert.strictEqual(readActiveRender(fx.projectDir)?.status, 'completed')
    console.log(`    cache=${JSON.stringify({ ...c, warnings: c.warnings.length })}`)
    void firstKill; void secondKill
  })

  await it('final output: duration, resolution, fps, audio, no black gaps, no leftovers', async () => {
    const p = await probeMedia(resumed!.outputPath)
    assert.ok(p && p.hasVideo && p.hasAudio)
    assert.strictEqual(p!.width, W)
    assert.strictEqual(p!.height, H)
    assert.ok(Math.abs(p!.fps - FPS) < 0.01)
    // NOTE: the pre-existing audio mix (`amix` + `-shortest`) can trim a few seconds
    assert.ok(Math.abs(p!.duration - TOTAL) < 6, `duration ${p!.duration}`)
    const black = blackSegments(resumed!.outputPath)
    assert.strictEqual(black.length, 0, `black segments: ${JSON.stringify(black)}`)
    assert.ok(!fs.existsSync(path.join(fx.projectDir, 'output', 'final_output.partial.mp4')))
    const partials = spawnSync('find', [getRenderCacheRoot(fx.projectDir), '-name', '*.partial.*'], { encoding: 'utf-8' }).stdout.trim()
    assert.strictEqual(partials, '', `leftover partials: ${partials}`)
    console.log(`    output ${p!.width}x${p!.height}@${p!.fps} ${p!.duration.toFixed(2)}s audio=${p!.hasAudio}`)
  })

  await it('resumed output is identical to an uninterrupted render (PSNR)', async () => {
    const clean = makeProject('clean')
    const t0 = Date.now()
    const r = await renderVideo({
      projectDir: clean.projectDir, voiceoverPath: clean.voiceoverPath, resolution: { width: W, height: H }, fps: FPS,
      captionPlan: clean.captionPlan, transitionSettings: TRANSITIONS
    })
    timings.cleanFullRender = Date.now() - t0
    const v = psnr(resumed!.outputPath, r.outputPath)
    console.log(`    clean render ${(timings.cleanFullRender / 1000).toFixed(1)}s, PSNR(resumed, clean)=${v}`)
    assert.ok(v >= 45, `PSNR ${v}`)
  })

  await it('segmented transition assembly matches the legacy single-graph assembly (PSNR)', async () => {
    const ws = path.join(getRenderCacheRoot(fx.projectDir), readActiveRender(fx.projectDir)!.workspace)
    const prepared = prepareRenderPlan({
      projectDir: fx.projectDir, voiceoverPath: fx.voiceoverPath, resolution: { width: W, height: H }, fps: FPS,
      captionPlan: fx.captionPlan, transitionSettings: TRANSITIONS, encoderKey: softwareEncoder().key
    })
    const clips = prepared.sceneJobs.map((j) => path.join(ws, 'scenes', `scene-${String(j.ordinal).padStart(4, '0')}.mp4`))
    const single = path.join(ROOT, 'single-graph.mp4')
    const tmp = fs.mkdtempSync(path.join(ROOT, 'sg-'))
    await concatSceneClipsWithTransitions({
      sceneEntries: prepared.sceneEntries, sceneClips: clips, settings: prepared.validTransitionSettings!, fps: FPS, tmpDir: tmp, rawVideoPath: single
    })
    const segmented = path.join(ws, 'assembly', 'raw-video.mp4')
    const segCount = fs.readdirSync(path.join(ws, 'assembly', 'segments')).filter((f) => f.endsWith('.mp4')).length
    const a = await probeMedia(single)
    const b = await probeMedia(segmented)
    assert.ok(Math.abs(a!.duration - b!.duration) <= 1 / FPS + 0.01, `${a!.duration} vs ${b!.duration}`)
    const v = psnr(segmented, single)
    console.log(`    ${segCount} segments, PSNR(segmented, single-graph)=${v}`)
    assert.ok(segCount >= 2)
    assert.ok(v >= 40, `PSNR ${v}`)
  })

  if (process.env.SKIP_REMOTION !== '1') {
    await it('real Remotion: frameRange blocks are frame-identical to one continuous render at the block boundary', async () => {
      const { bundle } = await import('@remotion/bundler')
      const { renderMedia, selectComposition } = await import('@remotion/renderer')
      const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), 'src', 'remotion', 'index.ts') })
      const fps = 30
      const width = 640
      const height = 360
      const frames = 60
      // caption A ends on frame 29, caption B starts EXACTLY on the block boundary (frame 30 = 1.0s)
      const captionPlan = {
        enabled: true,
        activeRanges: [{ startTime: 0, endTime: 2, reason: 'normal' }],
        phrases: [
          { id: 'a', sceneId: 's1', text: 'BEFORE THE BOUNDARY', startTime: 0.3, endTime: 0.99, emphasisType: 'normal', style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' } },
          { id: 'b', sceneId: 's1', text: 'STARTS AT FRAME 30', startTime: 1.0, endTime: 1.9, emphasisType: 'normal', style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' } }
        ]
      }
      const inputProps = { captionPlan, proofVisuals: [], visualGrammar: [] }
      const comp = await selectComposition({ serveUrl, id: 'CaptionsOverlay', inputProps })
      const composition = { ...comp, durationInFrames: frames, fps, width, height }
      const common = { composition, serveUrl, codec: 'h264' as const, inputProps, concurrency: 1, crf: 1 }
      const full = path.join(ROOT, 'remotion-full.mp4')
      const b1 = path.join(ROOT, 'remotion-b1.mp4')
      const b2 = path.join(ROOT, 'remotion-b2.mp4')
      await renderMedia({ ...common, outputLocation: full })
      await renderMedia({ ...common, outputLocation: b1, frameRange: [0, 29] })
      await renderMedia({ ...common, outputLocation: b2, frameRange: [30, 59] })
      const list = path.join(ROOT, 'remotion-list.txt')
      fs.writeFileSync(list, `file '${b1}'\nfile '${b2}'\n`)
      const joined = path.join(ROOT, 'remotion-joined.mp4')
      spawnSync(getFfmpegBinary(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
      const pj = await probeMedia(joined)
      assert.strictEqual(pj!.frames, frames)
      const win = (src: string, a: number, b: number, tag: string): string => {
        const dst = path.join(ROOT, `rf-${tag}.mp4`)
        spawnSync(getFfmpegBinary(), ['-y', '-i', src, '-vf', `select=between(n\\,${a}\\,${b}),setpts=N/${fps}/TB`, '-r', String(fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0', dst])
        return dst
      }
      // the caption must actually change across the boundary (otherwise the test proves nothing)
      const visible = psnr(win(full, 29, 29, 'f29'), win(full, 30, 30, 'f30'))
      // frames 26..33 around the boundary: blocks vs continuous
      const v = psnr(win(full, 26, 33, 'full'), win(joined, 26, 33, 'joined'))
      // off-by-one controls: what a 1-frame timing error at the boundary would look like
      const early = psnr(win(full, 26, 33, 'full2'), win(joined, 27, 34, 'joinedp1'))
      const late = psnr(win(full, 27, 34, 'full3'), win(joined, 26, 33, 'joined2'))
      console.log(`    frame29↔30 PSNR=${visible.toFixed(1)} (caption change), blocks vs continuous=${v}, off-by-one controls=${early.toFixed(1)}/${late.toFixed(1)}`)
      assert.ok(visible < 60, `caption change across the boundary not visible (PSNR ${visible})`)
      assert.ok(v >= 40, `PSNR ${v}`)
      assert.ok(v - Math.max(early, late) >= 5, 'block render must match far better than a 1-frame shift')
    })
  }

  console.log('\nTimings (ms):', JSON.stringify(timings))
  console.log(`\n${passed} passed, ${failed} failed`)
  if (!process.env.KEEP_RV2) { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ } }
  else console.log('kept', ROOT)
  void readManifest
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
