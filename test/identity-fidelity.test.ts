import { describe, it, expect } from 'vitest'
import { validateIdentityFidelity } from '../src/main/content-intelligence/identity-fidelity'
import { enrichPromptWithIdentity } from '../src/main/content-intelligence/prompt-identity-enricher'
import type { SceneIdentityBinding, VisualIdentityBible } from '../src/main/content-intelligence/visual-identity-types'

describe('Identity Fidelity and Enricher', () => {
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
        aliases: [],
        description: '',
        visualSignature: {
          clothing: ['plaid shirt', 'suspenders'],
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
        mustNotConfuseWith: ['Amish'],
        uncertainty: [],
        evidence: [],
        confidence: 0.9
      }
    ],
    globalRules: { realism: [], authenticityRequirements: [], forbiddenGenericSubstitutions: [], forbiddenCrossIdentitySubstitutions: [] }
  }

  const dummyBinding: SceneIdentityBinding = {
    sceneIndex: 1,
    entityIds: ['community-hutterites'],
    presenceTypes: ['community'],
    strength: 'dominant',
    requiredPromptTraits: [],
    optionalPromptTraits: [],
    forbiddenPromptTraits: [],
    reason: ''
  }

  it('validates a correct prompt', () => {
    const result = validateIdentityFidelity('Hutterites working in the field in plaid shirts.', dummyBinding, dummyBible)
    expect(result.valid).toBe(true)
    expect(result.genericSubstitutionRisk.length).toBe(0)
  })

  it('detects missing canonical name', () => {
    const result = validateIdentityFidelity('Farmers working in the field.', dummyBinding, dummyBible)
    expect(result.valid).toBe(false)
    expect(result.missingRequiredTraits).toContain('Hutterites')
    expect(result.genericSubstitutionRisk).toContain('farmer')
  })

  it('detects forbidden confusion', () => {
    const result = validateIdentityFidelity('Hutterites in an Amish buggy.', dummyBinding, dummyBible)
    expect(result.valid).toBe(false)
    expect(result.conflictingTraits).toContain('Amish')
  })

  it('enriches a prompt automatically', () => {
    const result = enrichPromptWithIdentity({
      basePrompt: 'Farmers working in the field.',
      scene: { sceneIndex: 1 },
      identityBible: dummyBible,
      binding: dummyBinding
    })
    
    expect(result.repaired).toBe(true)
    expect(result.prompt).toContain('[Identity: Hutterites]')
    expect(result.prompt).toContain('plaid shirt')
    expect(result.prompt).toContain('Amish') // "Do NOT include: Amish"
  })
})
