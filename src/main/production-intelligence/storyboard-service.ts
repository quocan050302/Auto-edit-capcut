import { join, basename } from 'path'
import * as fs from 'fs'
import type {
  StockCandidate,
  StockSceneAssignment,
  StockAsset,
  StoryboardSummary
} from '../../../shared/types'
import {
  loadStockCandidates,
  saveStockCandidates,
  ProjectCandidatesStore
} from './candidate-ranking'
import { atomicWriteJson, readJsonSafe } from './json-store'
import { downloadAsset, loadAssetsManifest, saveAssetsManifest } from '../stock/downloader'
import { logger } from '../logger'

export function getStockCandidatesForProject(
  projectDir: string,
  sceneIndex?: number
): ProjectCandidatesStore | StockCandidate[] {
  const all = loadStockCandidates(projectDir)
  if (typeof sceneIndex === 'number') {
    const key = `scene_${sceneIndex}`
    return all[key] || all[String(sceneIndex)] || []
  }
  return all
}

export async function selectCandidateForScene(
  projectDir: string,
  sceneIndex: number,
  candidateId: string
): Promise<{ success: boolean; asset?: StockAsset; error?: string }> {
  try {
    const candidatesStore = loadStockCandidates(projectDir)
    const sceneKey = `scene_${sceneIndex}`
    const sceneCandidates = candidatesStore[sceneKey] || candidatesStore[String(sceneIndex)] || []

    const candidate = sceneCandidates.find((c) => c.candidateId === candidateId)
    if (!candidate) {
      return { success: false, error: `Candidate ${candidateId} not found for scene ${sceneIndex}` }
    }

    const stockDir = join(projectDir, 'assets', 'stock')
    fs.mkdirSync(stockDir, { recursive: true })
    let manifest = loadAssetsManifest(stockDir)

    // Check if asset is already downloaded
    let asset: StockAsset | undefined = manifest.find((a) => a.assetId === candidate.result.assetId)

    if (!asset || !fs.existsSync(asset.localPath) || fs.statSync(asset.localPath).size === 0) {
      // Need to download asset
      logger.info(`[Storyboard] Downloading candidate asset ${candidate.result.assetId} for scene ${sceneIndex}`)
      const queryUsed = candidate.result.searchQuery || candidate.result.title || `scene_${sceneIndex}`
      
      try {
        asset = await downloadAsset(candidate.result, sceneIndex, queryUsed, stockDir, manifest)
      } catch (dlErr: unknown) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr)
        logger.error(`[Storyboard] Download failed for candidate ${candidateId}: ${msg}`)
        // Preserve current asset and assignment intact
        return { success: false, error: `Download failed: ${msg}. Existing media retained.` }
      }

      // Validate downloaded file
      if (!fs.existsSync(asset.localPath) || fs.statSync(asset.localPath).size === 0) {
        return { success: false, error: 'Downloaded file is missing or empty. Existing media retained.' }
      }

      manifest = manifest.filter((a) => a.assetId !== asset!.assetId)
      manifest.push(asset)
      saveAssetsManifest(stockDir, manifest)
    }

    // Update candidates selection states
    for (const c of sceneCandidates) {
      c.selected = c.candidateId === candidateId
    }
    candidatesStore[sceneKey] = sceneCandidates
    saveStockCandidates(projectDir, candidatesStore)

    // Update stock-assignments.json
    const assignmentsPath = join(projectDir, 'analysis', 'stock-assignments.json')
    if (fs.existsSync(assignmentsPath)) {
      const assignments = readJsonSafe<StockSceneAssignment[]>(assignmentsPath, [])
      const idx = assignments.findIndex((a) => a.sceneIndex === sceneIndex)
      if (idx >= 0) {
        assignments[idx].asset = asset
        assignments[idx].selectedCandidateId = candidateId
        assignments[idx].candidates = sceneCandidates
        assignments[idx].score = candidate.score.totalScore
        assignments[idx].status = 'assigned'
        if (assignments[idx].approvalStatus !== 'approved') {
          assignments[idx].approvalStatus = 'auto_selected'
        }
        atomicWriteJson(assignmentsPath, assignments)
      }
    }

    // Update master-edit-plan.json (synchronize localPath, mediaFile, mediaType, preserve timing)
    const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
    if (fs.existsSync(planPath)) {
      const plan = readJsonSafe<{
        chapters?: Array<{
          sequences?: Array<{ scenes?: Array<{ sceneIndex: number; localPath?: string; mediaFile?: string; mediaType?: string }> }>
          chapters_seq?: Array<{ scenes?: Array<{ sceneIndex: number; localPath?: string; mediaFile?: string; mediaType?: string }> }>
        }>
      }>(planPath, {})

      for (const ch of plan.chapters ?? []) {
        const seqs = ch.sequences ?? ch.chapters_seq ?? []
        for (const seq of seqs) {
          for (const sc of seq.scenes ?? []) {
            if (sc.sceneIndex === sceneIndex) {
              sc.localPath = asset.localPath
              sc.mediaFile = basename(asset.localPath)
              sc.mediaType = asset.mediaType === 'photo' ? 'image' : 'video'
            }
          }
        }
      }
      atomicWriteJson(planPath, plan)
    }

    logger.info(`[Storyboard] Successfully switched scene ${sceneIndex} to candidate ${candidateId}`)
    return { success: true, asset }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[Storyboard] Selection error: ${msg}`)
    return { success: false, error: msg }
  }
}

export function approveCandidateForScene(
  projectDir: string,
  sceneIndex: number,
  candidateId?: string
): { success: boolean; error?: string } {
  try {
    const candidatesStore = loadStockCandidates(projectDir)
    const sceneKey = `scene_${sceneIndex}`
    const sceneCandidates = candidatesStore[sceneKey] || candidatesStore[String(sceneIndex)] || []

    if (candidateId) {
      for (const c of sceneCandidates) {
        if (c.candidateId === candidateId) {
          c.approved = true
          c.selected = true
        } else {
          c.approved = false
        }
      }
      candidatesStore[sceneKey] = sceneCandidates
      saveStockCandidates(projectDir, candidatesStore)
    }

    // Update assignments
    const assignmentsPath = join(projectDir, 'analysis', 'stock-assignments.json')
    if (fs.existsSync(assignmentsPath)) {
      const assignments = readJsonSafe<StockSceneAssignment[]>(assignmentsPath, [])
      const idx = assignments.findIndex((a) => a.sceneIndex === sceneIndex)
      if (idx >= 0) {
        assignments[idx].approvalStatus = 'approved'
        assignments[idx].reviewedAt = new Date().toISOString()
        if (candidateId) {
          assignments[idx].selectedCandidateId = candidateId
        }
        atomicWriteJson(assignmentsPath, assignments)
      }
    }

    return { success: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export function calculateStoryboardSummary(projectDir: string): StoryboardSummary {
  const assignmentsPath = join(projectDir, 'analysis', 'stock-assignments.json')
  const assignments = fs.existsSync(assignmentsPath)
    ? readJsonSafe<StockSceneAssignment[]>(assignmentsPath, [])
    : []

  const totalScenes = assignments.length
  let assignedScenes = 0
  let approvedScenes = 0
  let needsReviewScenes = 0
  let missingScenes = 0
  let totalScoreSum = 0
  let scoredScenesCount = 0

  const seenAssetIds = new Set<string>()
  let duplicateAvoidedCount = 0

  for (const a of assignments) {
    if (a.asset && a.asset.localPath && fs.existsSync(a.asset.localPath)) {
      assignedScenes++
      if (seenAssetIds.has(a.asset.assetId)) {
        // Repeated
      } else {
        seenAssetIds.add(a.asset.assetId)
      }
    } else {
      missingScenes++
    }

    if (a.approvalStatus === 'approved') {
      approvedScenes++
    } else if (a.status === 'failed' || !a.asset || a.score < 50) {
      needsReviewScenes++
    }

    if (typeof a.score === 'number' && a.score > 0) {
      totalScoreSum += a.score
      scoredScenesCount++
    }

    // Check candidate rejections for duplicate penalty avoidance
    for (const c of a.candidates ?? []) {
      if (c.score?.reusePenalty < 0) {
        duplicateAvoidedCount++
      }
    }
  }

  const averageScore = scoredScenesCount > 0 ? Math.round(totalScoreSum / scoredScenesCount) : 0

  return {
    totalScenes,
    assignedScenes,
    approvedScenes,
    needsReviewScenes,
    missingScenes,
    averageScore,
    duplicateAssetsAvoided: duplicateAvoidedCount
  }
}
