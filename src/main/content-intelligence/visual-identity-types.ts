export interface VisualIdentityEntity {
  id: string
  canonicalName: string
  entityType:
    | 'community'
    | 'person-role'
    | 'character'
    | 'occupation'
    | 'organization'
    | 'historical-group'
    | 'location'
    | 'architecture'
    | 'machine'
    | 'product'
    | 'species'
    | 'environment'
    | 'era'
    | 'other'
  importance: 'primary' | 'secondary' | 'supporting'
  aliases: string[]
  description: string

  visualSignature: {
    clothing: string[]
    grooming: string[]
    agePresentation: string[]
    physiquePresentation: string[]
    accessories: string[]
    tools: string[]
    behavior: string[]
    socialGrouping: string[]
    environment: string[]
    architecture: string[]
    machinery: string[]
    recurringObjects: string[]
    materialCulture: string[]
    eraMarkers: string[]
    geographicMarkers: string[]
    technologyLevel: string[]
    distinctiveShapesForms?: string[]
  }

  requiredTraits: string[]
  optionalTraits: string[]
  forbiddenTraits: string[]
  mustNotConfuseWith: string[]
  uncertainty: string[]

  evidence: Array<{
    trait: string
    level:
      | 'script-explicit'
      | 'global-context'
      | 'high-confidence-general-knowledge'
      | 'inferred'
      | 'unknown'
    confidence: number
  }>

  confidence: number
}

export interface VisualIdentityBible {
  schemaVersion: number
  generatedAt: string
  sourceHash: string
  contentIntelligenceHash: string
  primaryIdentityId?: string
  identityMode: 'none' | 'environment' | 'entity' | 'community' | 'character' | 'mixed'
  entities: VisualIdentityEntity[]
  globalRules: {
    realism: string[]
    authenticityRequirements: string[]
    forbiddenGenericSubstitutions: string[]
    forbiddenCrossIdentitySubstitutions: string[]
  }
}

export interface SceneIdentityBinding {
  sceneIndex: number
  entityIds: string[]
  presenceTypes: Array<
    | 'person'
    | 'community'
    | 'environment'
    | 'architecture'
    | 'object'
    | 'machine'
    | 'era'
    | 'location'
    | 'product'
  >
  strength: 'none' | 'context' | 'visible' | 'dominant'
  requiredPromptTraits: string[]
  optionalPromptTraits: string[]
  forbiddenPromptTraits: string[]
  reason: string
}

export interface IdentityFidelityResult {
  valid: boolean
  score: number
  missingRequiredTraits: string[]
  conflictingTraits: string[]
  genericSubstitutionRisk: string[]
  reason: string
}
