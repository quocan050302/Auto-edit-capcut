import * as fs from 'fs'
import * as path from 'path'
import { computeSourceFingerprint } from '../pipeline/source-fingerprint'
import type { GlobalScriptContext } from '../../../shared/types'
import type { ContentIntelligence } from './content-intelligence-types'
import type { VisualIdentityBible, VisualIdentityEntity } from './visual-identity-types'
import { logger } from '../logger'

export function getVisualIdentityBiblePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'visual-identity-bible.json')
}

export function loadVisualIdentityBible(projectDir: string, currentSourceHash?: string): VisualIdentityBible | null {
  const filePath = getVisualIdentityBiblePath(projectDir)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as VisualIdentityBible
    if (currentSourceHash && parsed.sourceHash && parsed.sourceHash !== currentSourceHash) {
      return null
    }
    return parsed
  } catch (err) {
    logger.warn(`Failed to parse ${filePath}:`, err)
    return null
  }
}

export function saveVisualIdentityBible(projectDir: string, bible: VisualIdentityBible): void {
  const filePath = getVisualIdentityBiblePath(projectDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(bible, null, 2), 'utf-8')
}

export function generateVisualIdentityBible(params: {
  projectDir: string
  scriptText: string
  globalContext: GlobalScriptContext
  contentIntelligence: ContentIntelligence
}): VisualIdentityBible {
  const { projectDir, scriptText, globalContext, contentIntelligence } = params
  const sourceHash = computeSourceFingerprint(scriptText)

  const cached = loadVisualIdentityBible(projectDir, sourceHash)
  if (cached) {
    return cached
  }

  const entities: VisualIdentityEntity[] = []
  let identityMode: VisualIdentityBible['identityMode'] = 'none'

  // Extract from communities
  if (globalContext.communities && globalContext.communities.length > 0) {
    for (const comm of globalContext.communities) {
      const isPrimary = globalContext.primarySubject.includes(comm.name)
      const entity: VisualIdentityEntity = {
        id: `community-${comm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        canonicalName: comm.name,
        entityType: 'community',
        importance: isPrimary ? 'primary' : 'secondary',
        aliases: [comm.name],
        description: comm.visualDescription || comm.role,
        visualSignature: {
          clothing: comm.visualIdentity?.clothing || [],
          grooming: comm.visualIdentity?.grooming || [],
          agePresentation: [],
          physiquePresentation: [],
          accessories: comm.visualIdentity?.accessories || [],
          tools: comm.visualIdentity?.tools || [],
          behavior: comm.visualIdentity?.socialBehavior || [],
          socialGrouping: comm.visualIdentity?.socialBehavior || [],
          environment: comm.visualIdentity?.environment || [],
          architecture: comm.visualIdentity?.architecture || [],
          machinery: comm.visualIdentity?.machinery || [],
          recurringObjects: [],
          materialCulture: comm.visualIdentity?.materialCulture || [],
          eraMarkers: comm.visualIdentity?.eraMarkers || [],
          geographicMarkers: [],
          technologyLevel: [],
          distinctiveShapesForms: []
        },
        requiredTraits: [],
        optionalTraits: [],
        forbiddenTraits: comm.visualIdentity?.forbiddenTraits || [],
        mustNotConfuseWith: comm.mustNotConfuseWith || [],
        uncertainty: [],
        evidence: [{ trait: 'Derived from global context community', level: 'global-context', confidence: 0.9 }],
        confidence: 0.9
      }
      entities.push(entity)
    }
  }

  // Extract from recurring people
  if (globalContext.recurringPeople && globalContext.recurringPeople.length > 0) {
    for (const person of globalContext.recurringPeople) {
      const entity: VisualIdentityEntity = {
        id: `person-${person.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        canonicalName: person.role,
        entityType: 'person-role',
        importance: 'secondary',
        aliases: [person.role],
        description: person.role,
        visualSignature: {
          clothing: person.clothing ? [person.clothing] : [],
          grooming: [],
          agePresentation: person.ageRange ? [person.ageRange] : [],
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
        requiredTraits: person.appearance ? [person.appearance] : [],
        optionalTraits: [],
        forbiddenTraits: [],
        mustNotConfuseWith: [],
        uncertainty: [],
        evidence: [{ trait: 'Derived from global context recurring people', level: 'global-context', confidence: 0.8 }],
        confidence: 0.8
      }
      entities.push(entity)
    }
  }

  if (entities.some(e => e.entityType === 'community')) {
    identityMode = 'community'
  } else if (entities.some(e => e.entityType === 'person-role')) {
    identityMode = 'mixed'
  } else if (globalContext.visualWorld?.environment?.length > 0) {
    identityMode = 'environment'
  }

  const primaryIdentityId = entities.find(e => e.importance === 'primary')?.id

  const bible: VisualIdentityBible = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHash,
    contentIntelligenceHash: contentIntelligence.sourceHash,
    primaryIdentityId,
    identityMode,
    entities,
    globalRules: {
      realism: [],
      authenticityRequirements: [],
      forbiddenGenericSubstitutions: [],
      forbiddenCrossIdentitySubstitutions: []
    }
  }

  saveVisualIdentityBible(projectDir, bible)
  logger.info(`[VisualIdentityBible] Generated identity bible with ${entities.length} entities`)
  
  return bible
}
