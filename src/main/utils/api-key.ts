import { GoogleGenAI } from '@google/genai'
import type { ApiKeyVerifyResult } from '../../../shared/types'
import { logger } from '../logger'

/**
 * Normalizes an API key:
 * - Trims whitespace
 * - Removes invisible zero-width characters frequently introduced by copy/paste
 * - Removes surrounding quotes, backticks, and smart quotes
 * - Removes accidental "Bearer " prefix
 * - Removes CR/LF and surrounding whitespace
 */
export function normalizeApiKey(raw: string): string {
  let value = raw ?? ''

  value = value.trim()

  // Remove invisible characters frequently introduced by copy/paste
  value = value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')

  // Remove wrapping quotes, backticks and smart quotes
  value = value.replace(/^[`"'“”‘’]+/, '')
  value = value.replace(/[`"'“”‘’]+$/, '')

  // Remove accidental Bearer prefix
  value = value.replace(/^Bearer\s+/i, '')

  // Remove CR/LF and surrounding whitespace
  value = value.replace(/[\r\n]/g, '').trim()

  return value
}

/**
 * Classifies an error received from Google GenAI provider into one of the 12 states:
 * INVALID_KEY, QUOTA_EXCEEDED, PERMISSION_DENIED, MODEL_UNAVAILABLE,
 * NETWORK_ERROR, SERVICE_UNAVAILABLE.
 */
export function classifyGeminiError(err: unknown): ApiKeyVerifyResult {
  const msg = err instanceof Error ? err.message : String(err)
  const errObj = err as Record<string, unknown> | null | undefined
  const status = typeof errObj?.status === 'number' ? errObj.status : undefined
  const code = (errObj?.code ?? (errObj?.cause as Record<string, unknown> | undefined)?.code) as string | undefined

  let reason = ''
  let statusText = ''
  try {
    const jsonMatch = msg.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      statusText = parsed?.error?.status ?? ''
      const details = parsed?.error?.details
      if (Array.isArray(details)) {
        for (const d of details) {
          if (d?.reason) reason = d.reason
        }
      }
    }
  } catch {
    // not JSON
  }

  const combined = `${msg} ${reason} ${statusText}`.toLowerCase()

  // 1. Network error (connection failure, DNS lookup failed, timeout, offline)
  if (
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'EAI_AGAIN' ||
    combined.includes('fetch failed') ||
    combined.includes('getaddrinfo') ||
    combined.includes('socket hang up') ||
    combined.includes('failed to fetch') ||
    combined.includes('network error') ||
    combined.includes('networktimeout')
  ) {
    return {
      valid: false,
      status: 'NETWORK_ERROR',
      message: 'Không thể kết nối tới Google AI API. Vui lòng kiểm tra lại kết nối mạng internet.'
    }
  }

  // 2. Model Unavailable (404 NOT_FOUND)
  if (
    status === 404 ||
    statusText === 'NOT_FOUND' ||
    combined.includes('not_found') ||
    combined.includes('model is not found') ||
    combined.includes('model not found') ||
    combined.includes('is not supported for this api version')
  ) {
    return {
      valid: false,
      status: 'MODEL_UNAVAILABLE',
      message: 'Model Gemini chỉ định không khả dụng với tài khoản này. Hệ thống sẽ tự động dùng model fallback.'
    }
  }

  // 3. Quota Exceeded (429 RESOURCE_EXHAUSTED)
  if (
    status === 429 ||
    statusText === 'RESOURCE_EXHAUSTED' ||
    combined.includes('resource_exhausted') ||
    combined.includes('quota') ||
    combined.includes('rate limit')
  ) {
    return {
      valid: false,
      status: 'QUOTA_EXCEEDED',
      message: 'API key hợp lệ nhưng đã hết quota (Rate limit / Resource exhausted). Vui lòng thử lại sau.'
    }
  }

  // 4. Permission Denied (403 PERMISSION_DENIED)
  if (
    status === 403 ||
    statusText === 'PERMISSION_DENIED' ||
    combined.includes('permission_denied') ||
    combined.includes('permission') ||
    combined.includes('unregistered callers')
  ) {
    return {
      valid: false,
      status: 'PERMISSION_DENIED',
      message: 'Khóa API không có quyền truy cập dịch vụ này (Permission Denied). Hãy kiểm tra lại quyền trong Google Cloud / AI Studio.'
    }
  }

  // 5. Service Unavailable (503 / 500 / 502 / 504 temporary overload)
  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    status === 500 ||
    statusText === 'UNAVAILABLE' ||
    combined.includes('unavailable') ||
    combined.includes('high demand') ||
    combined.includes('overloaded') ||
    combined.includes('internal server error')
  ) {
    return {
      valid: false,
      status: 'SERVICE_UNAVAILABLE',
      message: 'Máy chủ Google AI đang tạm thời quá tải hoặc bảo trì (503 Service Unavailable). Hãy thử lại sau ít phút.'
    }
  }

  // 6. Invalid Key (400 API_KEY_INVALID)
  if (
    reason === 'API_KEY_INVALID' ||
    status === 400 ||
    combined.includes('api_key_invalid') ||
    combined.includes('api key not valid') ||
    combined.includes('invalid api key') ||
    combined.includes('key is invalid')
  ) {
    return {
      valid: false,
      status: 'INVALID_KEY',
      message: 'Khóa API không hợp lệ. Vui lòng lấy key mới từ Google AI Studio (aistudio.google.com).'
    }
  }

  return {
    valid: false,
    status: 'INVALID_KEY',
    message: msg
  }
}

/**
 * Performs a real API verification call to Google GenAI without guessing based on prefix.
 * Zero token cost verification: calls models.list({ pageSize: 1 }).
 */
export async function verifyGeminiApiKey(
  rawKey: string,
  model?: string
): Promise<ApiKeyVerifyResult> {
  const key = normalizeApiKey(rawKey)
  if (!key) {
    return {
      valid: false,
      status: 'EMPTY',
      message: 'Chưa nhập API key.'
    }
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: { apiVersion: 'v1beta' }
    })

    // Lightweight call to verify authentication with real Google API
    const pager = await ai.models.list({ config: { pageSize: 1 } })
    let firstModelName = ''
    for await (const m of pager) {
      firstModelName = m.name ?? ''
      break
    }

    if (model) {
      try {
        await ai.models.get({ model })
      } catch (modelErr: unknown) {
        const classified = classifyGeminiError(modelErr)
        if (classified.status === 'MODEL_UNAVAILABLE') {
          return classified
        }
        if (classified.status !== 'VERIFIED') {
          return classified
        }
      }
    }

    return {
      valid: true,
      status: 'VERIFIED',
      message: 'API key hợp lệ và đã sẵn sàng sử dụng.',
      modelTested: model ?? (firstModelName ? firstModelName.replace(/^models\//, '') : 'gemini-3.8-flash')
    }
  } catch (err: unknown) {
    logger.warn(`[GeminiKeyVerification] Failed: ${err}`)
    return classifyGeminiError(err)
  }
}
