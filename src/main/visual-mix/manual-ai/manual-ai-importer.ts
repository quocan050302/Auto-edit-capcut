import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../../logger'
import type {
  ManualAiImportMapping,
  ManualAiImportPlan,
  ManualAiImportRejection,
  ManualAiImportResult,
  ManualAiImportedItem,
  ManualAiStatus
} from '../../../../shared/types'
import { probeImageFileDimensions } from '../../thumbnail/utils/image-probe'
import {
  expectedFilenameForScene,
  getManualAiAssetsDir,
  getVisualMixPlanFilePath,
  resolutionDims,
  type ManualAiAssetRecord,
  type ManualAiPromptPack
} from './manual-ai-types'
import { loadManualAiPromptPack } from './manual-ai-prompt-pack'
import { upsertManualAiRecord } from './manual-ai-asset-store'
import {
  evaluateManualAiStatus,
  isSupportedImageExtension,
  validateImageFile
} from './manual-ai-validator'
import { manualAiAssetGate } from './manual-ai-gate'

// ─── Filename parsing ────────────────────────────────────────────────────────

/**
 * Accepts S0007, S7, S001, scene_7, scene-007, "scene 007" (case-insensitive, any extension).
 * Returns the scene number or null when the file name carries no scene number.
 */
export function parseSceneNumberFromFilename(fileName: string): number | null {
  const base = path.basename(fileName, path.extname(fileName)).trim()
  const m = /^(?:scene|s)[\s_-]*0*(\d+)(?!\d)/i.exec(base)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// ─── Normalization (scale-to-cover + center crop, SAR 1, no stretching) ─────

export type ImageNormalizer = (
  sourcePath: string,
  destPath: string,
  width: number,
  height: number
) => Promise<void>

export const defaultImageNormalizer: ImageNormalizer = (sourcePath, destPath, width, height) =>
  new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegPath: string = require('ffmpeg-static')
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
    const proc = spawn(ffmpegPath, ['-y', '-i', sourcePath, '-vf', vf, '-frames:v', '1', destPath], {
      windowsHide: true
    })
    const stderr: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-4).join('').slice(-300)}`))
    })
  })

// ─── Planning (maps files to scenes; never touches disk state) ──────────────

function loadOwnership(projectDir: string): Map<number, string> {
  const map = new Map<number, string>()
  try {
    const p = getVisualMixPlanFilePath(projectDir)
    if (!fs.existsSync(p)) return map
    const plan = JSON.parse(fs.readFileSync(p, 'utf-8')) as { scenes?: Array<{ sceneIndex: number; strategy: string }> }
    for (const s of plan.scenes ?? []) map.set(s.sceneIndex, s.strategy)
  } catch {
    /* ignore */
  }
  return map
}

function reject(
  filePath: string,
  code: ManualAiImportRejection['code'],
  message: string,
  extra?: Partial<ManualAiImportRejection>
): ManualAiImportRejection {
  return { filePath, fileName: path.basename(filePath), code, message, ...extra }
}

/**
 * Maps selected files to AI-owned scenes.
 *  - scene numbers in the file name map directly ("filename")
 *  - if NO file carries a scene number and the file count EXACTLY equals the number of missing AI
 *    images, a natural-sort mapping is proposed and flagged `needsConfirmation` (never silent)
 *  - duplicates, Stock-owned scenes, unknown scenes and (unless replacing) already-imported
 *    scenes are rejected with a clear reason
 */
export function planManualAiImport(params: {
  projectDir: string
  filePaths: string[]
  replaceExisting?: boolean
}): ManualAiImportPlan {
  const { projectDir } = params
  const rejections: ManualAiImportRejection[] = []
  const mappings: ManualAiImportMapping[] = []

  const files = Array.from(new Set(params.filePaths.map((f) => path.resolve(f))))
  const pack = loadManualAiPromptPack(projectDir)
  if (!pack) {
    for (const f of files) {
      rejections.push(reject(f, 'NO_PROMPT_PACK', 'No prompt pack exists yet. Start production in Prompt mode first.'))
    }
    return { mappings, rejections, needsConfirmation: false, missingCount: 0 }
  }

  const status = evaluateManualAiStatus({ projectDir, pack })
  const packScenes = new Set(pack.scenes.map((e) => e.sceneIndex))
  const ownership = loadOwnership(projectDir)
  const readyScenes = new Set(status.rows.filter((r) => r.status === 'ready').map((r) => r.sceneIndex))
  const missingSorted = [...status.missingSceneIndices].sort((a, b) => a - b)

  const supported: string[] = []
  for (const f of files) {
    if (!isSupportedImageExtension(f)) {
      rejections.push(reject(f, 'UNSUPPORTED_TYPE', `Unsupported file type "${path.extname(f) || 'none'}". Use PNG, JPG, JPEG or WEBP.`))
    } else {
      supported.push(f)
    }
  }

  const numbered = supported.map((f) => ({ f, n: parseSceneNumberFromFilename(f) }))
  const noneNumbered = numbered.length > 0 && numbered.every((x) => x.n === null)
  let needsConfirmation = false

  const candidates: ManualAiImportMapping[] = []

  if (noneNumbered) {
    const sortedFiles = [...supported].sort((a, b) => naturalCompare(path.basename(a), path.basename(b)))
    if (sortedFiles.length === missingSorted.length) {
      sortedFiles.forEach((f, i) =>
        candidates.push({ filePath: f, fileName: path.basename(f), sceneIndex: missingSorted[i], via: 'natural-sort' })
      )
      needsConfirmation = true
    } else {
      for (const f of sortedFiles) {
        rejections.push(
          reject(
            f,
            'NO_SCENE_NUMBER',
            `File has no scene number and ${sortedFiles.length} files do not match the ${missingSorted.length} missing AI images. ` +
              `Name files like ${expectedFilenameForScene(missingSorted[0] ?? 1)} or select exactly ${missingSorted.length} files.`
          )
        )
      }
    }
  } else {
    for (const x of numbered) {
      if (x.n === null) {
        rejections.push(
          reject(x.f, 'NO_SCENE_NUMBER', `File name has no scene number. Rename it like ${expectedFilenameForScene(missingSorted[0] ?? 1)}.`)
        )
      } else {
        candidates.push({ filePath: x.f, fileName: path.basename(x.f), sceneIndex: x.n, via: 'filename' })
      }
    }
  }

  // Duplicate scene numbers inside the batch: never silently pick one.
  const byScene = new Map<number, ManualAiImportMapping[]>()
  for (const c of candidates) {
    const list = byScene.get(c.sceneIndex) ?? []
    list.push(c)
    byScene.set(c.sceneIndex, list)
  }

  for (const [sceneIndex, list] of byScene) {
    if (list.length > 1) {
      for (const c of list) {
        rejections.push(
          reject(c.filePath, 'DUPLICATE_SCENE', `Scene ${sceneIndex} has ${list.length} files in this import (${list.map((x) => x.fileName).join(', ')}). Keep only one.`, { sceneIndex })
        )
      }
      continue
    }
    const c = list[0]
    const strategy = ownership.get(sceneIndex)
    if (!packScenes.has(sceneIndex)) {
      if (strategy === 'stock') {
        rejections.push(reject(c.filePath, 'NOT_AI_OWNED', `Scene ${sceneIndex} is not an AI-owned scene (it uses real footage).`, { sceneIndex }))
      } else {
        rejections.push(reject(c.filePath, 'UNKNOWN_SCENE', `Scene ${sceneIndex} does not exist in this project's AI prompt pack.`, { sceneIndex }))
      }
      continue
    }
    if (readyScenes.has(sceneIndex) && !params.replaceExisting) {
      rejections.push(reject(c.filePath, 'ALREADY_IMPORTED', `Scene ${sceneIndex} already has an image. Choose "Replace" to overwrite it.`, { sceneIndex }))
      continue
    }
    mappings.push(c)
  }

  mappings.sort((a, b) => a.sceneIndex - b.sceneIndex)
  return { mappings, rejections, needsConfirmation: needsConfirmation && mappings.length > 0, missingCount: missingSorted.length }
}

// ─── Commit ─────────────────────────────────────────────────────────────────

export interface CommitManualAiImportParams {
  projectDir: string
  mappings: ManualAiImportMapping[]
  replaceExisting?: boolean
  /** "Use Anyway": accept images below the quality target (flagged low-resolution). */
  allowLowResolution?: boolean
  normalizer?: ImageNormalizer
}

/**
 * Validates, normalizes (to the selected output resolution) and copies accepted images into
 * assets/generated/manual-ai/, records them in analysis/manual-ai-assets.json and wakes the gate.
 */
export async function commitManualAiImport(params: CommitManualAiImportParams): Promise<ManualAiImportResult> {
  const { projectDir } = params
  const normalizer = params.normalizer ?? defaultImageNormalizer
  const rejections: ManualAiImportRejection[] = []
  const imported: ManualAiImportedItem[] = []

  const pack = loadManualAiPromptPack(projectDir)
  if (!pack) {
    for (const m of params.mappings) {
      rejections.push(reject(m.filePath, 'NO_PROMPT_PACK', 'No prompt pack exists yet.', { sceneIndex: m.sceneIndex }))
    }
    return { imported, rejections, status: evaluateManualAiStatus({ projectDir, pack: null }) }
  }

  const target = resolutionDims(pack.outputResolution)
  const entryByScene = new Map(pack.scenes.map((e) => [e.sceneIndex, e]))
  const ownership = loadOwnership(projectDir)

  // Re-validate mappings (the UI may hold a stale plan): duplicates inside the batch are rejected.
  const counts = new Map<number, number>()
  for (const m of params.mappings) counts.set(m.sceneIndex, (counts.get(m.sceneIndex) ?? 0) + 1)

  const outDir = getManualAiAssetsDir(projectDir)
  fs.mkdirSync(outDir, { recursive: true })

  const countsFn = (manifest: Parameters<typeof evaluateManualAiStatus>[0]['manifest']): { expected: number; ready: number } => {
    const s = evaluateManualAiStatus({ projectDir, pack, manifest })
    return { expected: s.expected, ready: s.ready }
  }

  for (const m of [...params.mappings].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    const sceneIndex = m.sceneIndex
    const entry = entryByScene.get(sceneIndex)

    if ((counts.get(sceneIndex) ?? 0) > 1) {
      rejections.push(reject(m.filePath, 'DUPLICATE_SCENE', `Scene ${sceneIndex} appears more than once in this import.`, { sceneIndex }))
      continue
    }
    if (!entry) {
      const code = ownership.get(sceneIndex) === 'stock' ? 'NOT_AI_OWNED' : 'UNKNOWN_SCENE'
      rejections.push(
        reject(
          m.filePath,
          code,
          code === 'NOT_AI_OWNED'
            ? `Scene ${sceneIndex} is not an AI-owned scene (it uses real footage).`
            : `Scene ${sceneIndex} does not exist in this project's AI prompt pack.`,
          { sceneIndex }
        )
      )
      continue
    }

    const before = evaluateManualAiStatus({ projectDir, pack })
    const alreadyReady = before.rows.find((r) => r.sceneIndex === sceneIndex)?.status === 'ready'
    if (alreadyReady && !params.replaceExisting) {
      rejections.push(reject(m.filePath, 'ALREADY_IMPORTED', `Scene ${sceneIndex} already has an image.`, { sceneIndex }))
      continue
    }

    const validation = validateImageFile(m.filePath, target)
    if (!validation.ok) {
      rejections.push(reject(m.filePath, validation.code ?? 'UNREADABLE', validation.message ?? 'Invalid image.', { sceneIndex }))
      continue
    }
    if (validation.lowResolution && !params.allowLowResolution) {
      rejections.push(
        reject(
          m.filePath,
          'LOW_RESOLUTION',
          `LOW RESOLUTION: ${validation.width}x${validation.height} is below the selected ${pack.outputResolution} target ${target.width}x${target.height}. Replace it or choose "Use Anyway".`,
          { sceneIndex, width: validation.width, height: validation.height }
        )
      )
      continue
    }

    const finalName = expectedFilenameForScene(sceneIndex)
    const finalPath = path.join(outDir, finalName)
    const tmpPath = path.join(outDir, `.tmp_${process.pid}_${Date.now()}_${sceneIndex}.png`)

    try {
      await normalizer(m.filePath, tmpPath, target.width, target.height)
      const outDims = probeImageFileDimensions(tmpPath)
      if (!outDims || outDims.width !== target.width || outDims.height !== target.height) {
        throw new Error(`Normalized image is ${outDims ? `${outDims.width}x${outDims.height}` : 'unreadable'}, expected ${target.width}x${target.height}`)
      }
      fs.renameSync(tmpPath, finalPath)
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
      rejections.push(
        reject(m.filePath, 'NORMALIZE_FAILED', `Could not process image (it may be corrupted): ${err instanceof Error ? err.message : String(err)}`, { sceneIndex })
      )
      continue
    }

    const warnings = [...validation.warnings]
    if (validation.lowResolution) warnings.push('LOW_RESOLUTION_ACCEPTED')

    const record: ManualAiAssetRecord = {
      sceneIndex,
      promptHash: entry.promptHash,
      status: 'ready',
      sourcePath: m.filePath,
      localPath: finalPath,
      width: target.width,
      height: target.height,
      sourceWidth: validation.width,
      sourceHeight: validation.height,
      importedAt: new Date().toISOString(),
      lowResolution: validation.lowResolution || undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    }
    await upsertManualAiRecord(projectDir, record, countsFn)

    logger.info(`[ManualAI] Imported Scene ${sceneIndex} -> ${finalName}`)
    imported.push({
      sceneIndex,
      fileName: finalName,
      localPath: finalPath,
      width: target.width,
      height: target.height,
      warnings
    })
  }

  const status: ManualAiStatus = evaluateManualAiStatus({ projectDir, pack })
  logger.info(`[ManualAI] Ready ${status.ready}/${status.expected}`)
  // Event-driven wake-up of a waiting pipeline (no polling needed).
  manualAiAssetGate.notify(projectDir)
  return { imported, rejections, status }
}

export type { ManualAiPromptPack }
