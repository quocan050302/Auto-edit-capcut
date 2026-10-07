import type { SceneIdentityBinding, VisualIdentityBible } from './visual-identity-types'
import type { ContentIntelligence } from './content-intelligence-types'
import type { GlobalScriptContext } from '../../../shared/types'
import { validateIdentityFidelity } from './identity-fidelity'

export function enrichPromptWithIdentity(params: {
  basePrompt: string
  scene: { sceneIndex: number, narration?: string, intent?: string }
  identityBible?: VisualIdentityBible
  binding?: SceneIdentityBinding
  globalContext?: GlobalScriptContext
  contentIntelligence?: ContentIntelligence
}): {
  prompt: string
  injectedTraits: string[]
  identityScore: number
  repaired: boolean
} {
  const { basePrompt, identityBible, binding } = params

  if (!identityBible || !binding || binding.strength === 'none' || binding.entityIds.length === 0) {
    return { prompt: basePrompt, injectedTraits: [], identityScore: 1.0, repaired: false }
  }

  // Validate current prompt
  const initialValidation = validateIdentityFidelity(basePrompt, binding, identityBible)
  if (initialValidation.valid) {
    return { prompt: basePrompt, injectedTraits: [], identityScore: initialValidation.score, repaired: false }
  }

  const boundEntities = identityBible.entities.filter(e => binding.entityIds.includes(e.id))
  let enrichedPrompt = basePrompt
  const injectedTraits: string[] = []

  for (const entity of boundEntities) {
    if (!enrichedPrompt.toLowerCase().includes(entity.canonicalName.toLowerCase())) {
      // Very basic local repair mechanism: prepend canonical identity and append traits
      const identityPrefix = `[Identity: ${entity.canonicalName}]`
      
      const traits = []
      if (entity.visualSignature.clothing.length > 0) {
        traits.push(...entity.visualSignature.clothing)
      }
      if (entity.visualSignature.environment.length > 0) {
        traits.push(...entity.visualSignature.environment)
      }
      
      const identitySuffix = traits.length > 0 ? ` Required features: ${traits.join(', ')}.` : ''
      const forbiddenSuffix = entity.mustNotConfuseWith.length > 0 ? ` Do NOT include: ${entity.mustNotConfuseWith.join(', ')}.` : ''

      enrichedPrompt = `${identityPrefix} ${enrichedPrompt}${identitySuffix}${forbiddenSuffix}`
      injectedTraits.push(entity.canonicalName, ...traits)
    }
  }

  // Re-validate
  const finalValidation = validateIdentityFidelity(enrichedPrompt, binding, identityBible)

  return {
    prompt: enrichedPrompt,
    injectedTraits,
    identityScore: finalValidation.score,
    repaired: true
  }
}
