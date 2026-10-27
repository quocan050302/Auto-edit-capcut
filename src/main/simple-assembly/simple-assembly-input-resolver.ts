import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
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
 * Resolves scenes from an existing project's edit plan and media manifests.
 */
export function resolveProjectScenes(projectDir: string): {
  scenes: SimpleAssemblySceneInput[]
  missingSceneIndices: number[]
  hasEditPlanTimings: boolean
} {
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  const manualAiPath = path.join(projectDir, 'analysis', 'manual-ai-assets.json')
  const mediaIndexPath = path.join(projectDir, 'analysis', 'media-index.json')
  const stockAssignmentsPath = path.join(projectDir, 'analysis', 'stock-assignments.json')

  let editPlan: any = null
  if (fs.existsSync(planPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    } catch (err) {
      logger.warn(`[SimpleAssemblyInputResolver] Could not read master-edit-plan.json: ${err}`)
    }
  }

  let manualAiManifest: any = null
  if (fs.existsSync(manualAiPath)) {
    try {
      manualAiManifest = JSON.parse(fs.readFileSync(manualAiPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  let stockAssignments: any = null
  if (fs.existsSync(stockAssignmentsPath)) {
    try {
      stockAssignments = JSON.parse(fs.readFileSync(stockAssignmentsPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  let mediaIndex: Array<{ filename: string; path: string }> = []
  if (fs.existsSync(mediaIndexPath)) {
    try {
      mediaIndex = JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  // Flatten scenes from edit plan if available
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

  const scenes: SimpleAssemblySceneInput[] = []
  const missingSceneIndices: number[] = []

  if (planScenes.length > 0) {
    for (const sc of planScenes) {
      const scIdx = sc.sceneIndex
      let resolvedPath: string | null = null

      // Check manual AI assets manifest
      if (manualAiManifest?.scenes?.[String(scIdx)]?.localPath) {
        const candidate = manualAiManifest.scenes[String(scIdx)].localPath
        if (fs.existsSync(candidate)) resolvedPath = candidate
      }

      // Check stock assignments
      if (!resolvedPath && stockAssignments?.scenes?.[String(scIdx)]) {
        const item = stockAssignments.scenes[String(scIdx)]
        const candidate = item.downloadedPath || item.localPath
        if (candidate && fs.existsSync(candidate)) resolvedPath = candidate
      }

      // Check direct localPath in scene plan
      if (!resolvedPath && sc.localPath && fs.existsSync(sc.localPath)) {
        resolvedPath = sc.localPath
      }

      // Check media index by filename
      if (!resolvedPath && sc.mediaFile) {
        const hit = mediaIndex.find((m) => m.filename === sc.mediaFile || path.basename(m.path) === sc.mediaFile)
        if (hit && fs.existsSync(hit.path)) resolvedPath = hit.path
      }

      // Check standard assets directories
      if (!resolvedPath && sc.mediaFile) {
        const searchDirs = [
          path.join(projectDir, 'assets', 'manual-ai'),
          path.join(projectDir, 'assets', 'videos'),
          path.join(projectDir, 'assets', 'images'),
          path.join(projectDir, 'assets', 'stock')
        ]
        for (const dir of searchDirs) {
          const candidate = path.join(dir, sc.mediaFile)
          if (fs.existsSync(candidate)) {
            resolvedPath = candidate
            break
          }
        }
      }

      if (resolvedPath && fs.existsSync(resolvedPath)) {
        scenes.push({
          sceneIndex: scIdx,
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          mediaType: detectMediaType(resolvedPath),
          duration: typeof sc.duration === 'number' && sc.duration > 0 ? sc.duration : undefined
        })
      } else {
        missingSceneIndices.push(scIdx)
      }
    }

    scenes.sort((a, b) => a.sceneIndex - b.sceneIndex)
    return {
      scenes,
      missingSceneIndices,
      hasEditPlanTimings: scenes.length > 0 && scenes.every((s) => typeof s.duration === 'number' && s.duration > 0)
    }
  }

  // If no edit plan scenes, check if manual AI manifest alone has ready scenes
  if (manualAiManifest?.scenes && Object.keys(manualAiManifest.scenes).length > 0) {
    const rawKeys = Object.keys(manualAiManifest.scenes).map((k) => parseInt(k, 10)).sort((a, b) => a - b)
    for (const scIdx of rawKeys) {
      const rec = manualAiManifest.scenes[String(scIdx)]
      if (rec?.localPath && fs.existsSync(rec.localPath)) {
        scenes.push({
          sceneIndex: scIdx,
          filePath: rec.localPath,
          fileName: path.basename(rec.localPath),
          mediaType: detectMediaType(rec.localPath)
        })
      } else {
        missingSceneIndices.push(scIdx)
      }
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
