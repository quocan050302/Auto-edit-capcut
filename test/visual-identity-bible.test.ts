import { describe, it, expect } from 'vitest'
import { generateVisualIdentityBible } from '../src/main/content-intelligence/visual-identity-bible'
import type { GlobalScriptContext } from '../shared/types'
import type { ContentIntelligence } from '../src/main/content-intelligence/content-intelligence-types'
import { rmSync } from 'fs'
import { join } from 'path'

describe('Visual Identity Bible', () => {
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

  it('generates a bible for community identity', () => {
    const globalContext: GlobalScriptContext = {
      projectId: 'test',
      language: 'en',
      version: 1,
      generatedAt: 'now',
      modelUsed: 'test',
      primarySubject: 'Hutterites',
      secondarySubjects: [],
      globalSynopsis: 'A doc about Hutterites',
      centralThesis: '',
      documentaryAngle: '',
      targetAudience: '',
      geography: { secondaryLocations: [] },
      timeContext: { primaryPeriod: '2024', historicalPeriods: [] },
      communities: [
        {
          name: 'Hutterites',
          role: 'Primary subject',
          visualDescription: 'Communal farmers',
          mustNotConfuseWith: ['Amish', 'Mennonite'],
          visualIdentity: {
            clothing: ['plaid shirts', 'suspenders', 'dark dresses'],
            environment: ['communal farm', 'prairie'],
            forbiddenTraits: ['buggy']
          }
        }
      ],
      recurringPeople: [],
      visualWorld: { environment: [], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: '', documentaryStyle: '' },
      exactTopicAnchors: [],
      contextualAnchors: [],
      forbiddenSubstitutions: [],
      negativeKeywords: [],
      recurringVisualMotifs: [],
      storyArc: []
    }

    const tmpDir = join(__dirname, '.tmp_bible')
    
    const bible = generateVisualIdentityBible({
      projectDir: tmpDir,
      scriptText: 'This is a script about Hutterites.',
      globalContext,
      contentIntelligence: dummyCI
    })

    expect(bible.identityMode).toBe('community')
    expect(bible.entities.length).toBe(1)
    expect(bible.entities[0].canonicalName).toBe('Hutterites')
    expect(bible.entities[0].visualSignature.clothing).toContain('plaid shirts')
    expect(bible.entities[0].mustNotConfuseWith).toContain('Amish')

    try { rmSync(tmpDir, { recursive: true, force: true }) } catch (e) {}
  })
})
