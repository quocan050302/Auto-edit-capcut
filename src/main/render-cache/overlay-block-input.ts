/**
 * overlay-block-input.ts
 *
 * Performance optimization: selects only the overlay elements (captions, proof visuals,
 * visual grammar, opening retention) that can affect the current render block interval [startFrame, endFrameExclusive).
 *
 * Critical requirements preserved:
 *  - Absolute timeline is untouched: timestamps remain global (never reset to 0).
 *  - Global original index is preserved via phrase.originalIndex for deterministic caption animation seeds.
 *  - Input objects are never mutated (pure function returning immutable slices).
 *  - Boundary frame precision: an item active at even a single frame in the block is included.
 */

import type { CaptionPlan, CaptionPhrase, VisualGrammarDecision } from '../../../shared/types'
import type { ProofVisual } from '../retention/retention-types'
import type { OpeningRetentionEvent } from '../retention/opening-retention-types'

export interface BlockOverlayProps {
  captionPlan: CaptionPlan
  proofVisuals: ProofVisual[]
  visualGrammar: VisualGrammarDecision[]
  openingEvents: OpeningRetentionEvent[]
  totalItemsCount: number
}

export function selectOverlayPropsForBlock(params: {
  captionPlan: CaptionPlan
  proofVisuals?: ProofVisual[]
  visualGrammar?: VisualGrammarDecision[]
  openingEvents?: OpeningRetentionEvent[]
  startFrame: number
  endFrameExclusive: number
  fps: number
}): BlockOverlayProps {
  const { captionPlan, proofVisuals, visualGrammar, openingEvents, startFrame, endFrameExclusive, fps } = params

  if (endFrameExclusive <= startFrame || fps <= 0) {
    return {
      captionPlan: { ...captionPlan, phrases: [] },
      proofVisuals: [],
      visualGrammar: [],
      openingEvents: [],
      totalItemsCount: 0
    }
  }

  // Exact inclusive frame bounds rendered in Remotion: [startFrame, endFrameExclusive - 1]
  const lastRenderedFrame = endFrameExclusive - 1
  const blockStartTime = startFrame / fps
  const blockEndTime = lastRenderedFrame / fps

  // EPSILON for floating point boundary equality (e.g. 1/30s = 0.033333...)
  const EPS = 1e-5

  // 1. Captions: active if currentTime >= phrase.startTime && currentTime <= phrase.endTime
  // Intersects if phrase.startTime <= blockEndTime && phrase.endTime >= blockStartTime
  const blockPhrases: CaptionPhrase[] = []
  const allPhrases = captionPlan?.phrases ?? []
  for (let i = 0; i < allPhrases.length; i++) {
    const p = allPhrases[i]
    if (p.startTime <= blockEndTime + EPS && p.endTime >= blockStartTime - EPS) {
      blockPhrases.push({
        ...p,
        originalIndex: p.originalIndex ?? i
      })
    }
  }

  const blockCaptionPlan: CaptionPlan = {
    ...captionPlan,
    phrases: blockPhrases
  }

  // 2. Proof Visuals: active when frame >= entranceFrame && frame < exitFrame
  const blockProofVisuals: ProofVisual[] = []
  const allProofs = proofVisuals ?? []
  for (let i = 0; i < allProofs.length; i++) {
    const pv = allProofs[i]
    if (pv.absoluteStartTime == null || pv.absoluteEndTime == null) continue
    const startSec = pv.absoluteStartTime
    const endSec = pv.absoluteEndTime
    if (startSec <= blockEndTime + EPS && endSec >= blockStartTime - EPS) {
      blockProofVisuals.push({
        ...pv,
        ...({ originalIndex: (pv as any).originalIndex ?? i })
      })
    }
  }

  // 3. Visual Grammar: active when frame >= entranceFrame && frame < exitFrame
  const blockVisualGrammar: VisualGrammarDecision[] = []
  const allGrammar = visualGrammar ?? []
  for (let i = 0; i < allGrammar.length; i++) {
    const vg = allGrammar[i]
    if (!vg.enabled) continue
    const startSec = vg.absoluteStartTime ?? 0
    const endSec = vg.absoluteEndTime ?? (startSec + (vg.duration ?? 0))
    if (startSec <= blockEndTime + EPS && endSec >= blockStartTime - EPS) {
      blockVisualGrammar.push({
        ...vg,
        ...({ originalIndex: (vg as any).originalIndex ?? i })
      })
    }
  }

  // 4. Opening Retention Events: active when currentTime >= ev.startTime && currentTime <= ev.startTime + ev.duration
  const blockOpeningEvents: OpeningRetentionEvent[] = []
  const allOpening = openingEvents ?? []
  for (let i = 0; i < allOpening.length; i++) {
    const ev = allOpening[i]
    const startSec = ev.startTime
    const endSec = ev.startTime + ev.duration
    if (startSec <= blockEndTime + EPS && endSec >= blockStartTime - EPS) {
      blockOpeningEvents.push({
        ...ev,
        ...({ originalIndex: (ev as any).originalIndex ?? i })
      })
    }
  }

  const totalItemsCount =
    blockPhrases.length +
    blockProofVisuals.length +
    blockVisualGrammar.length +
    blockOpeningEvents.length

  return {
    captionPlan: blockCaptionPlan,
    proofVisuals: blockProofVisuals,
    visualGrammar: blockVisualGrammar,
    openingEvents: blockOpeningEvents,
    totalItemsCount
  }
}
