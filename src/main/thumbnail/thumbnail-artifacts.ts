import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { probeImageFile } from './utils/image-probe'
import { saveThumbnailJobStateAtomic } from './thumbnail-state'
import type {
  ThumbnailJobState,
  ThumbnailCandidate,
  ThumbnailManifest
} from '../../../shared/types'

export function getRoundDirectory(projectDir: string, round: number): string {
  const roundStr = `round-${String(round).padStart(3, '0')}`
  return path.join(projectDir, 'output', 'thumbnails', roundStr)
}

export function getCandidateImagePath(projectDir: string, round: number, optionId: string, revision = 1): string {
  const roundDir = getRoundDirectory(projectDir, round)
  const revSuffix = revision > 1 ? `-rev${revision}` : ''
  return path.join(roundDir, `thumbnail-${optionId}-master${revSuffix}.png`)
}

export function getSelectedDirectory(projectDir: string): string {
  return path.join(projectDir, 'output', 'thumbnails', 'selected')
}

export function reconcileThumbnailArtifacts(projectDir: string, state: ThumbnailJobState): boolean {
  let changed = false
  const roundDir = getRoundDirectory(projectDir, state.generationRound)

  for (const cand of state.candidates) {
    if (cand.round !== state.generationRound) continue

    const expectedPath = cand.exportedImagePath || getCandidateImagePath(projectDir, cand.round, cand.optionId, cand.revision)

    if (fs.existsSync(expectedPath)) {
      const stat = fs.statSync(expectedPath)
      if (stat.size > 0) {
        const dims = probeImageFile(expectedPath)
        if (dims && cand.status !== 'completed') {
          cand.status = 'completed'
          cand.exportedImagePath = expectedPath
          cand.actualWidth = dims.width
          cand.actualHeight = dims.height
          cand.exportQuality = cand.exportQuality || (dims.width >= 3840 ? 'native-4k' : '2k-fallback')
          changed = true
          logger.info(`[ThumbnailArtifacts] Reconciled candidate ${cand.optionId} to completed from disk artifact (${expectedPath})`)
        }
      }
    }
  }

  // Check if all candidates are completed
  const allCompleted = state.candidates.length === 5 && state.candidates.every((c) => c.status === 'completed')
  if (allCompleted && state.status !== 'completed') {
    state.status = 'completed'
    state.completedAt = state.completedAt || new Date().toISOString()
    changed = true
  }

  return changed
}

export function saveThumbnailManifest(projectDir: string, state: ThumbnailJobState): void {
  const roundDir = getRoundDirectory(projectDir, state.generationRound)
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true })
  }

  const manifestPath = path.join(roundDir, 'manifest.json')

  const manifest: ThumbnailManifest = {
    projectId: path.basename(projectDir),
    renderOutput: state.renderOutputPath,
    scriptHash: state.scriptHash,
    templateSnapshotHash: state.templateSnapshotHash,
    generationRound: state.generationRound,
    flowModel: 'GEM_PIX_2',
    flowProjectId: state.flowProjectId,
    candidates: state.candidates.map((c) => ({
      id: c.id,
      optionId: c.optionId,
      conceptName: c.conceptName,
      yellowText: c.yellowText,
      whiteText: c.whiteText,
      titleClear: c.titleClear,
      titleCuriosity: c.titleCuriosity,
      imagePrompt: c.imagePrompt,
      mediaId: c.mediaId,
      actualDimensions: c.actualWidth && c.actualHeight ? { width: c.actualWidth, height: c.actualHeight } : undefined,
      actualExportQuality: c.exportQuality,
      filePath: c.exportedImagePath,
      status: c.status,
      error: c.error
    })),
    selectedCandidateId: state.selectedCandidateId,
    createdAt: state.createdAt,
    completedAt: state.completedAt,
    errors: state.errors
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  logger.info(`[ThumbnailArtifacts] Saved manifest.json for round ${state.generationRound} to ${manifestPath}`)
}

export function selectThumbnailCandidate(
  projectDir: string,
  state: ThumbnailJobState,
  candidateId: string
): { success: boolean; selectedPath?: string; error?: string } {
  const candidate = state.candidates.find((c) => c.id === candidateId)
  if (!candidate) {
    return { success: false, error: `Candidate not found: ${candidateId}` }
  }

  if (candidate.status !== 'completed' || !candidate.exportedImagePath || !fs.existsSync(candidate.exportedImagePath)) {
    return { success: false, error: `Candidate ${candidate.optionId} is not completed or missing image file` }
  }

  const selectedDir = getSelectedDirectory(projectDir)
  if (!fs.existsSync(selectedDir)) {
    fs.mkdirSync(selectedDir, { recursive: true })
  }

  const ext = path.extname(candidate.exportedImagePath) || '.png'
  const destImagePath = path.join(selectedDir, `selected-thumbnail${ext}`)
  const destMetaPath = path.join(selectedDir, 'selected-thumbnail.json')

  // Copy without deleting original
  fs.copyFileSync(candidate.exportedImagePath, destImagePath)

  const meta = {
    selectedCandidateId: candidate.id,
    optionId: candidate.optionId,
    conceptName: candidate.conceptName,
    yellowText: candidate.yellowText,
    whiteText: candidate.whiteText,
    titleClear: candidate.titleClear,
    titleCuriosity: candidate.titleCuriosity,
    imagePrompt: candidate.imagePrompt,
    mediaId: candidate.mediaId,
    actualDimensions: { width: candidate.actualWidth, height: candidate.actualHeight },
    exportQuality: candidate.exportQuality,
    sourceFilePath: candidate.exportedImagePath,
    selectedAt: new Date().toISOString()
  }

  fs.writeFileSync(destMetaPath, JSON.stringify(meta, null, 2), 'utf-8')

  state.selectedCandidateId = candidate.id
  saveThumbnailJobStateAtomic(projectDir, state)
  saveThumbnailManifest(projectDir, state)

  logger.info(`[ThumbnailArtifacts] Selected candidate ${candidate.optionId} copied to ${destImagePath}`)
  return { success: true, selectedPath: destImagePath }
}
