/**
 * Unit Test Suite for:
 * Thumbnail Planner (src/main/thumbnail/thumbnail-planner.ts)
 */

import * as assert from 'assert'
import {
  substituteTemplateVariables,
  cleanJsonFence,
  validateThumbnailPlanSchema
} from '../src/main/thumbnail/thumbnail-planner'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING THUMBNAIL PLANNER UNIT TESTS')
  console.log('==================================================\n')

  await it('1. Replaces all variables in template safely', () => {
    const rawTemplate = `
Script: {{SCRIPT}}
Title: {{VIDEO_TITLE}}
Visuals: {{GLOBAL_VISUAL_CONTEXT}}
Variants: {{VARIANT_COUNT}}
Previous: {{PREVIOUS_CONCEPTS}}
Lang: {{OUTPUT_LANGUAGE}}`

    const substituted = substituteTemplateVariables(rawTemplate, {
      script: 'This is the full documentary script about grocery supply chains.',
      videoTitle: 'The Hidden Cost of Food',
      globalVisualContext: 'Warehouse supermarket, grocery shelves',
      variantCount: 5,
      previousConcepts: 'Round 1 used shopping cart close up',
      outputLanguage: 'en-US'
    })

    assert.ok(substituted.includes('This is the full documentary script about grocery supply chains.'))
    assert.ok(substituted.includes('The Hidden Cost of Food'))
    assert.ok(substituted.includes('Warehouse supermarket, grocery shelves'))
    assert.ok(substituted.includes('5'))
    assert.ok(substituted.includes('Round 1 used shopping cart close up'))
    assert.ok(substituted.includes('en-US'))
    assert.ok(!substituted.includes('{{SCRIPT}}'))
  })

  await it('2. Injects 5-variant requirement wrapper if {{VARIANT_COUNT}} was omitted', () => {
    const rawTemplate = 'Analyze this script: {{SCRIPT}} and generate good YouTube thumbnails.'
    const substituted = substituteTemplateVariables(rawTemplate, {
      script: 'Script text'
    })

    assert.ok(substituted.includes('exactly 5 distinct options with IDs A, B, C, D, and E'))
  })

  await it('3. Cleans markdown code fences cleanly', () => {
    const fencedJson = '```json\n{"scriptInsight": {}}\n```'
    const cleaned = cleanJsonFence(fencedJson)
    assert.strictEqual(cleaned, '{"scriptInsight": {}}')
  })

  await it('4. Validates a compliant 5-option schema', () => {
    const validPayload = {
      scriptInsight: {
        mainTopic: 'US Grocery Scarcity and Preparedness',
        groundedHook: 'Prices doubled overnight',
        strongestVisualDetail: 'Empty canned food aisle',
        viewerConcernOrGoal: 'Stocking emergency supplies',
        unsupportedClaimsToAvoid: ['Total economic collapse']
      },
      options: [
        {
          id: 'A',
          conceptName: 'The Stunned Shopper',
          yellowText: 'FOOD SHORTAGE?',
          whiteText: 'WHAT NOBODY TOLD YOU',
          visualConcept: 'Shopper holding grocery receipt in disbelief',
          imagePrompt: 'Photorealistic documentary photo of an American shopper looking at a receipt...',
          titleClear: 'Why Grocery Prices Are Skyrocketing in 2026',
          titleCuriosity: 'The Real Reason Shelves Are Suddenly Empty',
          whyItWorks: 'Emotional mirror and curiosity gap'
        },
        {
          id: 'B',
          conceptName: 'Empty Canned Goods',
          yellowText: 'STOCK UP NOW',
          whiteText: 'BEFORE PRICES TRIPLE',
          visualConcept: 'Warehouse shelves with barren sections',
          imagePrompt: 'Wide shot of warehouse supermarket shelves with canned beans...',
          titleClear: 'Top 10 Food Items to Stockpile',
          titleCuriosity: 'Why Smart Shoppers Are Buying These 5 Canned Foods Today',
          whyItWorks: 'Stakes and urgency'
        },
        {
          id: 'C',
          conceptName: 'The Receipt Shock',
          yellowText: 'RECEIPT SHOCK',
          whiteText: 'SEE THE DAMAGE',
          visualConcept: 'Extreme close up of grocery total with price tag',
          imagePrompt: 'Macro shot of cash register display showing unexpected total...',
          titleClear: 'How Inflation Changed the Average Grocery Bill',
          titleCuriosity: 'I Spent $200 at Costco and Got Only This',
          whyItWorks: 'Proof object'
        },
        {
          id: 'D',
          conceptName: 'Pantry Secret',
          yellowText: 'PANTRY SECRETS',
          whiteText: 'SAVE THOUSANDS',
          visualConcept: 'Organized home emergency pantry with preserved mason jars',
          imagePrompt: 'Cozy basement pantry organized with canned staples and grain buckets...',
          titleClear: 'How to Build a 6-Month Emergency Pantry',
          titleCuriosity: 'The Prepper Pantry Setup Every Family Needs',
          whyItWorks: 'Solution and preparation'
        },
        {
          id: 'E',
          conceptName: 'Contrast Then and Now',
          yellowText: 'THEN VS NOW',
          whiteText: 'THE UNSEEN CRUNCH',
          visualConcept: 'Split composition showing full cart in 2020 vs bare cart in 2026',
          imagePrompt: 'Split composition with high contrast comparing grocery purchasing power...',
          titleClear: 'The Reality of American Food Insecurity',
          titleCuriosity: 'This Comparison Will Make You Rethink Your Grocery Budget',
          whyItWorks: 'Visual mismatch and contrast'
        }
      ],
      recommendedOptionId: 'A',
      recommendationReason: 'Shopper reaction creates highest emotional resonance.',
      postGenerationCheck: 'All text is legible and photorealistic.'
    }

    const res = validateThumbnailPlanSchema(validPayload)
    assert.strictEqual(res.valid, true)
    assert.strictEqual(res.plan?.options.length, 5)
    assert.strictEqual(res.plan?.options[0].id, 'A')
    assert.strictEqual(res.plan?.options[4].id, 'E')
  })

  await it('5. Rejects plans with fewer than 5 options', () => {
    const invalidPayload = {
      scriptInsight: { mainTopic: 'Topic' },
      options: [
        { id: 'A', conceptName: 'One', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Prompt' }
      ]
    }

    const res = validateThumbnailPlanSchema(invalidPayload)
    assert.strictEqual(res.valid, false)
    assert.ok(res.error?.includes('Expected exactly 5 thumbnail options'))
  })

  await it('6. Rejects plans where option ID sequence is broken', () => {
    const brokenIds = {
      scriptInsight: { mainTopic: 'Topic' },
      options: [
        { id: '1', conceptName: 'A', yellowText: 'Y', whiteText: 'W', imagePrompt: 'P' },
        { id: '2', conceptName: 'B', yellowText: 'Y', whiteText: 'W', imagePrompt: 'P' },
        { id: '3', conceptName: 'C', yellowText: 'Y', whiteText: 'W', imagePrompt: 'P' },
        { id: '4', conceptName: 'D', yellowText: 'Y', whiteText: 'W', imagePrompt: 'P' },
        { id: '5', conceptName: 'E', yellowText: 'Y', whiteText: 'W', imagePrompt: 'P' }
      ]
    }

    const res = validateThumbnailPlanSchema(brokenIds)
    assert.strictEqual(res.valid, false)
    assert.ok(res.error?.includes('must have id "A"'))
  })

  await it('7. Rejects plans with "same as above" in imagePrompt', () => {
    const sameAsAbove = {
      scriptInsight: { mainTopic: 'Topic' },
      options: [
        { id: 'A', conceptName: 'A', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Complete prompt' },
        { id: 'B', conceptName: 'B', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Same as above with red shirt' },
        { id: 'C', conceptName: 'C', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Complete prompt' },
        { id: 'D', conceptName: 'D', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Complete prompt' },
        { id: 'E', conceptName: 'E', yellowText: 'Y', whiteText: 'W', imagePrompt: 'Complete prompt' }
      ]
    }

    const res = validateThumbnailPlanSchema(sameAsAbove)
    assert.strictEqual(res.valid, false)
    assert.ok(res.error?.includes('same as above'))
  })

  console.log(`\n==================================================`)
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`==================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
