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
 * Nhóm words[] thành cụm 2-4 từ theo khoảng thời gian.
 * Không nhóm qua dấu ngắt câu lớn (khoảng cách > 0.6s = nghỉ tự nhiên).
 */
function groupWordsIntoPhrases(
  words: TranscriptWord[],
  sceneId: string,
  emphasisType: CaptionEmphasis,
  chunkSize: number = 3
): CaptionPhrase[] {
  const phrases: CaptionPhrase[] = []
  let i = 0
  let phraseIndex = 0

  while (i < words.length) {
    // Lấy chunk 2-4 từ
    const chunk = words.slice(i, i + chunkSize)
    if (chunk.length === 0) break

    const text = chunk.map(w => w.word).join(' ').trim()
    if (!text) { i += chunkSize; continue }

    const startTime = chunk[0].start
    const endTime = chunk[chunk.length - 1].end

    // Tìm highlight words: từ nào là số liệu hoặc từ khóa
    const highlightWords: string[] = []
    for (const w of chunk) {
      if (SHOCK_STAT_REGEX.test(w.word)) {
        highlightWords.push(w.word)
      }
    }

    // Style mặc định: sans_bold_caps, trừ punchline dùng serif_italic
    const fontPreset = emphasisType === 'punchline' ? 'serif_italic' : 'sans_bold_caps'
    const baseColor = fontPreset === 'serif_italic' ? 'yellow_pale' : 'white'
    const boxHighlight = emphasisType === 'shock_stat' && highlightWords.length > 0
    const skew = emphasisType === 'list_transition'

    phrases.push({
      id: `cap_${sceneId}_${String(phraseIndex).padStart(3, '0')}`,
      sceneId,
      text,
      startTime,
      endTime,
      emphasisType,
      highlightWords,
      style: { fontPreset, boxHighlight, skew, baseColor }
    })

    phraseIndex++

    // Nếu khoảng cách giữa từ cuối chunk và từ tiếp theo > 0.6s → break chunk tự nhiên
    const nextWord = words[i + chunkSize]
    if (nextWord && nextWord.start - endTime > 0.6) {
      i += chunkSize
      continue
    }

    i += chunkSize
  }

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

  // Luôn có hook ở 0-25s đầu
  const hookEnd = Math.min(25, transcript.duration)
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
      "highlightWords": [],
      "style": { "fontPreset": "sans_bold_caps", "boxHighlight": false, "skew": false, "baseColor": "white" }
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
      parsed.generatedAt = new Date().toISOString()

      // Validate tối thiểu
      if (!Array.isArray(parsed.phrases) || !Array.isArray(parsed.activeRanges)) {
        throw new Error('Response JSON thiếu phrases hoặc activeRanges')
      }

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

  // Lưu file
  progress('Đang lưu caption-plan.json...', 0.90)
  fs.mkdirSync(path.join(projectDir, 'analysis'), { recursive: true })
  fs.writeFileSync(captionPlanPath, JSON.stringify(plan, null, 2), 'utf-8')

  logger.info(`[CaptionPlanner] Đã lưu ${plan.phrases.length} phrases vào caption-plan.json`)
  progress('Hoàn thành!', 1.0)

  return plan
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
