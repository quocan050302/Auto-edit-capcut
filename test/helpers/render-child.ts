/**
 * Child process used by the integration test to simulate a real crash:
 * it runs renderVideo() and prints every progress stage as a JSON line,
 * so the parent can SIGKILL it at an exact point.
 *
 * argv[2] = JSON { projectDir, voiceoverPath, width, height, fps, captionPlanPath?, transitions?, prefsPath, source }
 */

import * as fs from 'fs'
import { renderVideo, setOverlayRendererForTests } from '../../src/main/renderer'
import { setRenderPreferencesPathForTests } from '../../src/main/render-cache/render-preferences'
import { makeFakeOverlayRenderer } from './render-fixture'

async function main(): Promise<void> {
  const args = JSON.parse(process.argv[2])
  setRenderPreferencesPathForTests(args.prefsPath)
  setOverlayRendererForTests(makeFakeOverlayRenderer([]) as never)
  const captionPlan = args.captionPlanPath ? JSON.parse(fs.readFileSync(args.captionPlanPath, 'utf-8')) : undefined
  const r = await renderVideo({
    projectDir: args.projectDir,
    voiceoverPath: args.voiceoverPath,
    resolution: { width: args.width, height: args.height },
    fps: args.fps,
    captionPlan,
    transitionSettings: args.transitions,
    source: args.source ?? 'pipeline',
    onProgress: (p) => process.stdout.write(JSON.stringify({ stage: p.stage, progress: p.progress }) + '\n')
  })
  process.stdout.write(JSON.stringify({ done: true, cache: r.cache }) + '\n')
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err) }) + '\n')
  process.exit(1)
})
