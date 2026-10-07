import { describe, it, expect } from 'vitest'
import { resolveSceneIdentity } from '../src/main/content-intelligence/scene-identity-resolver'
import type { VisualIdentityBible } from '../src/main/content-intelligence/visual-identity-types'
import type { GlobalScriptContext } from '../shared/types'
import type { ContentIntelligence } from '../src/main/content-intelligence/content-intelligence-types'

describe('Scene Identity Resolver', () => {
  const dummyBible: VisualIdentityBible = {
    schemaVersion: 1,
    generatedAt: 'now',
    sourceHash: '123',
    contentIntelligenceHash: '123',
    identityMode: 'community',
    primaryIdentityId: 'community-hutterites',
    entities: [
      {
        id: 'community-hutterites',
        canonicalName: 'Hutterites',
        entityType: 'community',
        importance: 'primary',
        aliases: ['Hutterite colony'],
        description: '',
        visualSignature: {
          clothing: ['plaid'],
          grooming: [],
          agePresentation: [],
          physiquePresentation: [],
          accessories: [],
          tools: [],
          behavior: [],
          socialGrouping: [],
          environment: [],
          architecture: [],
          machinery: [],
          recurringObjects: [],
          materialCulture: [],
          eraMarkers: [],
          geographicMarkers: [],
          technologyLevel: [],
          distinctiveShapesForms: []
        },
        requiredTraits: [],
        optionalTraits: [],
        forbiddenTraits: [],
        mustNotConfuseWith: [],
        uncertainty: [],
        evidence: [],
        confidence: 0.9
      }
    ],
    globalRules: { realism: [], authenticityRequirements: [], forbiddenGenericSubstitutions: [], forbiddenCrossIdentitySubstitutions: [] }
  }

  const dummyCI: ContentIntelligence = {
    schemaVersion: 1,
    generatedAt: 'now',
    sourceHash: 'abc',
    subject: { primarySubject: 'Test', secondarySubjects: [], mainEntities: [] },
    domain: { primaryDomain: 'test', secondaryDomains: [], confidence: 1 },
    executionProfile: { recommended: 'general', confidence: 1, humanMedical: false, humanMedicalConfidence: 0, reason: '' },
    documentaryAngle: 'Test',
    visualOntology: { people: [], places: [], environments: [], objects: [], activities: [], infrastructure: [], machinery: [], documents: [] },
    visualStyle: { documentaryStyle: 'test', lighting: 'test', colorMood: 'test', cameraLanguage: 'test' },
    forbiddenInterpretations: [],
    dangerousAmbiguities: [],
    evidence: [],
    generatedBy: 'deterministic-fallback'
  }

  const globalContext: GlobalScriptContext = {} as any

  it('resolves dominant identity when specifically mentioned', () => {
    const binding = resolveSceneIdentity({
      sceneIndex: 1,
      sceneNarration: 'The Hutterite colony is quiet in the morning.',
      visualIntent: 'A view of the colony',
      identityBible: dummyBible,
      globalContext,
      contentIntelligence: dummyCI
    })

    expect(binding.entityIds).toContain('community-hutterites')
    expect(binding.strength).toBe('dominant')
  })

  it('resolves context identity when primary subject is not mentioned but implicit', () => {
    const binding = resolveSceneIdentity({
      sceneIndex: 2,
      sceneNarration: 'Tractors roll across the field.',
      visualIntent: 'Farming equipment',
      identityBible: dummyBible,
      globalContext,
      contentIntelligence: dummyCI
    })

    // Because it's primary, it should still bind as 'context'
    expect(binding.entityIds).toContain('community-hutterites')
    expect(binding.strength).toBe('context')
  })
})
