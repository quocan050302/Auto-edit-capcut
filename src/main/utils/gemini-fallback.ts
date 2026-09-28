/**
 * Gemini Model Fallback and Classification Manager
 *
 * Implements defensive fallback chain:
 * ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
 * Auto-normalizes deprecated models (gemini-2.5-flash, gemini-1.5-flash, etc.).
 * Handles MODEL_NOT_FOUND (404) by immediately switching models without retry.
 */

import { logger } from "../logger"

export const DEPRECATED_TEXT_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest"
])

export const RECOMMENDED_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite"
]

export function normalizePreferredTextModel(savedModel?: string): string {
  if (!savedModel || DEPRECATED_TEXT_MODELS.has(savedModel.trim())) {
    return "gemini-3.8-flash"
  }
  return savedModel.trim()
}

export type GeminiErrorKind =
  | "MODEL_NOT_FOUND"
  | "RATE_LIMIT"
  | "SERVICE_UNAVAILABLE"
  | "AUTH_ERROR"
  | "BAD_REQUEST"
  | "UNKNOWN"

export function classifyGeminiErrorKind(err: unknown): { kind: GeminiErrorKind; message: string } {
  if (!err) return { kind: "UNKNOWN", message: "Unknown error" }
  const anyErr = err as Record<string, unknown>
  const status = typeof anyErr.status === "number" ? anyErr.status : undefined
  const statusText = typeof anyErr.statusText === "string" ? anyErr.statusText : ""
  const msg = err instanceof Error ? err.message : String(err)
  const combined = `${status ?? ""} ${statusText} ${msg}`.toLowerCase()

  // MODEL_NOT_FOUND: 404, NOT_FOUND, model is no longer available, model not found, is not supported
  if (
    status === 404 ||
    statusText === "NOT_FOUND" ||
    combined.includes("404") ||
    combined.includes("not_found") ||
    combined.includes("model not found") ||
    combined.includes("model is not found") ||
    combined.includes("is no longer available") ||
    combined.includes("no longer available") ||
    combined.includes("is not supported for this api version") ||
    combined.includes("is not found for api version")
  ) {
    return { kind: "MODEL_NOT_FOUND", message: msg }
  }

  // AUTH_ERROR: 400 with api_key_invalid, 401, 403 permission denied
  if (
    status === 401 ||
    status === 403 ||
    combined.includes("api_key_invalid") ||
    combined.includes("api key not valid") ||
    combined.includes("invalid api key") ||
    combined.includes("key is invalid") ||
    combined.includes("permission_denied") ||
    combined.includes("unregistered callers")
  ) {
    return { kind: "AUTH_ERROR", message: msg }
  }

  // RATE_LIMIT: 429, RESOURCE_EXHAUSTED, quota, rate limit
  if (
    status === 429 ||
    statusText === "RESOURCE_EXHAUSTED" ||
    combined.includes("429") ||
    combined.includes("resource_exhausted") ||
    combined.includes("rate limit") ||
    combined.includes("quota")
  ) {
    return { kind: "RATE_LIMIT", message: msg }
  }

  // SERVICE_UNAVAILABLE: 503, 502, 504, 500, UNAVAILABLE, overloaded
  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    status === 500 ||
    statusText === "UNAVAILABLE" ||
    combined.includes("503") ||
    combined.includes("unavailable") ||
    combined.includes("overloaded") ||
    combined.includes("high demand")
  ) {
    return { kind: "SERVICE_UNAVAILABLE", message: msg }
  }

  // BAD_REQUEST: 400
  if (status === 400 || combined.includes("400") || combined.includes("invalid argument")) {
    return { kind: "BAD_REQUEST", message: msg }
  }

  return { kind: "UNKNOWN", message: msg }
}

export function buildFallbackModelList(initialModel?: string): string[] {
  const norm = normalizePreferredTextModel(initialModel)
  const models = [norm, ...RECOMMENDED_TEXT_MODELS].filter(
    (m) => !DEPRECATED_TEXT_MODELS.has(m)
  )
  return models.filter((v, i, a) => a.indexOf(v) === i)
}

export async function executeGeminiWithFallback<T>(params: {
  initialModel?: string
  taskName: string
  callerDescription?: string
  execute: (model: string) => Promise<T>
  onModelSwitched?: (prevModel: string, nextModel: string, reason: string) => void
}): Promise<{ result: T; modelUsed: string } | null> {
  const { initialModel, taskName, execute, onModelSwitched } = params

  if (initialModel && DEPRECATED_TEXT_MODELS.has(initialModel)) {
    const normalized = normalizePreferredTextModel(initialModel)
    logger.warn(`[GeminiModel] Saved model ${initialModel} is unavailable for this account. Falling back to ${normalized}.`)
    onModelSwitched?.(initialModel, normalized, "deprecated")
  }

  const modelChain = buildFallbackModelList(initialModel)

  for (let mIdx = 0; mIdx < modelChain.length; mIdx++) {
    const currentModel = modelChain[mIdx]
    let retryCount = 0
    const maxRetriesForModel = 2 // max 2 retries for transient errors

    while (retryCount <= maxRetriesForModel) {
      try {
        const result = await execute(currentModel)
        return { result, modelUsed: currentModel }
      } catch (err: unknown) {
        const { kind, message } = classifyGeminiErrorKind(err)

        if (kind === "MODEL_NOT_FOUND") {
          const nextModel = modelChain[mIdx + 1]
          logger.warn(`[GeminiModel] Saved model ${currentModel} is unavailable for this account. Falling back to ${nextModel ?? "rule-based fallback"}.`)
          if (nextModel) {
            onModelSwitched?.(currentModel, nextModel, "not_found")
          }
          // Do not retry same model on 404, switch immediately
          break
        }

        if (kind === "AUTH_ERROR") {
          logger.error(`[GeminiModel] Authentication error (${taskName}). Check API key.`)
          // Do not retry on auth error
          return null
        }

        if (kind === "BAD_REQUEST") {
          logger.warn(`[GeminiModel] Bad request error (${taskName}): ${message.slice(0, 100)}`)
          // Bad request, switch model or abort
          break
        }

        if (kind === "RATE_LIMIT" || kind === "SERVICE_UNAVAILABLE" || kind === "UNKNOWN") {
          retryCount++
          if (retryCount <= maxRetriesForModel) {
            const backoffMs = Math.pow(2, retryCount) * 1000 + Math.floor(Math.random() * 500)
            logger.warn(`[GeminiModel] ${taskName} with ${currentModel} encountered ${kind}. Retrying in ${backoffMs}ms (attempt ${retryCount}/${maxRetriesForModel})...`)
            await new Promise((r) => setTimeout(r, backoffMs))
            continue
          } else {
            logger.warn(`[GeminiModel] ${taskName} with ${currentModel} exhausted retries. Switching model.`)
            break
          }
        }
      }
    }
  }

  return null
}
