import type { GlobalScriptContext } from '../../../shared/types'
import type { ContentIntelligence } from '../content-intelligence/content-intelligence-types'
import type { VisualIdentityBible, SceneIdentityBinding } from '../content-intelligence/visual-identity-types'
import { enrichPromptWithIdentity } from '../content-intelligence/prompt-identity-enricher'

export type GeneralVisualNiche =
  | 'history'
  | 'finance'
  | 'food'
  | 'technology'
  | 'travel'
  | 'nature'
  | 'documentary'

const HISTORY_KEYWORDS = /\b(century|ancient|empire|war|battle|reign|dynasty|soldier|medieval|revolution|colony|settler|settlement|historic|historical|heritage|monarch|king|queen|emperor|castle|monastery|traditional|vintage|archive|era|treaty|conquest|founding|pioneer)\b/i
const FINANCE_KEYWORDS = /\b(finance|financial|money|bank|banking|stock|market|trade|trading|crypto|bitcoin|currency|inflation|economy|economic|invest|investment|investor|dollar|wealth|capital|fund|asset|ledger|real\s*estate|corporate|commerce|startup)\b/i
const FOOD_KEYWORDS = /\b(food|culinary|chef|cooking|recipe|dish|cuisine|kitchen|ingredient|vegetable|fruit|spice|baking|bread|pastry|flavor|restaurant|meal|dining|taste|coffee|wine|brewery|harvest)\b/i
const TECH_KEYWORDS = /\b(technology|tech|software|hardware|computer|digital|internet|cyber|ai|algorithm|robot|robotics|space|satellite|quantum|chip|semiconductor|server|network|data\s*center|futuristic|engineering|code|circuit)\b/i
const TRAVEL_KEYWORDS = /\b(travel|destination|journey|explore|exploration|tourist|tourism|landscape|mountain|ocean|island|valley|desert|coast|cultural|monument|landmark|scenic|architecture|temple|ruins|expedition)\b/i
const NATURE_KEYWORDS = /\b(wildlife|animal|forest|jungle|tree|river|ecosystem|species|flora|fauna|oceanic|marine|arctic|glacier|volcano|creature|habitat|biodiversity|planet|earth|safari)\b/i

/**
 * Detects the visual niche of a scene or global script.
 */
export function detectVisualNiche(
  text: string,
  globalContext?: GlobalScriptContext
): GeneralVisualNiche {
  // Check globalContext first if available
  if (globalContext) {
    const globalText = `${globalContext.primarySubject || ''} ${globalContext.centralThesis || ''} ${globalContext.visualWorld?.documentaryStyle || ''}`.toLowerCase()
    if (HISTORY_KEYWORDS.test(globalText)) return 'history'
    if (FINANCE_KEYWORDS.test(globalText)) return 'finance'
    if (FOOD_KEYWORDS.test(globalText)) return 'food'
    if (TECH_KEYWORDS.test(globalText)) return 'technology'
    if (TRAVEL_KEYWORDS.test(globalText)) return 'travel'
    if (NATURE_KEYWORDS.test(globalText)) return 'nature'
  }

  // Check scene text
  const sceneLower = (text || '').toLowerCase()
  if (HISTORY_KEYWORDS.test(sceneLower)) return 'history'
  if (FINANCE_KEYWORDS.test(sceneLower)) return 'finance'
  if (FOOD_KEYWORDS.test(sceneLower)) return 'food'
  if (TECH_KEYWORDS.test(sceneLower)) return 'technology'
  if (TRAVEL_KEYWORDS.test(sceneLower)) return 'travel'
  if (NATURE_KEYWORDS.test(sceneLower)) return 'nature'

  return 'documentary'
}

export const detectNicheFromText = detectVisualNiche

export const NICHE_STYLE_DIRECTIVES: Record<GeneralVisualNiche, string> = {
  history:
    'cinematic historical reconstruction, authentic period detail, natural dramatic documentary lighting, grounded atmosphere, archival richness',
  finance:
    'premium editorial documentary visual, clean sophisticated lighting, sleek architectural realism, high-end business editorial aesthetic',
  food:
    'high-end food documentary photography, appetizing natural textures, clean culinary composition, soft directional lighting, rich sensory detail',
  technology:
    'modern technological documentary visualization, sleek contemporary detail, professional ambient lighting, clean cinematic realism',
  travel:
    'cinematic location photography, authentic cultural landscape, sweeping atmosphere, golden hour natural light, rich depth of field',
  nature:
    'cinematic natural history photography, rich environmental depth, authentic natural lighting, National Geographic editorial quality',
  documentary:
    'realistic cinematic documentary still, clear visual storytelling, high detail, professional natural lighting, cinematic 35mm film still aesthetic'
}

const UNIVERSAL_NEGATIVE_CONSTRAINTS =
  '16:9 horizontal composition, clear focal subject, high detail, no text, no readable labels, no watermark, no logo, no UI elements, no blurry foreground occlusions.'

export interface GeneralImagePromptParams {
  narration: string
  visualIntent?: string
  globalContext?: GlobalScriptContext
  category?: string
  sceneIndex?: number
  contentIntelligence?: ContentIntelligence
  identityBible?: VisualIdentityBible
  identityBinding?: SceneIdentityBinding
}

/**
 * Builds a scene-specific Google Flow image prompt for non-health (general) content.
 * Follows documentary aesthetics adapted to the specific niche.
 */
export function buildGeneralImagePrompt(params: GeneralImagePromptParams): string {
  const { narration, visualIntent, globalContext } = params

  let rawSubject = (visualIntent || narration || '')
    .replace(/["'`]/g, '')
    .replace(/[^\w\s,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (rawSubject.length > 220) {
    rawSubject = rawSubject.slice(0, 220).trim()
  }

  const combinedContext = `${narration || ''} ${visualIntent || ''}`
  const niche = detectVisualNiche(combinedContext, globalContext)
  const styleDirective = NICHE_STYLE_DIRECTIVES[niche]

  let contextualAnchor = ''
  if (globalContext?.primarySubject && !rawSubject.toLowerCase().includes(globalContext.primarySubject.toLowerCase())) {
    contextualAnchor = `context: ${globalContext.primarySubject.slice(0, 50)}, `
  }

  let prompt = `${rawSubject}, ${contextualAnchor}${styleDirective}, ${UNIVERSAL_NEGATIVE_CONSTRAINTS}`

  if (params.identityBible && params.identityBinding) {
    const enrichment = enrichPromptWithIdentity({
      basePrompt: prompt,
      scene: { sceneIndex: params.sceneIndex || 0, narration: params.narration, intent: params.visualIntent },
      identityBible: params.identityBible,
      binding: params.identityBinding,
      globalContext: params.globalContext,
      contentIntelligence: params.contentIntelligence
    })
    prompt = enrichment.prompt
  }

  return prompt
}
