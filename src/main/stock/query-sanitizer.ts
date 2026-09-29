/**
 * query-sanitizer.ts — Stock search query cleaning and normalization.
 * Removes junk placeholders, fictional character names, and stop words
 * while strictly preserving brand names, locations, and visual nouns.
 */

// Placeholders and filler terms to strip (case-insensitive)
const FILLER_PHRASES = [
  /\bnot\s+specified\b/gi,
  /\bnot\s+available\b/gi,
  /\bunknown\b/gi,
  /\bn\/?a\b/gi,
  /\bnone\b/gi,
  /\bnull\b/gi,
  /\bundefined\b/gi,
  /\bstock\s+footage\s+of\b/gi,
  /\bfootage\s+of\b/gi,
  /\bpicture\s+of\b/gi,
  /\bimage\s+of\b/gi,
  /\bphoto\s+of\b/gi,
  /\bvideo\s+of\b/gi,
  /\bclip\s+of\b/gi,
  /\bscene\s+showing\b/gi,
  /\bshow\s+a\b/gi,
  /\bpicture\b/gi,
  /\bphoto\b/gi,
  /\bfootage\b/gi
]

// Character naming patterns: "man named David", "woman called Karen" -> "man", "woman"
const CHARACTER_NAME_REGEX = /\b(man|woman|person|boy|girl|guy|worker|farmer|shopper|customer|doctor|lawyer|teacher|driver|passenger|elder|child)\s+(?:named|called)\s+[A-ZÀ-Ỹa-zà-ỹ0-9_-]+/gi

// Generic punctuation to remove
const PUNCTUATION_REGEX = /[.,;:!?"'()[\]{}<>\\/|_~`#@*+=]/g

/**
 * Sanitizes a raw search query into a clean, visual-friendly search query.
 */
export function sanitizeStockQuery(query: string, fallback = ''): string {
  if (!query || typeof query !== 'string') {
    return fallback.trim()
  }

  let cleaned = query.trim()

  // 1. Remove character naming patterns first (e.g. "man named David" -> "man")
  cleaned = cleaned.replace(CHARACTER_NAME_REGEX, '$1')

  // 2. Remove filler phrases and meta words
  for (const pattern of FILLER_PHRASES) {
    cleaned = cleaned.replace(pattern, ' ')
  }

  // 3. Remove punctuation
  cleaned = cleaned.replace(PUNCTUATION_REGEX, ' ')

  // 4. Normalize spaces and remove consecutive duplicate words
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)

  const dedupedWords: string[] = []
  const seenLower = new Set<string>()

  for (const word of words) {
    const lower = word.toLowerCase()
    // Skip single letter filler words except 'a' in specific contexts if needed
    if (lower.length === 1 && lower !== 'a') continue

    if (!seenLower.has(lower)) {
      seenLower.add(lower)
      dedupedWords.push(word)
    }
  }

  let result = dedupedWords.join(' ').trim()

  // 5. Enforce length limit (maximum 100 characters)
  if (result.length > 100) {
    result = result.slice(0, 100).trim()
    // Clean up trailing cut word if cut in middle
    const lastSpace = result.lastIndexOf(' ')
    if (lastSpace > 20) {
      result = result.slice(0, lastSpace).trim()
    }
  }

  // 6. If result is empty or too short, use fallback
  if (!result || result.length < 2) {
    if (fallback && fallback.trim().length > 0) {
      return sanitizeStockQuery(fallback)
    }
    return 'documentary scene'
  }

  return result
}

/**
 * Normalizes query string for reliable cache keys and deduplication.
 * Strips casing, whitespace variation, and non-alphanumeric chars.
 */
export function normalizeStockQueryKey(query: string): string {
  return (query || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\sà-ỹ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Deduplicates an array of search queries after sanitizing and normalizing.
 * Preserves the original order of first appearance.
 */
export function dedupeStockQueries(queries: string[], fallback?: string): string[] {
  const result: string[] = []
  const seenKeys = new Set<string>()

  for (const raw of queries) {
    const sanitized = sanitizeStockQuery(raw, fallback)
    const key = normalizeStockQueryKey(sanitized)
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key)
      result.push(sanitized)
    }
  }

  return result
}
