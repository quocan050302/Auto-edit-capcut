/**
 * Model Health and Circuit Breaker Registry
 *
 * Tracks model availability across the lifecycle of a job.
 * Ensures models encountering 429 RATE_LIMIT or 503 SERVICE_UNAVAILABLE
 * are blocked immediately for subsequent scenes/batches without slow retry loops.
 */

import { logger } from "../logger"
import type { GeminiErrorKind } from "../utils/gemini-fallback"

export type ModelHealthStatus = "available" | "rate_limited" | "unavailable"

export interface ModelHealthState {
  model: string
  status: ModelHealthStatus
  blockedUntil: number
  consecutiveFailures: number
  lastErrorKind?: string
  lastErrorTime?: number
}

const healthRegistry = new Map<string, ModelHealthState>()

function getOrCreateState(model: string): ModelHealthState {
  let state = healthRegistry.get(model)
  if (!state) {
    state = {
      model,
      status: "available",
      blockedUntil: 0,
      consecutiveFailures: 0
    }
    healthRegistry.set(model, state)
  }
  return state
}

/** Check if a model is currently available (not blocked by circuit breaker) */
export function isModelAvailable(model: string): boolean {
  const state = healthRegistry.get(model)
  if (!state) return true
  if (state.status === "available") return true

  if (Date.now() >= state.blockedUntil) {
    // Unblock for trial in later batch
    state.status = "available"
    return true
  }
  return false
}

/** Record RATE_LIMIT (429): block for at least 60 seconds (or retry-after) */
export function recordModelRateLimit(model: string, retryAfterMs?: number): void {
  const now = Date.now()
  const blockDuration = Math.max(retryAfterMs || 60_000, 60_000)
  const state = getOrCreateState(model)
  state.status = "rate_limited"
  state.blockedUntil = now + blockDuration
  state.consecutiveFailures++
  state.lastErrorKind = "RATE_LIMIT"
  state.lastErrorTime = now
  logger.warn(`[ModelHealth] Model ${model} rate-limited. Blocked for ${Math.round(blockDuration / 1000)}s for current job.`)
}

/** Record SERVICE_UNAVAILABLE (503): block for 30 seconds */
export function recordModelUnavailable(model: string, durationMs: number = 30_000, reason = "SERVICE_UNAVAILABLE"): void {
  const now = Date.now()
  const state = getOrCreateState(model)
  state.status = "unavailable"
  state.blockedUntil = now + durationMs
  state.consecutiveFailures++
  state.lastErrorKind = reason
  state.lastErrorTime = now
  logger.warn(`[ModelHealth] Model ${model} unavailable (${reason}). Blocked for ${Math.round(durationMs / 1000)}s.`)
}

/** Record MODEL_NOT_FOUND (404): block for entire job (24h) */
export function recordModelNotFound(model: string): void {
  const now = Date.now()
  const state = getOrCreateState(model)
  state.status = "unavailable"
  state.blockedUntil = now + 24 * 60 * 60 * 1000 // 24 hours
  state.consecutiveFailures++
  state.lastErrorKind = "MODEL_NOT_FOUND"
  state.lastErrorTime = now
  logger.warn(`[ModelHealth] Model ${model} not found/unsupported. Blocked for entire job.`)
}

/** Record successful model response */
export function recordModelSuccess(model: string): void {
  const state = getOrCreateState(model)
  state.status = "available"
  state.blockedUntil = 0
  state.consecutiveFailures = 0
}

/** Generic failure dispatcher based on classified GeminiErrorKind */
export function recordModelFailure(
  model: string,
  kind: GeminiErrorKind | string,
  retryAfterMs?: number
): void {
  if (kind === "RATE_LIMIT") {
    recordModelRateLimit(model, retryAfterMs)
  } else if (kind === "SERVICE_UNAVAILABLE") {
    recordModelUnavailable(model, 30_000, "SERVICE_UNAVAILABLE")
  } else if (kind === "MODEL_NOT_FOUND") {
    recordModelNotFound(model)
  } else if (kind === "AUTH_ERROR") {
    recordModelUnavailable(model, 24 * 60 * 60 * 1000, "AUTH_ERROR")
  } else {
    const state = getOrCreateState(model)
    state.consecutiveFailures++
    state.lastErrorKind = String(kind)
    state.lastErrorTime = Date.now()
  }
}

/** Get copy of model health state */
export function getModelHealthState(model: string): ModelHealthState | undefined {
  const state = healthRegistry.get(model)
  return state ? { ...state } : undefined
}

/** Reset all health states (in-memory, e.g. for new job or test) */
export function resetModelHealth(): void {
  healthRegistry.clear()
}

/** Testing helper to manipulate blockedUntil timestamp */
export function setBlockedUntilForTesting(model: string, timestamp: number): void {
  const state = getOrCreateState(model)
  state.blockedUntil = timestamp
}

/** Get all current health states */
export function getAllModelHealth(): Record<string, ModelHealthState> {
  const res: Record<string, ModelHealthState> = {}
  for (const [k, v] of healthRegistry.entries()) {
    res[k] = { ...v }
  }
  return res
}
