import type {
  AiFailureBehavior,
  StockSceneAssignment,
  VisualMixConfig,
  VisualMixPlan
} from '../../../shared/types'

export type FinalAssignmentViolationCode =
  | 'VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION'
  | 'VISUAL_MIX_STOCK_OWNED_AI_ASSIGNMENT'

export interface FinalAssignmentViolation {
  sceneIndex: number
  code: FinalAssignmentViolationCode
  provider: string
  message: string
}

export interface FinalAssignmentValidation {
  valid: boolean
  violations: FinalAssignmentViolation[]
  /** AI-owned scenes that have no usable assignment (failed / not yet generated). */
  missingAiSceneIndices: number[]
  /** Stock-owned scenes that have no assigned asset. */
  missingStockSceneIndices: number[]
}

export function resolveAiFailureBehavior(
  config?: Pick<VisualMixConfig, 'aiFailureBehavior'> | null
): AiFailureBehavior {
  return config?.aiFailureBehavior === 'stock-fallback' ? 'stock-fallback' : 'strict'
}

/**
 * Decides whether ANY Stock network work is permitted for a Custom Mix branch.
 * - initial branch: only when the user requested Stock footage (ratio > 0).
 * - fallback branch: only when the user explicitly enabled 'stock-fallback'.
 */
export function isStockAllowed(
  config: Pick<VisualMixConfig, 'stockFootageRatio' | 'aiFailureBehavior'>,
  isFallback: boolean
): boolean {
  if (isFallback) return resolveAiFailureBehavior(config) === 'stock-fallback'
  return config.stockFootageRatio > 0
}

export function assertStockAllowed(params: {
  config: Pick<VisualMixConfig, 'stockFootageRatio' | 'aiImageRatio' | 'aiFailureBehavior'>
  isFallback: boolean
  sceneIndices: number[]
}): void {
  const { config, isFallback, sceneIndices } = params
  if (sceneIndices.length === 0) return
  if (!isStockAllowed(config, isFallback)) {
    throw new Error(
      `VISUAL_MIX_ZERO_STOCK_VIOLATION requestedAiPercent=${Math.round(config.aiImageRatio * 100)} ` +
        `requestedStockPercent=${Math.round(config.stockFootageRatio * 100)} ` +
        `isFallback=${isFallback} failureBehavior=${resolveAiFailureBehavior(config)} ` +
        `sceneIndices=${sceneIndices.join(',')}`
    )
  }
}

/**
 * Validates the FINAL assignments against the authoritative Visual Mix plan.
 * The plan represents USER INTENT: an AI-owned scene may only be backed by a
 * 'google-flow' asset. Stock providers are accepted for AI-owned scenes only when
 * `aiFailureBehavior === 'stock-fallback'` AND the scene is explicitly recorded in
 * `approvedFallbackSceneIndices`.
 */
export function validateFinalVisualAssignments(params: {
  plan: Pick<VisualMixPlan, 'scenes'>
  assignments: StockSceneAssignment[]
  config: Pick<VisualMixConfig, 'aiFailureBehavior'>
  approvedFallbackSceneIndices?: number[]
}): FinalAssignmentValidation {
  const behavior = resolveAiFailureBehavior(params.config)
  const approved = new Set(params.approvedFallbackSceneIndices ?? [])
  const byScene = new Map<number, StockSceneAssignment>()
  for (const a of params.assignments) byScene.set(a.sceneIndex, a)

  const violations: FinalAssignmentViolation[] = []
  const missingAi: number[] = []
  const missingStock: number[] = []

  for (const scene of params.plan.scenes) {
    const a = byScene.get(scene.sceneIndex)
    const usable = !!a && a.status === 'assigned' && !!a.asset
    const provider = a?.asset?.provider ?? 'none'

    if (scene.strategy === 'ai-still') {
      if (!usable) {
        missingAi.push(scene.sceneIndex)
        continue
      }
      if (provider !== 'google-flow') {
        const fallbackApproved = behavior === 'stock-fallback' && approved.has(scene.sceneIndex)
        if (!fallbackApproved) {
          violations.push({
            sceneIndex: scene.sceneIndex,
            code: 'VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION',
            provider,
            message: `Scene ${scene.sceneIndex} is AI-owned but assigned to provider "${provider}"`
          })
        }
      }
    } else {
      if (!usable) {
        missingStock.push(scene.sceneIndex)
        continue
      }
      if (provider === 'google-flow') {
        violations.push({
          sceneIndex: scene.sceneIndex,
          code: 'VISUAL_MIX_STOCK_OWNED_AI_ASSIGNMENT',
          provider,
          message: `Scene ${scene.sceneIndex} is Stock-owned but assigned to a Google Flow image`
        })
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    missingAiSceneIndices: missingAi,
    missingStockSceneIndices: missingStock
  }
}

/** Throws VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION when ownership is violated. */
export function assertFinalVisualAssignments(
  params: Parameters<typeof validateFinalVisualAssignments>[0]
): FinalAssignmentValidation {
  const res = validateFinalVisualAssignments(params)
  if (!res.valid) {
    const first = res.violations[0]
    throw new Error(
      `${first.code}: ${res.violations.map((v) => v.message).join('; ')}`
    )
  }
  return res
}
