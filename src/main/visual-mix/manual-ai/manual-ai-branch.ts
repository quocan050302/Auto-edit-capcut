import * as fs from 'fs'
import type {
  ManualAiStatus,
  ManualAiWaitInfo,
  StockAsset,
  StockSceneAssignment,
  VisualMixScenePlan
} from '../../../../shared/types'
import type { VisualAssignmentStore } from '../visual-assignment-store'
import type { ManualAiPromptPack } from './manual-ai-types'
import { evaluateManualAiStatus } from './manual-ai-validator'
import { loadManualAiManifest } from './manual-ai-asset-store'

/**
 * Engine-side helpers for the Prompt-mode two-branch execution.
 *
 *  - the importer only writes analysis/manual-ai-assets.json (never stock-assignments.json)
 *  - the engine mirrors that manifest into the single serialized VisualAssignmentStore, so a manual
 *    import and a Stock completion happening at the same moment can never lose each other's update.
 */

function normWs(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim()
}

function fileHasContent(p: string | undefined): boolean {
  if (!p) return false
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

export function buildManualAiAssignment(
  scene: VisualMixScenePlan,
  localPath: string,
  isHealth: boolean
): StockSceneAssignment {
  let size = 0
  try {
    size = fs.statSync(localPath).size
  } catch {
    /* ignore */
  }
  const asset: StockAsset = {
    assetId: `manual_ai_${scene.sceneIndex}`,
    provider: 'manual-ai',
    mediaType: 'photo',
    localPath,
    thumbnailUrl: `file://${localPath}`,
    downloadUrl: '',
    creator: 'Manual AI Image',
    searchQuery: scene.imagePrompt || '',
    downloadedAt: new Date().toISOString(),
    fileSizeBytes: size
  }
  return {
    sceneId: `scene_${scene.sceneIndex}`,
    sceneIndex: scene.sceneIndex,
    narrationText: scene.narration,
    startTime: scene.startTime,
    endTime: scene.endTime,
    visualIntent: scene.visualIntent,
    searchQueries: [],
    usedQuery: isHealth ? 'AI Medical Still (Manual Import)' : 'AI Still (Manual Import)',
    score: 95,
    locked: true,
    manualOverride: false,
    status: 'assigned',
    asset
  }
}

/**
 * Mirrors every READY manual image into the store (provider 'manual-ai') and removes manual
 * assignments whose image became stale / missing. Never touches Stock-owned scenes.
 */
export async function syncManualAiAssignments(params: {
  projectDir: string
  pack: ManualAiPromptPack
  aiScenes: VisualMixScenePlan[]
  store: VisualAssignmentStore
  isHealth: boolean
}): Promise<{ status: ManualAiStatus; changed: boolean }> {
  const { projectDir, pack, aiScenes, store, isHealth } = params
  const status = evaluateManualAiStatus({ projectDir, pack, manifest: loadManualAiManifest(projectDir) })
  const sceneByIndex = new Map(aiScenes.map((s) => [s.sceneIndex, s]))
  let changed = false

  for (const row of status.rows) {
    const scene = sceneByIndex.get(row.sceneIndex)
    if (!scene) continue
    const existing = store.get(row.sceneIndex)

    if (row.status === 'ready' && row.localPath) {
      const same =
        existing?.status === 'assigned' &&
        existing.asset?.provider === 'manual-ai' &&
        existing.asset.localPath === row.localPath &&
        normWs(existing.narrationText) === normWs(scene.narration)
      if (!same) {
        store.set(row.sceneIndex, buildManualAiAssignment(scene, row.localPath, isHealth))
        changed = true
      }
    } else if (existing?.asset?.provider === 'manual-ai') {
      // stale / missing image: a manual assignment must never stay active.
      store.delete(row.sceneIndex)
      changed = true
    }
  }

  if (changed) await store.flushAtomic()
  return { status, changed }
}

/**
 * An existing assignment may be reused by Prompt mode (so Stock is NOT searched again after a
 * restart) only when it is a usable, non-AI asset still matching the scene narration.
 */
export function isReusableStockAssignment(
  a: StockSceneAssignment | undefined,
  scene: Pick<VisualMixScenePlan, 'narration'>
): boolean {
  if (!a || a.status !== 'assigned' || !a.asset) return false
  const provider = a.asset.provider
  if (provider === 'google-flow' || provider === 'manual-ai') return false
  if (!fileHasContent(a.asset.localPath)) return false
  const prev = normWs(a.narrationText)
  return prev === '' || prev === normWs(scene.narration)
}

/** Stock-owned scenes that still need acquisition (everything else is reused from the cache). */
export function filterPendingStockScenes(
  store: VisualAssignmentStore,
  stockScenes: VisualMixScenePlan[]
): VisualMixScenePlan[] {
  return stockScenes.filter((s) => !isReusableStockAssignment(store.get(s.sceneIndex), s))
}

export function countReadyStock(
  store: VisualAssignmentStore,
  stockScenes: VisualMixScenePlan[]
): number {
  let n = 0
  for (const s of stockScenes) {
    if (isReusableStockAssignment(store.get(s.sceneIndex), s)) n++
  }
  return n
}

export function buildManualAiWaitInfo(params: {
  status: ManualAiStatus
  stockExpected: number
  stockReady: number
}): ManualAiWaitInfo {
  const { status } = params
  return {
    expected: status.expected,
    ready: status.ready,
    missingSceneIndices: status.missingSceneIndices,
    promptFilePath: status.promptFilePath ?? '',
    stockExpected: params.stockExpected,
    stockReady: params.stockReady
  }
}

export function describeManualAiWait(info: ManualAiWaitInfo): string {
  const missing = Math.max(0, info.expected - info.ready)
  const aiPart = missing > 0 ? `Waiting for ${missing} AI image${missing === 1 ? '' : 's'}` : 'AI images ready'
  return `${aiPart} — AI ${info.ready}/${info.expected} imported · Stock ${info.stockReady}/${info.stockExpected} ready`
}
