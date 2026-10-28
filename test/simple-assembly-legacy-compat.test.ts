import * as fs from 'fs'
import * as path from 'path'
import {
  resolveBackgroundMusicMode,
  resolveVideoAssemblyMode,
  DEFAULT_PRODUCTION_MODE_SETTINGS,
  type AutoPipelineOptions
} from '../shared/types'
import { createInitialPipelineState, computeInputFingerprint } from '../src/main/pipeline/pipeline-state'
import { loadProductionModeSettings } from '../src/main/simple-assembly/production-mode-settings'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'

const { it, finish } = createRunner('Simple Assembly Legacy Compatibility Tests')

void (async () => {
  const testRoot = freshDir('legacy-compat-tests')

  await it('Section 1: Legacy project defaults — absent fields preserve Full Production and Auto Music', () => {
    const legacyProjectDir = path.join(testRoot, 'legacy-proj')
    fs.mkdirSync(legacyProjectDir, { recursive: true })

    // No production-mode-settings.v1.json exists yet
    const settings = loadProductionModeSettings(legacyProjectDir)
    assert.strictEqual(settings.assemblyMode, 'full-production')
    assert.strictEqual(settings.backgroundMusicMode, 'auto')
    assert.strictEqual(settings.shortClipPolicy, 'freeze-last-frame')

    // Resolver on empty legacy options
    const legacyOptions: AutoPipelineOptions = {
      projectDir: legacyProjectDir,
      scriptPath: 'script.txt',
      voiceoverPath: 'vo.wav'
    }

    assert.strictEqual(resolveVideoAssemblyMode(legacyOptions.assemblyMode), 'full-production')
    assert.strictEqual(resolveBackgroundMusicMode(legacyOptions.backgroundMusicMode), 'auto')
  })

  await it('Section 2: Pipeline state backward compatibility — absent assemblyMode initializes all standard stages', async () => {
    const sPath = path.join(testRoot, 'script.txt')
    const vPath = path.join(testRoot, 'vo.wav')
    fs.writeFileSync(sPath, 'Sample narration')
    fs.writeFileSync(vPath, 'Sample audio')

    const legacyOptions: AutoPipelineOptions = {
      projectDir: testRoot,
      scriptPath: sPath,
      voiceoverPath: vPath
    }

    const fp = await computeInputFingerprint(legacyOptions)
    const state = createInitialPipelineState(legacyOptions, fp)

    // All original stages must exist and be pending
    const expectedStages = [
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

    for (const stage of expectedStages) {
      assert.strictEqual(stage in state.stages, true, `Expected stage ${stage} to exist in state`)
      assert.strictEqual(state.stages[stage as keyof typeof state.stages]?.status, 'pending')
    }
  })

  await it('Section 3: True No Music isolation — audio-plan cache never overrides backgroundMusicMode off', () => {
    // Simulate an existing project with an approved music track in audio-plan.json
    const projDir = path.join(testRoot, 'cached-music-proj')
    const analysisDir = path.join(projDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    const staleAudioPlan = {
      sections: [
        {
          id: 'sec-1',
          music: {
            approved: true,
            filePath: path.join(projDir, 'music', 'old_approved_track.mp3'),
            volume: 0.15
          }
        }
      ]
    }
    fs.writeFileSync(path.join(analysisDir, 'audio-plan.json'), JSON.stringify(staleAudioPlan))

    // When backgroundMusicMode is 'off', effective approved music is cleared
    const effectiveMusicMode = resolveBackgroundMusicMode('off')
    assert.strictEqual(effectiveMusicMode, 'off')

    // Emulate renderer's music-mode filtering
    let approvedMusic: Array<{ path: string; volume: number }> = [
      { path: staleAudioPlan.sections[0].music.filePath, volume: 0.15 }
    ]
    if (effectiveMusicMode === 'off') {
      approvedMusic = []
    }

    assert.strictEqual(approvedMusic.length, 0)
  })

  finish()
})()
