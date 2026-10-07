/**
 * Automated Unit Tests for General AI Visuals & Prompting
 * (src/main/visual-mix/general-image-prompt.ts & visual-mix-cache.ts)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildGeneralImagePrompt,
  detectNicheFromText
} from '../src/main/visual-mix/general-image-prompt'
import { buildHealthImagePrompt } from '../src/main/health/health-visual-planner'
import {
  computeGenerationHash,
  VisualMixCache
} from '../src/main/visual-mix/visual-mix-cache'

let passed = 0
let failed = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).stack || (err as Error).message}`)
    failed++
  }
}

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING GENERAL AI VISUALS & PROMPT TESTS')
  console.log('==================================================\n')

  // 1. Niche Detection
  it('1. detectNicheFromText accurately detects various documentary niches', () => {
    assert.strictEqual(detectNicheFromText('The fall of the Roman Empire and the ancient Senate'), 'history')
    assert.strictEqual(detectNicheFromText('Wall Street stocks, hedge fund inflation and banking capital'), 'finance')
    assert.strictEqual(detectNicheFromText('Artisanal sourdough bread baking in a wood-fired oven'), 'food')
    assert.strictEqual(detectNicheFromText('Artificial intelligence neural networks, semiconductors and quantum computing'), 'technology')
    assert.strictEqual(detectNicheFromText('Backpacking across mountain peaks in Kyoto temples'), 'travel')
    assert.strictEqual(detectNicheFromText('Rainforest biodiversity and coral reef ecosystems'), 'nature')
    assert.strictEqual(detectNicheFromText('The social habits of human civilizations'), 'documentary')
  })

  // 2. Generic prompt generation contains no medical bias
  it('2. General prompts contain NO medical bias or anatomical keywords for non-health content', () => {
    const historyPrompt = buildGeneralImagePrompt({
      narration: 'Julius Caesar crossed the Rubicon with his thirteenth legion.',
      visualIntent: 'Historical Roman legion on riverbank',
      sceneIndex: 1
    })

    const lower = historyPrompt.toLowerCase()
    assert.ok(lower.includes('historical'), 'Should include historical context')
    assert.ok(!lower.includes('medical documentary'), 'Must NOT contain medical documentary')
    assert.ok(!lower.includes('biomedical'), 'Must NOT contain biomedical')
    assert.ok(!lower.includes('anatomical'), 'Must NOT contain anatomical')
    assert.ok(!lower.includes('cellular'), 'Must NOT contain cellular')
    assert.ok(!lower.includes('patient'), 'Must NOT contain patient')

    const financePrompt = buildGeneralImagePrompt({
      narration: 'Global currency reserves shifted dramatically following the Bretton Woods conference.',
      visualIntent: 'Economic summit meeting room with global currencies',
      sceneIndex: 2
    })
    const fLower = financePrompt.toLowerCase()
    assert.ok(fLower.includes('editorial') || fLower.includes('financial') || fLower.includes('economic'), 'Should match finance styling')
    assert.ok(!fLower.includes('medical'), 'Must NOT contain medical')
  })

  // 3. Generic prompt negative constraints and 16:9 composition
  it('3. General prompts strictly enforce negative constraints and horizontal composition', () => {
    const prompt = buildGeneralImagePrompt({
      narration: 'Deep learning models process millions of parameters simultaneously.',
      visualIntent: 'Abstract neural network architecture data streams',
      sceneIndex: 3
    })

    const lower = prompt.toLowerCase()
    assert.ok(lower.includes('16:9'), 'Must request 16:9 horizontal composition')
    assert.ok(lower.includes('no text'), 'Must forbid text')
    assert.ok(lower.includes('no watermark'), 'Must forbid watermarks')
    assert.ok(lower.includes('no logo'), 'Must forbid logos')
    assert.ok(lower.includes('no readable labels'), 'Must forbid readable labels')
    assert.ok(lower.includes('no ui'), 'Must forbid UI elements')
  })

  // 4. Health prompt retains specialized medical logic
  it('4. Health prompts retain medical safety rules and scientific accuracy', () => {
    const healthPrompt = buildHealthImagePrompt(
      'Inside the glomerulus, podocytes maintain the blood filtration barrier.',
      'Renal glomerulus filtration membrane',
      'anatomy'
    )

    const lower = healthPrompt.toLowerCase()
    assert.ok(lower.includes('medical') || lower.includes('scientific') || lower.includes('glomerulus'))
    assert.ok(lower.includes('no text') && lower.includes('no labels'))
  })

  // 5. Generation Hash & Profile Independence
  it('5. computeGenerationHash is deterministic and distinguishes content profiles', () => {
    const generalHash = computeGenerationHash({
      sceneIndex: 1,
      narration: 'The foundation of modern computing.',
      visualIntent: 'Abstract silicon processor',
      imagePrompt: 'Cinematic documentary still of a silicon processor',
      profile: 'general',
      width: 1920,
      height: 1080
    })

    const sameGeneralHash = computeGenerationHash({
      sceneIndex: 1,
      narration: 'The foundation of modern computing.',
      visualIntent: 'Abstract silicon processor',
      imagePrompt: 'Cinematic documentary still of a silicon processor',
      profile: 'general',
      width: 1920,
      height: 1080
    })

    const healthHash = computeGenerationHash({
      sceneIndex: 1,
      narration: 'The foundation of modern computing.',
      visualIntent: 'Abstract silicon processor',
      imagePrompt: 'Cinematic documentary still of a silicon processor',
      profile: 'health',
      width: 1920,
      height: 1080
    })

    assert.strictEqual(generalHash, sameGeneralHash, 'Identical inputs must yield identical hash')
    assert.notStrictEqual(generalHash, healthHash, 'Different profiles must yield different hashes')
  })

  // 6. Cache Asset Paths
  it('6. VisualMixCache routes general to assets/generated/general and health to assets/generated/health', () => {
    const projectDir = 'D:/mock-video-project'
    const generalPath = VisualMixCache.getAssetPath(projectDir, 'general', 1, 'abc12345')
    const healthPath = VisualMixCache.getAssetPath(projectDir, 'health', 1, 'abc12345')

    assert.ok(generalPath.replace(/\\/g, '/').includes('assets/generated/general/S0001_abc12345.png'))
    assert.ok(healthPath.replace(/\\/g, '/').includes('assets/generated/health/S0001_abc12345.png'))
  })

  // 7. Reading Legacy Health Manifest
  it('7. VisualMixCache loads legacy health-generated-assets.json seamlessly', () => {
    const testDir = path.join(__dirname, '..', 'tmp-test-manifest')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    const legacyManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      configHash: 'legacy-hash',
      scenes: {
        '1': {
          sceneIndex: 1,
          promptHash: 'legacy_hash_001',
          outputPath: 'assets/generated/health/S0001_legacy.png',
          status: 'completed',
          mediaId: 'flow-media-1',
          prompt: 'medical image'
        }
      }
    }
    fs.writeFileSync(
      path.join(analysisDir, 'health-generated-assets.json'),
      JSON.stringify(legacyManifest, null, 2),
      'utf-8'
    )

    const cache = new VisualMixCache(testDir, 'health')
    const record = cache.getRecord(1)
    assert.ok(record, 'Must load legacy record')
    assert.strictEqual(record?.sceneIndex, 1)
    assert.strictEqual(record?.promptHash, 'legacy_hash_001')
    assert.strictEqual(record?.status, 'completed')

    // Clean up
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  console.log(`\nGeneral AI Visuals Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
