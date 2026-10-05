/**
 * Test suite for the Resumable Render Engine V2 (src/main/render-cache/*, src/main/renderer.ts)
 *
 * Uses tiny FFmpeg-generated fixtures (160x90 @ 5fps) and a fake Remotion overlay
 * renderer so the whole suite runs in a couple of minutes without Chromium.
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRenderFixture, ffmpegSync, makeFakeOverlayRenderer, type RenderFixture } from './helpers/render-fixture'
import {
  renderVideo,
  prepareRenderPlan,
  setOverlayRendererForTests,
  setTransitionAssemblerForTests,
  type RenderVideoParams,
  type RenderResult
} from '../src/main/renderer'
import { canonicalJson, fingerprintOf } from '../src/main/render-cache/render-fingerprint'
import { writeJsonAtomic, readJsonWithRecovery, readManifest } from '../src/main/render-cache/render-manifest'
import {
  getRenderCacheRoot,
  isInsideCacheRoot,
  safeRemoveCachePath,
  readActiveRender,
  writeActiveRender,
  clearRenderCache
} from '../src/main/render-cache/render-cache-manager'
import { inspectRenderRecovery } from '../src/main/render-cache/render-recovery'
import { maybeAutoResumeRender, resetAutoResumeForTests } from '../src/main/render-cache/render-auto-resume'
import { RenderJobCoordinator, RenderBusyError } from '../src/main/render-cache/render-job-coordinator'
import {
  LineRingBuffer,
  ffmpegRun,
  getLiveRenderProcessCount,
  isRenderCancelledError,
  RenderCancelledError,
  setFfmpegBinaryForTests
} from '../src/main/render-cache/ffmpeg-process'
import { computeResourceLimits } from '../src/main/render-cache/render-resource-manager'
import {
  HardwareEncoderError,
  resolveEncoder,
  resetVideoToolboxProbeForTests,
  softwareEncoder
} from '../src/main/render-cache/video-encoder'
import { setRenderPreferencesPathForTests } from '../src/main/render-cache/render-preferences'
import { ThumbnailAutoTrigger } from '../src/main/thumbnail/thumbnail-auto-trigger'
import { saveProjectThumbnailSettings } from '../src/main/thumbnail/thumbnail-settings-manager'
import type { RenderTransitionSettings } from '../shared/types'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    const res = fn()
    if (res instanceof Promise) await res
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✕ ${name}`)
    console.error(err)
    failed++
  } finally {
    setOverlayRendererForTests(defaultOverlay)
    setTransitionAssemblerForTests(null)
    setFfmpegBinaryForTests(null)
  }
}

// Remotion bundling needs the Electron/Vite build layout; tests use a frame-exact FFmpeg stand-in.
const defaultOverlay = makeFakeOverlayRenderer([]) as never
setOverlayRendererForTests(defaultOverlay)

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rv2-test-'))
setRenderPreferencesPathForTests(path.join(ROOT, 'render-preferences.json'))

const W = 160
const H = 90
const FPS = 5
const TRANSITIONS = { enabled: true, mode: 'smart', defaultDuration: 0.4, chapterDuration: 0.6 } as unknown as RenderTransitionSettings
const SW_KEY = softwareEncoder().key

function fixture(name: string, opts: Partial<Parameters<typeof createRenderFixture>[1]> = {}): RenderFixture {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return createRenderFixture(dir, { scenes: 6, sceneDuration: 6, width: W, height: H, fps: FPS, ...opts })
}

function baseParams(fx: RenderFixture, extra: Partial<RenderVideoParams> = {}): RenderVideoParams {
  return {
    projectDir: fx.projectDir,
    voiceoverPath: fx.voiceoverPath,
    resolution: { width: W, height: H },
    fps: FPS,
    captionPlan: fx.captionPlan,
    transitionSettings: TRANSITIONS,
    ...extra
  }
}

function plan(fx: RenderFixture, extra: Partial<Parameters<typeof prepareRenderPlan>[0]> = {}) {
  return prepareRenderPlan({
    projectDir: fx.projectDir,
    voiceoverPath: fx.voiceoverPath,
    resolution: { width: W, height: H },
    fps: FPS,
    captionPlan: fx.captionPlan,
    transitionSettings: TRANSITIONS,
    encoderKey: SW_KEY,
    ...extra
  })
}

/** Runs a render that aborts as soon as a progress stage matches `stageStartsWith`. */
async function renderAndAbortAt(
  params: RenderVideoParams,
  stageStartsWith: string,
  reason: 'user-cancelled' | 'app-closed' = 'app-closed'
): Promise<{ stages: string[] }> {
  const ac = new AbortController()
  const stages: string[] = []
  let err: unknown
  try {
    await renderVideo({
      ...params,
      signal: ac.signal,
      getCancelReason: () => (ac.signal.aborted ? reason : undefined),
      onProgress: (p) => {
        stages.push(p.stage)
        if (!ac.signal.aborted && p.stage.startsWith(stageStartsWith)) ac.abort()
      }
    })
  } catch (e) {
    err = e
  }
  assert.ok(ac.signal.aborted, `abort stage "${stageStartsWith}" never reached; stages=${stages.slice(-5).join(' | ')}`)
  assert.ok(err && isRenderCancelledError(err), `expected RenderCancelledError, got ${String(err)}`)
  return { stages }
}

async function renderFull(params: RenderVideoParams, stages?: string[]): Promise<RenderResult> {
  return renderVideo({ ...params, onProgress: (p) => stages?.push(p.stage) })
}

function workspaceDir(projectDir: string): string {
  const rec = readActiveRender(projectDir)
  assert.ok(rec, 'active-render.json missing')
  return path.join(getRenderCacheRoot(projectDir), rec!.workspace)
}

async function main(): Promise<void> {
  console.log('\n=== Resumable Render Engine V2 ===\n')

  // ── Fingerprints ──────────────────────────────────────────────────────────
  const f0 = fixture('f0-fingerprints', { withMusic: true, captionEverySecs: 5 })

  await it('1. canonical fingerprints are stable and prepareRenderPlan is deterministic', () => {
    assert.strictEqual(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }), canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }))
    assert.strictEqual(fingerprintOf({ x: 1, y: 2 }), fingerprintOf({ y: 2, x: 1 }))
    assert.notStrictEqual(fingerprintOf({ x: 1 }), fingerprintOf({ x: 2 }))
    const a = plan(f0)
    const b = plan(f0)
    assert.strictEqual(a.renderFingerprint, b.renderFingerprint)
    assert.strictEqual(a.assemblyFingerprint, b.assemblyFingerprint)
    assert.deepStrictEqual(a.sceneJobs.map((j) => j.fingerprint), b.sceneJobs.map((j) => j.fingerprint))
  })

  await it('2. scene fingerprint changes when its media file changes (others untouched)', () => {
    const before = plan(f0).sceneJobs.map((j) => j.fingerprint)
    const clipA = path.join(f0.mediaDir, 'clip-a.mp4')
    ffmpegSync(['-f', 'lavfi', '-i', `mandelbrot=size=${W}x${H}:rate=${FPS}`, '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clipA])
    const after = plan(f0).sceneJobs.map((j) => j.fingerprint)
    // scenes 1,4 use clip-a (i % 3 === 0)
    assert.notStrictEqual(after[0], before[0])
    assert.notStrictEqual(after[3], before[3])
    assert.strictEqual(after[1], before[1])
    assert.strictEqual(after[2], before[2])
  })

  await it('3. caption change keeps scene + assembly fingerprints (only overlay/render key change)', () => {
    const a = plan(f0)
    const cp = JSON.parse(JSON.stringify(f0.captionPlan))
    cp.phrases[0].text = 'CHANGED CAPTION'
    const b = plan(f0, { captionPlan: cp })
    assert.deepStrictEqual(b.sceneJobs.map((j) => j.fingerprint), a.sceneJobs.map((j) => j.fingerprint))
    assert.strictEqual(b.assemblyFingerprint, a.assemblyFingerprint)
    assert.notStrictEqual(b.renderFingerprint, a.renderFingerprint)
  })

  await it('4. audio plan change keeps scene + assembly fingerprints', () => {
    const a = plan(f0)
    const p = path.join(f0.projectDir, 'analysis', 'audio-plan.json')
    const ap = JSON.parse(fs.readFileSync(p, 'utf-8'))
    ap.sections[0].volumeDb = -24
    fs.writeFileSync(p, JSON.stringify(ap))
    const b = plan(f0)
    assert.deepStrictEqual(b.sceneJobs.map((j) => j.fingerprint), a.sceneJobs.map((j) => j.fingerprint))
    assert.strictEqual(b.assemblyFingerprint, a.assemblyFingerprint)
    assert.notStrictEqual(b.renderFingerprint, a.renderFingerprint)
  })

  await it('5. transition change keeps scene fingerprints but changes assembly', () => {
    const a = plan(f0)
    const b = plan(f0, { transitionSettings: { ...TRANSITIONS, defaultDuration: 0.8 } as RenderTransitionSettings })
    assert.deepStrictEqual(b.sceneJobs.map((j) => j.fingerprint), a.sceneJobs.map((j) => j.fingerprint))
    assert.notStrictEqual(b.assemblyFingerprint, a.assemblyFingerprint)
  })

  await it('6. resolution / fps change invalidates scene fingerprints', () => {
    const a = plan(f0).sceneJobs.map((j) => j.fingerprint)
    const r = plan(f0, { resolution: { width: 320, height: 180 } }).sceneJobs.map((j) => j.fingerprint)
    const f = plan(f0, { fps: 10 }).sceneJobs.map((j) => j.fingerprint)
    a.forEach((fp, i) => {
      assert.notStrictEqual(r[i], fp)
      assert.notStrictEqual(f[i], fp)
    })
  })

  // ── Phase checkpoints on one project ─────────────────────────────────────
  const f1 = fixture('f1-phases', { captionEverySecs: 5 })
  const f1Calls: Array<[number, number]> = []

  await it('13. crash after assembly → resume reuses the assembled scene video', async () => {
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    await renderAndAbortAt(baseParams(f1), 'Loading audio plan')
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    const { stages } = await renderAndAbortAt(baseParams(f1), 'Rendering overlay block 1/')
    assert.ok(stages.some((s) => s.startsWith('Reusing cached scene 6/6')), 'scenes should be reused')
    assert.ok(stages.some((s) => /Reusing (assembled scene video|cached scene assembly)/.test(s)), 'assembly should be reused')
    assert.ok(!stages.some((s) => s.startsWith('Rendering scene')), 'no scene may be re-rendered')
  })

  await it('14. crash during overlay → resume reuses audio mix (+ scenes + assembly)', async () => {
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    const r = await renderFull(baseParams(f1))
    assert.strictEqual(r.cache?.reusedScenes, 6)
    assert.strictEqual(r.cache?.reusedAssembly, true)
    assert.strictEqual(r.cache?.reusedAudioMix, true)
    assert.ok(fs.existsSync(r.outputPath))
  })

  await it('7. identical re-render reuses every checkpoint', async () => {
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    const callsBefore = f1Calls.length
    const r = await renderFull(baseParams(f1))
    assert.strictEqual(r.cache?.renderedScenes, 0)
    assert.strictEqual(r.cache?.reusedAssembly, true)
    assert.strictEqual(r.cache?.reusedAudioMix, true)
    assert.strictEqual(r.cache?.reusedOverlayBlocks, r.cache?.totalOverlayBlocks)
    assert.strictEqual(r.cache?.reusedComposite, true)
    assert.strictEqual(f1Calls.length, callsBefore, 'overlay renderer must not run')
  })

  await it('8. corrupted cached scene (same size, random bytes) → only that scene re-renders', async () => {
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    const clip = path.join(workspaceDir(f1.projectDir), 'scenes', 'scene-0003.mp4')
    const size = fs.statSync(clip).size
    fs.writeFileSync(clip, Buffer.alloc(size, 0x5a))
    const r = await renderFull(baseParams(f1))
    assert.strictEqual(r.cache?.renderedScenes, 1)
    assert.strictEqual(r.cache?.reusedScenes, 5)
  })

  await it('9. stale .partial.mp4 + missing clip → partial discarded, one scene re-rendered', async () => {
    setOverlayRendererForTests(makeFakeOverlayRenderer(f1Calls) as never)
    const ws = workspaceDir(f1.projectDir)
    const clip = path.join(ws, 'scenes', 'scene-0002.mp4')
    const partial = path.join(ws, 'scenes', 'scene-0002.partial.mp4')
    fs.renameSync(clip, partial)
    fs.appendFileSync(partial, Buffer.alloc(1024, 1)) // truncated/garbage tail like a killed encode
    const r = await renderFull(baseParams(f1))
    assert.strictEqual(r.cache?.renderedScenes, 1)
    assert.ok(!fs.existsSync(partial), 'stale partial must be removed')
    assert.ok(fs.existsSync(clip))
  })

  // ── Manifest atomicity ───────────────────────────────────────────────────
  await it('10. writeJsonAtomic writes complete JSON and leaves no tmp file', () => {
    const p = path.join(ROOT, 'atomic', 'm.json')
    writeJsonAtomic(p, { a: 1, list: [1, 2, 3] })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 1, list: [1, 2, 3] })
    assert.ok(!fs.existsSync(p + '.tmp'))
  })

  await it('11. readJsonWithRecovery: broken primary + valid tmp → tmp; valid primary + stale tmp → primary', () => {
    const p = path.join(ROOT, 'atomic', 'r.json')
    fs.writeFileSync(p, '{"a": 1, "trunc')
    fs.writeFileSync(p + '.tmp', JSON.stringify({ a: 2 }))
    assert.deepStrictEqual(readJsonWithRecovery(p), { a: 2 })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 2 })
    fs.writeFileSync(p + '.tmp', JSON.stringify({ a: 3 }))
    assert.deepStrictEqual(readJsonWithRecovery(p), { a: 2 })
    assert.ok(!fs.existsSync(p + '.tmp'))
    fs.writeFileSync(p, 'garbage')
    assert.strictEqual(readJsonWithRecovery(p), null)
  })

  // ── 100-scene crash ──────────────────────────────────────────────────────
  await it('12. 100 scenes, crash at scene 51 → resume reuses 50 cached scenes untouched', async () => {
    const fx = fixture('f12-100-scenes', { scenes: 100, sceneDuration: 1.2 })
    const params = baseParams(fx, { transitionSettings: undefined })
    await renderAndAbortAt(params, 'Rendering scene 51/100', 'app-closed')
    const ws = workspaceDir(fx.projectDir)
    const rec = readActiveRender(fx.projectDir)
    assert.strictEqual(rec?.status, 'interrupted')
    assert.strictEqual(rec?.interruptionReason, 'app-closed')
    const info = inspectRenderRecovery(fx.projectDir)
    assert.strictEqual(info.completedScenes, 50)
    assert.strictEqual(info.totalScenes, 100)
    assert.ok(info.message?.includes('Resume from cached scene 51'), info.message)
    const mtimes = new Map<number, number>()
    for (let i = 1; i <= 50; i++) {
      mtimes.set(i, fs.statSync(path.join(ws, 'scenes', `scene-${String(i).padStart(4, '0')}.mp4`)).mtimeMs)
    }
    const r = await renderFull(params)
    assert.strictEqual(r.cache?.reusedScenes, 50)
    assert.strictEqual(r.cache?.renderedScenes, 50)
    for (const [i, m] of mtimes) {
      assert.strictEqual(fs.statSync(path.join(ws, 'scenes', `scene-${String(i).padStart(4, '0')}.mp4`)).mtimeMs, m, `scene ${i} was rewritten`)
    }
    assert.ok(Math.abs(r.durationSecs - 120) < 1.5, `duration ${r.durationSecs}`)
  })

  await it('15. ~18 min timeline: crash in a late overlay block → resume from that block only', async () => {
    const fx = fixture('f15-long', { scenes: 24, sceneDuration: 45, captionEverySecs: 20 })
    const params = baseParams(fx, { transitionSettings: undefined })
    const calls: Array<[number, number]> = []
    setOverlayRendererForTests(makeFakeOverlayRenderer(calls) as never)
    let total = 0
    let abortAt = 0
    const ac = new AbortController()
    let err: unknown
    try {
      await renderVideo({
        ...params,
        signal: ac.signal,
        getCancelReason: () => 'app-closed',
        onProgress: (p) => {
          const m = /^Rendering overlay block (\d+)\/(\d+)$/.exec(p.stage)
          if (!m || ac.signal.aborted) return
          total = Number(m[2])
          if (!abortAt) abortAt = Math.max(2, Math.ceil(total * 0.75))
          if (Number(m[1]) === abortAt) ac.abort()
        }
      })
    } catch (e) {
      err = e
    }
    assert.ok(total >= 2, `expected several overlay blocks, got ${total} (error: ${String(err)})`)
    assert.ok(isRenderCancelledError(err), String(err))
    const ws = workspaceDir(fx.projectDir)
    const m = readManifest(path.join(ws, 'manifest.json'))!
    const target = m.overlayBlocks[abortAt - 1]
    const info = inspectRenderRecovery(fx.projectDir)
    assert.strictEqual(info.completedScenes, 24)
    assert.strictEqual(info.completedOverlayBlocks, abortAt - 1)
    assert.ok((info.estimatedWorkSavedPct ?? 0) >= 70, `saved ${info.estimatedWorkSavedPct}`)

    calls.length = 0
    setOverlayRendererForTests(makeFakeOverlayRenderer(calls) as never)
    const r = await renderFull(params)
    assert.strictEqual(r.cache?.reusedScenes, 24)
    assert.strictEqual(r.cache?.reusedAssembly, true)
    assert.strictEqual(r.cache?.reusedAudioMix, true)
    assert.strictEqual(r.cache?.reusedOverlayBlocks, abortAt - 1)
    assert.strictEqual(calls.length, total - abortAt + 1)
    assert.deepStrictEqual(calls[0], [target.startFrame, target.endFrameExclusive - 1])
    assert.ok(Math.abs(r.durationSecs - 1080) < 4, `duration ${r.durationSecs}`)
  })

  // ── Auto-resume policy ───────────────────────────────────────────────────
  const f16 = fixture('f16-autoresume', { scenes: 5, sceneDuration: 6 })

  await it('16. user cancel → resumable manually but never auto-resumed', async () => {
    await renderAndAbortAt(baseParams(f16, { source: 'pipeline' }), 'Rendering scene 3/5', 'user-cancelled')
    const info = inspectRenderRecovery(f16.projectDir)
    assert.strictEqual(info.resumable, true)
    assert.strictEqual(info.interruptionReason, 'user-cancelled')
    assert.strictEqual(info.canAutoResume, false)
    assert.strictEqual(info.completedScenes, 2)
  })

  await it('17. crashed pipeline render (dead pid, other instance) → auto-resume exactly once', async () => {
    const rec = readActiveRender(f16.projectDir)!
    writeActiveRender(f16.projectDir, {
      ...rec,
      status: 'running',
      interruptionReason: undefined,
      source: 'pipeline',
      pid: 999_999,
      appInstanceId: 'another-instance',
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      autoResumeCount: 0
    })
    const info = inspectRenderRecovery(f16.projectDir)
    assert.strictEqual(info.interruptionReason, 'crashed')
    assert.strictEqual(info.canAutoResume, true)
    assert.strictEqual(readActiveRender(f16.projectDir)?.status, 'interrupted')

    resetAutoResumeForTests()
    let resumes = 0
    const deps = {
      resumePipeline: async () => { resumes++ },
      getPipelineStatus: () => ({ overallStatus: 'interrupted', stages: { rendering: { status: 'running' } } }),
      isPipelineActive: () => false
    }
    assert.strictEqual(await maybeAutoResumeRender(f16.projectDir, deps), true)
    assert.strictEqual(await maybeAutoResumeRender(f16.projectDir, deps), false)
    resetAutoResumeForTests() // simulates relaunching the app after a second crash
    assert.strictEqual(await maybeAutoResumeRender(f16.projectDir, deps), false)
    assert.strictEqual(resumes, 1)
    assert.strictEqual(readActiveRender(f16.projectDir)?.autoResumeCount, 1)
  })

  // ── Coordinator / process management ─────────────────────────────────────
  await it('18. coordinator: same key attaches, different key is rejected, cancel aborts', async () => {
    const c = new RenderJobCoordinator()
    let release!: () => void
    let seenSignal!: AbortSignal
    const first = c.run({
      projectDir: '/tmp/p1', requestKey: 'k1', source: 'manual',
      starter: (signal) => { seenSignal = signal; return new Promise<string>((r) => { release = () => r('done') }) }
    })
    assert.strictEqual(first.attached, false)
    const second = c.run({ projectDir: '/tmp/p1/', requestKey: 'k1', source: 'pipeline', starter: async () => 'dup' })
    assert.strictEqual(second.attached, true)
    assert.strictEqual(second.promise, first.promise)
    assert.throws(() => c.run({ projectDir: '/tmp/p1', requestKey: 'k2', source: 'manual', starter: async () => 'x' }), RenderBusyError)
    release()
    assert.strictEqual(await first.promise, 'done')
    assert.strictEqual(c.isActive('/tmp/p1'), false)

    const third = c.run({ projectDir: '/tmp/p2', requestKey: 'k', source: 'manual', starter: (s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(new RenderCancelledError()))) })
    assert.strictEqual(c.cancel('/tmp/p2', 'app-closed'), true)
    await assert.rejects(third.promise, RenderCancelledError)
    void seenSignal
  })

  await it('19. FFmpeg log ring buffer stays bounded', () => {
    const rb = new LineRingBuffer(50, 4096)
    for (let i = 0; i < 10_000; i++) rb.push(`frame=${i} fps=30 q=28.0 size=1234kB time=00:00:${i}\n`)
    assert.ok(rb.lineCount <= 50)
    assert.ok(rb.byteSize <= 4096)
    assert.ok(rb.tail(1).includes('frame=9999'))
    rb.push('x'.repeat(100_000))
    assert.ok(rb.byteSize <= 4096 * 2)
  })

  await it('20. aborting ffmpegRun rejects with RenderCancelledError and leaves no live process', async () => {
    const ac = new AbortController()
    const out = path.join(ROOT, 'abort-test.mp4')
    const p = ffmpegRun(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '600', '-c:v', 'libx264', '-preset', 'veryslow', out], { signal: ac.signal, killGraceMs: 500 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(getLiveRenderProcessCount() >= 1)
    ac.abort()
    await assert.rejects(p, (e: unknown) => isRenderCancelledError(e))
    await new Promise((r) => setTimeout(r, 100))
    assert.strictEqual(getLiveRenderProcessCount(), 0)
  })

  // ── Legacy project + publish safety ──────────────────────────────────────
  const f21 = fixture('f21-legacy', { scenes: 4, sceneDuration: 8 })

  await it('22. final output is only published after validation; abort while finalizing leaves nothing', async () => {
    const out = path.join(f21.projectDir, 'output', 'final_output.mp4')
    const partial = path.join(f21.projectDir, 'output', 'final_output.partial.mp4')
    const ac = new AbortController()
    const seen: Array<[string, boolean]> = []
    let err: unknown
    try {
      await renderVideo({
        ...baseParams(f21, { transitionSettings: undefined }),
        signal: ac.signal,
        getCancelReason: () => 'user-cancelled',
        onProgress: (p) => {
          if (/^(Running postflight|Finalizing)/.test(p.stage)) seen.push([p.stage, fs.existsSync(out)])
          if (p.stage.startsWith('Finalizing')) ac.abort()
        }
      })
    } catch (e) {
      err = e
    }
    assert.ok(err, 'render should be aborted')
    assert.ok(seen.length >= 1)
    assert.ok(seen.every(([, exists]) => !exists), 'final output must not exist before validation')
    assert.ok(!fs.existsSync(out), 'no final output after abort')
    assert.ok(!fs.existsSync(partial), 'no partial output after abort')
  })

  await it('21. project without any .cache (legacy) renders normally and creates the cache', async () => {
    const legacy = fixture('f21b-legacy-fresh', { scenes: 4, sceneDuration: 8 })
    assert.ok(!fs.existsSync(getRenderCacheRoot(legacy.projectDir)))
    const r = await renderFull(baseParams(legacy, { transitionSettings: undefined }))
    assert.ok(fs.existsSync(r.outputPath))
    assert.ok(fs.existsSync(path.join(getRenderCacheRoot(legacy.projectDir), 'active-render.json')))
    assert.strictEqual(r.cache?.renderedScenes, 4)
    assert.strictEqual(r.cache?.resourceProfile, 'balanced')
    assert.strictEqual(r.cache?.encoder, SW_KEY)
    // f21 (aborted while finalizing) completes from its cache
    const r2 = await renderFull(baseParams(f21, { transitionSettings: undefined }))
    assert.strictEqual(r2.cache?.reusedScenes, 4)
    assert.ok(fs.existsSync(r2.outputPath))
  })

  await it('23. thumbnail auto-trigger fires once per rendered output (idempotent)', async () => {
    const dir = path.join(ROOT, 'thumb')
    fs.mkdirSync(path.join(dir, 'output'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'script.txt'), 'Script text.')
    const out = path.join(dir, 'output', 'final_output.mp4')
    fs.copyFileSync(path.join(f21.projectDir, 'output', 'final_output.mp4'), out)
    await saveProjectThumbnailSettings(dir, {
      enabled: true, autoGenerateAfterRender: true, selectedTemplateId: 't', templateSnapshot: 'T {{SCRIPT}}',
      templateSnapshotHash: 'h', variantCount: 5, outputLanguage: 'en-US', provider: 'google-flow', imageModel: 'GEM_PIX_2', outputQuality: '4k'
    })
    const trigger = new ThumbnailAutoTrigger()
    // pipeline + IPC both completing the same (attached) render
    const results = await Promise.all([
      trigger.startIfEligible({ projectDir: dir, renderOutputPath: out }),
      trigger.startIfEligible({ projectDir: dir, renderOutputPath: out })
    ])
    assert.strictEqual(results.filter(Boolean).length, 1)
    assert.strictEqual(await trigger.startIfEligible({ projectDir: dir, renderOutputPath: out }), false)
  })

  await it('24. cache deletion refuses path traversal and symlink escapes', () => {
    const proj = path.join(ROOT, 'safety')
    const root = getRenderCacheRoot(proj)
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true })
    const outside = path.join(ROOT, 'safety-outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep')
    fs.writeFileSync(path.join(proj, 'source.mp4'), 'keep')
    assert.strictEqual(isInsideCacheRoot(proj, path.join(root, 'ws', 'a.mp4')), true)
    assert.strictEqual(isInsideCacheRoot(proj, root), false)
    assert.strictEqual(isInsideCacheRoot(proj, path.join(root, '..', '..', 'source.mp4')), false)
    assert.strictEqual(isInsideCacheRoot(proj, path.join(root, 'ws', '..', '..', '..', 'source.mp4')), false)
    fs.symlinkSync(outside, path.join(root, 'evil'))
    assert.strictEqual(isInsideCacheRoot(proj, path.join(root, 'evil', 'precious.txt')), false)
    assert.throws(() => safeRemoveCachePath(proj, path.join(root, 'evil', 'precious.txt')))
    assert.throws(() => safeRemoveCachePath(proj, path.join(proj, 'source.mp4')))
    assert.ok(fs.existsSync(path.join(outside, 'precious.txt')))
    assert.ok(fs.existsSync(path.join(proj, 'source.mp4')))
  })

  // ── Fallbacks ────────────────────────────────────────────────────────────
  const f25 = fixture('f25-fallback', { scenes: 5, sceneDuration: 6 })

  await it('25. transition assembler failure falls back to legacy concat with exact duration', async () => {
    let called = 0
    setTransitionAssemblerForTests((async () => { called++; throw new Error('xfade graph exploded') }) as never)
    const stages: string[] = []
    const r = await renderFull(baseParams(f25), stages)
    assert.strictEqual(called, 1)
    assert.ok(stages.some((s) => s.startsWith('Transitions failed')))
    assert.ok(Math.abs(r.durationSecs - 30) < 0.6, `duration ${r.durationSecs}`)
  })

  await it('26. Balanced profile limits for 4/8/10/12 logical CPUs', () => {
    const exp: Record<number, [number, number, number]> = { 4: [2, 1, 1], 8: [4, 2, 2], 10: [4, 3, 2], 12: [4, 3, 2] }
    for (const [n, [ff, filt, rem]] of Object.entries(exp)) {
      const l = computeResourceLimits('balanced', Number(n), 16 * 1024 ** 3)
      assert.deepStrictEqual([l.ffmpegThreads, l.ffmpegFilterThreads, l.remotionConcurrency], [ff, filt, rem], `cpus=${n}`)
    }
    assert.strictEqual(computeResourceLimits(undefined, 8).profile, 'balanced')
    assert.strictEqual(computeResourceLimits('low-power', 8).remotionConcurrency, 1)
    assert.ok(computeResourceLimits('fast', 8).ffmpegThreads >= computeResourceLimits('balanced', 8).ffmpegThreads)
  })

  await it('27. hardware encoder failure retries with Software H.264; unavailable VT resolves to software', async () => {
    clearRenderCache(f25.projectDir)
    let n = 0
    setTransitionAssemblerForTests((async () => {
      n++
      if (n === 1) throw new HardwareEncoderError('VideoToolbox encode failed: test')
      return false
    }) as never)
    const r = await renderFull(baseParams(f25))
    assert.strictEqual(n, 2)
    assert.ok(fs.existsSync(r.outputPath))
    assert.ok(r.cache?.warnings.some((w) => w.includes('Hardware encoder failed')), JSON.stringify(r.cache?.warnings))

    resetVideoToolboxProbeForTests()
    setFfmpegBinaryForTests(path.join(ROOT, 'no-such-ffmpeg'))
    const warnings: string[] = []
    const enc = await resolveEncoder('videotoolbox-h264', { width: W, height: H, fps: FPS }, warnings)
    assert.strictEqual(enc.mode, 'software-h264')
    assert.ok(warnings.some((w) => w.includes('VideoToolbox unavailable')))
    resetVideoToolboxProbeForTests()
    assert.strictEqual((await resolveEncoder('software-h264', { width: W, height: H, fps: FPS }, [])).mode, 'software-h264')
  })

  await it('28. media shorter than its scene only warns (legacy parity) and the clip is still reusable', async () => {
    const fx = fixture('f28-short-media', { scenes: 4, sceneDuration: 8 })
    ffmpegSync(['-f', 'lavfi', '-i', `smptebars=size=${W}x${H}:rate=${FPS}:duration=6`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(fx.mediaDir, 'clip-b.mp4')])
    const r = await renderFull(baseParams(fx, { transitionSettings: undefined }))
    assert.ok(fs.existsSync(r.outputPath))
    const r2 = await renderFull(baseParams(fx, { transitionSettings: undefined }))
    assert.strictEqual(r2.cache?.renderedScenes, 0)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
