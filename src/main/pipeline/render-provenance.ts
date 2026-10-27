import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { VideoAssemblyMode, BackgroundMusicMode } from '../../../shared/types'

export interface RenderOutputProvenance {
  schemaVersion: 1
  assemblyMode: VideoAssemblyMode
  backgroundMusicMode: BackgroundMusicMode
  renderRequestFingerprint: string
  outputPath: string
  status: 'completed'
  completedAt: string
  durationSecs: number
  fileSizeBytes: number
  resolution: { width: number; height: number }
  fps: number
  engineVersion: string
}

export function getRenderProvenancePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'render-provenance.json')
}

export function readRenderProvenance(projectDir: string): RenderOutputProvenance | null {
  const p = getRenderProvenancePath(projectDir)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as RenderOutputProvenance
    if (parsed && parsed.schemaVersion === 1 && parsed.status === 'completed' && parsed.outputPath) {
      return parsed
    }
  } catch (err) {
    logger.warn(`[RenderProvenance] Failed to read ${p}: ${err}`)
  }
  return null
}

export function writeRenderProvenance(projectDir: string, provenance: RenderOutputProvenance): void {
  const p = getRenderProvenancePath(projectDir)
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(provenance, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
  logger.info(
    `[RenderProvenance] Recorded completed output provenance: mode=${provenance.assemblyMode}, music=${provenance.backgroundMusicMode}, output=${path.basename(provenance.outputPath)}`
  )
}
