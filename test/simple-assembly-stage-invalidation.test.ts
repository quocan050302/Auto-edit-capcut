import { assert, createRunner } from './manual-ai-test-utils'
import {
  determineInvalidatedStages,
  createInitialPipelineState,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Simple Assembly Stage Invalidation Tests')

void (async () => {
  const dummyFingerprint: InputFingerprint = {
    scriptPath: 'C:/test/script.txt',
    scriptHash: 'abc123hash',
    voiceoverPath: 'C:/test/vo.mp3',
    voiceoverSize: 1000000,
    voiceoverMtimeMs: 123456789
  }

  await it('Section 23: Toggling assemblyMode invalidates ONLY preflight, rendering, postflight', () => {
    const initialOptions: AutoPipelineOptions = {
      projectDir: 'C:/test/proj',
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'full-production',
      backgroundMusicMode: 'off'
    }

    const state = createInitialPipelineState(initialOptions, dummyFingerprint)

    // User switches to simple-assembly
    const newOptions: AutoPipelineOptions = {
      ...initialOptions,
      assemblyMode: 'simple-assembly'
    }

    const invalidated = determineInvalidatedStages(state, newOptions, dummyFingerprint)

    // Expected: ONLY preflight, rendering, postflight
    assert.deepStrictEqual(
      invalidated.sort(),
      ['postflight', 'preflight', 'rendering'].sort(),
      'Toggling assemblyMode must ONLY invalidate preflight, rendering, and postflight'
    )

    // Crucial check: Upstream intelligence MUST NOT be invalidated!
    assert.strictEqual(invalidated.includes('transcribing'), false, 'transcribing must NOT be invalidated')
    assert.strictEqual(invalidated.includes('planning'), false, 'planning must NOT be invalidated')
    assert.strictEqual(invalidated.includes('captions'), false, 'captions must NOT be invalidated')
    assert.strictEqual(invalidated.includes('global-context'), false, 'global-context must NOT be invalidated')
    assert.strictEqual(invalidated.includes('stock-search'), false, 'stock-search must NOT be invalidated')
    assert.strictEqual(invalidated.includes('audio-search'), false, 'audio-search must NOT be invalidated')
  })

  await it('Section 23: Toggling backgroundMusicMode invalidates audio-search, preflight, rendering, postflight', () => {
    const initialOptions: AutoPipelineOptions = {
      projectDir: 'C:/test/proj',
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'auto'
    }

    const state = createInitialPipelineState(initialOptions, dummyFingerprint)

    // User toggles backgroundMusicMode from auto to off
    const newOptions: AutoPipelineOptions = {
      ...initialOptions,
      backgroundMusicMode: 'off'
    }

    const invalidated = determineInvalidatedStages(state, newOptions, dummyFingerprint)

    assert.deepStrictEqual(
      invalidated.sort(),
      ['audio-search', 'postflight', 'preflight', 'rendering'].sort(),
      'Toggling backgroundMusicMode must invalidate audio-search and downstream render stages'
    )

    // Upstream stages remain valid
    assert.strictEqual(invalidated.includes('transcribing'), false)
    assert.strictEqual(invalidated.includes('planning'), false)
    assert.strictEqual(invalidated.includes('captions'), false)
    assert.strictEqual(invalidated.includes('global-context'), false)
    assert.strictEqual(invalidated.includes('stock-search'), false)
  })

  await finish()
})()
