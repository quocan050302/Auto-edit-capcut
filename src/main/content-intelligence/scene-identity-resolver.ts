import type { SceneIdentityBinding, VisualIdentityBible } from './visual-identity-types'
import type { ContentIntelligence } from './content-intelligence-types'
import type { GlobalScriptContext } from '../../../shared/types'

export function resolveSceneIdentity(params: {
  sceneIndex: number
  sceneNarration: string
  visualIntent: string
  identityBible: VisualIdentityBible
  globalContext: GlobalScriptContext
  contentIntelligence: ContentIntelligence
}): SceneIdentityBinding {
  const { sceneIndex, sceneNarration, visualIntent, identityBible } = params

  const binding: SceneIdentityBinding = {
    sceneIndex,
    entityIds: [],
    presenceTypes: [],
    strength: 'none',
    requiredPromptTraits: [],
    optionalPromptTraits: [],
    forbiddenPromptTraits: [],
    reason: 'Default no-identity'
  }

  if (identityBible.identityMode === 'none') {
    return binding
  }

  const narrationLower = sceneNarration.toLowerCase()
  const intentLower = visualIntent.toLowerCase()
  const combinedText = `${narrationLower} ${intentLower}`

  for (const entity of identityBible.entities) {
    const isPrimary = entity.importance === 'primary'
    const nameLower = entity.canonicalName.toLowerCase()
    
    const mentionsName = combinedText.includes(nameLower) || entity.aliases.some(a => combinedText.includes(a.toLowerCase()))
    
    // Crude detection logic for demo purposes (can be expanded)
    if (mentionsName || isPrimary) {
      binding.entityIds.push(entity.id)
      
      if (entity.entityType === 'community') {
        binding.presenceTypes.push('community')
      } else if (entity.entityType === 'person-role') {
        binding.presenceTypes.push('person')
      } else if (entity.entityType === 'environment') {
        binding.presenceTypes.push('environment')
      }

      binding.strength = mentionsName ? 'dominant' : 'context'
      
      // Pull traits
      binding.requiredPromptTraits.push(...entity.requiredTraits)
      binding.requiredPromptTraits.push(...entity.visualSignature.clothing)
      binding.requiredPromptTraits.push(...entity.visualSignature.environment)
      
      binding.forbiddenPromptTraits.push(...entity.forbiddenTraits)
      binding.forbiddenPromptTraits.push(...entity.mustNotConfuseWith)
    }
  }

  if (binding.entityIds.length > 0) {
    binding.reason = `Detected entities: ${binding.entityIds.join(', ')}`
  }

  return binding
}
