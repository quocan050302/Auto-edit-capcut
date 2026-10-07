import { expect, describe, it, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { evaluateContentProfileSemantics } from '../src/main/visual-mix/content-profile-detector'
import { generateContentIntelligence } from '../src/main/content-intelligence/content-intelligence-analyzer'
import { validateSemanticFidelity } from '../src/main/content-intelligence/semantic-fidelity'
import { computeSourceFingerprint } from '../src/main/pipeline/source-fingerprint'

describe('Content Intelligence Regression Tests', () => {
  const TEST_DIR = path.join(__dirname, 'test-project-ci')
  
  beforeAll(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_DIR)
  })

  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  const HUTTERITE_SCRIPT = `
The Hutterites are an Anabaptist group, tracing their roots to the Radical Reformation of the 16th century.
Like the Amish and Mennonites, they are known for their commitment to pacifism, communal living, and a strict adherence to their faith.
However, unlike the Amish, who eschew most modern technology, Hutterites enthusiastically embrace modern agricultural machinery.
Their colonies operate as large-scale, highly efficient farming enterprises, utilizing tractors, combines, and advanced irrigation systems.
This documentary explores how they balance their deep-rooted religious traditions with the demands of modern agribusiness, 
particularly during land purchases which can create friction with neighboring communities.
Their agricultural colony focuses on filtering fluid from the wheat field and processing the harvest efficiently.
`

  const GLOBAL_CONTEXT = {
    primarySubject: 'Hutterite agricultural colonies and land purchases',
    centralThesis: 'Hutterites balance traditional Anabaptist faith with modern agricultural practices and community friction',
    exactTopicAnchors: ['Hutterite colony', 'Anabaptist', 'agricultural machinery', 'land purchase']
  }

  it('evaluates Hutterite documentary as General profile despite false-positive triggers', () => {
    // Note: The script contains "filtering fluid" which was causing medical visuals.
    const evaluation = evaluateContentProfileSemantics({
      scriptText: HUTTERITE_SCRIPT,
      globalContext: GLOBAL_CONTEXT as any
    })
    console.log('REASONS:', evaluation.reasons)
    console.log('SIGNALS:', evaluation.detectedSignals)

    expect(evaluation.resolvedProfile).to.equal('general')
  })

  it('generates Content Intelligence with general domain and medical=false', () => {
    const ci = generateContentIntelligence({
      projectDir: TEST_DIR,
      scriptText: HUTTERITE_SCRIPT,
      globalContext: GLOBAL_CONTEXT as any
    })

    expect(ci.executionProfile.humanMedical).to.be.false
    expect(ci.domain.primaryDomain).to.equal('general documentary')
  })

  it('rejects medical semantic queries for Hutterite documentary', () => {
    const ci = generateContentIntelligence({
      projectDir: TEST_DIR,
      scriptText: HUTTERITE_SCRIPT,
      globalContext: GLOBAL_CONTEXT as any
    })

    // Suppose AI mistakenly proposed a medical prompt
    const fid1 = validateSemanticFidelity('kidney filtering biological fluid', ci)
    expect(fid1.valid).to.be.false
    expect(fid1.unsupportedConcepts).to.include('kidney')

    const fid2 = validateSemanticFidelity('agricultural colony machinery', ci)
    expect(fid2.valid).to.be.true
  })
  
  it('computes stable source fingerprints for script content', () => {
    const hash1 = computeSourceFingerprint(HUTTERITE_SCRIPT)
    const hash2 = computeSourceFingerprint(HUTTERITE_SCRIPT + '   \n  ') // normalization should make this match
    expect(hash1).to.equal(hash2)
  })
})
