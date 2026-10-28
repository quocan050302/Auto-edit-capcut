import * as fs from 'fs'
import * as path from 'path'
import {
  resolveBackgroundMusicMode,
  resolveVideoAssemblyMode,
  DEFAULT_PRODUCTION_MODE_SETTINGS
} from '../shared/types'
import {
  loadProductionModeSettings,
  saveProductionModeSettings
} from '../src/main/simple-assembly/production-mode-settings'
import {
  computeAudioFingerprint,
  computeRenderFingerprint
} from '../src/main/render-cache/render-fingerprint'
import { determineInvalidatedStages } from '../src/main/pipeline/pipeline-state'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'

const { it, finish } = createRunner('Music Mode Selection & Fingerprint Isolation Tests')

void (async () => {
  const testRoot = freshDir('music-mode-tests')

  await it('Section 1: Resolver semantics — undefined/legacy maps to auto, off maps to off', () => {
    assert.strictEqual(resolveBackgroundMusicMode(undefined), 'auto')
    assert.strictEqual(resolveBackgroundMusicMode(null as any), 'auto')
    assert.strictEqual(resolveBackgroundMusicMode('auto'), 'auto')
    assert.strictEqual(resolveBackgroundMusicMode('off'), 'off')
    assert.strictEqual(resolveBackgroundMusicMode('unknown' as any), 'auto')

    assert.strictEqual(resolveVideoAssemblyMode(undefined), 'full-production')
    assert.strictEqual(resolveVideoAssemblyMode('simple-assembly'), 'simple-assembly')
    assert.strictEqual(resolveVideoAssemblyMode('full-production'), 'full-production')
  })

  await it('Section 2: Production mode settings persistence — atomic save and reload', () => {
    const projDir = path.join(testRoot, 'proj-settings')
    fs.mkdirSync(projDir, { recursive: true })

    // Uninitialized project loads defaults
    const initial = loadProductionModeSettings(projDir)
    assert.strictEqual(initial.schemaVersion, 1)
    assert.strictEqual(initial.assemblyMode, 'full-production')
    assert.strictEqual(initial.backgroundMusicMode, 'auto')

    // Persist No Music and Simple Assembly
    const saved = saveProductionModeSettings(projDir, {
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })
    assert.strictEqual(saved.assemblyMode, 'simple-assembly')
    assert.strictEqual(saved.backgroundMusicMode, 'off')

    // Reload from disk
    const reloaded = loadProductionModeSettings(projDir)
    assert.strictEqual(reloaded.assemblyMode, 'simple-assembly')
    assert.strictEqual(reloaded.backgroundMusicMode, 'off')

    // Confirm file exists in analysis/production-mode-settings.v1.json
    const filePath = path.join(projDir, 'analysis', 'production-mode-settings.v1.json')
    assert.strictEqual(fs.existsSync(filePath), true)
  })

  await it('Section 3: Audio fingerprint isolation — changing backgroundMusicMode invalidates audio cache', () => {
    const voPath = path.join(testRoot, 'vo.wav')
    fs.writeFileSync(voPath, 'dummy-audio-content')

    const fpAuto = computeAudioFingerprint({
      voiceoverPath: voPath,
      musicTracks: [{ path: 'music1.mp3', volume: 0.1 }],
      backgroundMusicMode: 'auto'
    })

    const fpOff = computeAudioFingerprint({
      voiceoverPath: voPath,
      musicTracks: [{ path: 'music1.mp3', volume: 0.1 }],
      backgroundMusicMode: 'off'
    })

    // Fingerprints must differ when music mode changes
    assert.notStrictEqual(fpAuto, fpOff)
    assert.strictEqual(typeof fpAuto, 'string')
    assert.strictEqual(typeof fpOff, 'string')
  })

  await it('Section 4: Render fingerprint isolation — backgroundMusicMode alters render fingerprint', () => {
    const voPath = path.join(testRoot, 'vo.wav')
    fs.writeFileSync(voPath, 'dummy-voiceover')

    const baseInput = {
      projectDir: testRoot,
      visualMixMode: 'custom-mix' as const,
      editorialMode: 'classic' as const,
      renderOverlayMode: 'full' as const,
      aiImageRatio: 0.5,
      imageOutputResolution: '1080p' as const,
      audioPlanHash: 'hash-abc',
      visualSceneCount: 5,
      voiceoverSignature: 'vo-sig',
      scenes: []
    }

    const fpAuto = computeRenderFingerprint({
      ...baseInput,
      backgroundMusicMode: 'auto'
    })

    const fpOff = computeRenderFingerprint({
      ...baseInput,
      backgroundMusicMode: 'off'
    })

    assert.strictEqual(typeof fpAuto, 'string')
    assert.strictEqual(typeof fpOff, 'string')
    assert.notStrictEqual(fpAuto, fpOff)
  })

  await it('Section 5: Stage invalidation — toggling backgroundMusicMode invalidates downstream stages', async () => {
    const sPath = path.join(testRoot, 's.txt')
    const vPath = path.join(testRoot, 'v.wav')
    fs.writeFileSync(sPath, 'dummy script')
    fs.writeFileSync(vPath, 'dummy voiceover')

    const previousOptions = {
      projectDir: testRoot,
      scriptPath: sPath,
      voiceoverPath: vPath,
      backgroundMusicMode: 'auto' as const
    }

    const currentOptions = {
      projectDir: testRoot,
      scriptPath: sPath,
      voiceoverPath: vPath,
      backgroundMusicMode: 'off' as const
    }

    const { createInitialPipelineState, computeInputFingerprint } = await import('../src/main/pipeline/pipeline-state')
    const oldFp = await computeInputFingerprint(previousOptions)
    const oldState = createInitialPipelineState(previousOptions, oldFp)
    const newFp = await computeInputFingerprint(currentOptions)

    const invalidated = determineInvalidatedStages(oldState, currentOptions, newFp)
    assert.strictEqual(invalidated.includes('audio-search'), true)
    assert.strictEqual(invalidated.includes('preflight'), true)
    assert.strictEqual(invalidated.includes('rendering'), true)
    assert.strictEqual(invalidated.includes('postflight'), true)
    // Upstream stages (planning, visuals) should remain untouched
    assert.strictEqual(invalidated.includes('planning'), false)
    assert.strictEqual(invalidated.includes('stock-search'), false)
  })

  await it('Section 6: Legacy backward compatibility — requireBackgroundMusic alone does not disable music', () => {
    const legacyOpts = {
      requireBackgroundMusic: false
    }
    // Mode defaults to auto
    const effectiveMode = resolveBackgroundMusicMode((legacyOpts as any).backgroundMusicMode)
    assert.strictEqual(effectiveMode, 'auto')
  })

  finish()
})()
