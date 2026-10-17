import type {
  GlobalScriptContext,
  VisualMixScenePlan
} from '../../../../shared/types'
import type { ManualAiSceneDirection } from './manual-ai-types'
import type { VideoSubjectGrounding } from './manual-ai-video-subject-grounding'
import type { VideoVisualNiche } from './manual-ai-video-prompt-pack'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanText(text: any): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/["'`]/g, '')
    .replace(/[^\p{L}\p{N}\s,.\-:;%()/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeKey(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function deduplicateKeywords(list: string[], max = 16): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const raw of list) {
    const cleaned = cleanText(raw)
    if (!cleaned || cleaned.length < 2) continue
    const key = normalizeKey(cleaned)
    if (!key || seen.has(key)) continue

    // Filter near duplicates (e.g. "farmer" vs "farmers")
    let isSubsumed = false
    for (const existingKey of seen) {
      if (existingKey.length > 5 && key.length > 5) {
        if (existingKey.startsWith(key) || key.startsWith(existingKey)) {
          // If already covered by a very similar root, skip
          isSubsumed = true
          break
        }
      }
    }

    if (!isSubsumed) {
      seen.add(key)
      result.push(cleaned)
    }

    if (result.length >= max) break
  }

  return result
}

// ─── Positive Keywords Extractor ─────────────────────────────────────────────

export function extractSceneVideoKeywords(params: {
  scene: VisualMixScenePlan
  grounding: VideoSubjectGrounding
  globalContext?: GlobalScriptContext
  sceneDirection?: ManualAiSceneDirection
  niche?: VideoVisualNiche
}): string[] {
  const { scene, grounding, sceneDirection, niche } = params
  const candidates: string[] = []

  const isHealth = niche === 'health' || grounding.subjectType === 'species'

  // 1. Subject identity keywords (Rank 1)
  if (grounding.canonicalSubject) {
    // Add concise subject descriptor
    candidates.push(grounding.canonicalSubject)
  }
  if (grounding.presence === 'dominant' || grounding.presence === 'visible') {
    if (grounding.aliases && grounding.aliases.length > 0) {
      candidates.push(grounding.aliases[0])
    }
    for (const trait of grounding.requiredVisualTraits.slice(0, 2)) {
      candidates.push(trait)
    }
  }

  // 2. Physical appearance / object structure / wardrobe (Rank 2)
  if (grounding.presence === 'dominant' || grounding.presence === 'visible') {
    for (const w of grounding.wardrobe.slice(0, 2)) {
      candidates.push(w)
    }
    for (const a of grounding.physicalAppearance.slice(0, 2)) {
      candidates.push(a)
    }
  }

  // 3. Scene action (Rank 3)
  const action = cleanText(sceneDirection?.visualEvent?.action)
  if (action && !action.includes('demonstrating concrete dynamic action') && !action.includes('demonstrating realistic purposeful')) {
    candidates.push(action)
  }
  for (const b of grounding.socialBehavior.slice(0, 2)) {
    candidates.push(b)
  }

  // 4. Distinctive environment & architecture (Rank 4)
  for (const env of grounding.environment.slice(0, 2)) {
    candidates.push(env)
  }
  for (const arch of grounding.architecture.slice(0, 2)) {
    candidates.push(arch)
  }

  // 5. Scene-specific equipment / tools / machinery (Rank 5)
  for (const tool of grounding.tools.slice(0, 2)) {
    candidates.push(tool)
  }
  for (const m of grounding.machinery.slice(0, 2)) {
    candidates.push(m)
  }
  for (const mc of grounding.materialCulture.slice(0, 2)) {
    candidates.push(mc)
  }

  // 6. Cinematographic / framing descriptors (Rank 6)
  const shotType = cleanText(sceneDirection?.composition?.shotType)
  if (shotType && !shotType.includes('standard')) {
    candidates.push(shotType)
  }
  if (isHealth) {
    candidates.push('medical documentary cutaway', 'volumetric clinical lighting')
  } else {
    candidates.push('observational documentary cinematography', 'natural daylight')
  }

  // Cross-domain safety filter: remove biological terms from non-health keywords!
  const filtered = candidates.filter((item) => {
    const lower = item.toLowerCase()
    if (!isHealth) {
      if (
        lower.includes('kidney') ||
        lower.includes('biological') ||
        lower.includes('physiological') ||
        lower.includes('glomerulus') ||
        lower.includes('nephron') ||
        lower.includes('cellular')
      ) {
        return false
      }
    }
    return true
  })

  // Deduplicate and target 8 to 16 keywords
  const result = deduplicateKeywords(filtered, 14)

  // Ensure at least 8 keywords by backfilling sensible grounded descriptors if needed
  if (result.length < 8) {
    const fallbacks = isHealth
      ? ['human physiology', 'cellular activity', 'biological transport', 'high clarity macro']
      : ['documentary realism', 'authentic setting', 'fluid camera movement', 'detailed environmental textures']
    for (const fb of fallbacks) {
      if (result.length >= 8) break
      if (!result.map(normalizeKey).includes(normalizeKey(fb))) {
        result.push(fb)
      }
    }
  }

  return result
}

// ─── Avoid / Negative Keywords Extractor ─────────────────────────────────────

export function extractSceneAvoidKeywords(params: {
  scene: VisualMixScenePlan
  grounding: VideoSubjectGrounding
  globalContext?: GlobalScriptContext
  sceneDirection?: ManualAiSceneDirection
  niche?: VideoVisualNiche
}): string[] {
  const { grounding, niche, globalContext } = params
  const avoids: string[] = []

  const isHealth = niche === 'health'

  // 1. Prioritize identity confusion / community substitution items first (up to 2)
  for (const f of grounding.forbiddenSubstitutions) {
    if (f.toLowerCase().includes('amish') || f.toLowerCase().includes('confuse') || f.toLowerCase().includes('substitut')) {
      avoids.push(f)
      if (avoids.length >= 2) break
    }
  }

  // 2. Other specific forbidden substitutions from grounding (up to 3 total)
  for (const f of grounding.forbiddenSubstitutions) {
    if (!avoids.includes(f)) {
      avoids.push(f)
    }
    if (avoids.length >= 3) break
  }

  // 3. Negative keywords from globalContext (1 item)
  if (globalContext?.negativeKeywords) {
    for (const neg of globalContext.negativeKeywords) {
      if (!avoids.includes(neg)) {
        avoids.push(neg)
        break
      }
    }
  }

  // 4. Domain safety avoids (1 item)
  if (isHealth) {
    avoids.push('fake diagnostic UI')
  } else {
    avoids.push('medical imagery')
  }

  // 5. Technical hygiene constraints (always preserved)
  avoids.push('subtitles', 'watermark')

  // Deduplicate and cap at 8
  return deduplicateKeywords(avoids, 8)
}
