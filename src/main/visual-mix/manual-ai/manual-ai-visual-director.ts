import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { logger } from '../../logger'
import { normalizeApiKey } from '../../utils/api-key'
import {
  classifyGeminiErrorKind,
  DEPRECATED_TEXT_MODELS,
  normalizePreferredTextModel
} from '../../utils/gemini-fallback'
import { getAvailableModelsForTask } from '../../ai/model-router'
import { recordModelFailure, recordModelSuccess } from '../../ai/model-health'
import type {
  GlobalScriptContext,
  VisualMixProfile,
  VisualMixScenePlan
} from '../../../../shared/types'
import {
  MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION,
  getManualAiVisualBriefPath,
  getManualAiSceneDirectionsPath,
  type ManualAiVisualBrief,
  type ManualAiSceneDirection,
  type ManualAiSceneDirectionsArtifact,
  type ManualAiSceneRole,
  type ManualAiHookLevel,
  type ManualAiStorytellingMode
} from './manual-ai-types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('||')).digest('hex')
}

function cleanText(text: string | undefined): string {
  return (text || '')
    .replace(/["'`]/g, '')
    .replace(/[^\p{L}\p{N}\s,.\-:;%()/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractNumbers(text: string): string[] {
  const matches = text.match(/\b\d+(?:[.,]\d+)?%?\b/g)
  return matches ? matches.map((m) => m.replace(/,/g, '')) : []
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

// ─── Public Interfaces ───────────────────────────────────────────────────────

export interface PrepareVisualDirectorParams {
  projectDir: string
  plan: {
    scenes: VisualMixScenePlan[]
    totalScenes: number
    targetAiScenes: number
  }
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  scriptText?: string | null
  apiKey?: string
  preferredModel?: string
  forceRegenerate?: boolean
  onProgress?: (msg: string, pct: number) => void
}

export interface VisualDirectorMetrics {
  globalMs: number
  sceneMs: number
  cacheHit: boolean
  enrichedCount: number
  fallbackCount: number
  overlayCount: number
  modelUsed: string
}

export interface VisualDirectorBundle {
  brief: ManualAiVisualBrief
  sceneDirections: Map<number, ManualAiSceneDirection>
  metrics: VisualDirectorMetrics
}

// ─── Semantic Hashes ─────────────────────────────────────────────────────────

export function computeScriptHash(
  scriptText: string,
  profile: VisualMixProfile,
  globalContext?: GlobalScriptContext
): string {
  const semanticParts = [
    scriptText.trim(),
    profile,
    globalContext?.primarySubject || '',
    globalContext?.centralThesis || '',
    globalContext?.documentaryAngle || '',
    globalContext?.visualWorld?.colorMood || '',
    String(MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION)
  ]
  return sha256(semanticParts)
}

export function computeSceneDirectionsHash(
  briefHash: string,
  aiScenes: VisualMixScenePlan[]
): string {
  const sceneTokens = aiScenes.map(
    (s) => `${s.sceneIndex}:${cleanText(s.narration)}:${cleanText(s.visualIntent)}`
  )
  return sha256([briefHash, ...sceneTokens, String(MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION)])
}

// ─── Level A: Global Visual Brief ────────────────────────────────────────────

function buildFallbackVisualBrief(
  scriptHashVal: string,
  profile: VisualMixProfile,
  globalContext?: GlobalScriptContext,
  sampleNarration?: string
): ManualAiVisualBrief {
  const isHealth = profile === 'health'
  const subject = globalContext?.primarySubject || (isHealth ? 'Human physiological mechanism' : 'Documentary investigation')
  const thesis = globalContext?.centralThesis || (isHealth ? 'Unveiling the hidden internal processes of the human body' : 'Exploring real-world mechanisms and consequences')

  let storytellingMode: ManualAiStorytellingMode = isHealth ? 'mechanism-explainer' : 'documentary'
  const combinedText = `${sampleNarration || ''} ${thesis}`.toLowerCase()
  if (combinedText.includes('why') || combinedText.includes('mechanism') || combinedText.includes('how')) {
    storytellingMode = isHealth ? 'mechanism-explainer' : 'scientific-explainer'
  } else if (combinedText.includes('warning') || combinedText.includes('danger') || combinedText.includes('risk')) {
    storytellingMode = 'warning'
  } else if (combinedText.includes('myth') || combinedText.includes('lie') || combinedText.includes('wrong')) {
    storytellingMode = 'myth-busting'
  } else if (combinedText.includes('compare') || combinedText.includes('vs') || combinedText.includes('difference')) {
    storytellingMode = 'comparison'
  }

  return {
    schemaVersion: MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scriptHash: scriptHashVal,
    profile,
    primaryNiche: isHealth ? 'medical-documentary' : 'editorial-documentary',
    secondaryNiches: isHealth ? ['human-physiology', 'biology'] : ['investigative-journalism'],
    storytellingMode,
    corePromise: isHealth
      ? 'Reveal the hidden physiological mechanisms and biological cause-and-effect processes.'
      : 'Uncover the real-world forces, cause-and-effect relationships, and visible consequences.',
    centralQuestion: isHealth
      ? `What unseen internal mechanism governs ${subject.toLowerCase()}?`
      : `What causes the observable phenomena behind ${subject.toLowerCase()}?`,
    centralThesis: thesis,
    audienceTakeaway: isHealth
      ? 'Understand the internal biological chain reaction that explains symptoms and daily bodily function.'
      : 'Grasp the underlying systematic forces shaping real-world outcomes.',
    emotionalArc: ['curiosity', 'realization', 'clarity', 'empowerment'],
    narrativeArc: [
      { phase: 'hook', purpose: 'Establish visual tension and introduce the central question' },
      { phase: 'mechanism', purpose: 'Reveal internal processes, active flows, and cause-effect chains' },
      { phase: 'consequence', purpose: 'Demonstrate visible outcomes and lifestyle manifestations' },
      { phase: 'resolution', purpose: 'Synthesize core takeaways and provide clarity' }
    ],
    visualStrategy: {
      dominantStyle: isHealth ? 'cinematic medical documentary' : 'cinematic grounded documentary',
      realismLevel: 'photorealistic documentary realism',
      cameraLanguage: isHealth ? '85mm macro lens, tight internal cutaways, three-quarter anatomical depth' : '35mm to 50mm documentary lenses at eye level with authentic framing',
      lightingLanguage: isHealth ? 'controlled cool rim lighting over dark navy background with gentle warm biological highlights' : 'natural documentary light with balanced contrast and layered depth',
      colorLanguage: isHealth ? 'deep navy blue, biological crimson, subtle amber highlights' : 'authentic documentary palette with natural contrast',
      depthLanguage: 'strong foreground subject separation with layered background context',
      recurringMotifs: isHealth ? ['active directional flow', 'organ filtration', 'cellular transport'] : ['human movement', 'environmental tension'],
      avoidVisualCliches: isHealth ? ['static anatomical models in void', 'flat textbook diagrams', 'gory surgical scenes'] : ['generic stock photo posing', 'blank office voids']
    },
    hookStrategy: {
      primaryHookType: 'unseen-mechanism-reveal',
      tensionSources: ['invisible biological events happening right now', 'cause and consequence gap'],
      curiosityPatterns: ['counterintuitive physiological fact', 'visible transformation of common state']
    },
    overlayStrategy: {
      enabled: true,
      targetDensity: 0.30,
      maxDensity: 0.35,
      maxWords: 5,
      maxCharacters: 28,
      avoidBottomCaptionArea: true
    },
    modelUsed: 'local-fallback',
    fallbackUsed: true
  }
}

async function generateGlobalVisualBriefWithGemini(params: {
  apiKey: string
  preferredModel?: string
  scriptText: string
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  scenesSummary: string
  scriptHashVal: string
  onProgress?: (msg: string, pct: number) => void
}): Promise<ManualAiVisualBrief> {
  const { apiKey, preferredModel, scriptText, profile, globalContext, scenesSummary, scriptHashVal, onProgress } = params
  const cleanKey = normalizeApiKey(apiKey)
  if (!cleanKey) throw new Error('NO_API_KEY')

  const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: 'v1beta' } })
  const candidateModels = getAvailableModelsForTask('manual_ai_visual_director', preferredModel)

  const systemPrompt = `You are the Lead Visual Director for a high-end cinematic documentary.
Analyze the ENTIRE script and produce a Global Visual Brief JSON object that guides all individual image prompts for AI Image Generation.
The documentary profile is: "${profile}".

CRITICAL VISUAL PHILOSOPHY:
- DO NOT MERELY DRAW THE NOUN. Visualize ACTION, MECHANISM, VISIBLE CHANGE, CAUSE & EFFECT, and VISUAL TENSION.
- HEALTH TOPICS: Focus on active internal mechanisms (filtration, filling, flow, constriction, dilation, cellular signaling). Scientifically plausible anatomy with correct organ relationships. No gore. No anatomical labels.
- GENERAL TOPICS: Focus on narrative tension, human behavior, environmental context, candid actions. Avoid generic stock posing.
- OVERLAY STRATEGY: Recommend selective smart text overlays (target ~25-35% of scenes) that enhance comprehension or hook curiosity. Overlays must be 2-5 words, max 28 chars, safe for video (avoid bottom 25% caption area). NO invented numbers or facts.
- Return ONLY valid JSON matching the schema. No markdown, no commentary.`

  const userPrompt = `DOCUMENTARY CONTEXT:
Profile: ${profile}
Global Subject: ${globalContext?.primarySubject || 'N/A'}
Central Thesis: ${globalContext?.centralThesis || 'N/A'}
Documentary Angle: ${globalContext?.documentaryAngle || 'N/A'}

SCENES OVERVIEW:
${scenesSummary.slice(0, 12000)}

FULL SCRIPT / NARRATION:
---
${scriptText.slice(0, 24000)}
---

Produce a JSON object conforming EXACTLY to:
{
  "profile": "${profile}",
  "primaryNiche": "e.g. medical-documentary or financial-documentary",
  "secondaryNiches": ["string"],
  "storytellingMode": "mechanism-explainer" | "investigative" | "warning" | "myth-busting" | "comparison" | "problem-solution" | "historical-narrative" | "financial-explainer" | "lifestyle-explainer" | "scientific-explainer" | "documentary" | "other",
  "corePromise": "one clear sentence",
  "centralQuestion": "the single compelling question the video answers",
  "centralThesis": "core argument",
  "audienceTakeaway": "what viewer understands by the end",
  "emotionalArc": ["curiosity", "tension", "realization", "empowerment"],
  "narrativeArc": [
    { "phase": "hook", "purpose": "..." },
    { "phase": "mechanism", "purpose": "..." },
    { "phase": "consequence", "purpose": "..." },
    { "phase": "resolution", "purpose": "..." }
  ],
  "visualStrategy": {
    "dominantStyle": "string",
    "realismLevel": "string",
    "cameraLanguage": "string",
    "lightingLanguage": "string",
    "colorLanguage": "string",
    "depthLanguage": "string",
    "recurringMotifs": ["string"],
    "avoidVisualCliches": ["string"]
  },
  "hookStrategy": {
    "primaryHookType": "string",
    "tensionSources": ["string"],
    "curiosityPatterns": ["string"]
  },
  "overlayStrategy": {
    "enabled": true,
    "targetDensity": 0.30,
    "maxDensity": 0.35,
    "maxWords": 5,
    "maxCharacters": 28,
    "avoidBottomCaptionArea": true
  }
}`

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx]
    try {
      onProgress?.(`Analyzing full script for Global Visual Brief (${model})...`, 0.05)
      const res = await ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 4096
        }
      })
      const text = res.text?.trim()
      if (!text) throw new Error('Empty response from model')

      const parsed = JSON.parse(text)
      if (!parsed.centralQuestion || !parsed.visualStrategy) {
        throw new Error('Malformed Visual Brief JSON: missing required fields')
      }

      recordModelSuccess(model)
      return {
        schemaVersion: MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        scriptHash: scriptHashVal,
        profile,
        primaryNiche: parsed.primaryNiche || (profile === 'health' ? 'medical-documentary' : 'documentary'),
        secondaryNiches: Array.isArray(parsed.secondaryNiches) ? parsed.secondaryNiches : [],
        storytellingMode: parsed.storytellingMode || (profile === 'health' ? 'mechanism-explainer' : 'documentary'),
        corePromise: parsed.corePromise || '',
        centralQuestion: parsed.centralQuestion || '',
        centralThesis: parsed.centralThesis || globalContext?.centralThesis || '',
        audienceTakeaway: parsed.audienceTakeaway || '',
        emotionalArc: Array.isArray(parsed.emotionalArc) ? parsed.emotionalArc : ['curiosity', 'clarity'],
        narrativeArc: Array.isArray(parsed.narrativeArc) ? parsed.narrativeArc : [],
        visualStrategy: {
          dominantStyle: parsed.visualStrategy?.dominantStyle || 'cinematic documentary',
          realismLevel: parsed.visualStrategy?.realismLevel || 'photorealistic realism',
          cameraLanguage: parsed.visualStrategy?.cameraLanguage || '50mm documentary lens',
          lightingLanguage: parsed.visualStrategy?.lightingLanguage || 'natural cinematic light',
          colorLanguage: parsed.visualStrategy?.colorLanguage || 'balanced documentary tones',
          depthLanguage: parsed.visualStrategy?.depthLanguage || 'layered depth with clear subject focus',
          recurringMotifs: Array.isArray(parsed.visualStrategy?.recurringMotifs) ? parsed.visualStrategy.recurringMotifs : [],
          avoidVisualCliches: Array.isArray(parsed.visualStrategy?.avoidVisualCliches) ? parsed.visualStrategy.avoidVisualCliches : []
        },
        hookStrategy: {
          primaryHookType: parsed.hookStrategy?.primaryHookType || 'curiosity-gap',
          tensionSources: Array.isArray(parsed.hookStrategy?.tensionSources) ? parsed.hookStrategy.tensionSources : [],
          curiosityPatterns: Array.isArray(parsed.hookStrategy?.curiosityPatterns) ? parsed.hookStrategy.curiosityPatterns : []
        },
        overlayStrategy: {
          enabled: parsed.overlayStrategy?.enabled ?? true,
          targetDensity: parsed.overlayStrategy?.targetDensity ?? 0.30,
          maxDensity: parsed.overlayStrategy?.maxDensity ?? 0.35,
          maxWords: parsed.overlayStrategy?.maxWords ?? 5,
          maxCharacters: parsed.overlayStrategy?.maxCharacters ?? 28,
          avoidBottomCaptionArea: parsed.overlayStrategy?.avoidBottomCaptionArea ?? true
        },
        modelUsed: model,
        fallbackUsed: false
      }
    } catch (err) {
      const { kind, message } = classifyGeminiErrorKind(err)
      recordModelFailure(model, kind)
      logger.warn(`[ManualAI:Director] Gemini model ${model} failed for Global Visual Brief (${kind}): ${message}`)
    }
  }

  throw new Error('ALL_MODELS_FAILED')
}

// ─── Level B: Scene Directions Batching ───────────────────────────────────────

function inferFallbackSceneRole(text: string, isOpening: boolean): ManualAiSceneRole {
  const lower = text.toLowerCase()
  if (isOpening) return 'hook'
  if (lower.includes('?')) return 'question'
  if (/\b(kidney|bladder|vessel|blood|cell|artery|vein|organ|filter|flow|fluid|hormone|enzyme|transport|absorb|expand|contract)\b/.test(lower)) {
    return 'mechanism'
  }
  if (/\b(because|cause|leads to|results in|trigger|reaction|consequence|due to)\b/.test(lower)) {
    return 'cause-effect'
  }
  if (/\b(danger|risk|warning|symptom|toxic|damage|threat|pain|problem|crisis)\b/.test(lower)) {
    return 'symptom'
  }
  if (/\b(percent|%|\b\d+\b|study|research|trial|evidence|data)\b/.test(lower)) {
    return 'statistic'
  }
  if (/\b(compare|contrast|unlike|whereas|different|versus|vs)\b/.test(lower)) {
    return 'comparison'
  }
  if (/\b(sleep|drink|water|night|morning|walk|lifestyle|habit|bed|daily|routine)\b/.test(lower)) {
    return 'lifestyle'
  }
  if (/\b(finally|remember|takeaway|summary|conclude|solution|protect|heal)\b/.test(lower)) {
    return 'solution'
  }
  return 'setup'
}

function inferFallbackHookLevel(role: ManualAiSceneRole, isOpening: boolean): ManualAiHookLevel {
  if (isOpening || role === 'hook' || role === 'reveal') return 'high'
  if (role === 'mechanism' || role === 'cause-effect' || role === 'statistic' || role === 'question') return 'medium'
  return 'low'
}

function extractActionVerb(text: string, isHealth: boolean): string {
  const match = text.match(/\b(filtering|flowing|filling|contracting|narrowing|expanding|releasing|absorbing|accumulating|separating|slowing|accelerating|signaling|responding|circulating|descending|rising|rushing|pumping|clearing|building)\b/i)
  if (match) return match[1].toLowerCase()
  return isHealth ? 'actively filtering and transporting fluid' : 'demonstrating concrete dynamic action'
}

function buildFallbackSceneDirection(
  scene: VisualMixScenePlan,
  profile: VisualMixProfile,
  isOpening: boolean
): ManualAiSceneDirection {
  const isHealth = profile === 'health'
  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const combined = `${narration} ${intent}`
  const role = inferFallbackSceneRole(combined, isOpening)
  const hook = inferFallbackHookLevel(role, isOpening)
  const action = extractActionVerb(combined, isHealth)
  const subject = intent || narration.slice(0, 80)

  // Check if narration has numbers for safe overlay candidate
  const numbers = extractNumbers(narration)
  const eligibleForOverlay = (isOpening || role === 'statistic' || role === 'hook' || numbers.length > 0) && combined.length > 10
  let overlayText: string | undefined
  if (eligibleForOverlay) {
    if (numbers.length > 0) {
      overlayText = numbers[0]
    } else if (isOpening && isHealth) {
      overlayText = "YOUR BODY AT NIGHT"
    } else if (role === 'mechanism' && isHealth) {
      overlayText = "INTERNAL MECHANISM"
    }
  }

  return {
    sceneIndex: scene.sceneIndex,
    sceneRole: role,
    hookLevel: hook,
    coreMeaning: narration.slice(0, 100),
    viewerShouldNotice: `The visual event of ${action}`,
    curiosityGap: hook === 'high' ? 'What hidden process causes this visible reaction?' : undefined,
    visualEvent: {
      subject: subject.slice(0, 60),
      action,
      change: 'visible dynamic transition and movement',
      cause: 'physiological biological activity',
      consequence: 'observable biological state'
    },
    composition: {
      shotType: isHealth ? 'close three-quarter cutaway' : 'medium documentary framing',
      cameraAngle: 'straight-on eye level',
      lensFeel: isHealth ? '85mm medical-documentary lens' : '50mm prime lens',
      focalPriority: 'dominant foreground subject with high clarity',
      foreground: 'main active subject occupying roughly 60% of useful frame',
      background: isHealth ? 'controlled deep navy gradient with soft atmospheric depth' : 'natural contextual environment with layered depth',
      negativeSpace: 'clean upper-right area reserved for editorial balance'
    },
    lighting: isHealth
      ? 'controlled cool rim light with soft biological volumetric fill'
      : 'natural documentary lighting with balanced contrast',
    colorStrategy: isHealth ? 'deep navy blue with warm tissue accents' : 'natural realistic documentary palette',
    continuityNote: 'maintain documentary realism and consistent color grading with adjacent scenes',
    textOverlay: {
      enabled: !!overlayText,
      text: overlayText,
      purpose: role === 'statistic' ? 'stat' : 'hook',
      position: 'top-right',
      emphasis: 'medium',
      reason: overlayText ? 'Anchors viewer attention on key takeaway' : 'Visual self-explanatory'
    },
    avoid: isHealth ? ['flat textbook diagrams', 'static anatomical cards', 'fake medical UI'] : ['generic stock poses'],
    confidence: 0.75
  }
}

async function analyzeSceneBatchWithGemini(params: {
  apiKey: string
  preferredModel?: string
  brief: ManualAiVisualBrief
  batchScenes: VisualMixScenePlan[]
  prevContext?: VisualMixScenePlan
  nextContext?: VisualMixScenePlan
  profile: VisualMixProfile
}): Promise<ManualAiSceneDirection[]> {
  const { apiKey, preferredModel, brief, batchScenes, prevContext, nextContext, profile } = params
  const cleanKey = normalizeApiKey(apiKey)
  if (!cleanKey) throw new Error('NO_API_KEY')

  const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: 'v1beta' } })
  const candidateModels = getAvailableModelsForTask('manual_ai_visual_director', preferredModel)

  const scenesPayload = batchScenes.map((s) => ({
    sceneIndex: s.sceneIndex,
    narration: cleanText(s.narration),
    visualIntent: cleanText(s.visualIntent)
  }))

  const prevText = prevContext ? `SCENE ${prevContext.sceneIndex}: ${cleanText(prevContext.narration)}` : 'None (start of video)'
  const nextText = nextContext ? `SCENE ${nextContext.sceneIndex}: ${cleanText(nextContext.narration)}` : 'None (end of video)'

  const prompt = `You are the Lead Visual Director for a cinematic documentary (${profile}).
GLOBAL VISUAL BRIEF:
- Storytelling Mode: ${brief.storytellingMode}
- Core Promise: ${brief.corePromise}
- Central Question: ${brief.centralQuestion}
- Visual Strategy: ${brief.visualStrategy.dominantStyle}, ${brief.visualStrategy.cameraLanguage}, ${brief.visualStrategy.lightingLanguage}
- Avoid Visual Cliches: ${brief.visualStrategy.avoidVisualCliches.join(', ')}

SURROUNDING CONTEXT:
- Previous Scene: ${prevText}
- Next Scene: ${nextText}

BATCH SCENES TO DIRECT (respond for EACH of these ${scenesPayload.length} scenes):
${JSON.stringify(scenesPayload, null, 2)}

INSTRUCTIONS FOR EACH SCENE:
1. sceneRole: select from hook | question | problem | symptom | setup | mechanism | cause-effect | reveal | evidence | statistic | comparison | definition | demonstration | consequence | solution | lifestyle | emotion | transition | recap
2. hookLevel: low | medium | high (Scene 1, major reveals, surprising warnings = high; mechanisms = medium; lifestyle/setup = low)
3. visualEvent: DO NOT JUST DRAW A NOUN. Subject + ACTION (must contain an active visible verb like filtering, flowing, filling, expanding, contracting, etc.) + change + cause/consequence.
4. composition: shotType, cameraAngle, lensFeel, focalPriority, foreground, background, negativeSpace. For mechanisms, dominant subject occupies ~55-75% of useful frame.
5. lighting & colorStrategy: specific, consistent with brief.
6. textOverlay: Recommend an editorial text overlay ONLY if this scene is a Hook, Reveal, Statistic/Number, or complex Mechanism.
   - Text must be 2-5 words, max 28 characters, in the PRIMARY LANGUAGE of the narration.
   - If numbers/statistics are included, they MUST BE EXACTLY MENTIONED in the scene narration. NEVER invent numbers!
   - Position: top-left | top-right | center-left | center-right (never bottom caption zone).
   - If image is already visually clear or simple lifestyle, set enabled: false. Target ~25-35% of scenes enabled across the documentary.
7. avoid: list specific visual cliches or static textbook errors to avoid.

Return ONLY a valid JSON array of ${scenesPayload.length} objects matching the schema.`

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx]
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.25,
          maxOutputTokens: 8192
        }
      })
      const text = res.text?.trim()
      if (!text) throw new Error('Empty response from model')

      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) throw new Error('Response is not a JSON array')

      const directions: ManualAiSceneDirection[] = []
      const byIndex = new Map<number, any>()
      for (const item of parsed) {
        if (typeof item?.sceneIndex === 'number') {
          byIndex.set(item.sceneIndex, item)
        }
      }

      for (const s of batchScenes) {
        const raw = byIndex.get(s.sceneIndex)
        if (raw && raw.visualEvent && raw.composition) {
          directions.push({
            sceneIndex: s.sceneIndex,
            sceneRole: raw.sceneRole || inferFallbackSceneRole(s.narration, s.sceneIndex === 1),
            hookLevel: raw.hookLevel || 'medium',
            coreMeaning: raw.coreMeaning || cleanText(s.narration).slice(0, 100),
            viewerShouldNotice: raw.viewerShouldNotice || 'The visible action of the subject',
            curiosityGap: raw.curiosityGap,
            visualEvent: {
              subject: raw.visualEvent.subject || cleanText(s.visualIntent || s.narration),
              action: raw.visualEvent.action || extractActionVerb(s.narration, profile === 'health'),
              change: raw.visualEvent.change,
              cause: raw.visualEvent.cause,
              consequence: raw.visualEvent.consequence
            },
            composition: {
              shotType: raw.composition.shotType || 'medium documentary view',
              cameraAngle: raw.composition.cameraAngle || 'eye level',
              lensFeel: raw.composition.lensFeel || '50mm prime',
              focalPriority: raw.composition.focalPriority || 'foreground subject',
              foreground: raw.composition.foreground || 'dominant subject',
              background: raw.composition.background || 'atmospheric background',
              negativeSpace: raw.composition.negativeSpace
            },
            lighting: raw.lighting || 'natural documentary lighting',
            colorStrategy: raw.colorStrategy || 'balanced documentary tones',
            continuityNote: raw.continuityNote,
            textOverlay: {
              enabled: !!raw.textOverlay?.enabled,
              text: raw.textOverlay?.text,
              purpose: raw.textOverlay?.purpose || 'hook',
              position: raw.textOverlay?.position || 'top-right',
              emphasis: raw.textOverlay?.emphasis || 'medium',
              reason: raw.textOverlay?.reason || 'Editorial clarity'
            },
            avoid: Array.isArray(raw.avoid) ? raw.avoid : [],
            confidence: 0.90
          })
        } else {
          // Missing from batch response: fallback locally for this specific scene
          directions.push(buildFallbackSceneDirection(s, profile, s.sceneIndex === 1))
        }
      }

      recordModelSuccess(model)
      return directions
    } catch (err) {
      const { kind, message } = classifyGeminiErrorKind(err)
      recordModelFailure(model, kind)
      logger.warn(`[ManualAI:Director] Gemini model ${model} failed for scene batch (${kind}): ${message}`)
    }
  }

  throw new Error('BATCH_ANALYSIS_FAILED')
}

// ─── Level B Post-Processing: Smart Text Overlay Pass ────────────────────────

export function applySmartOverlayPass(
  directions: ManualAiSceneDirection[],
  scriptText: string,
  profile: VisualMixProfile
): void {
  const total = directions.length
  if (total === 0) return

  const scriptLower = scriptText.toLowerCase()
  const scriptNumbers = new Set(extractNumbers(scriptText))

  // 1. Per-scene sanitization & strict validation
  for (const d of directions) {
    if (!d.textOverlay.enabled || !d.textOverlay.text) {
      d.textOverlay.enabled = false
      continue
    }

    let text = d.textOverlay.text
      .replace(/["'`]/g, '')
      .replace(/[^\p{L}\p{N}\s,.\-:;%()/]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const words = text.split(/\s+/).filter(Boolean)
    // Word limit: 2 to 5 words preferred; max 5 words
    if (words.length > 5) {
      text = words.slice(0, 5).join(' ')
    }
    // Char limit: max 28 characters
    if (text.length > 28) {
      const truncated = text.slice(0, 28).replace(/[,.:;\-\s]+$/, '')
      text = truncated
    }

    const finalWords = text.split(/\s+/).filter(Boolean)
    if (finalWords.length === 0 || text.length < 2) {
      d.textOverlay.enabled = false
      continue
    }

    // Reject vague single generic words
    const upper = text.toUpperCase()
    if (['HEALTH', 'WARNING', 'BODY', 'IMPORTANT', 'NOTE', 'DANGER'].includes(upper)) {
      d.textOverlay.enabled = false
      continue
    }

    // Number verification: if overlay contains a number, it MUST exist in script / narration
    const overlayNums = extractNumbers(text)
    if (overlayNums.length > 0) {
      const sceneNums = extractNumbers(d.coreMeaning)
      const numberValid = overlayNums.every(
        (n) => sceneNums.includes(n) || scriptNumbers.has(n) || scriptLower.includes(n.toLowerCase())
      )
      if (!numberValid) {
        logger.info(`[ManualAI:Overlay] Disabling overlay "${text}" for scene ${d.sceneIndex}: number not found in script`)
        d.textOverlay.enabled = false
        continue
      }
    }

    // Position safety: ensure safe side/top areas, never bottom-center
    const allowedPositions = ['top-left', 'top-right', 'center-left', 'center-right']
    if (!d.textOverlay.position || !allowedPositions.includes(d.textOverlay.position)) {
      d.textOverlay.position = 'top-right'
    }

    d.textOverlay.text = text
  }

  // 2. Maximum density pass: hard max 35% of AI-owned scenes
  const maxAllowed = Math.max(1, Math.floor(total * 0.35))
  const enabledDirections = directions.filter((d) => d.textOverlay.enabled)

  if (enabledDirections.length > maxAllowed) {
    // Sort by role priority: hook > reveal > stat > mechanism > comparison > term > conclusion > other
    const rolePriority = (role: ManualAiSceneRole): number => {
      switch (role) {
        case 'hook': return 10
        case 'reveal': return 9
        case 'statistic': return 8
        case 'mechanism': return 7
        case 'cause-effect': return 6
        case 'comparison': return 5
        case 'definition': return 4
        case 'recap': return 3
        default: return 1
      }
    }

    enabledDirections.sort((a, b) => {
      const pDiff = rolePriority(b.sceneRole) - rolePriority(a.sceneRole)
      if (pDiff !== 0) return pDiff
      const hookScore = (h: ManualAiHookLevel) => (h === 'high' ? 3 : h === 'medium' ? 2 : 1)
      return hookScore(b.hookLevel) - hookScore(a.hookLevel)
    })

    const keepers = new Set(enabledDirections.slice(0, maxAllowed).map((d) => d.sceneIndex))
    for (const d of directions) {
      if (d.textOverlay.enabled && !keepers.has(d.sceneIndex)) {
        d.textOverlay.enabled = false
      }
    }
  }

  // 3. Consecutive overlay limit: no more than 2 consecutive scenes
  for (let i = 0; i < directions.length - 2; i++) {
    if (
      directions[i].textOverlay.enabled &&
      directions[i + 1].textOverlay.enabled &&
      directions[i + 2].textOverlay.enabled
    ) {
      // Disable the middle one or the one with lowest priority
      const mid = directions[i + 1]
      mid.textOverlay.enabled = false
    }
  }
}

// ─── Main Coordinator: prepareManualAiVisualDirection ────────────────────────

export async function prepareManualAiVisualDirection(
  params: PrepareVisualDirectorParams
): Promise<VisualDirectorBundle> {
  const t0 = Date.now()
  const { projectDir, plan, profile, globalContext, preferredModel, forceRegenerate = false, onProgress } = params

  const aiScenes = plan.scenes
    .filter((s) => s.strategy === 'ai-still')
    .sort((a, b) => a.sceneIndex - b.sceneIndex)

  if (aiScenes.length === 0) {
    const emptyBrief = buildFallbackVisualBrief('empty', profile, globalContext)
    return {
      brief: emptyBrief,
      sceneDirections: new Map(),
      metrics: {
        globalMs: 0,
        sceneMs: 0,
        cacheHit: true,
        enrichedCount: 0,
        fallbackCount: 0,
        overlayCount: 0,
        modelUsed: 'none'
      }
    }
  }

  const fullScriptText =
    params.scriptText ||
    plan.scenes.map((s) => cleanText(s.narration)).join(' ')

  const scriptHashVal = computeScriptHash(fullScriptText, profile, globalContext)
  const briefPath = getManualAiVisualBriefPath(projectDir)
  const directionsPath = getManualAiSceneDirectionsPath(projectDir)

  // 1. Level A: Check / generate Global Visual Brief
  let brief: ManualAiVisualBrief | null = null
  let briefCacheHit = false
  let globalT0 = Date.now()

  if (!forceRegenerate && fs.existsSync(briefPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(briefPath, 'utf-8')) as ManualAiVisualBrief
      if (
        cached.schemaVersion === MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION &&
        cached.scriptHash === scriptHashVal &&
        cached.profile === profile
      ) {
        brief = cached
        briefCacheHit = true
        logger.info(`[ManualAI:VisualDirector] Global visual brief cache hit (model=${cached.modelUsed})`)
      }
    } catch {
      /* ignore cache read error */
    }
  }

  if (!brief) {
    const scenesSummary = plan.scenes
      .map((s) => `Scene ${s.sceneIndex}: ${cleanText(s.narration).slice(0, 120)} | Intent: ${cleanText(s.visualIntent).slice(0, 80)}`)
      .join('\n')

    try {
      if (params.apiKey) {
        brief = await generateGlobalVisualBriefWithGemini({
          apiKey: params.apiKey,
          preferredModel,
          scriptText: fullScriptText,
          profile,
          globalContext,
          scenesSummary,
          scriptHashVal,
          onProgress
        })
      }
    } catch (err) {
      logger.warn(`[ManualAI:VisualDirector] AI Global Brief generation failed (${err}) — using local fallback brief`)
    }

    if (!brief) {
      brief = buildFallbackVisualBrief(
        scriptHashVal,
        profile,
        globalContext,
        aiScenes[0]?.narration
      )
    }

    writeFileAtomic(briefPath, JSON.stringify(brief, null, 2))
  }

  const globalMs = Date.now() - globalT0
  const briefHash = sha256([
    brief.storytellingMode,
    brief.corePromise,
    brief.centralQuestion,
    brief.centralThesis,
    brief.visualStrategy.dominantStyle,
    brief.modelUsed
  ])
  const sceneInputHash = computeSceneDirectionsHash(briefHash, aiScenes)

  // 2. Level B: Check / generate Scene Directions
  let sceneDirectionsList: ManualAiSceneDirection[] | null = null
  let sceneCacheHit = false
  let sceneT0 = Date.now()

  if (!forceRegenerate && fs.existsSync(directionsPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(directionsPath, 'utf-8')) as ManualAiSceneDirectionsArtifact
      if (
        cached.schemaVersion === MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION &&
        cached.briefHash === briefHash &&
        cached.inputHash === sceneInputHash &&
        cached.totalAiScenes === aiScenes.length &&
        Array.isArray(cached.directions) &&
        cached.directions.length === aiScenes.length
      ) {
        sceneDirectionsList = cached.directions
        sceneCacheHit = true
        logger.info(`[ManualAI:VisualDirector] Scene directions cache hit (${cached.directions.length} scenes)`)
      }
    } catch {
      /* ignore */
    }
  }

  let enrichedCount = 0
  let fallbackCount = 0

  if (!sceneDirectionsList) {
    const directionsMap = new Map<number, ManualAiSceneDirection>()
    const batchSize = 10
    const batches: VisualMixScenePlan[][] = []

    for (let i = 0; i < aiScenes.length; i += batchSize) {
      batches.push(aiScenes.slice(i, i + batchSize))
    }

    // Process batches with concurrency <= 2
    const concurrency = 2
    for (let i = 0; i < batches.length; i += concurrency) {
      const slice = batches.slice(i, i + concurrency)
      await Promise.all(
        slice.map(async (batch, sliceIdx) => {
          const batchIndex = i + sliceIdx
          const firstScene = batch[0]
          const lastScene = batch[batch.length - 1]
          const prevCtx = plan.scenes.find((s) => s.sceneIndex === firstScene.sceneIndex - 1)
          const nextCtx = plan.scenes.find((s) => s.sceneIndex === lastScene.sceneIndex + 1)

          let batchDirections: ManualAiSceneDirection[] | null = null
          if (params.apiKey && !brief?.fallbackUsed) {
            try {
              onProgress?.(
                `Building scene visual directions ${Math.min((batchIndex + 1) * batchSize, aiScenes.length)}/${aiScenes.length}...`,
                0.2 + (batchIndex / batches.length) * 0.6
              )
              batchDirections = await analyzeSceneBatchWithGemini({
                apiKey: params.apiKey,
                preferredModel,
                brief: brief!,
                batchScenes: batch,
                prevContext: prevCtx,
                nextContext: nextCtx,
                profile
              })
            } catch (err) {
              logger.warn(`[ManualAI:VisualDirector] Batch ${batchIndex + 1} analysis failed (${err}); falling back locally for this batch`)
            }
          }

          if (batchDirections && batchDirections.length === batch.length) {
            for (const d of batchDirections) {
              directionsMap.set(d.sceneIndex, d)
              enrichedCount++
            }
          } else {
            // Local deterministic fallback for this batch
            for (const s of batch) {
              const fb = buildFallbackSceneDirection(s, profile, s.sceneIndex === 1)
              directionsMap.set(s.sceneIndex, fb)
              fallbackCount++
            }
          }
        })
      )
    }

    sceneDirectionsList = aiScenes.map((s) => directionsMap.get(s.sceneIndex)!)

    // Apply Smart Text Overlay sanitization and density pass
    applySmartOverlayPass(sceneDirectionsList, fullScriptText, profile)

    const overlayCount = sceneDirectionsList.filter((d) => d.textOverlay.enabled).length
    const artifact: ManualAiSceneDirectionsArtifact = {
      schemaVersion: MANUAL_AI_VISUAL_DIRECTOR_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      briefHash,
      inputHash: sceneInputHash,
      totalAiScenes: aiScenes.length,
      enrichedCount,
      fallbackCount,
      overlayCount,
      directions: sceneDirectionsList
    }

    writeFileAtomic(directionsPath, JSON.stringify(artifact, null, 2))
  } else {
    enrichedCount = sceneDirectionsList.filter((d) => d.confidence > 0.8).length
    fallbackCount = sceneDirectionsList.length - enrichedCount
  }

  const sceneMs = Date.now() - sceneT0
  const overlayCount = sceneDirectionsList.filter((d) => d.textOverlay.enabled).length
  const overlayDensityPct = Math.round((overlayCount / aiScenes.length) * 100)

  // Standard Section 112 Logs
  logger.info(
    `[ManualAI:VisualDirector] Global brief generated profile=${brief.profile} mode=${brief.storytellingMode} model=${brief.modelUsed}`
  )
  logger.info(
    `[ManualAI:VisualDirector] Scene directions generated AI scenes=${aiScenes.length} AI enriched=${enrichedCount} fallback=${fallbackCount}`
  )
  logger.info(
    `[ManualAI:Overlay] enabled=${overlayCount}/${aiScenes.length} density=${overlayDensityPct}%`
  )

  const resultMap = new Map<number, ManualAiSceneDirection>()
  for (const d of sceneDirectionsList) {
    resultMap.set(d.sceneIndex, d)
  }

  return {
    brief,
    sceneDirections: resultMap,
    metrics: {
      globalMs,
      sceneMs,
      cacheHit: briefCacheHit && sceneCacheHit,
      enrichedCount,
      fallbackCount,
      overlayCount,
      modelUsed: brief.modelUsed
    }
  }
}
