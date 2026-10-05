/**
 * preflight-cache.ts
 *
 * Avoids running Render Preflight QA twice back-to-back (RenderPage runs it, then
 * renderVideo used to run it again). The report is reused only when every input
 * that preflight inspects is unchanged. Preflight is never skipped otherwise.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { runRenderPreflight, type PreflightOptions } from '../qa/render-preflight'
import { fileSignature, fingerprintOf, hashFileContent } from './render-fingerprint'
import { readJsonWithRecovery, writeJsonAtomic } from './render-manifest'
import type { RenderQaReport } from '../../../shared/types'

const MAX_REUSE_AGE_MS = 30 * 60 * 1000

function stockDirSignature(projectDir: string): unknown {
  const dir = path.join(projectDir, 'assets', 'stock')
  try {
    return fs.readdirSync(dir).sort().map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f))
        return [f, st.size, Math.floor(st.mtimeMs)]
      } catch {
        return [f, 0, 0]
      }
    })
  } catch {
    return null
  }
}

export function computePreflightFingerprint(options: PreflightOptions): string {
  const { projectDir } = options
  const analysis = path.join(projectDir, 'analysis')
  const cp = options.captionPlan
  return fingerprintOf({
    v: 'preflight-v1',
    plan: hashFileContent(path.join(analysis, 'master-edit-plan.json')),
    mediaIndex: hashFileContent(path.join(analysis, 'media-index.json')),
    stock: hashFileContent(path.join(analysis, 'stock-assignments.json')),
    audio: hashFileContent(path.join(analysis, 'audio-plan.json')),
    prod: hashFileContent(path.join(analysis, 'production-settings.json')),
    captions: cp && cp.enabled && (cp.phrases?.length ?? 0) > 0 ? fingerprintOf(cp) : null,
    voiceover: fileSignature(options.voiceoverPath),
    resolution: options.resolution ?? { width: 1920, height: 1080 },
    fps: options.fps ?? 30,
    stockDir: stockDirSignature(projectDir)
  })
}

function metaPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'render-preflight.meta.json')
}

export async function runRenderPreflightCached(
  options: PreflightOptions,
  opts: { force?: boolean } = {}
): Promise<{ report: RenderQaReport; reused: boolean }> {
  const fingerprint = computePreflightFingerprint(options)
  const reportPath = path.join(options.projectDir, 'analysis', 'render-preflight.json')

  if (!opts.force) {
    const meta = readJsonWithRecovery<{ fingerprint: string; generatedAt: string }>(metaPath(options.projectDir))
    const age = meta ? Date.now() - new Date(meta.generatedAt).getTime() : Infinity
    if (meta && meta.fingerprint === fingerprint && age < MAX_REUSE_AGE_MS && fs.existsSync(reportPath)) {
      const report = readJsonWithRecovery<RenderQaReport>(reportPath)
      if (report && report.status && report.status !== 'failed') {
        logger.info('[PreflightCache] Inputs unchanged — reusing preflight report')
        return { report, reused: true }
      }
    }
  }

  const report = await runRenderPreflight(options)
  try {
    writeJsonAtomic(metaPath(options.projectDir), { fingerprint, generatedAt: new Date().toISOString() })
  } catch {
    /* non-blocking */
  }
  return { report, reused: false }
}
