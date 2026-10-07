import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import {
  MANUAL_AI_MANIFEST_SCHEMA_VERSION,
  getManualAiManifestPath,
  type ManualAiAssetRecord,
  type ManualAiAssetsManifest
} from './manual-ai-types'

/**
 * Serialized, atomic persistence of analysis/manual-ai-assets.json.
 *
 * This file is the single source of truth for imported manual AI images. The importer ONLY writes
 * here (never stock-assignments.json); the engine's VisualAssignmentStore is the sole writer of
 * stock-assignments.json and mirrors this manifest into it, so concurrent imports and Stock
 * completion can never lose each other's updates.
 */

const queues = new Map<string, Promise<unknown>>()

function queueKey(projectDir: string): string {
  return path.resolve(projectDir)
}

function emptyManifest(): ManualAiAssetsManifest {
  return {
    schemaVersion: MANUAL_AI_MANIFEST_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    expected: 0,
    ready: 0,
    missing: 0,
    scenes: {}
  }
}

export function loadManualAiManifest(projectDir: string): ManualAiAssetsManifest {
  const p = getManualAiManifestPath(projectDir)
  if (!fs.existsSync(p)) return emptyManifest()
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as ManualAiAssetsManifest
    if (parsed && typeof parsed === 'object' && parsed.scenes && typeof parsed.scenes === 'object') {
      return parsed
    }
  } catch (err) {
    logger.warn(`[ManualAI] Failed to read ${p}: ${err}`)
  }
  return emptyManifest()
}

function writeManifestAtomic(projectDir: string, manifest: ManualAiAssetsManifest): void {
  const p = getManualAiManifestPath(projectDir)
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  manifest.updatedAt = new Date().toISOString()
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
}

/**
 * Applies `mutator` to a FRESHLY loaded manifest inside a per-project queue, then writes it atomically.
 * Optional `counts` refreshes the expected/ready/missing summary fields.
 */
export function updateManualAiManifest(
  projectDir: string,
  mutator: (manifest: ManualAiAssetsManifest) => void,
  counts?: (manifest: ManualAiAssetsManifest) => { expected: number; ready: number }
): Promise<ManualAiAssetsManifest> {
  const key = queueKey(projectDir)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => {
      const manifest = loadManualAiManifest(projectDir)
      mutator(manifest)
      if (counts) {
        const c = counts(manifest)
        manifest.expected = c.expected
        manifest.ready = c.ready
        manifest.missing = Math.max(0, c.expected - c.ready)
      }
      writeManifestAtomic(projectDir, manifest)
      return manifest
    })
  queues.set(key, next)
  return next
}

export function upsertManualAiRecord(
  projectDir: string,
  record: ManualAiAssetRecord,
  counts?: (manifest: ManualAiAssetsManifest) => { expected: number; ready: number }
): Promise<ManualAiAssetsManifest> {
  return updateManualAiManifest(
    projectDir,
    (m) => {
      m.scenes[String(record.sceneIndex)] = record
    },
    counts
  )
}

export function resolveManualAiAssetPath(projectDir: string, localPath: string): string {
  return path.isAbsolute(localPath) ? localPath : path.join(projectDir, localPath)
}
