/**
 * Remotion & Render Performance Benchmark Harness
 * Measures wall-clock render time, peak process-tree RSS, overlay block times,
 * and cache reuse across cold, warm, and partially-invalidated renders.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { createRenderFixture, type RenderFixture } from '../helpers/render-fixture'
import { renderVideo, setOverlayRendererForTests, setTransitionAssemblerForTests, type RenderVideoParams } from '../../src/main/renderer'
import { renderCaptionsOverlay } from '../../src/main/captions/remotion-renderer'
import { setRenderPreferencesPathForTests } from '../../src/main/render-cache/render-preferences'
import type { RenderTransitionSettings, CaptionPlan, CaptionPhrase } from '../../shared/types'
import type { ProofVisual } from '../../src/main/retention/retention-types'
import type { VisualGrammarDecision } from '../../shared/types'

export interface BenchmarkMetrics {
  scenarioName: string
  durationSecs: number
  totalFrames: number
  fps: number
  resolution: { width: number; height: number }
  wallClockMs: number
  peakRssMb: number
  overlayBlocksTotal: number
  overlayBlocksReused: number
  overlayBlocksRendered: number
  outputFilePath: string
  outputFileSizeKb: number
  success: boolean
}

export function sampleProcessTreeRss(rootPid = process.pid): number {
  let totalBytes = process.memoryUsage().rss
  try {
    const out = spawnSync('pgrep', ['-P', String(rootPid)], { encoding: 'utf-8' })
    if (out.status === 0 && out.stdout) {
      const pids = out.stdout.trim().split(/\s+/).filter(Boolean)
      if (pids.length > 0) {
        const psOut = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf-8' })
        if (psOut.status === 0 && psOut.stdout) {
          const lines = psOut.stdout.trim().split(/\s+/).filter(Boolean)
          for (const l of lines) {
            const kb = parseInt(l, 10)
            if (!isNaN(kb)) totalBytes += kb * 1024
          }
        }
      }
    }
  } catch {
    // fallback
  }
  return totalBytes
}

class RssSampler {
  private timer: NodeJS.Timeout | null = null
  private maxBytes = 0

  start(intervalMs = 300): void {
    this.maxBytes = sampleProcessTreeRss()
    this.timer = setInterval(() => {
      const current = sampleProcessTreeRss()
      if (current > this.maxBytes) this.maxBytes = current
    }, intervalMs)
  }

  stop(): number {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const final = sampleProcessTreeRss()
    if (final > this.maxBytes) this.maxBytes = final
    return Math.round(this.maxBytes / (1024 * 1024))
  }
}

export function buildRichCaptionPlan(totalDuration: number): CaptionPlan {
  const phrases: CaptionPhrase[] = []
  let k = 0
  for (let t = 1.0; t + 2.5 < totalDuration; t += 3.5) {
    phrases.push({
      id: `phrase_${k}`,
      sceneId: `scene_${Math.floor(t / 6) + 1}`,
      text: `EDITORIAL CAPTION SEGMENT ${k}: CRUCIAL HISTORICAL EVIDENCE`,
      startTime: Number(t.toFixed(3)),
      endTime: Number((t + 2.5).toFixed(3)),
      emphasisType: k % 3 === 0 ? 'hook' : (k % 3 === 1 ? 'shock_stat' : 'normal'),
      presetType: k % 3 === 0 ? 'big_statement' : (k % 3 === 1 ? 'data_note' : 'big_statement'),
      highlightWords: ['CRUCIAL', 'HISTORICAL'],
      style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
    })
    k++
  }
  return {
    enabled: true,
    activeRanges: [{ startTime: 0, endTime: totalDuration, reason: 'normal' }],
    phrases
  }
}

export function buildRichProofVisuals(totalDuration: number): ProofVisual[] {
  const visuals: ProofVisual[] = []
  let idx = 0
  for (let t = 2.0; t + 4.0 < totalDuration; t += 12.0) {
    visuals.push({
      type: 'stat_emphasis',
      primaryText: `${40 + (idx * 5)}% INCREASE`,
      secondaryText: 'Documented archival records verify output growth',
      sourceSnippet: 'Annual agricultural report',
      position: 'bottom_left',
      confidence: 0.95,
      absoluteStartTime: Number(t.toFixed(3)),
      absoluteEndTime: Number((t + 3.5).toFixed(3)),
      animation: 'slide_fade'
    })
    idx++
  }
  return visuals
}

export function buildRichVisualGrammar(totalDuration: number): VisualGrammarDecision[] {
  const decisions: VisualGrammarDecision[] = []
  let idx = 0
  for (let t = 7.0; t + 4.0 < totalDuration; t += 15.0) {
    decisions.push({
      sceneIndex: idx + 1,
      sceneId: `scene_${idx + 1}`,
      enabled: true,
      type: 'stat_card',
      layout: 'stat_card',
      headline: `RECORD ${idx + 1}`,
      supportingText: 'Verified colony ledger entry confirms operational efficiency',
      duration: 3.5,
      position: 'bottom_right',
      confidence: 0.9,
      ruleName: 'rule_stat_emphasis',
      reason: 'Key narrative moment',
      absoluteStartTime: Number(t.toFixed(3)),
      absoluteEndTime: Number((t + 3.5).toFixed(3))
    } as any)
    idx++
  }
  return decisions
}

export async function runBenchmarkScenario(params: {
  scenarioName: string
  projectDir: string
  durationSecs: number
  scenesCount: number
  width: number
  height: number
  fps: number
  useRealRemotion: boolean
  warmRun?: boolean
  modifyCaptionBlockIndex?: number // if set, modifies a caption in that block for partial test
}): Promise<BenchmarkMetrics> {
  const { scenarioName, projectDir, durationSecs, scenesCount, width, height, fps, useRealRemotion } = params

  if (useRealRemotion) {
    // Reset to real Remotion renderer
    setOverlayRendererForTests(null)
  }

  const sceneDur = durationSecs / scenesCount
  let fx: RenderFixture
  if (params.warmRun && fs.existsSync(path.join(projectDir, 'assets', 'voiceover.m4a'))) {
    fx = {
      projectDir,
      voiceoverPath: path.join(projectDir, 'assets', 'voiceover.m4a'),
      totalDuration: durationSecs,
      mediaDir: path.join(projectDir, 'assets', 'media'),
      planPath: path.join(projectDir, 'analysis', 'master-edit-plan.json')
    }
  } else {
    fx = createRenderFixture(projectDir, {
      scenes: scenesCount,
      sceneDuration: sceneDur,
      width,
      height,
      fps,
      withMusic: true,
      withSfx: true,
      withNarrative: true
    })
  }

  const captionPlan = buildRichCaptionPlan(durationSecs)
  const proofVisuals = buildRichProofVisuals(durationSecs)
  const visualGrammar = buildRichVisualGrammar(durationSecs)

  // Save analysis files
  fs.writeFileSync(path.join(projectDir, 'analysis', 'caption-plan.json'), JSON.stringify(captionPlan, null, 2))
  fs.writeFileSync(path.join(projectDir, 'analysis', 'proof-visuals.json'), JSON.stringify(proofVisuals, null, 2))
  fs.writeFileSync(path.join(projectDir, 'analysis', 'visual-grammar.json'), JSON.stringify(visualGrammar, null, 2))

  const transitions: RenderTransitionSettings = {
    enabled: true,
    mode: 'smart',
    defaultDuration: 0.4,
    chapterDuration: 0.6
  }

  const renderParams: RenderVideoParams = {
    projectDir,
    voiceoverPath: fx.voiceoverPath,
    resolution: { width, height },
    fps,
    captionPlan,
    transitionSettings: transitions
  }

  const sampler = new RssSampler()
  sampler.start(250)
  const t0 = Date.now()

  let res = await renderVideo(renderParams)
  let wallClockMs = Date.now() - t0
  let peakRssMb = sampler.stop()

  // Inspect manifest for block statistics
  let overlayBlocksTotal = 0
  let overlayBlocksReused = 0
  let overlayBlocksRendered = 0
  const cacheRoot = path.join(projectDir, '.render-cache-v2')
  let wsManifest: any = null
  if (fs.existsSync(cacheRoot)) {
    const subs = fs.readdirSync(cacheRoot).filter(d => fs.statSync(path.join(cacheRoot, d)).isDirectory())
    for (const sub of subs) {
      const mp = path.join(cacheRoot, sub, 'manifest.json')
      if (fs.existsSync(mp)) {
        try {
          wsManifest = JSON.parse(fs.readFileSync(mp, 'utf-8'))
          break
        } catch { /* ignore */ }
      }
    }
  }

  if (wsManifest && Array.isArray(wsManifest.overlayBlocks)) {
    overlayBlocksTotal = wsManifest.overlayBlocks.length
    overlayBlocksReused = wsManifest.overlayBlocks.filter((b: any) => b.reused).length
    overlayBlocksRendered = overlayBlocksTotal - overlayBlocksReused
  }

  const stat = fs.existsSync(res.outputPath) ? fs.statSync(res.outputPath) : null

  return {
    scenarioName,
    durationSecs,
    totalFrames: Math.ceil(durationSecs * fps),
    fps,
    resolution: { width, height },
    wallClockMs,
    peakRssMb,
    overlayBlocksTotal,
    overlayBlocksReused,
    overlayBlocksRendered,
    outputFilePath: res.outputPath,
    outputFileSizeKb: stat ? Math.round(stat.size / 1024) : 0,
    success: !!stat && stat.size > 0
  }
}

async function main(): Promise<void> {
  console.log('=== Remotion & Render Performance Benchmark ===')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotion-perf-bench-'))
  const outputPath = process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : path.join(__dirname, 'artifacts', 'baseline.json')

  const results: BenchmarkMetrics[] = []

  try {
    // 1. Scenario: 30s Cold Render (640x360 @ 30fps) with full rich overlays
    console.log('\n[1/3] Running 30s Video Benchmark (Cold)...')
    const p30 = path.join(root, 'bench-30s')
    const m30 = await runBenchmarkScenario({
      scenarioName: '30s_video_cold',
      projectDir: p30,
      durationSecs: 30,
      scenesCount: 5,
      width: 640,
      height: 360,
      fps: 30,
      useRealRemotion: true
    })
    console.log(`    WallClock: ${m30.wallClockMs}ms | Peak RSS: ${m30.peakRssMb}MB | Blocks: ${m30.overlayBlocksRendered} rendered, ${m30.overlayBlocksReused} reused`)
    results.push(m30)

    // 2. Scenario: 30s Warm Render (Cache hit test)
    console.log('\n[2/3] Running 30s Video Benchmark (Warm / Cache Re-hit)...')
    const m30Warm = await runBenchmarkScenario({
      scenarioName: '30s_video_warm',
      projectDir: p30,
      durationSecs: 30,
      scenesCount: 5,
      width: 640,
      height: 360,
      fps: 30,
      useRealRemotion: true,
      warmRun: true
    })
    console.log(`    WallClock: ${m30Warm.wallClockMs}ms | Peak RSS: ${m30Warm.peakRssMb}MB | Blocks: ${m30Warm.overlayBlocksRendered} rendered, ${m30Warm.overlayBlocksReused} reused`)
    results.push(m30Warm)

    // 3. Scenario: 120s Multi-block Video (2 blocks)
    console.log('\n[3/3] Running 120s Multi-Block Video Benchmark (Cold)...')
    const p120 = path.join(root, 'bench-120s')
    const m120 = await runBenchmarkScenario({
      scenarioName: '120s_video_multiblock',
      projectDir: p120,
      durationSecs: 120,
      scenesCount: 20,
      width: 640,
      height: 360,
      fps: 30,
      useRealRemotion: true
    })
    console.log(`    WallClock: ${m120.wallClockMs}ms | Peak RSS: ${m120.peakRssMb}MB | Blocks: ${m120.overlayBlocksRendered} rendered, ${m120.overlayBlocksReused} reused`)
    results.push(m120)

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2), 'utf-8')
    console.log(`\nBenchmark results written to: ${outputPath}`)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

if (require.main === module || process.argv[1]?.includes('remotion-render-benchmark')) {
  main().catch((err) => {
    console.error('Benchmark failed:', err)
    process.exit(1)
  })
}
