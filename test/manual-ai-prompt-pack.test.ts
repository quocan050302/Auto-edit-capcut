/**
 * Manual AI (Prompt mode) — prompt pack tests.
 * Covers: exact ownership counts, one-line prompts, TXT format, real scene numbers,
 * count guard, determinism / resume, Health vs General intelligence, prompt hashes.
 */
import * as fs from 'fs'
import * as path from 'path'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import {
  assertManualAiPromptPack,
  buildManualAiPromptPack,
  ensureManualAiPromptPack,
  formatManualAiPromptText,
  loadManualAiPromptPack,
  readManualAiPromptText,
  sanitizePromptLine
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { getManualAiPromptJsonPath, getManualAiPromptTxtPath } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import type { VisualMixProfile } from '../shared/types'
import { assert, cleanupFixtures, createRunner, makeProject, mixOf, readJson, rewriteNarration } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Prompt Pack Tests')

function planFor(dir: string, ai: number, stock: number, profile: VisualMixProfile) {
  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
  return VisualMixPlanner.buildPlan({
    projectDir: dir,
    rawScenes,
    config: mixOf(ai, stock, 'prompt'),
    profile,
    globalContext: undefined
  })
}

async function main(): Promise<void> {
  console.log('\nManual AI prompt pack')

  await it('85/15 over 100 scenes -> exactly 85 AI prompts, no Stock scene, sorted ascending', () => {
    const dir = makeProject(100)
    const plan = planFor(dir, 0.85, 0.15, 'general')
    const aiIdx = plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex)
    const stockIdx = plan.scenes.filter((s) => s.strategy === 'stock').map((s) => s.sceneIndex)
    assert.strictEqual(aiIdx.length, 85)
    assert.strictEqual(stockIdx.length, 15)
    assert.strictEqual(plan.targetAiScenes, 85)
    assert.strictEqual(plan.targetStockScenes, 15)

    const pack = buildManualAiPromptPack({ plan, profile: 'general', outputResolution: '1080p' })
    assert.strictEqual(pack.scenes.length, 85)
    assert.strictEqual(pack.expectedAiImages, 85)
    assert.strictEqual(pack.totalProjectScenes, 100)
    const packIdx = pack.scenes.map((s) => s.sceneIndex)
    assert.deepStrictEqual(packIdx, [...aiIdx].sort((a, b) => a - b), 'ascending, exact AI set')
    for (const s of stockIdx) assert.ok(!packIdx.includes(s), `stock scene ${s} must not have a prompt`)
    assert.strictEqual(new Set(packIdx).size, 85, 'no duplicates')
    assertManualAiPromptPack(pack, plan)
  })

  await it('100/0 -> 100 prompts', () => {
    const dir = makeProject(100)
    const plan = planFor(dir, 1, 0, 'general')
    const pack = buildManualAiPromptPack({ plan, profile: 'general', outputResolution: '1080p' })
    assert.strictEqual(pack.scenes.length, 100)
  })

  await it('TXT format: SCENE NNN | prompt, one blank line between, real scene numbers', () => {
    const pack = {
      scenes: [
        { sceneIndex: 7, prompt: 'prompt7 line' },
        { sceneIndex: 1, prompt: 'prompt1 line' },
        { sceneIndex: 4, prompt: 'prompt4\nwith\r\nnewlines   and   spaces' }
      ]
    } as unknown as Parameters<typeof formatManualAiPromptText>[0]
    const txt = formatManualAiPromptText(pack)
    assert.strictEqual(
      txt,
      'SCENE 001 | prompt1 line\n\nSCENE 004 | prompt4 with newlines and spaces\n\nSCENE 007 | prompt7 line'
    )
    const lines = txt.split('\n')
    assert.strictEqual(lines.filter((l) => l.startsWith('SCENE ')).length, 3, '3 prompt lines')
    assert.strictEqual(lines.filter((l) => l === '').length, 2, '2 blank separator lines')
    assert.ok(!/```/.test(txt), 'no markdown fences')
  })

  await it('sanitizePromptLine removes CR/LF/U+2028 and collapses whitespace', () => {
    const s = sanitizePromptLine('a\r\nb\u2028c \t d')
    assert.strictEqual(s, 'a b c d')
    assert.ok(!/[\r\n]/.test(s))
  })

  await it('uses REAL sceneIndex numbers (not renumbered) in TXT and JSON', () => {
    const dir = makeProject(10)
    const plan = planFor(dir, 0.5, 0.5, 'general')
    const aiIdx = plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex).sort((a, b) => a - b)
    const { pack } = ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
    const txt = fs.readFileSync(getManualAiPromptTxtPath(dir), 'utf-8')
    const labels = txt.split('\n').filter((l) => l.startsWith('SCENE ')).map((l) => Number(l.slice(6, 9)))
    assert.deepStrictEqual(labels, aiIdx)
    assert.deepStrictEqual(pack.scenes.map((s) => s.sceneIndex), aiIdx)
    assert.ok(!/AI PROMPT/i.test(txt))
  })

  await it('TXT / JSON artifacts: one physical line per prompt, schema fields, expected filenames', () => {
    const dir = makeProject(40)
    const plan = planFor(dir, 0.85, 0.15, 'general')
    const { pack } = ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '2k' })
    const txt = fs.readFileSync(getManualAiPromptTxtPath(dir), 'utf-8')
    const blocks = txt.trimEnd().split('\n\n')
    assert.strictEqual(blocks.length, pack.scenes.length)
    for (const b of blocks) {
      assert.ok(!b.includes('\n'), 'prompt must be one physical line')
      assert.ok(/^SCENE \d{3} \| .{40,}$/.test(b), `bad block: ${b.slice(0, 60)}`)
    }
    const json = readJson(getManualAiPromptJsonPath(dir))
    assert.strictEqual(json.schemaVersion, 1)
    assert.strictEqual(json.imageMode, 'prompt')
    assert.strictEqual(json.profile, 'general')
    assert.strictEqual(json.outputResolution, '2k')
    assert.strictEqual(json.totalProjectScenes, 40)
    assert.strictEqual(json.expectedAiImages, pack.scenes.length)
    const first = json.scenes[0]
    assert.strictEqual(first.status, 'waiting-image')
    assert.ok(/^S\d{4}\.png$/.test(first.expectedFilename))
    assert.strictEqual(first.expectedFilename, `S${String(first.sceneIndex).padStart(4, '0')}.png`)
    assert.ok(/^[0-9a-f]{64}$/.test(first.promptHash), 'promptHash present')
    assert.strictEqual(readManualAiPromptText(dir), formatManualAiPromptText(pack))
  })

  await it('prompts are detailed (~80-180 words), scene specific and contain no text/watermark directives missing', () => {
    const dir = makeProject(12)
    const plan = planFor(dir, 1, 0, 'general')
    const pack = buildManualAiPromptPack({ plan, profile: 'general', outputResolution: '1080p' })
    for (const e of pack.scenes) {
      const words = e.prompt.split(/\s+/).filter(Boolean).length
      assert.ok(words >= 60 && words <= 220, `scene ${e.sceneIndex}: ${words} words`)
      assert.ok(/16:9/.test(e.prompt), 'mentions 16:9')
      assert.ok(/no (on-screen )?text|no text/i.test(e.prompt), 'forbids text')
      assert.ok(/watermark/i.test(e.prompt) && /logo/i.test(e.prompt), 'forbids watermark/logo')
      assert.ok(!e.prompt.includes('\n'))
    }
    const scene2 = pack.scenes.find((e) => e.sceneIndex === 2)!
    assert.ok(/roman|legion/i.test(scene2.prompt), 'prompt grounded in the narration')
  })

  await it('Health profile uses medical documentary rules; General does not', () => {
    const dirH = makeProject(6, { health: true })
    const planH = planFor(dirH, 1, 0, 'health')
    const health = buildManualAiPromptPack({ plan: planH, profile: 'health', outputResolution: '1080p' })
    for (const e of health.scenes) {
      assert.ok(/anatom|medical|scientific/i.test(e.prompt), `health scene ${e.sceneIndex} lacks medical grounding`)
      assert.ok(/no (fake|invented)|no medical text|no diagnostic|no labels/i.test(e.prompt), 'health safety rules')
    }
    const dirG = makeProject(6)
    const planG = planFor(dirG, 1, 0, 'general')
    const general = buildManualAiPromptPack({ plan: planG, profile: 'general', outputResolution: '1080p' })
    for (const e of general.scenes) {
      assert.ok(!/anatomical accuracy|diagnostic/i.test(e.prompt), 'general prompt must not be forced to Health styling')
    }
  })

  await it('promptHash changes when narration changes; stays stable otherwise', () => {
    const dir = makeProject(8)
    const planA = planFor(dir, 1, 0, 'general')
    const a = buildManualAiPromptPack({ plan: planA, profile: 'general', outputResolution: '1080p' })
    const a2 = buildManualAiPromptPack({ plan: planA, profile: 'general', outputResolution: '1080p' })
    assert.deepStrictEqual(a.scenes.map((s) => s.promptHash), a2.scenes.map((s) => s.promptHash), 'deterministic')
    rewriteNarration(dir, 8, 'A completely different scene about a medieval castle siege at dawn.')
    const planB = planFor(dir, 1, 0, 'general')
    const b = buildManualAiPromptPack({ plan: planB, profile: 'general', outputResolution: '1080p' })
    const h = (p: typeof a, i: number): string => p.scenes.find((s) => s.sceneIndex === i)!.promptHash
    assert.notStrictEqual(h(a, 8), h(b, 8), 'scene 8 hash must change')
    assert.strictEqual(h(a, 3), h(b, 3), 'unchanged scene keeps its hash')
    const resChanged = buildManualAiPromptPack({ plan: planA, profile: 'general', outputResolution: '4k' })
    assert.notStrictEqual(h(a, 3), h(resChanged, 3), 'resolution is part of the hash')
  })

  await it('count guard throws MANUAL_AI_PROMPT_COUNT_MISMATCH (missing / duplicate / stock prompt)', () => {
    const dir = makeProject(20)
    const plan = planFor(dir, 0.5, 0.5, 'general')
    const pack = buildManualAiPromptPack({ plan, profile: 'general', outputResolution: '1080p' })
    assertManualAiPromptPack(pack, plan)

    const missing = { ...pack, scenes: pack.scenes.slice(1) }
    assert.throws(() => assertManualAiPromptPack(missing, plan), /MANUAL_AI_PROMPT_COUNT_MISMATCH/)

    const dup = { ...pack, scenes: [...pack.scenes.slice(0, -1), pack.scenes[0]] }
    assert.throws(() => assertManualAiPromptPack(dup, plan), /MANUAL_AI_PROMPT_COUNT_MISMATCH/)

    const stockIdx = plan.scenes.find((s) => s.strategy === 'stock')!.sceneIndex
    const withStock = { ...pack, scenes: [...pack.scenes.slice(0, -1), { ...pack.scenes[0], sceneIndex: stockIdx }] }
    assert.throws(() => assertManualAiPromptPack(withStock, plan), /MANUAL_AI_PROMPT_COUNT_MISMATCH/)
  })

  await it('ensure() persists the first pack and REUSES it on restart (no regeneration, no rewrite)', () => {
    const dir = makeProject(30)
    const plan = planFor(dir, 0.8, 0.2, 'general')
    const first = ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
    assert.strictEqual(first.reused, false)
    const txtPath = getManualAiPromptTxtPath(dir)
    const before = fs.readFileSync(txtPath, 'utf-8')
    const mtime = fs.statSync(txtPath).mtimeMs
    const second = ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
    assert.strictEqual(second.reused, true)
    assert.strictEqual(fs.readFileSync(txtPath, 'utf-8'), before)
    assert.strictEqual(fs.statSync(txtPath).mtimeMs, mtime, 'file must not be rewritten')
    assert.strictEqual(loadManualAiPromptPack(dir)!.generatedAt, first.pack.generatedAt)
  })

  await it('ratio change 85 -> 70 regenerates the pack for the new AI set only', () => {
    const dir = makeProject(100)
    const plan85 = planFor(dir, 0.85, 0.15, 'general')
    ensureManualAiPromptPack({ projectDir: dir, plan: plan85, profile: 'general', outputResolution: '1080p' })
    const plan70 = planFor(dir, 0.7, 0.3, 'general')
    const { pack } = ensureManualAiPromptPack({ projectDir: dir, plan: plan70, profile: 'general', outputResolution: '1080p' })
    assert.strictEqual(pack.scenes.length, 70)
    assertManualAiPromptPack(pack, plan70)
    assert.strictEqual(readJson(getManualAiPromptJsonPath(dir)).scenes.length, 70)
  })

  cleanupFixtures()
  finish()
}

void main()
