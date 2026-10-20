import type {
  GlobalScriptCommunity,
  GlobalScriptContext,
  VisualMixProfile,
  VisualMixScenePlan
} from '../../../../shared/types'
import type {
  SceneIdentityBinding,
  VisualIdentityBible,
  VisualIdentityEntity
} from '../../content-intelligence/visual-identity-types'
import type { ManualAiSceneDirection } from './manual-ai-types'

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface VideoSubjectGrounding {
  canonicalSubject: string
  aliases: string[]
  subjectType: string
  presence: 'dominant' | 'visible' | 'context' | 'none'

  requiredVisualTraits: string[]
  optionalVisualTraits: string[]

  wardrobe: string[]
  physicalAppearance: string[]
  architecture: string[]
  environment: string[]
  tools: string[]
  machinery: string[]
  materialCulture: string[]
  socialBehavior: string[]
  temporalMarkers: string[]
  geographicMarkers: string[]

  forbiddenSubstitutions: string[]
  uncertaintyNotes: string[]
  confidence: number
}

export interface ResolveVideoSubjectGroundingParams {
  scene: VisualMixScenePlan
  globalContext?: GlobalScriptContext
  identityBible?: VisualIdentityBible
  sceneIdentity?: SceneIdentityBinding
  sceneDirection?: ManualAiSceneDirection
  profile?: VisualMixProfile
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanText(text: any): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/["'`]/g, '')
    .replace(/[^\p{L}\p{N}\s,.\-:;%()/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function dedupeStrings(arr: (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'string') continue
    const cleaned = cleanText(item)
    const lower = cleaned.toLowerCase()
    if (lower && !seen.has(lower)) {
      seen.add(lower)
      result.push(cleaned)
    }
  }
  return result
}

// ─── Niche & Subject Detectors ───────────────────────────────────────────────

const HUTTERITE_SPECIFIC_REGEX = /\b(hutterite|hutterites|hutterian|anabaptist)\b/i
const AMISH_REGEX = /\b(amish|mennonite)\b/i

function isHutteriteContext(
  text: string,
  globalContext?: GlobalScriptContext,
  identityBible?: VisualIdentityBible
): boolean {
  if (HUTTERITE_SPECIFIC_REGEX.test(text)) return true
  if (globalContext) {
    const combined = `${globalContext.primarySubject || ''} ${(globalContext.exactTopicAnchors || []).join(' ')} ${(globalContext.contextualAnchors || []).join(' ')}`
    if (HUTTERITE_SPECIFIC_REGEX.test(combined)) return true
    if (globalContext.communities?.some((c) => HUTTERITE_SPECIFIC_REGEX.test(c.name))) return true
  }
  if (identityBible?.entities?.some((e) => HUTTERITE_SPECIFIC_REGEX.test(e.canonicalName) || e.aliases.some((a) => HUTTERITE_SPECIFIC_REGEX.test(a)))) {
    return true
  }
  return false
}

// ─── Main Grounding Resolver ──────────────────────────────────────────────────

export function resolveVideoSubjectGrounding(
  params: ResolveVideoSubjectGroundingParams
): VideoSubjectGrounding {
  const { scene, globalContext, identityBible, sceneIdentity, sceneDirection, profile } = params

  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const sceneText = `${intent} ${narration}`.trim()
  const sceneLower = sceneText.toLowerCase()

  // 1. Identify active entity from VisualIdentityBible or GlobalScriptContext
  let matchedEntity: VisualIdentityEntity | undefined
  let matchedCommunity: GlobalScriptCommunity | undefined

  if (identityBible && Array.isArray(identityBible.entities)) {
    // Prioritize entity matching scene text
    matchedEntity = identityBible.entities.find((e) => {
      const name = e.canonicalName.toLowerCase()
      if (sceneLower.includes(name)) return true
      return e.aliases?.some((a) => sceneLower.includes(a.toLowerCase()))
    })
    // If no direct match in scene text, check primary identity
    if (!matchedEntity && identityBible.primaryIdentityId) {
      matchedEntity = identityBible.entities.find((e) => e.id === identityBible.primaryIdentityId)
    }
    if (!matchedEntity && identityBible.entities.length > 0) {
      matchedEntity = identityBible.entities[0]
    }
  }

  if (globalContext && Array.isArray(globalContext.communities)) {
    matchedCommunity = globalContext.communities.find((c) => {
      const name = c.name.toLowerCase()
      return sceneLower.includes(name)
    })
    if (!matchedCommunity && globalContext.communities.length > 0) {
      matchedCommunity = globalContext.communities[0]
    }
  }

  // 2. Classify scene visual category
  const isCourthouse = /\b(courthouse|court house|courtroom|federal court|judge|judicial|legal records|hall of records|civic plaza)\b/i.test(sceneLower)
  const isDocumentsOnly = /\b(document|documents|deed|deeds|ledger|ledgers|contract|records|registry|parchment|balance sheet|official paper)\b/i.test(sceneLower) && !/\b(men|women|people|workers|farmers|labor|crew)\b/i.test(sceneLower)
  const isWorkshop = /\b(workshop|equipment maintenance|repairs|machine shop|workbench|mechanic|tool rack|hydraulic|fastening)\b/i.test(sceneLower)
  const isKitchen = /\b(kitchen|cooking|baking|meal prep|communal meal|bread|roast|cutting board|pantry)\b/i.test(sceneLower)
  const isAerialLandscape = /\b(aerial|drone|bird'?s eye|overhead|panoramic farm|prairie expanse|high altitude|landscape view)\b/i.test(sceneLower)
  const isMedicalScene = profile === 'health' || /\b(kidney|glomerulus|nephron|capillary|blood flow|vessel|cellular|organ|tissue|artery|filtration)\b/i.test(sceneLower)

  const mentionsPeople = /\b(men|man|women|woman|people|workers?|farmers?|crew|group|individual|hands?|members?|team|soldiers?|craftsmen|technicians?|agronomists?|specialists?|botanists?|scientists?|engineers?|doctors?|surgeons?|analysts?|traders?|chefs?|cooks?|officers?|citizens?|residents?|person)\b/i.test(sceneLower)

  // 3. Resolve Presence ('dominant' | 'visible' | 'context' | 'none')
  let presence: 'dominant' | 'visible' | 'context' | 'none' = 'none'

  if (sceneIdentity?.strength) {
    presence = sceneIdentity.strength
  } else if (isCourthouse || (isDocumentsOnly && !mentionsPeople)) {
    presence = matchedEntity || matchedCommunity ? 'context' : 'none'
  } else if (isAerialLandscape && !mentionsPeople) {
    presence = matchedEntity || matchedCommunity ? 'visible' : 'none'
  } else if (mentionsPeople) {
    presence = 'dominant'
  } else if (matchedEntity || matchedCommunity) {
    presence = 'visible'
  }

  // 4. Resolve Canonical Subject & Type
  let canonicalSubject = cleanText(intent || sceneDirection?.visualEvent?.subject || narration)
  let subjectType = matchedEntity?.entityType || 'other'
  const aliases: string[] = matchedEntity?.aliases ? [...matchedEntity.aliases] : []

  const isHutterite = isHutteriteContext(sceneText, globalContext, identityBible)

  if (isMedicalScene) {
    subjectType = 'species'
    if (/\b(nephron|glomerulus|kidney)\b/i.test(sceneLower)) {
      canonicalSubject = 'Renal nephron glomerulus and microvascular capillary bed'
    } else if (/\b(bladder)\b/i.test(sceneLower)) {
      canonicalSubject = 'Human urinary bladder wall and expanding internal lumen'
    } else {
      canonicalSubject = cleanText(intent || 'human physiological tissue structures')
    }
  } else if (isCourthouse) {
    canonicalSubject = 'Exterior facade of a federal courthouse'
    subjectType = 'architecture'
  } else if (isDocumentsOnly) {
    canonicalSubject = 'Archival legal documents and colony land registration records'
    subjectType = 'product'
  } else if (isAerialLandscape && isHutterite) {
    canonicalSubject = 'Contemporary Hutterite communal farm colony'
    subjectType = 'location'
  } else if (isWorkshop && isHutterite) {
    canonicalSubject = 'Hutterite men maintaining agricultural workshop equipment'
    subjectType = 'community'
  } else if (isKitchen && isHutterite) {
    canonicalSubject = 'Hutterite women preparing food in a communal colony kitchen'
    subjectType = 'community'
  } else if (isHutterite && mentionsPeople) {
    canonicalSubject = 'Hutterite colony members'
    subjectType = 'community'
  } else if (matchedEntity) {
    canonicalSubject = matchedEntity.canonicalName
    subjectType = matchedEntity.entityType
  } else if (globalContext?.primarySubject) {
    if (presence === 'context') {
      canonicalSubject = cleanText(intent || sceneDirection?.visualEvent?.subject || narration)
    } else {
      canonicalSubject = cleanText(globalContext.primarySubject)
    }
  }

  // 5. Gather Visual Traits & Signatures
  const requiredVisualTraits: string[] = []
  const optionalVisualTraits: string[] = []
  const wardrobe: string[] = []
  const physicalAppearance: string[] = []
  const architecture: string[] = []
  const environment: string[] = []
  const tools: string[] = []
  const machinery: string[] = []
  const materialCulture: string[] = []
  const socialBehavior: string[] = []
  const temporalMarkers: string[] = []
  const geographicMarkers: string[] = []
  const forbiddenSubstitutions: string[] = []
  const uncertaintyNotes: string[] = []

  // Ingest from matchedEntity if present
  if (matchedEntity) {
    if (matchedEntity.requiredTraits) requiredVisualTraits.push(...matchedEntity.requiredTraits)
    if (matchedEntity.optionalTraits) optionalVisualTraits.push(...matchedEntity.optionalTraits)
    if (matchedEntity.forbiddenTraits) forbiddenSubstitutions.push(...matchedEntity.forbiddenTraits)
    if (matchedEntity.mustNotConfuseWith) forbiddenSubstitutions.push(...matchedEntity.mustNotConfuseWith)
    if (matchedEntity.uncertainty) uncertaintyNotes.push(...matchedEntity.uncertainty)

    const sig = matchedEntity.visualSignature
    if (sig) {
      if (presence === 'dominant' || presence === 'visible') {
        if (sig.clothing) wardrobe.push(...sig.clothing)
        if (sig.accessories) wardrobe.push(...sig.accessories)
        if (sig.grooming) physicalAppearance.push(...sig.grooming)
        if (sig.agePresentation) physicalAppearance.push(...sig.agePresentation)
        if (sig.physiquePresentation) physicalAppearance.push(...sig.physiquePresentation)
        if (sig.behavior) socialBehavior.push(...sig.behavior)
        if (sig.socialGrouping) socialBehavior.push(...sig.socialGrouping)
      }
      if (sig.architecture) architecture.push(...sig.architecture)
      if (sig.environment) environment.push(...sig.environment)
      if (sig.tools) tools.push(...sig.tools)
      if (sig.machinery) machinery.push(...sig.machinery)
      if (sig.materialCulture) materialCulture.push(...sig.materialCulture)
      if (sig.recurringObjects) materialCulture.push(...sig.recurringObjects)
      if (sig.eraMarkers) temporalMarkers.push(...sig.eraMarkers)
      if (sig.geographicMarkers) geographicMarkers.push(...sig.geographicMarkers)
    }
  }

  // Ingest from matchedCommunity if present
  if (matchedCommunity) {
    if (matchedCommunity.mustNotConfuseWith) forbiddenSubstitutions.push(...matchedCommunity.mustNotConfuseWith)
    if (matchedCommunity.visualIdentity) {
      const vid = matchedCommunity.visualIdentity
      if (presence === 'dominant' || presence === 'visible') {
        if (vid.clothing) wardrobe.push(...vid.clothing)
        if (vid.grooming) physicalAppearance.push(...vid.grooming)
        if (vid.accessories) wardrobe.push(...vid.accessories)
        if (vid.socialBehavior) socialBehavior.push(...vid.socialBehavior)
      }
      if (vid.tools) tools.push(...vid.tools)
      if (vid.environment) environment.push(...vid.environment)
      if (vid.architecture) architecture.push(...vid.architecture)
      if (vid.machinery) machinery.push(...vid.machinery)
      if (vid.materialCulture) materialCulture.push(...vid.materialCulture)
      if (vid.eraMarkers) temporalMarkers.push(...vid.eraMarkers)
      if (vid.forbiddenTraits) forbiddenSubstitutions.push(...vid.forbiddenTraits)
    }
  }

  // Ingest from globalContext
  if (globalContext) {
    forbiddenSubstitutions.push(...(globalContext.forbiddenSubstitutions || []))
    if (globalContext.visualWorld) {
      const vw = globalContext.visualWorld
      if (vw.architecture) architecture.push(...vw.architecture)
      if (vw.environment) environment.push(...vw.environment)
      if (vw.machinery) machinery.push(...vw.machinery)
      if (vw.clothing && (presence === 'dominant' || presence === 'visible')) wardrobe.push(...vw.clothing)
      if (vw.recurringObjects) materialCulture.push(...vw.recurringObjects)
    }
    if (globalContext.geography?.primaryRegion) geographicMarkers.push(globalContext.geography.primaryRegion)
    if (globalContext.geography?.primaryCountry) geographicMarkers.push(globalContext.geography.primaryCountry)
    if (globalContext.timeContext?.primaryPeriod) temporalMarkers.push(globalContext.timeContext.primaryPeriod)
  }

  // 6. Domain-specific grounding refinements

  // (A) Hutterite Documentary Rules (Contemporary, respectful, agricultural)
  if (isHutterite) {
    forbiddenSubstitutions.push(
      'generic Amish horse-and-buggy setting',
      'Amish stereotyping',
      'horse-drawn carriage',
      'straw hats',
      'invented religious ceremonies',
      'anachronistic obsolete machinery',
      'exaggerated costumes'
    )

    if (isCourthouse) {
      // Courthouse scene: NO farm clothing or tractors on screen!
      architecture.push('classical stone courthouse', 'limestone facade', 'institutional columns', 'broad exterior steps')
      environment.push('civic plaza', 'government district', 'urban administrative setting')
      wardrobe.length = 0 // Clear farm clothes
      tools.length = 0
      machinery.length = 0
    } else if (isDocumentsOnly) {
      // Document close-up scene: focused on legal ledgers, paper, deeds
      materialCulture.push('bound registration ledgers', 'official stamped deed papers', 'notarized documents')
      tools.push('archival magnifying glass', 'fountain pen')
      environment.push('wooden archive desk', 'institutional examination table')
      wardrobe.length = 0
    } else if (isWorkshop) {
      if (presence === 'dominant' || presence === 'visible') {
        wardrobe.push('practical, modest collared work shirts', 'durable work trousers', 'appropriate working footwear')
        socialBehavior.push('coordinated manual work', 'collaborative equipment maintenance')
      }
      architecture.push('functional rural equipment workshop', 'utilitarian colony workshop')
      environment.push('organized tool racks', 'industrial workbenches')
      tools.push('hand tools', 'wrenches', 'mechanical fittings')
      machinery.push('modern agricultural equipment', 'mechanical housing', 'hydraulic components')
    } else if (isKitchen) {
      if (presence === 'dominant' || presence === 'visible') {
        wardrobe.push('modest practical dresses', 'work aprons', 'traditional dark head coverings')
        socialBehavior.push('communal cooking preparation', 'efficient collective food production')
      }
      architecture.push('large-scale communal colony kitchen', 'commercial food preparation facility')
      tools.push('commercial prep bowls', 'stainless steel utensils', 'wooden cutting boards')
      environment.push('stainless steel countertops', 'commercial range cookers', 'organized pantry storage')
    } else if (isAerialLandscape) {
      architecture.push('communal farm colony layout', 'central dining hall', 'clustered residential buildings', 'grain silos')
      environment.push('expansive rural prairie farmland', 'open agricultural fields', 'vast horizon')
      machinery.push('modern combines', 'large agricultural tractors', 'grain augers')
      wardrobe.length = 0 // No visible clothing from high altitude
    } else if (presence === 'dominant' || presence === 'visible') {
      wardrobe.push('practical modest clothing', 'collared shirts and trousers for men', 'modest dresses for women')
      environment.push('communal agricultural farmstead', 'rural colony yard')
      machinery.push('modern agricultural machinery')
    }
  }

  // (B) Health / Physiological Rules
  if (isMedicalScene) {
    environment.push('dark navy medical background', 'accurate cellular tissue environment', 'volumetric physiological depth')
    physicalAppearance.push('semi-permeable endothelial membrane', 'cellular transport structures')
    forbiddenSubstitutions.push(
      'fake diagnostic numbers',
      'exaggerated disease gore',
      'speculative molecular diagrams',
      'floating currency symbols',
      'agricultural machinery'
    )
    wardrobe.length = 0 // No wardrobe in cellular anatomy
    tools.length = 0
    machinery.length = 0
  }

  // (C) History Rules (e.g. Ancient Rome)
  if (/\b(roman|legion|centurion|gladiator|caesar|aqueduct)\b/i.test(sceneLower)) {
    forbiddenSubstitutions.push('modern artifacts', 'anachronistic objects', 'medieval armor', 'fantasy swords')
    if (presence === 'dominant' || presence === 'visible') {
      wardrobe.push('period-authentic wool tunics', 'lorica armor', 'caligae leather sandals', 'galea helmets')
      tools.push('gladius short swords', 'pilum javelins', 'scutum shields')
      socialBehavior.push('disciplined military patrol', 'grounded historical interaction')
    }
    architecture.push('stone and timber Roman fortifications', 'defensive palisade', 'watchtower')
    environment.push('frontier wilderness', 'rough gravel military road')
    temporalMarkers.push('Roman imperial period')
  }

  // Deduplicate all arrays
  const cleanWardrobe = dedupeStrings(wardrobe)
  const cleanPhysicalAppearance = dedupeStrings(physicalAppearance)
  const cleanArchitecture = dedupeStrings(architecture)
  const cleanEnvironment = dedupeStrings(environment)
  const cleanTools = dedupeStrings(tools)
  const cleanMachinery = dedupeStrings(machinery).filter((m) => {
    if (isHutterite && /\b(horse|buggy)\b/i.test(m)) return false
    return true
  })
  const cleanMaterialCulture = dedupeStrings(materialCulture)
  const cleanSocialBehavior = dedupeStrings(socialBehavior)
  const cleanTemporalMarkers = dedupeStrings(temporalMarkers)
  const cleanGeographicMarkers = dedupeStrings(geographicMarkers)
  const cleanForbidden = dedupeStrings(forbiddenSubstitutions)
  const cleanRequired = dedupeStrings(requiredVisualTraits)
  const cleanOptional = dedupeStrings(optionalVisualTraits)

  return {
    canonicalSubject,
    aliases: dedupeStrings(aliases),
    subjectType,
    presence,
    requiredVisualTraits: cleanRequired,
    optionalVisualTraits: cleanOptional,
    wardrobe: cleanWardrobe,
    physicalAppearance: cleanPhysicalAppearance,
    architecture: cleanArchitecture,
    environment: cleanEnvironment,
    tools: cleanTools,
    machinery: cleanMachinery,
    materialCulture: cleanMaterialCulture,
    socialBehavior: cleanSocialBehavior,
    temporalMarkers: cleanTemporalMarkers,
    geographicMarkers: cleanGeographicMarkers,
    forbiddenSubstitutions: cleanForbidden,
    uncertaintyNotes: dedupeStrings(uncertaintyNotes),
    confidence: matchedEntity ? matchedEntity.confidence : matchedCommunity ? 0.85 : 0.75
  }
}
