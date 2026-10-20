import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { ensureManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { commitManualAiImport, planManualAiImport } from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { evaluateManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import { loadManualAiPromptPack } from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import { buildManualAiAssignment } from '../src/main/visual-mix/manual-ai/manual-ai-branch'
import { getManualAiManifestPath } from '../src/main/visual-mix/manual-ai/manual-ai-types'
import { assert, cleanupFixtures, createRunner, freshDir, makeProject, mixOf, readJson } from './manual-ai-test-utils'

const { it, finish } = createRunner('Manual AI Video Import Tests')

async function main(): Promise<void> {
  try {
    await it('video opt-in does not change the original image-only importer', () => {
      const dir = makeProject(4)
      const scenes = VisualMixPlanner.loadScenesFromEditPlan(dir)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes: scenes, config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
      const file = path.join(freshDir('ext'), 'S0001.mp4')
      fs.writeFileSync(file, 'invalid video')
      const oldPlan = planManualAiImport({ projectDir: dir, filePaths: [file] })
      assert.strictEqual(oldPlan.mappings.length, 0)
      assert.strictEqual(oldPlan.rejections[0].code, 'UNSUPPORTED_TYPE')
      const videoPlan = planManualAiImport({ projectDir: dir, filePaths: [file], mediaType: 'video' })
      assert.strictEqual(videoPlan.mappings.length, 1)
      assert.strictEqual(videoPlan.mappings[0].mediaType, 'video')
    })
    await it('rejects unreadable video without unblocking the asset gate', async () => {
      const dir = makeProject(2)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes: VisualMixPlanner.loadScenesFromEditPlan(dir), config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
      const file = path.join(freshDir('bad'), 'S0001.mp4')
      fs.writeFileSync(file, 'invalid video')
      const res = await commitManualAiImport({ projectDir: dir, mappings: planManualAiImport({ projectDir: dir, filePaths: [file], mediaType: 'video' }).mappings })
      assert.strictEqual(res.imported.length, 0)
      assert.strictEqual(res.rejections[0].code, 'UNREADABLE')
      assert.strictEqual(res.status.ready, 0)
    })
    await it('valid clip is copied intact and assigned as video (original image path not invoked)', async () => {
      const dir = makeProject(2)
      const plan = VisualMixPlanner.buildPlan({ projectDir: dir, rawScenes: VisualMixPlanner.loadScenesFromEditPlan(dir), config: mixOf(1, 0, 'prompt'), profile: 'general' })
      ensureManualAiPromptPack({ projectDir: dir, plan, profile: 'general', outputResolution: '1080p' })
      const file = path.join(freshDir('clip'), 'S0001.mp4')
      // ffmpeg-static creates a valid video in a self-contained fixture.
      const ffmpeg: string = require('ffmpeg-static')
      const run = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=15:d=1',
        '-c:v', 'mpeg4', '-q:v', '6', file], { encoding: 'utf-8', timeout: 30000 })
      assert.strictEqual(run.status, 0, run.stderr)
      const mappings = planManualAiImport({ projectDir: dir, filePaths: [file], mediaType: 'video' }).mappings
      assert.strictEqual(mappings.length, 1)
      const res = await commitManualAiImport({ projectDir: dir, mappings })
      assert.strictEqual(res.imported.length, 1)
      assert.strictEqual(res.imported[0].mediaType, 'video')
      assert.strictEqual(fs.readFileSync(res.imported[0].localPath).equals(fs.readFileSync(file)), true)
      const manifest = readJson(getManualAiManifestPath(dir))
      assert.strictEqual(manifest.scenes['1'].mediaType, 'video')
      assert.ok(manifest.scenes['1'].durationSecs > 0)
      const status = evaluateManualAiStatus({ projectDir: dir, pack: loadManualAiPromptPack(dir) })
      assert.strictEqual(status.rows.find((r) => r.sceneIndex === 1)?.mediaType, 'video')
      const a = buildManualAiAssignment(plan.scenes.find((s) => s.sceneIndex === 1)!, res.imported[0].localPath, false, 'video')
      assert.strictEqual(a.asset?.mediaType, 'video')
      assert.strictEqual(a.asset?.provider, 'manual-ai')
    })
  } finally {
    cleanupFixtures()
    finish()
  }
}
void main()
