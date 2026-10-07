import { ContentIntelligence, SemanticFidelityResult } from './content-intelligence-types'

const MEDICAL_UNSUPPORTED_DOMAINS = [
  'kidney', 'liver', 'bladder', 'blood vessel', 'artery', 'organ', 'anatomy', 'physiology',
  'biological tissue', 'medical', 'clinical', 'human cells', 'biological fluid', 'hormone', 'enzyme',
  'filtering biological fluid', 'physiological activity', 'observable biological state', 'medical documentary'
]

export function validateSemanticFidelity(
  textToValidate: string,
  contentIntelligence: ContentIntelligence | null,
  sceneNarration?: string
): SemanticFidelityResult {
  const lowerText = textToValidate.toLowerCase()
  const lowerNarration = (sceneNarration || '').toLowerCase()
  
  const unsupported: string[] = []
  
  if (contentIntelligence && !contentIntelligence.executionProfile.humanMedical) {
    for (const term of MEDICAL_UNSUPPORTED_DOMAINS) {
      if (lowerText.includes(term)) {
        // Allow if it's explicitly supported in the scene narration
        if (!lowerNarration.includes(term)) {
          unsupported.push(term)
        }
      }
    }
    
    for (const term of contentIntelligence.forbiddenInterpretations) {
      if (lowerText.includes(term.toLowerCase())) {
        if (!lowerNarration.includes(term.toLowerCase())) {
          unsupported.push(term.toLowerCase())
        }
      }
    }
  }
  
  const isValid = unsupported.length === 0
  
  return {
    valid: isValid,
    score: isValid ? 1.0 : 0.0,
    unsupportedConcepts: unsupported,
    supportedConcepts: [],
    reason: isValid ? 'Passes semantic fidelity check' : `Unsupported domain introduction: ${unsupported.join(', ')}`
  }
}
