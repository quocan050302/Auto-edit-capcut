/**
 * Task-Specific Model Router
 *
 * Centralized model routing and retry policies across AI tasks.
 * Prevents high-throughput tasks like Stock QueryGen from overloading
 * expensive/rate-limited models (e.g., gemini-3.8-flash).
 */

import { logger } from "../logger"
import { DEPRECATED_TEXT_MODELS, normalizePreferredTextModel } from "../utils/gemini-fallback"
import { isModelAvailable, ModelHealthState, getModelHealthState } from "./model-health"

export type AiTaskType =
  | "planning"
  | "global_context"
  | "caption_planning"
  | "stock_query"
  | "retention_qa"
  | "visual_truth"
  | "claim_analysis"
  | "manual_ai_visual_director"

export const MODEL_ROUTES: Record<AiTaskType, string[]> = {
  planning: ["gemini-3.8-flash", "gemini-3.5-flash"],
  global_context: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  caption_planning: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  stock_query: ["gemini-3.5-flash-lite", "gemini-3.5-flash"],
  retention_qa: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  visual_truth: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  claim_analysis: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  manual_ai_visual_director: ["gemini-3.5-flash", "gemini-3.5-flash-lite"]
}

export const STOCK_QUERY_RETRY_POLICY = {
  maxRetriesPerModel: 0,
  switchModelImmediatelyOnRateLimit: true,
  switchModelImmediatelyOnUnavailable: true,
  useRuleFallbackAfterAllModelsFail: true
}

export const PLANNING_RETRY_POLICY = {
  maxRetriesPerModel: 1,
  switchModelImmediatelyOnRateLimit: false,
  switchModelImmediatelyOnUnavailable: true,
  useRuleFallbackAfterAllModelsFail: true
}

/**
 * Returns the candidate model route for a given task.
 * Enforces task-specific restrictions:
 * - stock_query NEVER attempts gemini-3.8-flash, even if user set preferredModel = gemini-3.8-flash.
 * - planning can prioritize user preferredModel.
 */
export function getModelRoute(taskType: AiTaskType, preferredModel?: string): string[] {
  const defaultRoute = [...MODEL_ROUTES[taskType]]

  // Normalize preferred model if provided
  let pref = preferredModel ? preferredModel.trim() : undefined
  if (pref && DEPRECATED_TEXT_MODELS.has(pref)) {
    pref = normalizePreferredTextModel(pref)
  }

  if (!pref) {
    return defaultRoute
  }

  // Task-specific override handling:
  if (taskType === "stock_query") {
    // STRICT: gemini-3.8-flash is never permitted for stock_query
    if (pref.includes("3.8")) {
      logger.info(`[ModelRouter] preferredModel "${pref}" ignored for stock_query; enforcing [${defaultRoute.join(", ")}].`)
      return defaultRoute
    }
    // Only reorder if pref is in allowed stock_query models
    if (defaultRoute.includes(pref)) {
      return [pref, ...defaultRoute.filter((m) => m !== pref)]
    }
    return defaultRoute
  }

  if (taskType === "planning") {
    // Planning allows 3.8-flash or 3.5-flash
    if (defaultRoute.includes(pref)) {
      return [pref, ...defaultRoute.filter((m) => m !== pref)]
    }
    return [pref, ...defaultRoute]
  }

  // For global_context, caption_planning, retention_qa:
  // Disallow gemini-3.8-flash as default override unless explicit and not stock_query
  if (pref.includes("3.8")) {
    logger.info(`[ModelRouter] preferredModel "${pref}" reserved for planning; using task default for ${taskType}.`)
    return defaultRoute
  }

  if (defaultRoute.includes(pref)) {
    return [pref, ...defaultRoute.filter((m) => m !== pref)]
  }

  return defaultRoute
}

/**
 * Returns models for the task that are currently healthy/available.
 * Models marked as rate_limited or unavailable within their cooldown window are filtered out.
 */
export function getAvailableModelsForTask(taskType: AiTaskType, preferredModel?: string): string[] {
  const fullRoute = getModelRoute(taskType, preferredModel)
  const available = fullRoute.filter((m) => isModelAvailable(m))

  if (available.length === 0 && fullRoute.length > 0) {
    logger.warn(`[ModelRouter] All candidate models for ${taskType} are currently blocked by circuit breaker: [${fullRoute.join(", ")}].`)
  }

  return available
}
