import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import type { RawSceneData } from '../../../shared/types'
import type { RetentionPlan, RetentionDecision } from './retention-types'
import type { CaptionPlan, CaptionPhrase } from '../captions/caption-types'
import type { ProofVisual } from './retention-types'
import type { VisualGrammarDecision } from '../production-intelligence/visual-grammar-engine'
import type {
  OpeningRetentionPlan,
  OpeningRetentionEvent,
  OpeningTransitionHint,
  OpeningMotionHint,
  OpeningSfxEvent,
  OpeningIntensitySegment
} from './opening-retention-types'
import { fingerprintOf } from '../utils/fingerprint'

const SCHEMA_VERSION = 1
const OPENING_WINDOW_SECS = 60

export interface OpeningComposerInputs {
  projectDir: string
  scenes: RawSceneData[]
  retentionPlan: RetentionPlan
  retentionDecisions: Map<number, RetentionDecision>
  captionPlan?: CaptionPlan
  proofVisuals: ProofVisual[]
  visualGrammar: VisualGrammarDecision[]
  globalContext?: any
}

function getOpeningPlanPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'opening-retention-plan.json')
}

export function ensureOpeningRetentionPlan(inputs: OpeningComposerInputs): OpeningRetentionPlan | null {
  try {
    const { projectDir, scenes, retentionPlan, captionPlan, proofVisuals, visualGrammar, globalContext } = inputs
    const p = getOpeningPlanPath(projectDir)

    // Calculate inputs fingerprint to decide if we need to regenerate
    const openingScenes = scenes.filter(s => s.startTime < OPENING_WINDOW_SECS)
    
    const inputHash = fingerprintOf({
      v: SCHEMA_VERSION,
      scenes: openingScenes.map(s => ({ i: s.sceneIndex, s: s.startTime, d: s.duration, v: s.visualIntent })),
      retention: openingScenes.map(s => retentionPlan.scenes[s.sceneIndex]),
      proofVisuals: proofVisuals.filter(pv => pv.absoluteStartTime < OPENING_WINDOW_SECS),
      visualGrammar: visualGrammar.filter(vg => vg.sceneIndex < openingScenes.length),
      captionPlan: captionPlan?.enabled ? captionPlan.phrases.filter(p => p.start < OPENING_WINDOW_SECS) : null,
      globalContext
    })

    if (fs.existsSync(p)) {
      try {
        const cached = JSON.parse(fs.readFileSync(p, 'utf-8')) as OpeningRetentionPlan
        if (cached.schemaVersion === SCHEMA_VERSION && cached.inputHash === inputHash) {
          return cached
        }
      } catch {
        // invalid cache, regenerate
      }
    }

    const plan = buildOpeningPlan(inputs, inputHash)
    fs.writeFileSync(p, JSON.stringify(plan, null, 2), 'utf-8')
    logger.info(
      `[OpeningRetention] window=${plan.windowSecs}s events=${plan.events.length} ` +
      `transitions=${plan.transitionHints.length} sfx=${plan.sfxEvents.length}`
    )
    return plan
  } catch (err) {
    logger.warn(`[OpeningRetention] Failed to generate plan (falling open): ${String(err)}`)
    return null
  }
}

function buildOpeningPlan(inputs: OpeningComposerInputs, inputHash: string): OpeningRetentionPlan {
  const { scenes, retentionPlan, captionPlan, proofVisuals, visualGrammar } = inputs
  const events: OpeningRetentionEvent[] = []
  const transitionHints: OpeningTransitionHint[] = []
  const motionHints: OpeningMotionHint[] = []
  const sfxEvents: OpeningSfxEvent[] = []
  
  const intensityCurve: OpeningIntensitySegment[] = [
    { startTime: 0, endTime: 5, intensity: 1.0 },
    { startTime: 5, endTime: 15, intensity: 0.9 },
    { startTime: 15, endTime: 30, intensity: 0.75 },
    { startTime: 30, endTime: 45, intensity: 0.6 },
    { startTime: 45, endTime: 60, intensity: 0.4 }
  ]

  // Track active visual regions to prevent collisions
  const activeIntervals: { start: number; end: number; type: string }[] = []
  
  if (captionPlan?.enabled) {
    captionPlan.phrases.filter(p => p.start < OPENING_WINDOW_SECS).forEach(p => {
      activeIntervals.push({ start: p.start, end: p.end, type: 'caption' })
    })
  }
  proofVisuals.filter(pv => pv.absoluteStartTime < OPENING_WINDOW_SECS).forEach(pv => {
    activeIntervals.push({ start: pv.absoluteStartTime, end: pv.absoluteEndTime, type: 'proof' })
  })
  
  function hasCollision(start: number, end: number): boolean {
    return activeIntervals.some(iv => (start < iv.end && end > iv.start))
  }

  let lastStrongEventTime = -999

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    if (scene.startTime >= OPENING_WINDOW_SECS) break
    
    const role = retentionPlan.scenes[i]
    
    // 1. Transition Hints
    if (i > 0) {
      const prevScene = scenes[i - 1]
      const boundaryTime = scene.startTime
      if (boundaryTime < OPENING_WINDOW_SECS) {
        if (boundaryTime < 15) {
          // Prefer cuts in the first 15 seconds, avoid dissolves unless role dictates
          transitionHints.push({
            fromSceneIndex: prevScene.sceneIndex,
            toSceneIndex: scene.sceneIndex,
            boundaryTime,
            type: role.role === 'setup' ? 'cut' : (role.role === 'payoff' ? 'zoomin' : 'cut'),
            strength: 'normal',
            reason: 'opening-documentary-cut'
          })
        } else if (boundaryTime < 30) {
          if (role.role === 'payoff' || role.role === 're-hook') {
            transitionHints.push({
              fromSceneIndex: prevScene.sceneIndex,
              toSceneIndex: scene.sceneIndex,
              boundaryTime,
              type: 'wipeleft',
              strength: 'normal',
              reason: 'opening-reveal'
            })
          }
        }
      }
    }

    // 2. Motion Hints (First 5s micro-push)
    if (scene.startTime < 5 && scene.duration > 2) {
      motionHints.push({
        sceneIndex: scene.sceneIndex,
        startTime: scene.startTime,
        type: 'micro-push',
        intensity: 'subtle',
        reason: '0-5s-engagement'
      })
    }

    // 3. Opening Graphic Events & SFX
    const sceneEnd = Math.min(scene.startTime + scene.duration, OPENING_WINDOW_SECS)
    
    // Generate a hook headline if role is hook
    if (role.role === 'hook' && scene.startTime < 15) {
      // Find a short phrase to emphasize
      const phrase = captionPlan?.phrases.find(p => p.start >= scene.startTime && p.end <= sceneEnd && p.words.length <= 5)
      
      if (phrase && !hasCollision(phrase.start, phrase.start + 1.5)) {
        if (phrase.start - lastStrongEventTime > 2) {
          const headlineText = phrase.words.map(w => w.text).join(' ').toUpperCase().replace(/[^A-Z0-9$!? ]/g, '')
          
          events.push({
            id: `hook-headline-${i}`,
            sourceSceneIndex: scene.sceneIndex,
            startTime: phrase.start,
            duration: 1.5,
            type: 'hook-headline',
            priority: 'critical',
            primaryText: headlineText,
            animationPreset: 'hook-punch',
            sourceEvidence: 'caption',
            confidence: 0.95
          })
          
          sfxEvents.push({
            id: `sfx-hook-${i}`,
            sceneIndex: scene.sceneIndex,
            absoluteTime: phrase.start,
            type: 'soft-impact',
            volumeDb: 0,
            duration: 2.0,
            priority: 'critical',
            reason: 'headline-impact'
          })
          
          activeIntervals.push({ start: phrase.start, end: phrase.start + 1.5, type: 'hook' })
          lastStrongEventTime = phrase.start
        }
      }
    }

    // Generate a question card if role is open-loop
    if (role.openLoopStart && scene.startTime < 30) {
      const qPhrase = captionPlan?.phrases.find(p => p.start >= scene.startTime && p.end <= sceneEnd && p.words.some(w => w.text.includes('?')))
      if (qPhrase && !hasCollision(qPhrase.start, qPhrase.start + 1.5) && (qPhrase.start - lastStrongEventTime > 3)) {
        events.push({
          id: `question-${i}`,
          sourceSceneIndex: scene.sceneIndex,
          startTime: qPhrase.start,
          duration: 1.5,
          type: 'question-card',
          priority: 'high',
          primaryText: qPhrase.words.map(w => w.text).join(' ').toUpperCase(),
          sourceEvidence: 'caption',
          confidence: 0.9
        })
        
        sfxEvents.push({
          id: `sfx-q-${i}`,
          sceneIndex: scene.sceneIndex,
          absoluteTime: qPhrase.start,
          type: 'reverse-whoosh',
          volumeDb: 0,
          duration: 1.0,
          priority: 'high',
          reason: 'question-reversal'
        })
        
        activeIntervals.push({ start: qPhrase.start, end: qPhrase.start + 1.5, type: 'question' })
        lastStrongEventTime = qPhrase.start
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    inputHash,
    windowSecs: OPENING_WINDOW_SECS,
    enabled: true,
    intensityCurve,
    events,
    transitionHints,
    motionHints,
    sfxEvents,
    summary: {
      overlays: events.length,
      transitions: transitionHints.length,
      motionAccents: motionHints.length,
      sfxCues: sfxEvents.length
    }
  }
}
