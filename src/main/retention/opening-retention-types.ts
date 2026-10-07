export interface OpeningIntensitySegment {
  startTime: number
  endTime: number
  intensity: number // 0-1
}

export interface OpeningRetentionEvent {
  id: string
  sourceSceneIndex: number
  startTime: number
  duration: number
  type:
    | 'hook-headline'
    | 'question-card'
    | 'stat-punch'
    | 'location-reveal'
    | 'comparison-reveal'
    | 'document-highlight'
    | 'keyword-emphasis'
    | 'transition-accent'
  priority: 'critical' | 'high' | 'medium' | 'low'
  primaryText?: string
  secondaryText?: string
  animationPreset?: string
  sourceEvidence:
    | 'narration'
    | 'caption'
    | 'proof-visual'
    | 'visual-grammar'
    | 'retention-plan'
    | 'global-context'
  confidence: number
}

export interface OpeningTransitionHint {
  fromSceneIndex: number
  toSceneIndex: number
  boundaryTime: number
  type:
    | 'cut'
    | 'fade'
    | 'dissolve'
    | 'wipeleft'
    | 'wiperight'
    | 'slideleft'
    | 'slideright'
    | 'smoothleft'
    | 'smoothright'
    | 'circleopen'
    | 'circleclose'
    | 'pixelize'
    | 'zoomin'
  strength: 'normal' | 'strong'
  reason: string
}

export interface OpeningMotionHint {
  sceneIndex: number
  startTime: number
  type: 'micro-push' | 'micro-pull' | 'detail-crop' | 'quick-reset' | 'hold'
  intensity: 'subtle' | 'medium' | 'strong'
  reason: string
}

export interface OpeningSfxEvent {
  id: string
  sceneIndex: number
  absoluteTime: number
  type:
    | 'soft-whoosh'
    | 'reverse-whoosh'
    | 'air-swish'
    | 'digital-scan'
    | 'soft-pulse'
    | 'soft-impact'
    | 'clock-tick'
    | 'subtle-riser'
  volumeDb: number
  duration: number
  priority: 'critical' | 'high' | 'medium'
  reason: string
}

export interface OpeningRetentionPlan {
  schemaVersion: number
  generatedAt: string
  inputHash: string
  windowSecs: number
  enabled: boolean
  intensityCurve: OpeningIntensitySegment[]
  events: OpeningRetentionEvent[]
  transitionHints: OpeningTransitionHint[]
  motionHints: OpeningMotionHint[]
  sfxEvents: OpeningSfxEvent[]
  summary: {
    overlays: number
    transitions: number
    motionAccents: number
    sfxCues: number
  }
}
