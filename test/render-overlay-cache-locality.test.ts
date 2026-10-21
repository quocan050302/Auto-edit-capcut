import assert from 'assert'
import { selectOverlayPropsForBlock } from '../src/main/render-cache/overlay-block-input'
import {
  computeBlockLocalOverlayFingerprint,
  fingerprintOf,
  computeDirectorySignature,
  type VisualBaseSettings
} from '../src/main/render-cache/render-fingerprint'
import type { CaptionPlan, CaptionPhrase } from '../shared/types'

console.log('=== Test: Overlay Cache Locality & Independence ===')

const base: VisualBaseSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  encoderProfile: 'libx264:balanced:crf20'
}

const totalFrames = 3600 // 120s @ 30fps
const remotionSourceHash = 'fake_remotion_hash'
const hwMode = 'disable'

// 3 blocks:
// Block 1: 0..1200 (0..40s)
// Block 2: 1200..2400 (40..80s)
// Block 3: 2400..3600 (80..120s)
const blocks = [
  { blockIndex: 1, startFrame: 0, endFrameExclusive: 1200 },
  { blockIndex: 2, startFrame: 1200, endFrameExclusive: 2400 },
  { blockIndex: 3, startFrame: 2400, endFrameExclusive: 3600 }
]

function makeCaptionPlan(phraseInBlock3Text = 'Original Block 3 Caption'): CaptionPlan {
  const phrases: CaptionPhrase[] = [
    {
      id: 'p1',
      sceneId: 's1',
      text: 'Block 1 Caption',
      startTime: 5.0,
      endTime: 8.0,
      emphasisType: 'normal',
      style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
    },
    {
      id: 'p2',
      sceneId: 's2',
      text: 'Block 2 Caption',
      startTime: 50.0,
      endTime: 53.0,
      emphasisType: 'normal',
      style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
    },
    {
      id: 'p3',
      sceneId: 's3',
      text: phraseInBlock3Text,
      startTime: 90.0,
      endTime: 93.0,
      emphasisType: 'normal',
      style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
    }
  ]
  return {
    enabled: true,
    activeRanges: [{ startTime: 0, endTime: 120, reason: 'normal' }],
    phrases
  }
}

function computeFps(plan: CaptionPlan): string[] {
  return blocks.map((b) => {
    const blockProps = selectOverlayPropsForBlock({
      captionPlan: plan,
      startFrame: b.startFrame,
      endFrameExclusive: b.endFrameExclusive,
      fps: 30
    })
    const blockOverlayPropsHash = fingerprintOf({
      captionPlan: blockProps.captionPlan,
      proofVisuals: blockProps.proofVisuals,
      visualGrammar: blockProps.visualGrammar,
      openingEvents: blockProps.openingEvents
    })
    return computeBlockLocalOverlayFingerprint({
      blockOverlayPropsHash,
      startFrame: b.startFrame,
      endFrameExclusive: b.endFrameExclusive,
      totalFrames,
      base,
      remotionSourceHash,
      hardwareAcceleration: hwMode
    })
  })
}

// 1. Initial render fingerprints
const initialPlan = makeCaptionPlan('Original Block 3 Caption')
const initialFps = computeFps(initialPlan)

// 2. Modified render: only caption 3 in Block 3 changed
const modifiedPlan = makeCaptionPlan('EDITED Caption in Block 3')
const modifiedFps = computeFps(modifiedPlan)

// Check Block 1: MUST BE STRICTLY IDENTICAL
assert.strictEqual(
  modifiedFps[0],
  initialFps[0],
  'Block 1 overlay fingerprint must NOT change when Block 3 caption changes!'
)

// Check Block 2: MUST BE STRICTLY IDENTICAL
assert.strictEqual(
  modifiedFps[1],
  initialFps[1],
  'Block 2 overlay fingerprint must NOT change when Block 3 caption changes!'
)

// Check Block 3: MUST CHANGE
assert.notStrictEqual(
  modifiedFps[2],
  initialFps[2],
  'Block 3 overlay fingerprint must change when its own caption changes!'
)

console.log('✓ Block-local fingerprint isolation verified: changing Block 3 leaves Block 1 & 2 fingerprints identical')

// 3. Manifest reconciliation check
// Suppose previous run completed all 3 blocks
const previousOverlayBlocks = blocks.map((b, idx) => ({
  blockIndex: b.blockIndex,
  startFrame: b.startFrame,
  endFrameExclusive: b.endFrameExclusive,
  status: 'completed' as const,
  fingerprint: initialFps[idx],
  artifactPath: `/cache/overlay_block_${b.blockIndex}.mp4`
}))

// New plan reconciles against previous completed blocks
const prevMap = new Map(previousOverlayBlocks.map((b) => [b.blockIndex, b]))
const reconciled = blocks.map((b, idx) => {
  const fp = modifiedFps[idx]
  const prev = prevMap.get(b.blockIndex)
  if (prev && prev.fingerprint === fp && prev.status === 'completed') {
    return { ...prev, reused: true }
  }
  return {
    blockIndex: b.blockIndex,
    startFrame: b.startFrame,
    endFrameExclusive: b.endFrameExclusive,
    status: 'pending' as const,
    fingerprint: fp,
    reused: false
  }
})

// Block 1 & 2 should be marked reused: true
assert.strictEqual(reconciled[0].reused, true, 'Block 1 must be reused')
assert.strictEqual(reconciled[1].reused, true, 'Block 2 must be reused')
assert.strictEqual(reconciled[2].reused, false, 'Block 3 must be re-rendered')
assert.strictEqual(reconciled[2].status, 'pending')

console.log('✓ Safe overlay checkpoint reconciliation verified: 2 of 3 blocks reused')
console.log('ALL Overlay Cache Locality tests passed successfully!')
