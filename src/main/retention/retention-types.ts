/**
 * retention-types.ts — Retention Enhancement types
 *
 * TẤT CẢ fields là OPTIONAL.
 * Project cũ không có những field này vẫn render bình thường.
 * Retention engine chỉ là additive metadata layer.
 */

// ─── Visual Beat ──────────────────────────────────────────────────────────────

/**
 * VisualBeat — sub-beat visual trong một scene.
 * Không chia scene — chỉ chia cách visual được presented.
 * Parent scene timing không bao giờ thay đổi.
 */
export interface VisualBeat {
  id: string
  sceneId: string

  /** Relative start/end seconds bên trong scene (0 = scene start) */
  relativeStart: number
  relativeEnd: number

  type:
    | 'main_shot'       // full frame stock
    | 'detail_crop'     // semantic zoom vào detail của cùng asset
    | 'secondary_asset' // asset khác cùng context
    | 'proof_visual'    // number/date/location graphic
    | 'text_emphasis'   // kinetic caption emphasis (phối hợp với caption engine)
    | 'pattern_interrupt' // visual reset

  purpose:
    | 'establish'       // giới thiệu scene
    | 'explain'         // minh họa narration
    | 'emphasize'       // nhấn mạnh điểm chính
    | 'reset_attention' // tránh monotony
    | 'reveal'          // moment reveal
    | 'transition'      // chuyển ý

  sourceAssetId?: string  // reuse primary asset hoặc secondary

  /** Semantic crop — chỉ dùng khi có subject xác định rõ */
  crop?: {
    x: number         // -1..1 (center offset)
    y: number         // -1..1 (center offset)
    scale: number     // 1.0 = full, 1.15 = 15% zoom — MAX 1.25
  }

  /** FFmpeg vf zoom filter string đã tính sẵn (computed khi render) */
  zoomFilter?: string

  transitionIn?: 'cut' | 'dissolve' | 'fade'
  transitionOut?: 'cut' | 'dissolve' | 'fade'
}

// ─── Proof Visual ─────────────────────────────────────────────────────────────

/**
 * ProofVisual — graphic thể hiện số liệu/ngày tháng/địa điểm từ narration.
 * CHỈ dùng data có trong source — không bịa.
 */
export type ProofVisualPosition = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'
export type ProofVisualStylePreset = 'date_card' | 'money_card' | 'stat_card' | 'location_tag' | 'doc_callout'

/**
 * ProofVisual — graphic thể hiện số liệu/ngày tháng/địa điểm từ narration.
 * CHỈ dùng data có trong source — không bịa.
 */
export interface ProofVisual {
  type: 'number_card' | 'date_card' | 'location_label' | 'stat_emphasis' | 'document_callout'
  primaryText: string     // Ví dụ: "$12,000" | "1963" | "Montana"
  subLabel?: string       // Ví dụ: "AVERAGE COST" — chỉ nếu có trong source
  sourceField: string     // Field nào trong narration/context cung cấp data này
  relativeTime: number    // Relative start seconds trong scene
  durationSecs: number    // Bao lâu hiện
  // ── Optional extended fields (backward compatible) ─────────────────────────
  position?: ProofVisualPosition     // Corner position — default bottom_right
  stylePreset?: ProofVisualStylePreset
  icon?: 'location' | 'calendar' | 'money' | 'stat' | 'none'
  confidence?: number                 // 0–1, dùng cho QA flags
  // ── Absolute timing (computed at render time) ──────────────────────────────
  absoluteStartTime?: number          // scene.startTime + relativeTime
  absoluteEndTime?: number            // absoluteStartTime + durationSecs
}

// ─── Pattern Interrupt ────────────────────────────────────────────────────────

export type PatternInterruptType =
  | 'kinetic_text'
  | 'data_card'
  | 'proof_visual'
  | 'quick_crop'
  | 'secondary_asset'
  | 'chapter_card'
  | 'brief_pause'   // brief_blackout → brief_pause (không blackout hoàn toàn)
  | 'audio_dip_reveal'

export interface PatternInterruptPlan {
  type: PatternInterruptType
  triggerReason: string   // log/debug
  relativeStart: number
  durationSecs: number
}

// ─── Retention Decision ───────────────────────────────────────────────────────

/**
 * Kết quả cuối của retention resolver cho một scene.
 * Được tính bởi resolveSceneRetention() — không stored bắt buộc.
 */
export interface RetentionDecision {
  sceneId: string
  visualBeats: VisualBeat[]
  proofVisual?: ProofVisual
  patternInterrupt?: PatternInterruptPlan
  visualLoadScore: number   // tổng visual load — overload guard
  audioLoadScore: number    // tổng audio load — phối hợp với audio plan
  transitionType?: 'cut' | 'dissolve' | 'fade'
  notes: string[]           // log messages
}

// ─── Retention QA Flag ────────────────────────────────────────────────────────

export type RetentionQaFlagType =
  | 'LONG_STATIC_VISUAL'
  | 'REPEATED_SHOT_TYPE'
  | 'REPEATED_VISUAL_MOTIF'
  | 'NO_VISUAL_RESET'
  | 'OVEREDITED'
  | 'EFFECT_OVERLOAD'
  | 'TOO_MANY_STRONG_CUTS'
  | 'LOW_RELEVANCE_SECONDARY_ASSET'
  | 'MISSING_PROOF_OPPORTUNITY'
  | 'DUPLICATE_PROOF_CAPTION'
  | 'PROOF_OVERLAPS_STRONG_CAPTION'
  | 'PROOF_TOO_FREQUENT'
  | 'PROOF_TEXT_TOO_LONG'
  | 'LOCATION_LOW_CONFIDENCE'

export interface RetentionQaFlag {
  sceneId: string
  flagType: RetentionQaFlagType
  severity: 'info' | 'warning' | 'error'
  description: string
  suggestion?: string
}

// ─── Retention Context (state tracking) ──────────────────────────────────────

/**
 * Context mutable được update sequentially khi resolve từng scene.
 * Dùng để track variation memory — không cần database.
 */
export interface RetentionContext {
  previousShotType: string
  previousTransitionType: string
  previousPatternInterruptType: string | null
  previousCropScale: number
  timeSinceLastHumanShot: number      // seconds
  timeSinceLastProofVisual: number    // seconds
  timeSinceLastStrongEffect: number   // seconds
  consecutiveSameShot: number
  consecutiveStrongEffect: number
  accumulatedVisualLoad: number
  sceneIndex: number
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export type RetentionLevel = 'low' | 'balanced' | 'high'

export interface RetentionSettings {
  enabled: boolean
  level: RetentionLevel
  proofVisualsEnabled: boolean
  semanticCropEnabled: boolean
  patternInterruptEnabled: boolean
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  enabled: true,
  level: 'balanced',
  proofVisualsEnabled: true,
  semanticCropEnabled: true,
  patternInterruptEnabled: true,
}
