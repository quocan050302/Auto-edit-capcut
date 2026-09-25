/**
 * ass-generator.ts
 *
 * Chuyển CaptionPlan (JSON thuần) thành file .ass (Advanced SubStation Alpha)
 * để FFmpeg burn vào video qua bộ lọc `ass=<path>`.
 *
 * Thuần thuật toán — KHÔNG gọi AI. Hỗ trợ:
 *  - Animation "bouncy scale pop" via \t override tags
 *  - Highlight word đổi màu vàng trong câu
 *  - Box highlight (hình chữ nhật đỏ phía sau, Layer 0)
 *  - Skew (bẻ góc trục X) cho list_transition
 *  - Hai font preset: SansBoldCaps & SerifItalic
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { CaptionPlan, CaptionPhrase } from '../../../shared/types'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Độ phân giải video chuẩn — ảnh hưởng tới PlayResX/Y và tính toán vị trí box */
const PLAY_RES_X = 1920
const PLAY_RES_Y = 1080

/**
 * Màu ASS dùng định dạng BGR (Blue-Green-Red), không phải RGB.
 * &HAABBGGRR& — AA = alpha (00 = không trong suốt)
 */
const COLORS = {
  white:       '&H00FFFFFF&',   // trắng thuần
  yellowLime:  '&H0000E8FF&',   // vàng chanh (BGR: 00, E8, FF → RGB: FF, E8, 00)
  yellowPale:  '&H0088E8FF&',   // vàng nhạt (cho serif_italic)
  red:         '&H000000CC&',   // đỏ cho box highlight
  black:       '&H00000000&',   // viền đen
  shadowBlack: '&H80000000&',   // đen 50% alpha cho shadow
  transparent: '&H00000000&',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Chuyển giây (float) thành định dạng ASS timestamp: H:MM:SS.CS
 * CS = centiseconds (1/100 giây)
 */
function toAssTime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  const cs = Math.round((secs % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * Tạo animation "bouncy scale pop" bằng override tags \t.
 * Sequence: scale 88% → (0–80ms) bung 105% → (80–160ms) về 100%
 * Không dùng \an (alignment) vì đã set trong Style.
 */
function bouncyScaleTag(): string {
  return '{\\fscx88\\fscy88\\t(0,80,\\fscx105\\fscy105)\\t(80,160,\\fscx100\\fscy100)}'
}

/**
 * Escape dấu { } trong text để không bị ASS parser hiểu nhầm là override tag.
 */
function escapeAssText(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

/**
 * Sinh phần text ASS có highlight word đổi màu vàng chanh.
 * Ví dụ: text="RIGHT NOW", highlightWords=["NOW"]
 * → "{tags}RIGHT {\c&H0000E8FF&}NOW{\c&HFFFFFF&}"
 */
function buildTextWithHighlights(
  text: string,
  highlightWords: string[],
  baseColorCode: string,
  prefixTags: string
): string {
  if (!highlightWords || highlightWords.length === 0) {
    return `${prefixTags}${escapeAssText(text.toUpperCase())}`
  }

  // Tách text thành các token, giữ khoảng trắng
  const words = text.split(/(\s+)/)
  const upperHighlights = highlightWords.map(w => w.toUpperCase())
  let result = prefixTags

  for (const token of words) {
    const upperToken = token.trim().toUpperCase()
    if (upperToken && upperHighlights.includes(upperToken)) {
      // Từ được highlight — đổi màu vàng, sau đó reset về màu gốc
      result += `{\\c${COLORS.yellowLime}}${escapeAssText(token.toUpperCase())}{\\c${baseColorCode}}`
    } else {
      result += escapeAssText(token.toUpperCase())
    }
  }
  return result
}

// ─── ASS Header ───────────────────────────────────────────────────────────────

/**
 * Tạo phần header cố định của file ASS.
 * Bao gồm [Script Info], [V4+ Styles] với 3 style:
 *   - SansBoldCaps: Montserrat Black, dùng cho hook/shock_stat/punchline
 *   - SerifItalic: Playfair Display Italic, dùng cho đoạn tâm sự/chậm
 *   - BoxRed: style ẩn dùng để vẽ hộp màu đỏ ở Layer 0
 */
function buildAssHeader(fontsDir: string): string {
  return [
    '[Script Info]',
    'Title: Dynamic Kinetic Captions — Auto-Generated',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    '',
    '[V4+ Styles]',
    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
    //         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,
    //         Alignment, MarginL, MarginR, MarginV, Encoding
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // SansBoldCaps: trắng, viền đen 3px, shadow, alignment=2 (bottom-center)
    `Style: SansBoldCaps,Montserrat Black,96,${COLORS.white},${COLORS.white},${COLORS.black},${COLORS.shadowBlack},1,0,0,0,100,100,0,0,1,3,2,2,0,0,120,1`,
    // SerifItalic: vàng nhạt, viền nhẹ, alignment=2
    `Style: SerifItalic,Playfair Display,84,${COLORS.yellowPale},${COLORS.yellowPale},${COLORS.black},${COLORS.shadowBlack},0,1,0,0,100,100,0,0,1,2,2,2,0,0,120,1`,
    // BoxRed: style ẩn dùng vẽ hình chữ nhật đỏ, không có text thật
    `Style: BoxRed,Arial,1,${COLORS.red},${COLORS.red},${COLORS.red},${COLORS.red},0,0,0,0,100,100,0,0,3,0,0,2,0,0,0,1`,
    '',
    // Khai báo font directory để FFmpeg tìm font
    `; FontsDir: ${fontsDir}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
}

// ─── Phrase → Dialogue Lines ──────────────────────────────────────────────────

/**
 * Tính kích thước box highlight ước tính dựa trên độ dài text.
 * Đây là ước tính heuristic — ASS không có API đo text width chính xác.
 * FontSize 96px Montserrat, mỗi ký tự ≈ 58px width trung bình sau uppercase.
 */
function estimateBoxWidth(text: string): number {
  const charCount = text.length
  return Math.min(PLAY_RES_X - 100, Math.max(300, charCount * 58 + 80))
}

/**
 * Sinh dòng Dialogue Layer 0 (box màu đỏ phía sau) dùng ASS drawing.
 * Box vẽ ở vị trí phía dưới màn hình, căn giữa theo chiều ngang.
 */
function buildBoxDialogue(phrase: CaptionPhrase): string {
  const startT = toAssTime(phrase.startTime)
  const endT = toAssTime(phrase.endTime)
  const boxW = estimateBoxWidth(phrase.text)
  const boxH = 120
  const boxX = Math.round((PLAY_RES_X - boxW) / 2)
  const boxY = PLAY_RES_Y - 120 - 20  // 20px trên margin bottom

  // ASS drawing: m <x0> <y0> l <x1> <y0> <x1> <y1> <x0> <y1>
  const drawCmd = `m ${boxX} ${boxY} l ${boxX + boxW} ${boxY} l ${boxX + boxW} ${boxY + boxH} l ${boxX} ${boxY + boxH}`

  return `Dialogue: 0,${startT},${endT},BoxRed,,0,0,0,,{\\p1\\c${COLORS.red}\\bord0\\shad0\\pos(0,0)}${drawCmd}{\\p0}`
}

/**
 * Sinh dòng Dialogue Layer 1 (text caption chính) với đầy đủ animation tags.
 */
function buildTextDialogue(phrase: CaptionPhrase): string {
  const startT = toAssTime(phrase.startTime)
  const endT = toAssTime(phrase.endTime)

  const styleName = phrase.style.fontPreset === 'serif_italic' ? 'SerifItalic' : 'SansBoldCaps'
  const baseColor = phrase.style.fontPreset === 'serif_italic' ? COLORS.yellowPale : COLORS.white

  // Xây dựng prefix tags
  const tagParts: string[] = []

  // Animation bouncy scale pop
  tagParts.push('\\fscx88\\fscy88\\t(0,80,\\fscx105\\fscy105)\\t(80,160,\\fscx100\\fscy100)')

  // Skew cho list_transition
  if (phrase.style.skew) {
    tagParts.push('\\fax0.3')
  }

  // Màu base
  tagParts.push(`\\c${baseColor}`)

  const prefixTags = `{${tagParts.join('')}}`

  const textContent = buildTextWithHighlights(
    phrase.text,
    phrase.highlightWords ?? [],
    baseColor,
    prefixTags
  )

  return `Dialogue: 1,${startT},${endT},${styleName},,0,0,0,,${textContent}`
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Sinh file .ass từ CaptionPlan và ghi ra outputPath.
 *
 * @param captionPlan - Kế hoạch caption đã được generate (AI hoặc fallback)
 * @param outputPath  - Đường dẫn tuyệt đối file .ass sẽ ghi ra
 * @param fontsDir    - Thư mục chứa font assets (để khai báo trong comment header)
 */
export function generateAssFile(
  captionPlan: CaptionPlan,
  outputPath: string,
  fontsDir: string
): void {
  logger.info(`[CaptionASS] Đang sinh file .ass: ${outputPath}`)
  logger.info(`[CaptionASS] ${captionPlan.phrases.length} phrases | fontsDir: ${fontsDir}`)

  // Tạo thư mục chứa file .ass nếu chưa có
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const lines: string[] = [buildAssHeader(fontsDir)]

  // Duyệt từng phrase, sinh các dòng Dialogue tương ứng
  for (const phrase of captionPlan.phrases) {
    // Nếu có box highlight → vẽ hộp đỏ ở Layer 0 trước
    if (phrase.style.boxHighlight) {
      lines.push(buildBoxDialogue(phrase))
    }
    // Dòng text chính ở Layer 1
    lines.push(buildTextDialogue(phrase))
  }

  const assContent = lines.join('\n') + '\n'
  fs.writeFileSync(outputPath, assContent, { encoding: 'utf-8' })

  logger.info(`[CaptionASS] Đã ghi ${captionPlan.phrases.length} phrases vào ${outputPath}`)
}

/**
 * Sinh file .ass mẫu (test) với dữ liệu hardcode để kiểm tra animation trước.
 * Dùng để test FFmpeg burn-in độc lập mà không cần chạy toàn bộ pipeline.
 */
export function generateTestAssFile(outputPath: string, fontsDir: string): void {
  logger.info(`[CaptionASS] Sinh file .ass TEST tại: ${outputPath}`)

  const testPlan: CaptionPlan = {
    enabled: true,
    activeRanges: [
      { startTime: 0, endTime: 30, reason: 'hook' },
      { startTime: 30, endTime: 60, reason: 'shock_stat' }
    ],
    phrases: [
      {
        id: 'test_001',
        sceneId: 'scene_1',
        text: 'RIGHT NOW',
        startTime: 0.0,
        endTime: 1.0,
        emphasisType: 'hook',
        highlightWords: ['NOW'],
        style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
      },
      {
        id: 'test_002',
        sceneId: 'scene_1',
        text: 'MILLIONS ARE',
        startTime: 1.1,
        endTime: 2.0,
        emphasisType: 'hook',
        highlightWords: [],
        style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
      },
      {
        id: 'test_003',
        sceneId: 'scene_2',
        text: '47% GONE',
        startTime: 2.1,
        endTime: 3.5,
        emphasisType: 'shock_stat',
        highlightWords: ['47%'],
        style: { fontPreset: 'sans_bold_caps', boxHighlight: true, skew: false, baseColor: 'white' }
      },
      {
        id: 'test_004',
        sceneId: 'scene_3',
        text: 'Number Nine',
        startTime: 3.6,
        endTime: 4.8,
        emphasisType: 'list_transition',
        highlightWords: ['Nine'],
        style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: true, baseColor: 'white' }
      },
      {
        id: 'test_005',
        sceneId: 'scene_4',
        text: 'quietly disappearing',
        startTime: 4.9,
        endTime: 6.5,
        emphasisType: 'punchline',
        highlightWords: ['disappearing'],
        style: { fontPreset: 'serif_italic', boxHighlight: false, skew: false, baseColor: 'yellow_pale' }
      }
    ],
    generatedByFallback: false,
    generatedAt: new Date().toISOString()
  }

  generateAssFile(testPlan, outputPath, fontsDir)
}
