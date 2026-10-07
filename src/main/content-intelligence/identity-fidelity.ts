import type { IdentityFidelityResult, SceneIdentityBinding, VisualIdentityBible } from './visual-identity-types'

export function validateIdentityFidelity(
  prompt: string,
  binding: SceneIdentityBinding,
  identityBible: VisualIdentityBible
): IdentityFidelityResult {
  const result: IdentityFidelityResult = {
    valid: true,
    score: 1.0,
    missingRequiredTraits: [],
    conflictingTraits: [],
    genericSubstitutionRisk: [],
    reason: 'Identity fidelity is intact.'
  }

  if (binding.strength === 'none' || binding.entityIds.length === 0) {
    return result
  }

  const promptLower = prompt.toLowerCase()

  // Find the entities for this binding
  const boundEntities = identityBible.entities.filter(e => binding.entityIds.includes(e.id))

  for (const entity of boundEntities) {
    const canonicalLower = entity.canonicalName.toLowerCase()
    
    // Check canonical name
    if (binding.strength === 'dominant' || binding.strength === 'visible') {
      if (!promptLower.includes(canonicalLower) && !entity.aliases.some(a => promptLower.includes(a.toLowerCase()))) {
        result.valid = false
        result.missingRequiredTraits.push(entity.canonicalName)
      }
    }

    // Check generic substitutions
    const genericWeakWords = ['farmer', 'worker', 'leader', 'woman', 'man', 'family', 'child', 'people', 'soldier', 'resident', 'businessman']
    let onlyGeneric = true
    for (const w of genericWeakWords) {
      if (promptLower.includes(w)) {
        if (!promptLower.includes(canonicalLower)) {
          result.genericSubstitutionRisk.push(w)
        }
      }
    }

    // Must not confuse with check
    for (const forbidden of entity.mustNotConfuseWith) {
      if (promptLower.includes(forbidden.toLowerCase())) {
        result.valid = false
        result.conflictingTraits.push(forbidden)
      }
    }
  }

  if (!result.valid) {
    result.score = 0.5
    result.reason = 'Missing canonical identity or contains generic/forbidden substitutions.'
  }

  return result
}
