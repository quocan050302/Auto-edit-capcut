import assert from 'assert'
import { IPC_CHANNELS } from '../shared/types'
import { BUILT_IN_PROMPT_CATEGORIES } from '../src/main/thumbnail/thumbnail-template-store'

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING THUMBNAIL UI CONTRACT & INTEGRITY TESTS')
  console.log('==================================================\n')

  let passed = 0
  let failed = 0

  function test(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(err)
      failed++
    }
  }

  test('1. All mandatory IPC channels for Thumbnail Studio are defined', () => {
    const requiredChannels = [
      'THUMBNAIL_TEMPLATE_LIST',
      'THUMBNAIL_TEMPLATE_CREATE',
      'THUMBNAIL_TEMPLATE_UPDATE',
      'THUMBNAIL_TEMPLATE_DUPLICATE',
      'THUMBNAIL_TEMPLATE_DELETE',
      'THUMBNAIL_TEMPLATE_IMPORT',
      'THUMBNAIL_TEMPLATE_EXPORT',
      'THUMBNAIL_SETTINGS_GET',
      'THUMBNAIL_SETTINGS_SAVE',
      'THUMBNAIL_FLOW_HEALTH',
      'THUMBNAIL_FLOW_OPEN',
      'THUMBNAIL_PLAN_GENERATE',
      'THUMBNAIL_JOB_START',
      'THUMBNAIL_JOB_GET',
      'THUMBNAIL_JOB_RESUME',
      'THUMBNAIL_JOB_CANCEL',
      'THUMBNAIL_JOB_GENERATE_MORE',
      'THUMBNAIL_CANDIDATE_RETRY',
      'THUMBNAIL_CANDIDATE_REGENERATE',
      'THUMBNAIL_CANDIDATE_EXPORT_4K',
      'THUMBNAIL_CANDIDATE_SELECT',
      'THUMBNAIL_OPEN_FOLDER',
      'THUMBNAIL_PROGRESS'
    ]

    for (const ch of requiredChannels) {
      assert.ok(
        (IPC_CHANNELS as Record<string, string>)[ch],
        `Channel ${ch} must be defined in IPC_CHANNELS`
      )
    }
  })

  test('2. Built-in category list contains all 6 required categories', () => {
    const expectedCategories = [
      'US Grocery',
      'Preparedness',
      'Hutterite Documentary',
      'Hidden Cost Documentary',
      'Streamer Reaction',
      'Custom'
    ]

    for (const cat of expectedCategories) {
      assert.ok(
        BUILT_IN_PROMPT_CATEGORIES.includes(cat),
        `Category "${cat}" must be present in BUILT_IN_PROMPT_CATEGORIES`
      )
    }
  })

  test('3. Video pipeline execution stages are untouched and remain 10 stages', () => {
    const { PIPELINE_EXECUTION_STAGES } = require('../src/main/pipeline/pipeline-types')
    const expectedStages = [
      'validating',
      'transcribing',
      'planning',
      'captions',
      'global-context',
      'stock-search',
      'audio-search',
      'preflight',
      'rendering',
      'postflight'
    ]

    assert.deepStrictEqual(
      PIPELINE_EXECUTION_STAGES,
      expectedStages,
      'PIPELINE_EXECUTION_STAGES must not contain thumbnail or be altered'
    )
  })

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
