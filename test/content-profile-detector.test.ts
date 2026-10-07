/**
 * Tests for Auto Content Profile Detector (Section 18, 19, 20, 21, 22, 69, 70, 74, 75)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  evaluateContentProfileSemantics,
  detectOrResolveContentProfile,
  getContentProfilePath,
  CONTENT_PROFILE_SCHEMA_VERSION
} from '../src/main/visual-mix/content-profile-detector'
import { resolveContentProfileMode, ContentProfileDetection } from '../shared/types'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING CONTENT PROFILE DETECTOR UNIT TESTS')
  console.log('==================================================\n')

  const testProjectDir = path.join(__dirname, 'fixtures', 'test-content-profile')
  if (!fs.existsSync(testProjectDir)) {
    fs.mkdirSync(testProjectDir, { recursive: true })
  }

  // 1. Health Script Detection
  await it('1. Health Detection: Accurately classifies human physiology, organs, and metabolism as health', () => {
    const healthScript = `
      When you consume dietary sugars, your pancreas releases insulin into the bloodstream.
      Insulin signals the liver and muscle cells to absorb glucose from the blood vessels.
      Over time, elevated blood sugar leads to cellular insulin resistance and metabolic dysfunction.
      This triggers chronic inflammation in kidney tissues and arterial walls.
    `
    const evalRes = evaluateContentProfileSemantics({
      scriptText: healthScript
    })

    assert.strictEqual(evalRes.resolvedProfile, 'health')
    assert.ok(evalRes.confidence >= 0.85, `Confidence must be >= 0.85, got ${evalRes.confidence}`)
    assert.ok(evalRes.detectedSignals.includes('pancreas'))
    assert.ok(evalRes.detectedSignals.includes('insulin'))
    assert.ok(evalRes.detectedSignals.includes('liver'))
    assert.ok(evalRes.detectedSignals.includes('glucose'))
    assert.ok(evalRes.reasons.length > 0)
  })

  // 2. Anatomy & Neuroscience Detection
  await it('2. Anatomy Detection: Brain, neurons, and neurotransmitters classify as health', () => {
    const neuroScript = `
      Deep inside the human brain, neurons communicate across microscopic synapses.
      During deep sleep and circadian rhythm regulation, cortisol drops while melatonin rises.
      This biological mechanism allows the glymphatic system to clear metabolic waste from cellular structures.
    `
    const evalRes = evaluateContentProfileSemantics({
      scriptText: neuroScript
    })

    assert.strictEqual(evalRes.resolvedProfile, 'health')
    assert.ok(evalRes.detectedSignals.includes('brain'))
    assert.ok(evalRes.detectedSignals.includes('neurons'))
    assert.ok(evalRes.detectedSignals.includes('synapses'))
    assert.ok(evalRes.detectedSignals.includes('melatonin'))
  })

  // 3. General Profile: History / Rome
  await it('3. General Profile: History documentaries without human physiology classify as general', () => {
    const historyScript = `
      In 44 BC, the Roman Senate gathered in the Theatre of Pompey.
      Julius Caesar arrived accompanied by senators and praetors to debate provincial governance.
      The conspiracy led by Marcus Junius Brutus altered the trajectory of the Roman Empire forever.
      Legions marched across Gaul and established military outposts in Germania.
    `
    const evalRes = evaluateContentProfileSemantics({
      scriptText: historyScript
    })

    assert.strictEqual(evalRes.resolvedProfile, 'general')
    assert.ok(evalRes.confidence >= 0.85)
    assert.ok(evalRes.detectedSignals.length === 0)
  })

  // 4. General Profile: Finance & Economy (False positive protection)
  await it('4. False Positive Protection: "financial health" or "healthy economy" does NOT trigger health', () => {
    const financeScript = `
      In this documentary, we analyze the financial health of Silicon Valley tech giants.
      Maintaining a healthy economy requires balancing interest rates and monetary inflation.
      Investors assess corporate health and market valuation before committing venture capital.
    `
    const evalRes = evaluateContentProfileSemantics({
      scriptText: financeScript
    })

    assert.strictEqual(evalRes.resolvedProfile, 'general', 'Finance script must resolve to general')
    assert.ok(evalRes.reasons.some((r) => r.toLowerCase().includes('financial') || r.toLowerCase().includes('general')))
  })

  // 5. Global Script Context Integration
  await it('5. Global Script Context: Incorporates primarySubject and topic anchors for accurate classification', () => {
    const evalRes = evaluateContentProfileSemantics({
      scriptText: 'In this chapter we look at daily habits and dietary patterns.',
      globalContext: {
        primarySubject: 'Human Liver Physiology and Fatty Acid Oxidation',
        centralThesis: 'How the liver processes triglycerides and manages cellular detoxification',
        exactTopicAnchors: ['hepatic tissue', 'mitochondria', 'metabolic enzymes'],
        contextualAnchors: ['nutrition', 'fasting'],
        forbiddenSubstitutions: ['financial models', 'city maps'],
        negativeKeywords: ['stocks', 'politics'],
        geography: [],
        timePeriod: [],
        storyArc: []
      }
    })

    assert.strictEqual(evalRes.resolvedProfile, 'health')
    assert.ok(evalRes.reasons.some((r) => r.includes('primary subject')))
  })

  // 6. Explicit Profile Overrides
  await it('6. Explicit Mode Override: respects explicit "general" and "health" overrides with 1.0 confidence', async () => {
    const overrideHealth = await detectOrResolveContentProfile({
      projectDir: testProjectDir,
      scriptText: 'Just talking about cars and ancient architecture.',
      mode: 'health'
    })
    assert.strictEqual(overrideHealth.resolvedProfile, 'health')
    assert.strictEqual(overrideHealth.confidence, 1.0)

    const overrideGeneral = await detectOrResolveContentProfile({
      projectDir: testProjectDir,
      scriptText: 'Human liver, heart, kidneys, blood glucose, insulin, and arteries.',
      mode: 'general'
    })
    assert.strictEqual(overrideGeneral.resolvedProfile, 'general')
    assert.strictEqual(overrideGeneral.confidence, 1.0)
  })

  // 7. Artifact Persistence
  await it('7. Artifact Persistence: Writes analysis/content-profile.json conforming to Section 22 specification', async () => {
    const autoProjectDir = path.join(__dirname, 'fixtures', 'test-content-profile-auto')
    if (!fs.existsSync(autoProjectDir)) {
      fs.mkdirSync(autoProjectDir, { recursive: true })
    }

    const detection = await detectOrResolveContentProfile({
      projectDir: autoProjectDir,
      scriptText: 'How glucose and insulin regulate liver glycogen stores and metabolic balance.',
      mode: 'auto',
      forceRefresh: true
    })

    const artifactPath = getContentProfilePath(autoProjectDir)
    assert.ok(fs.existsSync(artifactPath), 'analysis/content-profile.json must exist')

    const fileContent = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as ContentProfileDetection
    assert.strictEqual(fileContent.schemaVersion, CONTENT_PROFILE_SCHEMA_VERSION)
    assert.strictEqual(fileContent.mode, 'auto')
    assert.strictEqual(fileContent.resolvedProfile, 'health')
    assert.ok(fileContent.confidence > 0.8)
    assert.ok(Array.isArray(fileContent.reasons) && fileContent.reasons.length > 0)
    assert.ok(Array.isArray(fileContent.detectedSignals) && fileContent.detectedSignals.length > 0)
    assert.ok(typeof fileContent.generatedAt === 'string')

    try {
      fs.rmSync(autoProjectDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  // 8. Backward Compatibility: resolveContentProfileMode helper
  await it('8. Backward Compatibility: resolveContentProfileMode handles legacy projects cleanly (Section 8)', () => {
    // New project with contentProfileMode
    assert.strictEqual(resolveContentProfileMode({ contentProfileMode: 'auto' }), 'auto')
    assert.strictEqual(resolveContentProfileMode({ contentProfileMode: 'general' }), 'general')
    assert.strictEqual(resolveContentProfileMode({ contentProfileMode: 'health' }), 'health')

    // Old project with legacy contentType
    assert.strictEqual(resolveContentProfileMode({ contentType: 'health' }), 'health')
    assert.strictEqual(resolveContentProfileMode({ contentType: 'default' }), 'general')

    // Undefined / empty project
    assert.strictEqual(resolveContentProfileMode(null), 'auto')
    assert.strictEqual(resolveContentProfileMode({}), 'auto')
  })

  // Cleanup test directory
  try {
    fs.rmSync(testProjectDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\nContent Profile Detector Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
