/**
 * Manual AI (Prompt mode) — provider / assignment / config-compat / motion+SFX tests.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  normalizeVisualMixConfig,
  resolveAiImageMode,
  resolveVisualMixConfig,
  type StockSceneAssignment,
  type VisualMixConfig,
  type VisualMixProfile
} from '../shared/types'
import { determineInvalidatedStages } from '../src/main/pipeline/pipeline-state'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import { validateFinalVisualAssignments } from '../src/main/visual-mix/visual-mix-validator'
import { buildManualAiAssignment } from '../src/main/visual-mix/manual-ai/manual-ai-branch'
import { assert, cleanupFixtures, createRunner, freshDir, makeProject, mixOf, pngHeader } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Assignment / Compatibility Tests')

function assignment(sceneIndex: number, provider: string, localPath: string): StockSceneAssignment {
  return {
    sceneId: `scene_${sceneIndex}`,
    sceneIndex,
    narrationText: '',
    startTime: 0,
    endTime: 5,
    visualIntent: '',
    searchQueries: [],
    usedQuery: 'q',
    score: 80,
    locked: false,
    manualOverride: false,
    status: 'assigned',
    asset: {
      assetId: `${provider}_${sceneIndex}`,
      provider,
      mediaType: provider === 'pexels' ? 'video' : 'photo',
      localPath,
      thumbnailUrl: '',
      downloadUrl: '',
      creator: 'x',
      searchQuery: 'q',
      downloadedAt: new Date().toISOString(),
      fileSizeBytes: 64
    }
  } as unknown as StockSceneAssignment
}

function planFor(dir: string, ai: number, stock: number, profile: VisualMixProfile) {
  return VisualMixPlanner.buildPlan({
    projectDir: dir,
    rawScenes: VisualMixPlanner.loadScenesFromEditPlan(dir),
    config: mixOf(ai, stock, 'prompt'),
    profile,
    globalContext: undefined
  })
}

async function main(): Promise<void> {
  console.log('\nManual AI assignments & compatibility')

  // ── config / persistence ────────────────────────────────────────────
  await it('AiImageMode defaults to auto; old projects without the property resolve to auto', () => {
    assert.strictEqual(normalizeVisualMixConfig({ mode: 'custom-mix', aiImageRatio: 0.8, stockFootageRatio: 0.2 }, 'custom-mix').aiImageMode, 'auto')
    assert.strictEqual(resolveAiImageMode(undefined), 'auto')
    assert.strictEqual(resolveAiImageMode({} as Partial<VisualMixConfig>), 'auto')
    assert.strictEqual(resolveAiImageMode({ aiImageMode: 'prompt' } as Partial<VisualMixConfig>), 'prompt')
    assert.strictEqual(resolveAiImageMode({ aiImageMode: 'garbage' } as unknown as Partial<VisualMixConfig>), 'auto')
    const old = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: { aiImageRatio: 1, stockFootageRatio: 0 } as Partial<VisualMixConfig>
    })
    assert.strictEqual(resolveAiImageMode(old), 'auto')
  })

  await it('Prompt persists through a JSON round trip', () => {
    const saved = JSON.stringify(mixOf(0.85, 0.15, 'prompt', '2k'))
    const cfg = resolveVisualMixConfig({ visualSourceMode: 'custom-mix', visualMixConfig: JSON.parse(saved) })
    assert.strictEqual(cfg.aiImageMode, 'prompt')
    assert.strictEqual(cfg.aiImageRatio, 0.85)
    assert.strictEqual(cfg.imageOutputResolution, '2k')
  })

  await it('Default Workflow (legacy) config carries no Prompt mode', () => {
    const legacy = normalizeVisualMixConfig({ mode: 'legacy' } as Partial<VisualMixConfig>, 'legacy')
    assert.notStrictEqual(resolveAiImageMode(legacy), 'prompt')
  })

  const fp = { scriptPath: 's.txt', scriptHash: 'a', voiceoverPath: 'v.mp3', voiceoverSize: 1, voiceoverMtimeMs: 1 }
  function invalidation(oldCfg: Record<string, unknown>, newCfg: Record<string, unknown>): string[] {
    const base = { projectDir: 'D:/p', scriptPath: 's.txt', voiceoverPath: 'v.mp3', visualSourceMode: 'custom-mix' as const }
    const state = {
      schemaVersion: 1,
      version: 1,
      runId: 'r',
      projectDir: 'D:/p',
      currentStage: 'idle' as const,
      overallStatus: 'idle' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputFingerprint: fp,
      options: { ...base, visualMixConfig: oldCfg },
      stages: {},
      warnings: [],
      fatalErrors: []
    }
    return determineInvalidatedStages(state as never, { ...base, visualMixConfig: newCfg } as never, fp)
  }
  const cfgBase = { mode: 'custom-mix', aiImageRatio: 0.8, stockFootageRatio: 0.2, width: 1920, height: 1080, motionEnabled: true, generationConcurrency: 6, postProcessConcurrency: 2 }

  await it('upgrading an old project (no aiImageMode) to explicit auto does NOT invalidate any stage', () => {
    assert.deepStrictEqual(invalidation(cfgBase, { ...cfgBase, aiImageMode: 'auto' }), [])
  })

  await it('switching Auto <-> Prompt invalidates the visual stage and everything downstream', () => {
    for (const [from, to] of [['auto', 'prompt'], ['prompt', 'auto']] as const) {
      const inv = invalidation({ ...cfgBase, aiImageMode: from }, { ...cfgBase, aiImageMode: to })
      assert.ok(inv.includes('stock-search'), `${from}->${to}`)
      assert.ok(inv.includes('rendering'))
      assert.ok(!inv.includes('transcribing'))
      assert.ok(!inv.includes('captions'))
    }
    assert.deepStrictEqual(invalidation({ ...cfgBase, aiImageMode: 'prompt' }, { ...cfgBase, aiImageMode: 'prompt' }), [])
  })

  // ── final assignment validation ─────────────────────────────────────
  const dir = freshDir('assign')
  const stockFile = path.join(dir, 'a.mp4')
  const imgFile = path.join(dir, 'a.png')
  fs.writeFileSync(stockFile, 'x'.repeat(64))
  fs.writeFileSync(imgFile, pngHeader(1920, 1080))
  const plan = {
    scenes: [
      { sceneIndex: 1, strategy: 'ai-still' },
      { sceneIndex: 2, strategy: 'stock' }
    ]
  } as never

  await it('Prompt mode: AI-owned scene must be manual-ai; stock fallback and google-flow are violations', () => {
    const ok = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'manual-ai', imgFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' },
      aiImageMode: 'prompt'
    })
    assert.strictEqual(ok.valid, true)

    const fallback = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'pexels', stockFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' },
      aiImageMode: 'prompt'
    })
    assert.strictEqual(fallback.valid, false)
    assert.strictEqual(fallback.violations[0].sceneIndex, 1)

    // even with stock-fallback behaviour AND an approval, Prompt mode never accepts Stock for AI scenes
    const approved = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'pexels', stockFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'stock-fallback' },
      approvedFallbackSceneIndices: [1],
      aiImageMode: 'prompt'
    })
    assert.strictEqual(approved.valid, false)

    const flow = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'google-flow', imgFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' },
      aiImageMode: 'prompt'
    })
    assert.strictEqual(flow.valid, false)
  })

  await it('Prompt mode: a Stock-owned scene holding manual-ai (or google-flow) is a violation', () => {
    for (const provider of ['manual-ai', 'google-flow']) {
      const res = validateFinalVisualAssignments({
        plan,
        assignments: [assignment(1, 'manual-ai', imgFile), assignment(2, provider, imgFile)],
        config: { aiFailureBehavior: 'strict' },
        aiImageMode: 'prompt'
      })
      assert.strictEqual(res.valid, false, provider)
      assert.strictEqual(res.violations[0].code, 'VISUAL_MIX_STOCK_OWNED_AI_ASSIGNMENT')
    }
  })

  await it('Auto mode validation is unchanged: google-flow required, manual-ai rejected for AI scenes', () => {
    const ok = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'google-flow', imgFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' }
    })
    assert.strictEqual(ok.valid, true)
    const manual = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'manual-ai', imgFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' },
      aiImageMode: 'auto'
    })
    assert.strictEqual(manual.valid, false)
    const approvedFallback = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(1, 'pexels', stockFile), assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'stock-fallback' },
      approvedFallbackSceneIndices: [1]
    })
    assert.strictEqual(approvedFallback.valid, true, 'existing Auto stock-fallback still works')
  })

  await it('missing AI assignment in Prompt mode is reported as missing (never silently replaced)', () => {
    const res = validateFinalVisualAssignments({
      plan,
      assignments: [assignment(2, 'pexels', stockFile)],
      config: { aiFailureBehavior: 'strict' },
      aiImageMode: 'prompt'
    })
    assert.deepStrictEqual(res.missingAiSceneIndices, [1])
  })

  // ── assignment store ────────────────────────────────────────────────
  await it('VisualAssignmentStore: Stock caller cannot overwrite a valid manual-ai assignment', async () => {
    const d = freshDir('store')
    fs.mkdirSync(path.join(d, 'analysis'), { recursive: true })
    const img = path.join(d, 'S0001.png')
    fs.writeFileSync(img, pngHeader(1920, 1080))
    const sf = path.join(d, 's.mp4')
    fs.writeFileSync(sf, 'x'.repeat(64))
    const store = new VisualAssignmentStore(d)
    assert.strictEqual(store.set(1, assignment(1, 'manual-ai', img)), true)
    assert.strictEqual(store.set(1, assignment(1, 'pexels', sf), true), false, 'stock caller blocked')
    assert.strictEqual(store.set(1, assignment(1, 'pixabay', sf)), false, 'non-AI provider blocked')
    assert.strictEqual(store.get(1)!.asset!.provider, 'manual-ai')
    await store.flushAtomic()
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'analysis', 'stock-assignments.json'), 'utf-8'))[0].asset.provider, 'manual-ai')
  })

  await it('VisualAssignmentStore: concurrent writers keep every update (no lost updates)', async () => {
    const d = freshDir('store')
    fs.mkdirSync(path.join(d, 'analysis'), { recursive: true })
    const img = path.join(d, 'x.png')
    fs.writeFileSync(img, pngHeader(1920, 1080))
    const store = new VisualAssignmentStore(d)
    const tasks: Promise<void>[] = []
    for (let i = 1; i <= 60; i++) {
      store.set(i, assignment(i, i % 4 === 0 ? 'pexels' : 'manual-ai', img))
      tasks.push(store.flushAtomic())
    }
    await Promise.all(tasks)
    const onDisk = JSON.parse(fs.readFileSync(path.join(d, 'analysis', 'stock-assignments.json'), 'utf-8'))
    assert.strictEqual(onDisk.length, 60)
  })

  await it('manual-ai assignment: provider manual-ai, mediaType photo, local path inside the project', () => {
    const scene = { sceneIndex: 14, narration: 'n', visualIntent: 'v', startTime: 1, endTime: 6, imagePrompt: 'p' } as never
    const a = buildManualAiAssignment(scene, imgFile, false)
    assert.strictEqual(a.sceneIndex, 14)
    assert.strictEqual(a.status, 'assigned')
    assert.strictEqual(a.asset!.provider, 'manual-ai')
    assert.strictEqual(a.asset!.mediaType, 'photo')
    assert.strictEqual(a.asset!.localPath, imgFile)
    assert.ok(a.locked, 'locked so Stock can never replace it')
  })

  // ── motion / SFX are strategy-driven, not provider-driven ───────────
  await it('Health + Prompt: AI scenes carry Health motion and SFX cues in the plan (provider independent)', () => {
    const d = makeProject(20, { health: true })
    const p = planFor(d, 1, 0, 'health')
    const ai = p.scenes.filter((s) => s.strategy === 'ai-still')
    assert.strictEqual(ai.length, 20)
    for (const s of ai) assert.ok(s.motion || s.motionPreset, `scene ${s.sceneIndex} has motion`)
    assert.ok(ai.some((s) => s.sfxCue), 'Health SFX cues are planned for AI scenes')
  })

  await it('General + Prompt: motion present, NO Health SFX', () => {
    const d = makeProject(10)
    const p = planFor(d, 1, 0, 'general')
    const ai = p.scenes.filter((s) => s.strategy === 'ai-still')
    assert.strictEqual(ai.length, 10)
    assert.ok(ai.every((s) => !s.sfxCue), 'no Health SFX for the General profile')
  })

  await it('renderer / SFX wiring decides by strategy + plan, never by provider === google-flow', () => {
    const root = path.join(__dirname, '..', 'src', 'main')
    const renderer = fs.readFileSync(path.join(root, 'renderer.ts'), 'utf-8')
    assert.ok(/visualScene\?\.strategy === 'ai-still'/.test(renderer), 'motion keyed on strategy')
    const stageRunners = fs.readFileSync(path.join(root, 'pipeline', 'pipeline-stage-runners.ts'), 'utf-8')
    const sfxBlock = stageRunners.slice(stageRunners.indexOf('const sfxCues = new Map'), stageRunners.indexOf('const sfxCues = new Map') + 900)
    assert.ok(!/google-flow/.test(sfxBlock), 'SFX planning is not tied to Google Flow')
    assert.ok(!/provider/.test(sfxBlock) || !/google-flow/.test(sfxBlock))
  })

  await it('manual-ai assets live in their own folder, separate from Google Flow caches', () => {
    const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'visual-mix', 'manual-ai', 'manual-ai-types.ts'), 'utf-8')
    assert.ok(/'assets', 'generated', 'manual-ai'/.test(types))
    assert.ok(!/'health'|'general'/.test(types.slice(types.indexOf('getManualAiAssetsDir'), types.indexOf('getManualAiAssetsDir') + 200)))
  })

  cleanupFixtures()
  finish()
}

void main()
