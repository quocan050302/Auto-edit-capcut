import assert from 'assert'
import { selectOverlayPropsForBlock } from '../src/main/render-cache/overlay-block-input'
import type { CaptionPlan, CaptionPhrase, VisualGrammarDecision } from '../shared/types'
import type { ProofVisual } from '../src/main/retention/retention-types'
import type { OpeningRetentionEvent } from '../src/main/retention/opening-retention-types'

console.log('=== Test: selectOverlayPropsForBlock ===')

// Create a rich timeline: 120s, 30fps
const fps = 30
const phrases: CaptionPhrase[] = []
for (let i = 0; i < 20; i++) {
  phrases.push({
    id: `p_${i}`,
    sceneId: `scene_${i + 1}`,
    text: `PHRASE NUMBER ${i}`,
    startTime: i * 5,
    endTime: i * 5 + 3,
    emphasisType: 'normal',
    style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
  })
}

const captionPlan: CaptionPlan = {
  enabled: true,
  activeRanges: [{ startTime: 0, endTime: 120, reason: 'normal' }],
  phrases
}

const proofVisuals: ProofVisual[] = [
  {
    type: 'stat_emphasis',
    primaryText: 'PV 0',
    absoluteStartTime: 2,
    absoluteEndTime: 6,
    confidence: 0.9
  },
  {
    type: 'stat_emphasis',
    primaryText: 'PV 1',
    absoluteStartTime: 45,
    absoluteEndTime: 50,
    confidence: 0.9
  },
  {
    type: 'stat_emphasis',
    primaryText: 'PV 2',
    absoluteStartTime: 75,
    absoluteEndTime: 80,
    confidence: 0.9
  }
]

const visualGrammar: VisualGrammarDecision[] = [
  {
    sceneIndex: 1,
    sceneId: 'scene_1',
    enabled: true,
    type: 'stat_card',
    layout: 'stat_card',
    headline: 'VG 0',
    duration: 4,
    absoluteStartTime: 10,
    absoluteEndTime: 14,
    confidence: 0.9
  } as any,
  {
    sceneIndex: 10,
    sceneId: 'scene_10',
    enabled: true,
    type: 'stat_card',
    layout: 'stat_card',
    headline: 'VG 1',
    duration: 4,
    absoluteStartTime: 62,
    absoluteEndTime: 66,
    confidence: 0.9
  } as any
]

const openingEvents: OpeningRetentionEvent[] = [
  {
    id: 'op_1',
    sourceSceneIndex: 1,
    startTime: 0.5,
    duration: 3,
    type: 'hook-headline',
    priority: 'critical',
    confidence: 0.95
  }
]

// 1. Block 1: frames 0 to 900 (0.0s to 30.0s)
const b1 = selectOverlayPropsForBlock({
  captionPlan,
  proofVisuals,
  visualGrammar,
  openingEvents,
  startFrame: 0,
  endFrameExclusive: 900,
  fps
})

// Phrases in 0..30s: p_0 (0..3) to p_5 (25..28). p_6 starts at 30.0s.
// Since block end frame is 899 (899/30 = 29.966s), p_6 (start 30.0) should NOT be included.
assert.strictEqual(b1.captionPlan.phrases.length, 6, 'Block 1 should contain 6 phrases (p0..p5)')
assert.strictEqual(b1.captionPlan.phrases[0].id, 'p_0')
assert.strictEqual(b1.captionPlan.phrases[0].originalIndex, 0, 'Original index 0 preserved')
assert.strictEqual(b1.captionPlan.phrases[5].id, 'p_5')
assert.strictEqual(b1.captionPlan.phrases[5].originalIndex, 5, 'Original index 5 preserved')

// Proof Visuals in Block 1: only PV 0 (2..6)
assert.strictEqual(b1.proofVisuals.length, 1)
assert.strictEqual(b1.proofVisuals[0].primaryText, 'PV 0')
assert.strictEqual((b1.proofVisuals[0] as any).originalIndex, 0)

// Visual Grammar in Block 1: only VG 0 (10..14)
assert.strictEqual(b1.visualGrammar.length, 1)
assert.strictEqual(b1.visualGrammar[0].headline, 'VG 0')

// Opening Events: included in block 1
assert.strictEqual(b1.openingEvents.length, 1)
assert.strictEqual(b1.openingEvents[0].id, 'op_1')

console.log('✓ Block 1 local selection passed')

// 2. Block 2: frames 900 to 1800 (30.0s to 60.0s)
const b2 = selectOverlayPropsForBlock({
  captionPlan,
  proofVisuals,
  visualGrammar,
  openingEvents,
  startFrame: 900,
  endFrameExclusive: 1800,
  fps
})

// Phrases in 30..60s: p_6 (30..33) to p_11 (55..58)
assert.strictEqual(b2.captionPlan.phrases.length, 6, 'Block 2 should contain 6 phrases (p6..p11)')
assert.strictEqual(b2.captionPlan.phrases[0].id, 'p_6')
assert.strictEqual(b2.captionPlan.phrases[0].originalIndex, 6, 'Original index 6 must be preserved!')
assert.strictEqual(b2.captionPlan.phrases[5].id, 'p_11')
assert.strictEqual(b2.captionPlan.phrases[5].originalIndex, 11, 'Original index 11 must be preserved!')

// Proof visuals in block 2: PV 1 (45..50)
assert.strictEqual(b2.proofVisuals.length, 1)
assert.strictEqual(b2.proofVisuals[0].primaryText, 'PV 1')
assert.strictEqual((b2.proofVisuals[0] as any).originalIndex, 1)

// Visual grammar in block 2: none (VG 1 is at 62..66)
assert.strictEqual(b2.visualGrammar.length, 0)

// Opening events in block 2: none
assert.strictEqual(b2.openingEvents.length, 0)

console.log('✓ Block 2 local selection and originalIndex preservation passed')

// 3. Boundary test: caption exactly on block edge
const edgePhrase: CaptionPhrase = {
  id: 'edge',
  sceneId: 'scene_edge',
  text: 'EDGE CAPTION',
  startTime: 10.0,
  endTime: 12.0,
  emphasisType: 'normal',
  style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
}
const edgePlan: CaptionPlan = {
  enabled: true,
  activeRanges: [],
  phrases: [edgePhrase]
}

// Block ending at 10.0s (frames 0..300, last frame is 299 = 9.9666s)
// Phrase starts at 10.0s -> NOT in block [0, 300)
const bEdgeBefore = selectOverlayPropsForBlock({
  captionPlan: edgePlan,
  startFrame: 0,
  endFrameExclusive: 300,
  fps: 30
})
assert.strictEqual(bEdgeBefore.captionPlan.phrases.length, 0)

// Block starting at frame 300 (frame 300 = 10.0s)
// Phrase starts at 10.0s -> MUST be in block [300, 600)
const bEdgeAfter = selectOverlayPropsForBlock({
  captionPlan: edgePlan,
  startFrame: 300,
  endFrameExclusive: 600,
  fps: 30
})
assert.strictEqual(bEdgeAfter.captionPlan.phrases.length, 1)
assert.strictEqual(bEdgeAfter.captionPlan.phrases[0].id, 'edge')

console.log('✓ Boundary interval precision passed')

// 4. Immutability check
assert.strictEqual(captionPlan.phrases.length, 20)
assert.strictEqual(proofVisuals.length, 3)
console.log('✓ Immutability verified')

console.log('ALL selectOverlayPropsForBlock tests passed successfully!')
