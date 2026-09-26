/**
 * caption-planner.ts
 *
 * Phân tích script + transcript để lập CaptionPlan:
 *  - Gọi Gemini xác định activeRanges và sinh các CaptionPhrase
 *  - Fallback thuật toán nếu Gemini lỗi/hết quota
 *
 * Input:  transcript.json (words[]) + master-edit-plan.json (scenes + chapters)
 * Output: analysis/caption-plan.json
 *
 * Convention: code/biến tiếng Anh, comment tiếng Việt.
 */

import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { logger } from '../logger'
import type {
  CaptionPlan,
  CaptionPhrase,
  CaptionActiveRange,
  CaptionEmphasis,
  TranscriptWord,
  TranscriptResult
} from '../../../shared/types'

// ─── Types nội bộ ────────────────────────────────────────────────────────────

interface SceneRef {
  sceneId: string
  chapterId: string
  narrativeText: string
  visualIntent?: string
  startTime: number
  endTime: number
  isPatternInterrupt?: boolean
}

// ─── Fallback thuật toán ─────────────────────────────────────────────────────

/** Regex nhận diện số liệu gây sốc (dùng cho highlight + shock_stat detection) */
const SHOCK_STAT_REGEX = /\d+%|\$\d[\d,.]*|\d+[\d,.]* (năm|ngày|giờ|tháng|người|triệu|tỷ|billion|million|thousand|dollars|years|days)/i

/**
 * Hook window: first N seconds always have caption ON, maximum retention.
 * Used in both fallback algorithm AND Gemini prompt — must be the same value.
 */
export const HOOK_WINDOW_SECONDS = 30

// ─── Fallback thuật toán ─────────────────────────────────────────────────────────────

const SENTENCE_END_REGEX = /[.!?]$/
const PHRASE_BREAK_REGEX = /[,;:]$/
const MIN_PAUSE_FOR_SPLIT = 0.5  // giây
const MAX_WORDS_PER_PHRASE = 5
const DEFAULT_WORDS_PER_PHRASE = 3

/**
 * Nhóm words[] thành phrases theo pause, punctuation và readability.
 *
 * Rules (theo thứ tự ưu tiên):
 * 1. Kết thúc câu (.!?) → luôn split
 * 2. Pause > MIN_PAUSE_FOR_SPLIT → split
 * 3. Dấu phẩy/chấm phẩy → split nếu đã >= 2 words
 * 4. Max MAX_WORDS_PER_PHRASE words → force split
 *
 * KHÔNG rewrite text, KHÔNG bịa timestamp.
 */
function groupWordsIntoPhrases(
  words: TranscriptWord[],
  sceneId: string,
  emphasisType: CaptionEmphasis
): CaptionPhrase[] {
  const phrases: CaptionPhrase[] = []
  if (words.length === 0) return phrases

  let phraseIndex = 0
  let currentChunk: TranscriptWord[] = []

  const commitChunk = () => {
    if (currentChunk.length === 0) return

    const text = currentChunk.map(w => w.word).join(' ').trim()
    if (!text) { currentChunk = []; return }

    const highlightWords: string[] = []
    for (const w of currentChunk) {
      if (SHOCK_STAT_REGEX.test(w.word)) highlightWords.push(w.word)
    }

    const fontPreset = emphasisType === 'punchline' ? 'serif_italic' : 'sans_bold_caps'
    const baseColor = fontPreset === 'serif_italic' ? 'yellow_pale' : 'white'
    const boxHighlight = emphasisType === 'shock_stat' && highlightWords.length > 0
    const skew = emphasisType === 'list_transition'
    const presetType =
      emphasisType === 'hook' || emphasisType === 'punchline' ? 'big_statement' :
      emphasisType === 'list_transition' ? 'news_chyron' :
      emphasisType === 'shock_stat' ? 'data_note' :
      'big_statement'

    phrases.push({
      id: `cap_${sceneId}_${String(phraseIndex).padStart(3, '0')}`,
      sceneId,
      text,
      startTime: currentChunk[0].start,
      endTime: currentChunk[currentChunk.length - 1].end,
      emphasisType,
      highlightWords,
      presetType,
      style: { fontPreset, boxHighlight, skew, baseColor }
    })
    phraseIndex++
    currentChunk = []
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const nextWord = words[i + 1]

    currentChunk.push(word)

    const hasSentenceEnd = SENTENCE_END_REGEX.test(word.word)
    const hasPhraseBreak = PHRASE_BREAK_REGEX.test(word.word)
    const pauseToNext = nextWord ? nextWord.start - word.end : 999
    const atMaxWords = currentChunk.length >= MAX_WORDS_PER_PHRASE
    const atDefaultWords = currentChunk.length >= DEFAULT_WORDS_PER_PHRASE
    const isLast = !nextWord

    if (isLast || hasSentenceEnd || pauseToNext >= MIN_PAUSE_FOR_SPLIT ||
        (hasPhraseBreak && currentChunk.length >= 2) ||
        atMaxWords ||
        (atDefaultWords && pauseToNext >= 0.25)) {
      commitChunk()
    }
  }

  commitChunk()  // flush any remaining
  return phrases
}

/**
 * Fallback thuật toán: không cần Gemini.
 * - activeRanges mặc định: 0-25s (hook) + đầu mỗi chapter (list_transition)
 * - Phrase bằng cách nhóm words[] trong khoảng active
 */
function buildFallbackCaptionPlan(
  transcript: TranscriptResult,
  scenes: SceneRef[]
): CaptionPlan {
  logger.warn('[CaptionPlanner] Dùng fallback thuật toán — caption sẽ cơ bản, nên rà lại thủ công')

  const activeRanges: CaptionActiveRange[] = []
  const phrases: CaptionPhrase[] = []

  // Luôn có hook ở 0-HOOK_WINDOW_SECONDS đầu
  const hookEnd = Math.min(HOOK_WINDOW_SECONDS, transcript.duration)
  activeRanges.push({ startTime: 0, endTime: hookEnd, reason: 'hook' })

  // Thêm list_transition ở đầu mỗi chapter (scene đầu tiên của chapter)
  const seenChapters = new Set<string>()
  for (const scene of scenes) {
    if (!seenChapters.has(scene.chapterId)) {
      seenChapters.add(scene.chapterId)
      // Bỏ qua chapter đầu (đã cover bởi hook)
      if (scene.startTime > hookEnd + 2) {
        activeRanges.push({
          startTime: scene.startTime,
          endTime: Math.min(scene.startTime + 8, scene.endTime),
          reason: 'list_transition',
          chapterId: scene.chapterId
        })
      }
    }
  }

  // Lấy words trong từng activeRange và nhóm thành phrases
  const allWords = transcript.segments.flatMap(seg => seg.words ?? [])

  for (const range of activeRanges) {
    // Lấy scene liên quan
    const sceneInRange = scenes.find(
      s => s.startTime <= range.endTime && s.endTime >= range.startTime
    ) ?? scenes[0]

    const wordsInRange = allWords.filter(
      w => w.start >= range.startTime && w.end <= range.endTime
    )

    const rangeIdStr = `${range.reason}_${Math.round(range.startTime)}`
    const scenePhrases = groupWordsIntoPhrases(
      wordsInRange,
      sceneInRange?.sceneId ?? 'scene_unknown',
      range.reason
    )

    // Prefix ID với range để tránh duplicate
    for (const p of scenePhrases) {
      p.id = `cap_${rangeIdStr}_${p.id.split('_').pop()}`
      phrases.push(p)
    }
  }

  return {
    enabled: true,
    activeRanges,
    phrases,
    generatedByFallback: true,
    generationSource: 'fallback',
    generationReason: 'No Gemini API key or all Gemini models unavailable',
    hookWindowSeconds: HOOK_WINDOW_SECONDS,
    sourceDuration: transcript.duration,
    generatedAt: new Date().toISOString()
  }
}

// ─── Gemini prompt builder ────────────────────────────────────────────────────

/**
 * Xây dựng prompt gửi Gemini với danh sách scene + word timestamps.
 * Chỉ gửi scenes nằm trong khoảng activeRanges để giảm token.
 */
function buildGeminiPrompt(scenes: SceneRef[], allWords: TranscriptWord[]): string {
  // Chuẩn bị payload: scene + words khớp khung thời gian
  const scenePayload = scenes.map(scene => ({
    sceneId: scene.sceneId,
    chapterId: scene.chapterId,
    narrativeText: scene.narrativeText,
    visualIntent: scene.visualIntent ?? '',
    startTime: scene.startTime,
    endTime: scene.endTime,
    words: allWords.filter(w => w.start >= scene.startTime && w.end <= scene.endTime + 0.5)
  }))

  return `Bạn là chuyên gia dựng "dynamic kinetic captions" cho video documentary/listicle theo phong cách giữ chân người xem cao (giống các kênh YouTube top-tier dạng "X Foods/Things Disappearing...").

Nhiệm vụ: Với danh sách scene dưới đây (kèm narrativeText và khung thời gian), xác định:

BƯỚC A — Chọn khoảng thời gian BẬT caption (activeRanges), CHỈ theo 4 loại lý do sau, không bật tùy tiện:
1. "hook": 15-30 giây đầu tiên của toàn video (bất kể nội dung gì).
2. "list_transition": ngay tại câu chuyển sang một mục/số thứ tự mới trong danh sách.
3. "shock_stat": câu chứa số liệu, phần trăm, so sánh gây sốc, hoặc dữ kiện cốt lõi.
4. "punchline": câu đúc kết, cảnh báo, hoặc câu thúc giục hành động.

TUYỆT ĐỐI KHÔNG bật caption cho các đoạn giải thích sâu, phân tích nguyên nhân, mô tả lịch sử/bối cảnh dài dòng.

BƯỚC B — Chia narrativeText thành cụm từ 2-4 chữ, đồng bộ với word timestamps đã cung cấp. Không tự bịa timestamp.

BƯỚC C — Gán style cho mỗi phrase:
- emphasisType: kế thừa từ activeRange chứa nó
- highlightWords: từ khóa quan trọng nhất (số liệu, danh từ riêng, động từ mạnh) — tối đa 1-2 từ
- fontPreset: "sans_bold_caps" mặc định; "serif_italic" nếu đoạn có giọng chậm/tâm sự
- boxHighlight: true CHỈ khi emphasisType là "shock_stat" hoặc mang tính cảnh báo rõ rệt
- skew: true CHỈ khi emphasisType là "list_transition"
- baseColor: "white" mặc định, "yellow_pale" khi fontPreset là "serif_italic"

Dữ liệu đầu vào:
${JSON.stringify(scenePayload, null, 2)}

BƯỚC D — Với mỗi phrase, chọn presetType theo quy tắc:
- "hook" hoặc "punchline" → presetType = "big_statement" (chiếm trọn màn hình, tạo sức nặng tối đa)
- "list_transition" → presetType = "news_chyron" (cảm giác như 1 bản tin/headline mở màn cho mục mới), chia text thành 2 chyronSegments: segment đầu là mệnh đề chính (nền đỏ #E8352B, chữ trắng, font sans_bold_caps), segment sau là phần bổ nghĩa (nền trắng ngà #F5F0E6, chữ đen, font serif)
- "shock_stat" → MẶC ĐỊNH presetType = "data_note" (note nhỏ góc màn hình, không che B-roll đang phát) TRỪ KHI số liệu đó là luận điểm trung tâm của cả video thì mới dùng "big_statement". Với data_note, điền field "dataNote.label" là bản rút gọn số liệu dưới 8 từ.

QUY TẮC RIÊNG CHO 30 GIÂY ĐẦU (hook window, 0-30s):
Trong khoảng này, coi MỌI cụm từ được nói ra đều đáng hiện caption (không chỉ áp dụng 4 trigger như phần còn lại video) để tối đa hoá pattern interrupt. Luân phiên presetType giữa "big_statement" và "news_chyron" theo nhịp câu (không dùng "data_note" trong hook window — hook cần chiếm trọn màn hình, không phải note nhỏ). Ngoài hook window, áp dụng đúng 4 trigger đã nêu và cho phép nhiều khoảng trống hoàn toàn tắt caption.

Trả về CHÍNH XÁC JSON theo schema sau, không thêm text ngoài JSON:
{
  "enabled": true,
  "activeRanges": [
    { "startTime": 0, "endTime": 28.5, "reason": "hook" }
  ],
  "phrases": [
    {
      "id": "cap_001",
      "sceneId": "...",
      "text": "RIGHT NOW",
      "startTime": 0.0,
      "endTime": 0.6,
      "emphasisType": "hook",
      "highlightWords": ["NOW"],
      "presetType": "big_statement",
      "style": { "fontPreset": "sans_bold_caps", "boxHighlight": false, "skew": false, "baseColor": "white" }
    },
    {
      "id": "cap_002",
      "sceneId": "...",
      "text": "40% tăng mỗi năm",
      "startTime": 45.0,
      "endTime": 47.5,
      "emphasisType": "shock_stat",
      "highlightWords": ["40%"],
      "presetType": "data_note",
      "dataNote": { "label": "Tăng 40% từ 2023", "position": "bottom_right" },
      "style": { "fontPreset": "sans_bold_caps", "boxHighlight": true, "skew": false, "baseColor": "white" }
    }
  ]
}`
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface CaptionPlannerParams {
  projectDir: string
  apiKey: string
  model?: string
  forceRegenerate?: boolean
  onProgress?: (msg: string, pct: number) => void
}

/**
 * Chạy toàn bộ caption planner:
 * 1. Load transcript.json + master-edit-plan.json
 * 2. Gọi Gemini sinh CaptionPlan
 * 3. Fallback thuật toán nếu lỗi
 * 4. Lưu analysis/caption-plan.json
 */
export async function generateCaptionPlan(params: CaptionPlannerParams): Promise<CaptionPlan> {
  const { projectDir, apiKey, forceRegenerate = false } = params
  const progress = params.onProgress ?? (() => {})
  const modelId = params.model ?? 'gemini-3.8-flash'

  const captionPlanPath = path.join(projectDir, 'analysis', 'caption-plan.json')

  // Nếu đã có plan và không bắt buộc tạo lại → trả về cache
  if (!forceRegenerate && fs.existsSync(captionPlanPath)) {
    logger.info('[CaptionPlanner] Dùng caption-plan.json đã cache')
    return JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8')) as CaptionPlan
  }

  // Load transcript
  progress('Đang tải transcript...', 0.05)
  const transcriptPath = path.join(projectDir, 'analysis', 'transcript.json')
  if (!fs.existsSync(transcriptPath)) {
    throw new Error('Chưa có transcript.json — chạy bước Transcription trước')
  }
  const transcript: TranscriptResult = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'))

  // Load master-edit-plan
  progress('Đang tải edit plan...', 0.10)
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) {
    throw new Error('Chưa có master-edit-plan.json — chạy bước Planning trước')
  }
  const editPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))

  // Flatten scenes từ edit plan
  const scenes: SceneRef[] = []
  for (const chapter of (editPlan.chapters ?? [])) {
    const chapterId = chapter.id ?? chapter.chapterId ?? `ch_${scenes.length}`
    const sequences = chapter.sequences ?? chapter.chapters_seq ?? []
    for (const seq of sequences) {
      for (const scene of (seq.scenes ?? [])) {
        scenes.push({
          sceneId: scene.id ?? scene.sceneId ?? `scene_${scenes.length}`,
          chapterId,
          narrativeText: scene.narrativeText ?? scene.narration ?? '',
          visualIntent: scene.visualIntent ?? '',
          startTime: scene.startTime ?? 0,
          endTime: scene.endTime ?? (scene.startTime ?? 0) + (scene.duration ?? 5),
          isPatternInterrupt: scene.isPatternInterrupt ?? false
        })
      }
    }
  }

  logger.info(`[CaptionPlanner] ${scenes.length} scenes, ${transcript.segments.length} segments`)
  const allWords = transcript.segments.flatMap(seg => seg.words ?? [])

  // Thử Gemini với fallback chain
  const fallbackModels = [modelId, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-1.5-flash-latest']
    .filter((v, i, a) => a.indexOf(v) === i)

  let plan: CaptionPlan | null = null

  for (let attempt = 0; attempt < fallbackModels.length; attempt++) {
    const currentModel = fallbackModels[attempt]
    try {
      progress(
        attempt === 0
          ? `Đang gửi lên Gemini (${currentModel})...`
          : `Thử lại với ${currentModel}...`,
        0.20 + attempt * 0.10
      )

      const ai = new GoogleGenAI({ apiKey: apiKey.trim(), httpOptions: { apiVersion: 'v1beta' } })
      const prompt = buildGeminiPrompt(scenes, allWords)

      const response = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 }
      })

      const rawJson = response.text ?? ''
      const parsed = JSON.parse(rawJson) as CaptionPlan
      parsed.generatedByFallback = false
      parsed.generationSource = 'gemini'
      parsed.generationModel = currentModel
      parsed.hookWindowSeconds = HOOK_WINDOW_SECONDS
      parsed.sourceDuration = transcript.duration
      parsed.generatedAt = new Date().toISOString()

      // Validate tối thiểu
      if (!Array.isArray(parsed.phrases) || !Array.isArray(parsed.activeRanges)) {
        throw new Error('Response JSON thiếu phrases hoặc activeRanges')
      }

      // Sanitize: clamp timestamps, dedup IDs, sort, ensure hook range
      progress('Đang validate kết quả Gemini...', 0.60 + attempt * 0.05)
      sanitizePlan(parsed, transcript.duration)

      plan = parsed
      logger.info(`[CaptionPlanner] Gemini thành công với model ${currentModel}, ${plan.phrases.length} phrases`)
      break
    } catch (err) {
      logger.warn(`[CaptionPlanner] ${currentModel} thất bại: ${String(err)}`)
    }
  }

  // Fallback thuật toán nếu tất cả model đều lỗi
  if (!plan) {
    progress('Gemini không khả dụng — dùng fallback thuật toán...', 0.70)
    plan = buildFallbackCaptionPlan(transcript, scenes)
  }

  // Lưu file (atomic: write temp then rename để tránh corrupt)
  progress('Đang lưu caption-plan.json...', 0.90)
  fs.mkdirSync(path.join(projectDir, 'analysis'), { recursive: true })
  const tmpPath = captionPlanPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(plan, null, 2), 'utf-8')
  fs.renameSync(tmpPath, captionPlanPath)

  logger.info(`[CaptionPlanner] Đã lưu ${plan.phrases.length} phrases vào caption-plan.json`)
  progress('Hoàn thành!', 1.0)

  return plan
}

// ─── Sanitize helper ──────────────────────────────────────────────────────────

/**
 * sanitizePlan — post-process plan sau Gemini:
 * - Clamp timestamps vào [0, sourceDuration]
 * - Dedup phrase IDs
 * - Remove invalid ranges (endTime <= startTime)
 * - Sort ranges và phrases theo startTime
 * - Ensure hook range covers 0→min(HOOK_WINDOW_SECONDS, sourceDuration)
 */
function sanitizePlan(plan: CaptionPlan, sourceDuration: number): void {
  const dur = sourceDuration

  // 1. Clamp + deduplicate phrase IDs
  const seenIds = new Set<string>()
  let autoIdx = 0
  for (const p of plan.phrases) {
    p.startTime = Math.max(0, Math.min(p.startTime, dur))
    p.endTime = Math.max(p.startTime + 0.1, Math.min(p.endTime, dur))
    if (!p.id || seenIds.has(p.id)) {
      p.id = `cap_${String(++autoIdx).padStart(4, '0')}`
      logger.warn(`[CaptionPlanner] Duplicate/missing phrase ID fixed → ${p.id}`)
    }
    seenIds.add(p.id)
  }

  // 2. Remove invalid ranges
  const validRanges = plan.activeRanges.filter(r => {
    const valid = r.endTime > r.startTime && r.startTime >= 0 && r.endTime <= dur + 1
    if (!valid) logger.warn(`[CaptionPlanner] Removed invalid range ${r.startTime}→${r.endTime}`)
    return valid
  })
  plan.activeRanges = validRanges

  // 3. Clamp range boundaries
  for (const r of plan.activeRanges) {
    r.startTime = Math.max(0, r.startTime)
    r.endTime = Math.min(r.endTime, dur)
  }

  // 4. Sort
  plan.activeRanges.sort((a, b) => a.startTime - b.startTime)
  plan.phrases.sort((a, b) => a.startTime - b.startTime)

  // 5. Ensure hook range covers 0→hookEnd
  const hookEnd = Math.min(HOOK_WINDOW_SECONDS, dur)
  const hookRange = plan.activeRanges.find(r => r.reason === 'hook')
  if (!hookRange) {
    logger.warn('[CaptionPlanner] Gemini missing hook range — adding default 0→' + hookEnd)
    plan.activeRanges.unshift({ startTime: 0, endTime: hookEnd, reason: 'hook' })
    plan.activeRanges.sort((a, b) => a.startTime - b.startTime)
  } else if (hookRange.endTime < hookEnd - 0.5) {
    logger.warn(`[CaptionPlanner] Gemini hook range ends at ${hookRange.endTime}s — extending to ${hookEnd}s`)
    hookRange.endTime = hookEnd
  }
}

/**
 * Load CaptionPlan đã có từ file JSON (không tính toán lại).
 * Trả về null nếu chưa generate.
 */
export function loadCaptionPlan(projectDir: string): CaptionPlan | null {
  const planPath = path.join(projectDir, 'analysis', 'caption-plan.json')
  if (!fs.existsSync(planPath)) return null
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf-8')) as CaptionPlan
  } catch {
    return null
  }
}

/**
 * Lưu CaptionPlan (dùng sau khi user chỉnh sửa thủ công từ UI).
 */
export function saveCaptionPlan(projectDir: string, plan: CaptionPlan): void {
  const planPath = path.join(projectDir, 'analysis', 'caption-plan.json')
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  logger.info(`[CaptionPlanner] Đã lưu thủ công caption-plan.json (${plan.phrases.length} phrases)`)
}
