/**
 * helpers.ts — Animation utility functions
 *
 * - secondsToFrames(): chuyển giây → frames theo fps
 * - getResponsiveFontSize(): font size dựa trên resolution + text length
 * - SAFE_AREA: padding constants theo aspect ratio
 * - normalizeWord(): xóa punctuation để match highlightWords
 * - hashStr(): deterministic pseudo-random từ string seed
 */

/**
 * Chuyển giây thành frames.
 * Không hardcode 30fps.
 */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps)
}

/**
 * Font size responsive theo resolution, số chữ và preset.
 *
 * @param wordCount - số từ trong phrase
 * @param width     - output width (px)
 * @param preset    - 'normal' | 'keyword' | 'impact'
 */
export function getResponsiveFontSize(
  wordCount: number,
  width: number,
  preset: 'normal' | 'keyword' | 'impact' = 'normal'
): number {
  // Base scale factor so với 1920px
  const scale = width / 1920

  // Base sizes (px) ở 1920×1080
  const BASE: Record<string, number> = {
    normal: 52,
    keyword: 64,
    impact: 78,
  }

  let size = BASE[preset] * scale

  // Giảm nếu text dài
  if (wordCount > 5) size *= 0.88
  if (wordCount > 8) size *= 0.80

  // Min/max clamp
  const MIN: Record<string, number> = { normal: 28, keyword: 36, impact: 48 }
  const MAX: Record<string, number> = { normal: 72, keyword: 88, impact: 110 }

  return Math.round(Math.min(MAX[preset], Math.max(MIN[preset], size)))
}

/**
 * Safe area constants (fraction 0-1) theo aspect ratio.
 * Dùng để padding caption tránh crop và tránh UI TikTok.
 */
export const SAFE_AREA = {
  '16:9': { horizontal: 0.06, top: 0.10, bottom: 0.10 },
  '9:16': { horizontal: 0.06, top: 0.12, bottom: 0.20 }, // bottom cao hơn vì TikTok UI
  '1:1':  { horizontal: 0.08, top: 0.10, bottom: 0.10 },
} as const

/** Lấy safe area theo width/height ratio */
export function getSafeArea(width: number, height: number) {
  const ratio = width / height
  if (ratio > 1.5) return SAFE_AREA['16:9']
  if (ratio < 0.75) return SAFE_AREA['9:16']
  return SAFE_AREA['1:1']
}

/**
 * Xóa punctuation ở đầu/cuối word để match highlightWords chính xác.
 * Ví dụ: "MONEY," → "MONEY"
 */
export function normalizeWord(word: string): string {
  return word.replace(/^[^a-zA-Z0-9$€£¥₫%]+|[^a-zA-Z0-9$€£¥₫%]+$/g, '').toUpperCase()
}

/**
 * Deterministic hash từ string → số [0, max).
 * Dùng để chọn preset variation mà không dùng Math.random().
 */
export function hashStr(str: string, max: number): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash % max
}
