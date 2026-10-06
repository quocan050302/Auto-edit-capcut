import * as fs from 'fs'
import * as path from 'path'
import { probeImageFileDimensions } from '../../thumbnail/utils/image-probe'
import type {
  AiImageMode,
  ManualAiSceneRow,
  ManualAiStatus,
  StockSceneAssignment
} from '../../../../shared/types'
import { resolveAiImageMode } from '../../../../shared/types'
import {
  MANUAL_AI_SUPPORTED_EXTENSIONS,
  getManualAiPromptTxtPath,
  getVisualMixPlanFilePath,
  type ManualAiAssetsManifest,
  type ManualAiPromptPack,
  type TargetDims
} from './manual-ai-types'
import { loadManualAiManifest, resolveManualAiAssetPath } from './manual-ai-asset-store'
import { loadManualAiPromptPack } from './manual-ai-prompt-pack'

export interface ImageValidation {
  ok: boolean
  code?: 'UNSUPPORTED_TYPE' | 'UNREADABLE'
  message?: string
  width?: number
  height?: number
  /** Below the selected quality target (no silent upscaling pretending to be high quality). */
  lowResolution: boolean
  warnings: string[]
}

export function isSupportedImageExtension(filePath: string): boolean {
  return MANUAL_AI_SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase())
}

/**
 * Validates an imported image: exists, supported type, readable header, non-zero dimensions.
 * Resolution is compared with the selected AI Image Quality target.
 */
export function validateImageFile(filePath: string, target: TargetDims): ImageValidation {
  const base: ImageValidation = { ok: false, lowResolution: false, warnings: [] }

  if (!isSupportedImageExtension(filePath)) {
    return { ...base, code: 'UNSUPPORTED_TYPE', message: `Unsupported file type "${path.extname(filePath) || 'none'}". Use PNG, JPG, JPEG or WEBP.` }
  }
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    return { ...base, code: 'UNREADABLE', message: 'File does not exist or cannot be read.' }
  }
  if (size <= 0) {
    return { ...base, code: 'UNREADABLE', message: 'File is empty.' }
  }

  const dims = probeImageFileDimensions(filePath)
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) {
    return { ...base, code: 'UNREADABLE', message: 'Image is corrupted or has no readable dimensions.' }
  }

  const warnings: string[] = []
  const ratio = dims.width / dims.height
  if (Math.abs(ratio - 16 / 9) / (16 / 9) > 0.02) {
    warnings.push('ASPECT_RATIO_NOT_16_9')
  }

  return {
    ok: true,
    width: dims.width,
    height: dims.height,
    lowResolution: dims.width < target.width || dims.height < target.height,
    warnings
  }
}

function fileHasContent(p: string): boolean {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

/**
 * Evaluates the manual-image state of every prompt in the pack against the manifest.
 * ready   = record exists + file exists + promptHash still matches the current prompt
 * stale   = an image was imported for an OLD prompt (narration changed) and must be replaced
 * waiting = nothing usable imported yet
 */
export function evaluateManualAiStatus(params: {
  projectDir: string
  pack: ManualAiPromptPack | null
  manifest?: ManualAiAssetsManifest
  imageMode?: AiImageMode
}): ManualAiStatus {
  const { projectDir, pack } = params
  const imageMode = params.imageMode ?? 'prompt'

  if (!pack) {
    return {
      imageMode,
      hasPromptPack: false,
      expected: 0,
      ready: 0,
      missingSceneIndices: [],
      staleSceneIndices: [],
      lowResolutionSceneIndices: [],
      allReady: false,
      rows: []
    }
  }

  const manifest = params.manifest ?? loadManualAiManifest(projectDir)
  const rows: ManualAiSceneRow[] = []
  const missing: number[] = []
  const stale: number[] = []
  const lowRes: number[] = []
  let ready = 0

  const sorted = [...pack.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)
  for (const entry of sorted) {
    const record = manifest.scenes[String(entry.sceneIndex)]
    const localPath = record ? resolveManualAiAssetPath(projectDir, record.localPath) : undefined
    const fileOk = !!localPath && fileHasContent(localPath)

    let status: ManualAiSceneRow['status'] = 'waiting-image'
    if (record && fileOk) {
      if (record.promptHash === entry.promptHash) {
        status = 'ready'
        ready++
        if (record.lowResolution) lowRes.push(entry.sceneIndex)
      } else {
        status = 'stale'
        stale.push(entry.sceneIndex)
        missing.push(entry.sceneIndex)
      }
    } else {
      missing.push(entry.sceneIndex)
    }

    rows.push({
      sceneIndex: entry.sceneIndex,
      sceneId: entry.sceneId,
      prompt: entry.prompt,
      promptHash: entry.promptHash,
      expectedFilename: entry.expectedFilename,
      status,
      localPath: record && fileOk ? localPath : undefined,
      width: record?.width,
      height: record?.height,
      importedAt: record?.importedAt
    })
  }

  const expected = sorted.length
  return {
    imageMode,
    hasPromptPack: true,
    profile: pack.profile,
    outputResolution: pack.outputResolution,
    promptFilePath: getManualAiPromptTxtPath(projectDir),
    expected,
    ready,
    missingSceneIndices: missing,
    staleSceneIndices: stale,
    lowResolutionSceneIndices: lowRes,
    allReady: expected > 0 && ready === expected,
    rows
  }
}

export function evaluateManualAiStatusForProject(projectDir: string, imageMode: AiImageMode = 'prompt'): ManualAiStatus {
  return evaluateManualAiStatus({ projectDir, pack: loadManualAiPromptPack(projectDir), imageMode })
}

// ─── Render preflight ───────────────────────────────────────────────────────

function readJsonSafe<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
  } catch {
    return null
  }
}

/**
 * Prompt-mode render guard. Returns the AI-owned scenes that have no valid `manual-ai` assignment.
 * Returns [] unless the last visual run was in Prompt mode, so Default Workflow and Auto mode are
 * never affected. A missing image must stop the render instead of becoming a black placeholder.
 */
export function findMissingManualAiScenes(projectDir: string): number[] {
  const snapshot = readJsonSafe<{ aiImageMode?: AiImageMode }>(
    path.join(projectDir, 'analysis', 'visual-input-snapshot.json')
  )
  if (snapshot?.aiImageMode !== 'prompt') return []

  // The project must CURRENTLY be configured for Custom Mix + Prompt (a stale snapshot from an
  // earlier Prompt run must never block a Default Workflow / Auto render).
  const stateFile = [
    path.join(projectDir, 'project-state.json'),
    path.join(projectDir, 'project.json')
  ].find((p) => fs.existsSync(p))
  if (stateFile) {
    const proj = readJsonSafe<{
      inputs?: { visualSourceMode?: string; visualMixConfig?: { aiImageMode?: AiImageMode } }
    }>(stateFile)
    const inputs = proj?.inputs
    if (inputs) {
      if (inputs.visualSourceMode !== 'custom-mix') return []
      if (resolveAiImageMode(inputs.visualMixConfig) !== 'prompt') return []
    }
  }

  const plan = readJsonSafe<{ scenes?: Array<{ sceneIndex: number; strategy: string }> }>(getVisualMixPlanFilePath(projectDir))
  const aiScenes = (plan?.scenes ?? []).filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex)
  if (aiScenes.length === 0) return []

  const assignmentsRaw = readJsonSafe<StockSceneAssignment[]>(path.join(projectDir, 'analysis', 'stock-assignments.json'))
  const assignments = Array.isArray(assignmentsRaw) ? assignmentsRaw : []
  const byScene = new Map(assignments.map((a) => [a.sceneIndex, a]))

  const missing: number[] = []
  for (const idx of [...aiScenes].sort((a, b) => a - b)) {
    const a = byScene.get(idx)
    const ok =
      !!a &&
      a.status === 'assigned' &&
      a.asset?.provider === 'manual-ai' &&
      !!a.asset.localPath &&
      fileHasContent(resolveManualAiAssetPath(projectDir, a.asset.localPath))
    if (!ok) missing.push(idx)
  }
  return missing
}
