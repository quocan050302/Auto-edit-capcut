export interface ContentIntelligence {
  schemaVersion: number
  generatedAt: string
  sourceHash: string

  subject: {
    primarySubject: string
    secondarySubjects: string[]
    mainEntities: string[]
  }

  domain: {
    primaryDomain: string
    secondaryDomains: string[]
    confidence: number
  }

  executionProfile: {
    recommended: 'general' | 'health'
    confidence: number
    humanMedical: boolean
    humanMedicalConfidence: number
    reason: string
  }

  documentaryAngle: string

  visualOntology: {
    people: string[]
    places: string[]
    environments: string[]
    objects: string[]
    activities: string[]
    infrastructure: string[]
    machinery: string[]
    documents: string[]
  }

  visualStyle: {
    documentaryStyle: string
    lighting: string
    colorMood: string
    cameraLanguage: string
  }

  forbiddenInterpretations: string[]

  dangerousAmbiguities: Array<{
    term: string
    intendedMeaning: string
    forbiddenMeaning: string
  }>

  evidence: Array<{
    signal: string
    explanation: string
  }>

  generatedBy: 'global-context-ai' | 'deterministic-fallback'
}

export interface SemanticFidelityResult {
  valid: boolean
  score: number
  unsupportedConcepts: string[]
  supportedConcepts: string[]
  reason: string
}
