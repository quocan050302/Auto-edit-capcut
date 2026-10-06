/**
 * Manual AI (Prompt mode) — importer tests.
 * Covers: filename parsing, duplicates, wrong-scene (Stock-owned), natural-sort fallback with
 * confirmation, partial import, validation, LOW_RESOLUTION / "Use Anyway", storage + manifest,
 * and REAL ffmpeg normalization to 1080p / 2K / 4K without stretching.
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { ensureManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  commitManualAiImport,
  defaultImageNormalizer,
  parseSceneNumberFromFilename,
  planManualAiImport
} from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { getManualAiAssetsDir, getManualAiManifestPath } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { probeImageFileDimensions } from '../src/main/thumbnail/utils/image-probe'
import type { AiImageOutputResolution } from '../shared/types'
import {
  assert,
  cleanupFixtures,
  createRunner,
  fakeNormalizer,
  freshDir,
  makeExternalImage,
  makeProject,
  mixOf,
  readJson,
  sceneFileName
} from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Importer Tests')

function setup(sceneCount: number, ai: number, stock: number, res: AiImageOutputResolution = '1080p'): {
  dir: string
  aiIdx: number[]
  stockIdx: number[]
} {
  const dir = makeProject(sceneCount)
  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
  const plan = VisualMixPlanner.buildPlan({
    projectDir: dir,
    rawScenes,
    config: mixOf(ai, stock, 'prompt', res),
    profile: 'general',
    globalContext: undefined
  })
  ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: res })
  return {
    dir,
    aiIdx: plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex).sort((a, b) => a - b),
    stockIdx: plan.scenes.filter((s) => s.strategy === 'stock').map((s) => s.sceneIndex).sort((a, b) => a - b)
  }
}

async function main(): Promise<void> {
  console.log('\nManual AI importer')

  await it('parses S0007 / S7 / S001 / scene_7 / scene-007 / "scene 007" -> scene number', () => {
    for (const name of ['S0007.png', 'S7.png', 'S007.jpeg', 'scene_7.png', 'scene-007.jpg', 'scene 007.webp', 'SCENE_7.PNG']) {
      assert.strictEqual(parseSceneNumberFromFilename(name), 7, name)
    }
    assert.strictEqual(parseSceneNumberFromFilename('S0044.jpg'), 44)
    assert.strictEqual(parseSceneNumberFromFilename('image_001.png'), null)
    assert.strictEqual(parseSceneNumberFromFilename('portrait.png'), null)
    assert.strictEqual(parseSceneNumberFromFilename('S0.png'), null, 'scene 0 is invalid')
  })

  await it('duplicate scene in one batch (S0007.png + scene_7.jpg) is detected, never silently picked', () => {
    const { dir, aiIdx } = setup(20, 1, 0)
    assert.ok(aiIdx.includes(7))
    const ext = freshDir('ext')
    const a = makeExternalImage(ext, 'S0007.png')
    const b = makeExternalImage(ext, 'scene_7.jpg')
    const plan = planManualAiImport({ projectDir: dir, filePaths: [a, b] })
    assert.strictEqual(plan.mappings.length, 0)
    assert.strictEqual(plan.rejections.length, 2)
    assert.ok(plan.rejections.every((r) => r.code === 'DUPLICATE_SCENE' && r.sceneIndex === 7))
  })

  await it('Stock-owned scene (S0014.png) is rejected as NOT_AI_OWNED; Stock assignment untouched', async () => {
    const { dir, stockIdx } = setup(100, 0.85, 0.15)
    const target = stockIdx[0]
    const stockFile = path.join(dir, 'analysis', 'stock-assignments.json')
    fs.writeFileSync(stockFile, JSON.stringify([{ sceneIndex: target, asset: { provider: 'pexels' } }]), 'utf-8')
    const before = fs.readFileSync(stockFile, 'utf-8')
    const ext = freshDir('ext')
    const f = makeExternalImage(ext, sceneFileName(target))
    const plan = planManualAiImport({ projectDir: dir, filePaths: [f] })
    assert.strictEqual(plan.mappings.length, 0)
    assert.strictEqual(plan.rejections[0].code, 'NOT_AI_OWNED')
    assert.ok(/not an AI-owned scene/.test(plan.rejections[0].message))
    const res = await commitManualAiImport({
      projectDir: dir,
      mappings: [{ filePath: f, fileName: path.basename(f), sceneIndex: target, via: 'filename' }],
      normalizer: fakeNormalizer
    })
    assert.strictEqual(res.imported.length, 0)
    assert.strictEqual(res.rejections[0].code, 'NOT_AI_OWNED')
    assert.strictEqual(fs.readFileSync(stockFile, 'utf-8'), before, 'Stock assignment must not be replaced')
    assert.ok(!fs.existsSync(path.join(getManualAiAssetsDir(dir), sceneFileName(target))))
  })

  await it('unsupported types (.mp4/.gif/.bmp) are rejected; png/jpg/jpeg/webp accepted by type', () => {
    const { dir } = setup(10, 1, 0)
    const ext = freshDir('ext')
    const files = ['S0001.mp4', 'S0002.gif', 'S0003.bmp'].map((n) => {
      const p = path.join(ext, n)
      fs.writeFileSync(p, 'x')
      return p
    })
    const plan = planManualAiImport({ projectDir: dir, filePaths: files })
    assert.strictEqual(plan.mappings.length, 0)
    assert.ok(plan.rejections.every((r) => r.code === 'UNSUPPORTED_TYPE'))
    const ok = ['S0004.png', 'S0005.jpg', 'S0006.jpeg', 'S0007.webp'].map((n) => makeExternalImage(ext, n))
    const plan2 = planManualAiImport({ projectDir: dir, filePaths: ok })
    assert.deepStrictEqual(plan2.mappings.map((m) => m.sceneIndex), [4, 5, 6, 7])
  })

  await it('natural-sort fallback: only when NO file has a number AND count == missing; needs confirmation', () => {
    const { dir, aiIdx } = setup(10, 0.5, 0.5)
    assert.strictEqual(aiIdx.length, 5)
    const ext = freshDir('ext')
    const names = ['image_10.png', 'image_2.png', 'image_1.png', 'image_3.png', 'image_4.png']
    const files = names.map((n) => makeExternalImage(ext, n))
    const plan = planManualAiImport({ projectDir: dir, filePaths: files })
    assert.strictEqual(plan.needsConfirmation, true, 'must require explicit confirmation')
    assert.strictEqual(plan.mappings.length, 5)
    assert.ok(plan.mappings.every((m) => m.via === 'natural-sort'))
    // natural order: 1,2,3,4,10 -> missing AI scenes ascending
    const byFile = new Map(plan.mappings.map((m) => [m.fileName, m.sceneIndex]))
    assert.strictEqual(byFile.get('image_1.png'), aiIdx[0])
    assert.strictEqual(byFile.get('image_2.png'), aiIdx[1])
    assert.strictEqual(byFile.get('image_3.png'), aiIdx[2])
    assert.strictEqual(byFile.get('image_4.png'), aiIdx[3])
    assert.strictEqual(byFile.get('image_10.png'), aiIdx[4])

    // count != missing -> no guessing
    const plan2 = planManualAiImport({ projectDir: dir, filePaths: files.slice(0, 3) })
    assert.strictEqual(plan2.mappings.length, 0)
    assert.strictEqual(plan2.needsConfirmation, false)
    assert.ok(plan2.rejections.every((r) => r.code === 'NO_SCENE_NUMBER'))
  })

  await it('mixed numbered + unnumbered files never trigger the natural-sort guess', () => {
    const { dir } = setup(10, 1, 0)
    const ext = freshDir('ext')
    const plan = planManualAiImport({
      projectDir: dir,
      filePaths: [makeExternalImage(ext, 'S0001.png'), makeExternalImage(ext, 'random.png')]
    })
    assert.strictEqual(plan.mappings.length, 1)
    assert.strictEqual(plan.mappings[0].via, 'filename')
    assert.strictEqual(plan.needsConfirmation, false)
    assert.strictEqual(plan.rejections[0].code, 'NO_SCENE_NUMBER')
  })

  await it('partial import 30 of 85 -> ready 30 / missing 55; files + manifest stored in the project', async () => {
    const { dir, aiIdx } = setup(100, 0.85, 0.15)
    assert.strictEqual(aiIdx.length, 85)
    const ext = freshDir('ext')
    const first30 = aiIdx.slice(0, 30)
    const files = first30.map((i) => makeExternalImage(ext, sceneFileName(i), 2048, 1152))
    const plan = planManualAiImport({ projectDir: dir, filePaths: files })
    assert.strictEqual(plan.mappings.length, 30)
    assert.strictEqual(plan.rejections.length, 0)
    const res = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
    assert.strictEqual(res.imported.length, 30)
    assert.strictEqual(res.status.expected, 85)
    assert.strictEqual(res.status.ready, 30)
    assert.strictEqual(res.status.missingSceneIndices.length, 55)
    assert.deepStrictEqual(res.status.missingSceneIndices, aiIdx.slice(30))

    for (const i of first30) {
      const p = path.join(getManualAiAssetsDir(dir), sceneFileName(i))
      assert.ok(fs.existsSync(p), `copied into project storage: ${p}`)
      const dims = probeImageFileDimensions(p)!
      assert.deepStrictEqual([dims.width, dims.height], [1920, 1080])
    }
    const manifest = readJson(getManualAiManifestPath(dir))
    assert.strictEqual(manifest.schemaVersion, 1)
    assert.strictEqual(manifest.expected, 85)
    assert.strictEqual(manifest.ready, 30)
    assert.strictEqual(manifest.missing, 55)
    const rec = manifest.scenes[String(aiIdx[0])]
    assert.strictEqual(rec.status, 'ready')
    assert.ok(rec.promptHash && rec.localPath && rec.importedAt)
    assert.ok(/assets[\\/]generated[\\/]manual-ai[\\/]S\d{4}\.png$/.test(rec.localPath))

    // Later import of the rest: no need for all 85 in one action.
    const rest = aiIdx.slice(30).map((i) => makeExternalImage(ext, sceneFileName(i)))
    const plan2 = planManualAiImport({ projectDir: dir, filePaths: rest })
    const res2 = await commitManualAiImport({ projectDir: dir, mappings: plan2.mappings, normalizer: fakeNormalizer })
    assert.strictEqual(res2.status.ready, 85)
    assert.strictEqual(res2.status.missingSceneIndices.length, 0)
  })

  await it('already imported scene needs explicit Replace', async () => {
    const { dir } = setup(6, 1, 0)
    const ext = freshDir('ext')
    const f = makeExternalImage(ext, 'S0002.png')
    const p1 = planManualAiImport({ projectDir: dir, filePaths: [f] })
    await commitManualAiImport({ projectDir: dir, mappings: p1.mappings, normalizer: fakeNormalizer })
    const p2 = planManualAiImport({ projectDir: dir, filePaths: [f] })
    assert.strictEqual(p2.mappings.length, 0)
    assert.strictEqual(p2.rejections[0].code, 'ALREADY_IMPORTED')
    const p3 = planManualAiImport({ projectDir: dir, filePaths: [f], replaceExisting: true })
    assert.strictEqual(p3.mappings.length, 1)
    const res = await commitManualAiImport({ projectDir: dir, mappings: p3.mappings, replaceExisting: true, normalizer: fakeNormalizer })
    assert.strictEqual(res.imported.length, 1)
  })

  await it('corrupted / unreadable image is rejected and not stored', async () => {
    const { dir } = setup(6, 1, 0)
    const ext = freshDir('ext')
    const bad = path.join(ext, 'S0003.png')
    fs.writeFileSync(bad, 'this is not an image')
    const plan = planManualAiImport({ projectDir: dir, filePaths: [bad] })
    const res = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
    assert.strictEqual(res.imported.length, 0)
    assert.strictEqual(res.rejections.length, 1)
    assert.ok(!fs.existsSync(path.join(getManualAiAssetsDir(dir), 'S0003.png')))
    assert.strictEqual(res.status.ready, 0)
  })

  await it('LOW_RESOLUTION is rejected until the user chooses "Use Anyway"', async () => {
    const { dir } = setup(6, 1, 0, '1080p')
    const ext = freshDir('ext')
    const f = makeExternalImage(ext, 'S0004.png', 1280, 720)
    const plan = planManualAiImport({ projectDir: dir, filePaths: [f] })
    const res = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
    assert.strictEqual(res.imported.length, 0)
    assert.strictEqual(res.rejections[0].code, 'LOW_RESOLUTION')
    assert.ok(/LOW RESOLUTION/.test(res.rejections[0].message))
    assert.strictEqual(res.status.ready, 0, 'must not count as READY')

    const res2 = await commitManualAiImport({
      projectDir: dir,
      mappings: plan.mappings,
      allowLowResolution: true,
      normalizer: fakeNormalizer
    })
    assert.strictEqual(res2.imported.length, 1)
    assert.ok(res2.imported[0].warnings.includes('LOW_RESOLUTION_ACCEPTED'))
    assert.strictEqual(res2.status.ready, 1)
  })

  await it('2K / 4K targets require bigger sources and normalize to 2560x1440 / 3840x2160', async () => {
    for (const [res, w, h] of [['2k', 2560, 1440], ['4k', 3840, 2160]] as const) {
      const { dir } = setup(4, 1, 0, res)
      const ext = freshDir('ext')
      const small = makeExternalImage(ext, 'S0001.png', 1920, 1080)
      const big = makeExternalImage(ext, 'S0002.png', w, h)
      const plan = planManualAiImport({ projectDir: dir, filePaths: [small, big] })
      const out = await commitManualAiImport({ projectDir: dir, mappings: plan.mappings, normalizer: fakeNormalizer })
      assert.strictEqual(out.imported.length, 1, `${res}: only the big one is accepted`)
      assert.strictEqual(out.rejections[0].code, 'LOW_RESOLUTION')
      const dims = probeImageFileDimensions(path.join(getManualAiAssetsDir(dir), 'S0002.png'))!
      assert.deepStrictEqual([dims.width, dims.height], [w, h])
    }
  })

  // ── Real ffmpeg normalization: scale-to-cover + center crop, never stretch ──
  function ffmpegBin(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('ffmpeg-static') as string
  }

  function makeWideImage(dest: string): void {
    // 2000x1000 (2:1) black frame with a centred 100x100 white square.
    const r = spawnSync(
      ffmpegBin(),
      ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=2000x1000', '-vf', 'drawbox=x=950:y=450:w=100:h=100:color=white:t=fill', '-frames:v', '1', dest],
      { windowsHide: true }
    )
    if (r.status !== 0) throw new Error(`ffmpeg lavfi failed: ${r.stderr?.toString().slice(-300)}`)
  }

  /** Counts white pixels on the centre row via raw gray output. */
  function centreRowWhite(png: string, width: number, height: number): number {
    const r = spawnSync(
      ffmpegBin(),
      ['-v', 'error', '-i', png, '-vf', `crop=${width}:1:0:${Math.floor(height / 2)},format=gray`, '-f', 'rawvideo', '-frames:v', '1', '-'],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
    if (r.status !== 0) throw new Error(`ffmpeg raw failed: ${r.stderr?.toString().slice(-300)}`)
    const buf = r.stdout as Buffer
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] > 200) n++
    return n
  }

  for (const [res, w, h] of [['1080p', 1920, 1080], ['2k', 2560, 1440], ['4k', 3840, 2160]] as const) {
    await it(`REAL ffmpeg: ${res} import normalizes to ${w}x${h} (cover + center crop, no stretch)`, async () => {
      const ext = freshDir('ext')
      const src = path.join(ext, 'wide.png')
      makeWideImage(src)
      const dest = path.join(ext, `out_${res}.png`)
      await defaultImageNormalizer(src, dest, w, h)
      const dims = probeImageFileDimensions(dest)!
      assert.deepStrictEqual([dims.width, dims.height], [w, h])
      // 2:1 source covered into 16:9: scale factor = h/1000, so the 100px box becomes ~100*h/1000 wide.
      const expected = Math.round((100 * h) / 1000)
      const white = centreRowWhite(dest, w, h)
      assert.ok(Math.abs(white - expected) <= 4, `box width ${white} should be ~${expected} (stretching would give ~${Math.round((100 * w) / 2000)})`)
    })
  }

  cleanupFixtures()
  finish()
}

void main()
