import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { resolveSceneMediaWithSource } from '../renderer'
import { loadManualAiManifest, resolveManualAiAssetPath } from '../visual-mix/manual-ai/manual-ai-asset-store'
import { VisualAssignmentStore } from '../visual-mix/visual-assignment-store'
import type { SimpleAssemblySceneInput } from './simple-assembly-types'

const SUPPORTED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/**
 * Extracts a numeric scene index from a filename.
 * Supports patterns like:
 *  - "Scene 1.mp4", "Scene 002.webm", "Scene-10.mp4"
 *  - "S0001.mp4", "s2.mov"
 *  - "001.mp4", "1.mp4", "01_intro.mp4"
 *  - "shot_01.mp4", "clip_10.mp4"
 * Returns null if no numeric pattern is identifiable.
 */
export function extractSceneNumber(filename: string): number | null {
  const base = path.parse(filename).name.trim()

  // 1. Explicit scene / shot / clip prefix: e.g. "Scene 1", "scene_002", "S01", "shot-3"
  const prefixMatch = base.match(/^(?:scene|shot|clip|part|s)[-_\s]*0*(\d+)(?:[-_\s].*)?$/i)
  if (prefixMatch) {
    const num = parseInt(prefixMatch[1], 10)
    if (Number.isFinite(num)) return num
  }

  // 2. Pure number or leading number: e.g. "001", "01_nature", "1 - intro"
  const leadingMatch = base.match(/^0*(\d+)(?:[-_\s].*)?$/)
  if (leadingMatch) {
    const num = parseInt(leadingMatch[1], 10)
    if (Number.isFinite(num)) return num
  }

  // 3. Embedded "scene X" anywhere in the filename: e.g. "take1_scene_5_final"
  const embeddedMatch = base.match(/(?:^|[-_\s])(?:scene|shot|s)[-_\s]*0*(\d+)(?:[-_\s]|$)/i)
  if (embeddedMatch) {
    const num = parseInt(embeddedMatch[1], 10)
    if (Number.isFinite(num)) return num
  }

  // 4. Trailing number: e.g. "intro_01.mp4", "broll_2.mp4"
  const trailingMatch = base.match(/[-_\s]0*(\d+)$/)
  if (trailingMatch) {
    const num = parseInt(trailingMatch[1], 10)
    if (Number.isFinite(num)) return num
  }

  return null
}

export function detectMediaType(filePath: string): 'video' | 'image' {
  const ext = path.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'video'
}

/**
 * Natural comparator for scene filenames: orders by extracted scene number,
 * then falls back to numeric locale comparison.
 */
export function naturalCompareScenes(a: string, b: string): number {
  const numA = extractSceneNumber(a)
  const numB = extractSceneNumber(b)
  if (numA !== null && numB !== null) {
    if (numA !== numB) return numA - numB
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Resolves scenes directly from a user-selected folder containing numbered clips.
 * Guaranteed:
 *  - Strict numeric natural sorting (Scene 2 before Scene 10).
 *  - Duplicate scene numbers are rejected.
 *  - Ambiguous / unnumbered files are reported clearly without guessing.
 *  - Never orders files by filesystem timestamps.
 */
export function resolveDirectFolderScenes(folderPath: string): SimpleAssemblySceneInput[] {
  if (!fs.existsSync(folderPath)) {
    throw new Error(`Scene folder does not exist: ${folderPath}`)
  }

  const entries = fs.readdirSync(folderPath, { withFileTypes: true })
  const validFiles = entries
    .filter((ent) => ent.isFile() && !ent.name.startsWith('.'))
    .filter((ent) => SUPPORTED_EXTENSIONS.has(path.extname(ent.name).toLowerCase()))

  if (validFiles.length === 0) {
    throw new Error(
      `No supported video or image files found in folder: ${folderPath}. Supported formats: MP4, MOV, WEBM, MKV, PNG, JPG, WEBP.`
    )
  }

  const scenes: SimpleAssemblySceneInput[] = []
  const ambiguousFiles: string[] = []
  const seenIndices = new Map<number, string>()

  for (const ent of validFiles) {
    const sceneIndex = extractSceneNumber(ent.name)
    if (sceneIndex === null) {
      ambiguousFiles.push(ent.name)
      continue
    }

    if (seenIndices.has(sceneIndex)) {
      const existingName = seenIndices.get(sceneIndex)!
      throw new Error(
        `Duplicate scene number ${sceneIndex} detected in scene folder: "${existingName}" and "${ent.name}". Each scene number must be unique.`
      )
    }

    seenIndices.set(sceneIndex, ent.name)
    const fullPath = path.join(folderPath, ent.name)
    scenes.push({
      sceneIndex,
      filePath: fullPath,
      fileName: ent.name,
      mediaType: detectMediaType(fullPath)
    })
  }

  if (ambiguousFiles.length > 0) {
    throw new Error(
      `Could not determine scene order for ${ambiguousFiles.length} file(s): ${ambiguousFiles.slice(0, 5).join(', ')}${
        ambiguousFiles.length > 5 ? '...' : ''
      }. Please name files with scene numbers (e.g. "Scene 1.mp4", "Scene 2.mp4" or "001.mp4").`
    )
  }

  // Sort strictly by numeric scene index (natural numeric sort)
  scenes.sort((a, b) => a.sceneIndex - b.sceneIndex)

  logger.info(`[SimpleAssemblyInputResolver] Resolved ${scenes.length} scenes from direct folder: ${folderPath}`)
  return scenes
}

/**
 * Resolves authoritative production scenes from an existing project's master edit plan
 * and canonical asset stores (Manual AI manifest, VisualAssignmentStore, renderer media resolver).
 * Strictly preserves the edit plan's chapter -> sequence -> scene timeline order.
 */
export function resolvePreparedProductionScenes(projectDir: string): {
  scenes: SimpleAssemblySceneInput[]
  missingSceneIndices: number[]
  missingScenes: number[]
  expectedCount: number
  expectedScenes: number
  resolvedValidScenes: number
  hasEditPlanTimings: boolean
} {
  const planCandidates = [
    path.join(projectDir, 'analysis', 'master-edit-plan.json'),
    path.join(projectDir, 'analysis', 'edit-plan.json'),
    path.join(projectDir, 'master-edit-plan.json'),
    path.join(projectDir, 'edit-plan.json')
  ]
  const targetPlanPath = planCandidates.find((p) => fs.existsSync(p))

  if (!targetPlanPath) {
    throw new Error('Master edit plan not found. AI Planning must be executed before final assembly.')
  }

  let editPlan: any = null
  try {
    editPlan = JSON.parse(fs.readFileSync(targetPlanPath, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to parse master-edit-plan.json: ${err}`)
  }

  const planScenes: any[] = []
  if (editPlan && Array.isArray(editPlan.chapters)) {
    for (const ch of editPlan.chapters) {
      const seqs = ch.sequences ?? ch.chapters_seq ?? []
      for (const seq of seqs) {
        for (const sc of seq.scenes ?? []) {
          planScenes.push(sc)
        }
      }
    }
  }

  if (planScenes.length === 0) {
    throw new Error('Edit plan contains 0 planned scenes. AI Planning must be executed before final assembly.')
  }

  const manualAiManifest = loadManualAiManifest(projectDir)
  const store = new VisualAssignmentStore(projectDir)
  const mediaIndexPath = path.join(projectDir, 'analysis', 'media-index.json')
  let mediaIndex: Array<{ filename: string; path: string }> = []
  if (fs.existsSync(mediaIndexPath)) {
    try {
      mediaIndex = JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  const scenes: SimpleAssemblySceneInput[] = []
  const missingSceneIndices: number[] = []

  for (const sc of planScenes) {
    const scIdx = sc.sceneIndex
    let resolvedPath: string | null = null

    // 1. Check Manual AI manifest first (authoritative for prompt/manual AI mode)
    const manualRecord = manualAiManifest?.scenes?.[String(scIdx)]
    if (manualRecord?.localPath) {
      const candidate = resolveManualAiAssetPath(projectDir, manualRecord.localPath)
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        resolvedPath = candidate
      }
    }

    // 2. Check VisualAssignmentStore (sole writer for unified Stock and AI assignments)
    if (!resolvedPath) {
      const assignment = store.get(scIdx)
      if (assignment?.asset?.localPath) {
        const candidate = path.isAbsolute(assignment.asset.localPath)
          ? assignment.asset.localPath
          : path.join(projectDir, assignment.asset.localPath)
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
          resolvedPath = candidate
        }
      }
    }

    // 3. Check renderer's canonical resolveSceneMediaWithSource
    if (!resolvedPath) {
      const r = resolveSceneMediaWithSource(sc, mediaIndex, projectDir)
      if (r.mediaPath && fs.existsSync(r.mediaPath) && fs.statSync(r.mediaPath).size > 0) {
        resolvedPath = r.mediaPath
      }
    }

    // 4. Fallback: check sc.localPath or sc.localAsset
    if (!resolvedPath && sc.localPath) {
      const p = path.isAbsolute(sc.localPath) ? sc.localPath : path.join(projectDir, sc.localPath)
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        resolvedPath = p
      }
    }
    if (!resolvedPath && sc.localAsset) {
      const p = path.isAbsolute(sc.localAsset) ? sc.localAsset : path.join(projectDir, sc.localAsset)
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        resolvedPath = p
      }
    }

    if (resolvedPath) {
      scenes.push({
        sceneIndex: scIdx,
        sceneId: sc.sceneId,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        mediaType: detectMediaType(resolvedPath),
        duration: typeof sc.duration === 'number' && sc.duration > 0
          ? sc.duration
          : typeof sc.endTime === 'number' && typeof sc.startTime === 'number' && sc.endTime > sc.startTime
          ? sc.endTime - sc.startTime
          : undefined
      })
    } else {
      missingSceneIndices.push(scIdx)
    }
  }

  // NOTE: PRESERVE authoritative timeline order! Do NOT re-order by sorting sceneIndex!
  return {
    scenes,
    missingSceneIndices,
    missingScenes: missingSceneIndices,
    expectedCount: planScenes.length,
    expectedScenes: planScenes.length,
    resolvedValidScenes: scenes.length,
    hasEditPlanTimings: scenes.length > 0 && scenes.every((s) => typeof s.duration === 'number' && s.duration > 0)
  }
}

/**
 * Asserts all planned scenes are ready before rendering.
 * Throws explicit descriptive error if any scene is missing.
 */
export function assertAllProductionScenesReady(result: {
  scenes: SimpleAssemblySceneInput[]
  missingSceneIndices?: number[]
  missingScenes?: number[]
  expectedCount?: number
  expectedScenes?: number
}): void {
  const expected = result.expectedScenes ?? result.expectedCount ?? 0
  const missing = result.missingScenes ?? result.missingSceneIndices ?? []

  if (expected === 0) {
    throw new Error('Master edit plan contains 0 planned scenes. AI Planning must complete first.')
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot begin Simple Assembly: Missing ${missing.length} of ${expected} required production scene assets. Missing scene indices: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]. All scenes must be ready before final render.`
    )
  }
  if (result.scenes.length !== expected) {
    throw new Error(
      `Scene count mismatch: expected ${expected} scenes from edit plan, but resolved ${result.scenes.length} valid scenes.`
    )
  }
}

/**
 * Resolves scenes from an existing project's edit plan and media manifests.
 */
export function resolveProjectScenes(projectDir: string): {
  scenes: SimpleAssemblySceneInput[]
  missingSceneIndices: number[]
  hasEditPlanTimings: boolean
} {
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  const rootPlan = path.join(projectDir, 'master-edit-plan.json')
  if (fs.existsSync(planPath) || fs.existsSync(rootPlan)) {
    try {
      const prodRes = resolvePreparedProductionScenes(projectDir)
      return {
        scenes: prodRes.scenes,
        missingSceneIndices: prodRes.missingSceneIndices,
        hasEditPlanTimings: prodRes.hasEditPlanTimings
      }
    } catch (err) {
      logger.warn(`[SimpleAssemblyInputResolver] resolvePreparedProductionScenes notice: ${err}`)
    }
  }

  // If no edit plan scenes, check if manual AI manifest alone has ready scenes
  const manualAiManifest = loadManualAiManifest(projectDir)
  if (manualAiManifest?.scenes && Object.keys(manualAiManifest.scenes).length > 0) {
    const rawKeys = Object.keys(manualAiManifest.scenes).map((k) => parseInt(k, 10)).sort((a, b) => a - b)
    const scenes: SimpleAssemblySceneInput[] = []
    const missingSceneIndices: number[] = []
    for (const scIdx of rawKeys) {
      const rec = manualAiManifest.scenes[String(scIdx)]
      if (rec?.localPath) {
        const fullPath = resolveManualAiAssetPath(projectDir, rec.localPath)
        if (fs.existsSync(fullPath)) {
          scenes.push({
            sceneIndex: scIdx,
            filePath: fullPath,
            fileName: path.basename(fullPath),
            mediaType: detectMediaType(fullPath)
          })
          continue
        }
      }
      missingSceneIndices.push(scIdx)
    }
    return { scenes, missingSceneIndices, hasEditPlanTimings: false }
  }

  return { scenes: [], missingSceneIndices: [], hasEditPlanTimings: false }
}

/**
 * Authoritative input resolution for Simple Assembly.
 */
export function resolveSimpleAssemblyInputs(
  projectDir: string,
  sceneFolder?: string | null
): {
  scenes: SimpleAssemblySceneInput[]
  source: 'direct-folder' | 'project-plan'
  hasEditPlanTimings: boolean
} {
  // 1. Direct scene folder takes priority if specified and exists
  if (sceneFolder && sceneFolder.trim().length > 0) {
    const resolved = resolveDirectFolderScenes(sceneFolder)
    return {
      scenes: resolved,
      source: 'direct-folder',
      hasEditPlanTimings: false
    }
  }

  // 2. Resolve from project manifests
  const projectRes = resolveProjectScenes(projectDir)
  if (projectRes.missingSceneIndices.length > 0 && projectRes.scenes.length === 0) {
    throw new Error(
      `Import your scenes to begin Simple Assembly. Missing ${projectRes.missingSceneIndices.length} required scenes.`
    )
  }

  if (projectRes.scenes.length > 0) {
    if (projectRes.missingSceneIndices.length > 0) {
      throw new Error(
        `Simple Assembly blocked: Scene(s) ${projectRes.missingSceneIndices.slice(0, 10).join(', ')} are missing imported media. Please import all scenes or select a Scene Video Folder.`
      )
    }
    return {
      scenes: projectRes.scenes,
      source: 'project-plan',
      hasEditPlanTimings: projectRes.hasEditPlanTimings
    }
  }

  // 3. Fallback: check project's assets/manual-ai or assets/videos directory for direct numbered clips
  const fallbackDirs = [
    path.join(projectDir, 'assets', 'manual-ai'),
    path.join(projectDir, 'assets', 'videos')
  ]
  for (const fDir of fallbackDirs) {
    if (fs.existsSync(fDir)) {
      try {
        const resolved = resolveDirectFolderScenes(fDir)
        if (resolved.length > 0) {
          return {
            scenes: resolved,
            source: 'direct-folder',
            hasEditPlanTimings: false
          }
        }
      } catch {
        /* ignore fallback errors */
      }
    }
  }

  throw new Error('Import your scenes to begin Simple Assembly. No scene media found.')
}
