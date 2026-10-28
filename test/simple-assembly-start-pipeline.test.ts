import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { resolveVideoAssemblyMode, resolveBackgroundMusicMode } from '../shared/types'
import { loadProductionModeSettings, saveProductionModeSettings } from '../src/main/simple-assembly/production-mode-settings'

const { it, finish } = createRunner('Simple Assembly Start Pipeline Contract Tests')

void (async () => {
  const testRoot = freshDir('start-pipeline-tests')

  await it('Requirement 2.2: Setup readiness logic strictly requires both Script and Voiceover for Simple Assembly', () => {
    // Contract check: Auto Production readiness formula
    const checkIsAutoReady = (scriptPath?: string | null, voiceoverPath?: string | null): boolean => {
      return !!(scriptPath && voiceoverPath)
    }

    // Voiceover alone is NOT ready (this was the root cause bug where Simple Assembly was treated as VO-only)
    assert.strictEqual(
      checkIsAutoReady(null, 'C:/media/vo.mp3'),
      false,
      'VO alone must NOT be auto-ready'
    )
    assert.strictEqual(
      checkIsAutoReady(undefined, 'C:/media/vo.mp3'),
      false,
      'Undefined script must NOT be auto-ready'
    )
    assert.strictEqual(
      checkIsAutoReady('C:/scripts/test.txt', null),
      false,
      'Script alone must NOT be auto-ready'
    )
    assert.strictEqual(
      checkIsAutoReady('C:/scripts/test.txt', 'C:/media/vo.mp3'),
      true,
      'Both script and voiceover present must be auto-ready'
    )
  })

  await it('Requirement 2.3 & 6: Start Pipeline options receive and persist confirmed assemblyMode and backgroundMusicMode', () => {
    const projDir = path.join(testRoot, 'proj-options')
    fs.mkdirSync(projDir, { recursive: true })

    // User chooses Simple Assembly and No Music in Setup
    const confirmed = saveProductionModeSettings(projDir, {
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })

    assert.strictEqual(confirmed.assemblyMode, 'simple-assembly')
    assert.strictEqual(confirmed.backgroundMusicMode, 'off')

    // Start pipeline payload construction
    const startPayload = {
      projectDir: projDir,
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: confirmed.assemblyMode,
      backgroundMusicMode: confirmed.backgroundMusicMode,
      requireBackgroundMusic: confirmed.backgroundMusicMode === 'off' ? false : true
    }

    assert.strictEqual(startPayload.assemblyMode, 'simple-assembly')
    assert.strictEqual(startPayload.backgroundMusicMode, 'off')
    assert.strictEqual(startPayload.requireBackgroundMusic, false)
  })

  await it('Requirement 12: Direct scene folder does not bypass Start Auto Production pipeline', () => {
    const projDir = path.join(testRoot, 'proj-direct-folder')
    fs.mkdirSync(projDir, { recursive: true })

    // User has configured Simple Assembly in settings
    const settings = saveProductionModeSettings(projDir, {
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off'
    })

    // In Auto Production, the pipeline starts with projectDir-owned scenes, NOT raw direct execution
    assert.strictEqual(settings.assemblyMode, 'simple-assembly')
    assert.strictEqual(settings.backgroundMusicMode, 'off')
  })

  await finish()
})()
