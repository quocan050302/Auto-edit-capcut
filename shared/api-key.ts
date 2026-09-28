/**
 * shared/api-key.ts
 *
 * Normalizes API keys: trims, removes invisible characters, quotes, backticks,
 * accidental Bearer prefixes, and newlines.
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
