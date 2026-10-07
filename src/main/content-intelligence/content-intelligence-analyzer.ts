import * as fs from 'fs'
import * as path from 'path'
import { ContentIntelligence } from './content-intelligence-types'
import { GlobalScriptContext } from '../../../shared/types'
import { computeSourceFingerprint } from '../pipeline/source-fingerprint'
import { evaluateContentProfileSemantics } from '../visual-mix/content-profile-detector'

export function getContentIntelligencePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'content-intelligence.json')
}

export function loadContentIntelligence(projectDir: string, currentHash: string): ContentIntelligence | null {
  const p = getContentIntelligencePath(projectDir)
  if (!fs.existsSync(p)) return null
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as ContentIntelligence
    if (data.sourceHash === currentHash) {
      return data
    }
  } catch {
    /* ignore */
  }
  return null
}

export function saveContentIntelligence(projectDir: string, ci: ContentIntelligence): void {
  const p = getContentIntelligencePath(projectDir)
  fs.mkdirSync(path.join(projectDir, 'analysis'), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(ci, null, 2), 'utf-8')
}

export function generateContentIntelligence(params: {
  projectDir: string
  scriptText: string
  globalContext: GlobalScriptContext
}): ContentIntelligence {
  const { projectDir, scriptText, globalContext } = params
  const sourceHash = computeSourceFingerprint(scriptText)

  // Try to load cached
  const cached = loadContentIntelligence(projectDir, sourceHash)
  if (cached) return cached

  // Fallback heuristic evaluation
  const evaluation = evaluateContentProfileSemantics({ scriptText, globalContext })

  // Build deterministically from Global Context
  const primaryDomain = globalContext.targetAudience || 'general documentary'
  
  const ci: ContentIntelligence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHash,
    subject: {
      primarySubject: globalContext.primarySubject,
      secondarySubjects: globalContext.secondarySubjects || [],
      mainEntities: globalContext.exactTopicAnchors || []
    },
    domain: {
      primaryDomain,
      secondaryDomains: [],
      confidence: evaluation.confidence
    },
    executionProfile: {
      recommended: evaluation.resolvedProfile,
      confidence: evaluation.confidence,
      humanMedical: evaluation.resolvedProfile === 'health',
      humanMedicalConfidence: evaluation.resolvedProfile === 'health' ? evaluation.confidence : 0,
      reason: evaluation.reasons.join('; ')
    },
    documentaryAngle: globalContext.documentaryAngle || '',
    visualOntology: {
      people: globalContext.recurringPeople?.map(p => p.role) || [],
      places: globalContext.geography?.secondaryLocations || [],
      environments: globalContext.visualWorld?.environment || [],
      objects: globalContext.visualWorld?.recurringObjects || [],
      activities: globalContext.visualWorld?.occupations || [],
      infrastructure: globalContext.visualWorld?.architecture || [],
      machinery: globalContext.visualWorld?.machinery || [],
      documents: []
    },
    visualStyle: {
      documentaryStyle: globalContext.visualWorld?.documentaryStyle || '',
      lighting: globalContext.visualWorld?.colorMood || '',
      colorMood: globalContext.visualWorld?.colorMood || '',
      cameraLanguage: 'observational'
    },
    forbiddenInterpretations: globalContext.forbiddenSubstitutions || [],
    dangerousAmbiguities: [],
    evidence: evaluation.reasons.map(r => ({ signal: r, explanation: r })),
    generatedBy: 'deterministic-fallback'
  }

  saveContentIntelligence(projectDir, ci)
  return ci
}
