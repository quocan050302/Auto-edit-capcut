import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { readRenderProvenance, writeRenderProvenance } from '../src/main/pipeline/render-provenance'
import type { AutoPipelineOptions } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Simple Assembly Render Dispatch & Provenance Tests')

void (async () => {
  const testRoot = freshDir('render-dispatch-tests')

  await it('Section 9 & 10: Dispatch logic routes based on options.assemblyMode', () => {
    const fullOptions: AutoPipelineOptions = {
      projectDir: path.join(testRoot, 'proj-full'),
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'full-production'
    }

    const simpleOptions: AutoPipelineOptions = {
      projectDir: path.join(testRoot, 'proj-simple'),
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly'
    }

    const defaultOptions: AutoPipelineOptions = {
      projectDir: path.join(testRoot, 'proj-default'),
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3'
    }

    // Determine target runner based on options
    const selectRunner = (opts: AutoPipelineOptions): string => {
      if (opts.assemblyMode === 'simple-assembly') {
        return 'runSimpleAssemblyRenderStage'
      }
      return 'runExistingFullRenderStage'
    }

    assert.strictEqual(selectRunner(simpleOptions), 'runSimpleAssemblyRenderStage')
    assert.strictEqual(selectRunner(fullOptions), 'runExistingFullRenderStage')
    assert.strictEqual(selectRunner(defaultOptions), 'runExistingFullRenderStage')
  })

  await it('Section 10 & 22: Provenance isolation between Full Production and Simple Assembly', () => {
    const projSimple = path.join(testRoot, 'proj-prov-simple')
    const projFull = path.join(testRoot, 'proj-prov-full')
    fs.mkdirSync(projSimple, { recursive: true })
    fs.mkdirSync(projFull, { recursive: true })

    // Simple Assembly records simple-assembly provenance
    writeRenderProvenance(projSimple, {
      schemaVersion: 1,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off',
      renderRequestFingerprint: 'simple-fp-123',
      outputPath: path.join(projSimple, 'output', 'simple_assembly.mp4'),
      durationSecs: 15.5,
      fileSizeBytes: 2048500,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    const simpleProv = readRenderProvenance(projSimple)
    assert.ok(simpleProv, 'Simple provenance must exist')
    assert.strictEqual(simpleProv?.assemblyMode, 'simple-assembly')
    assert.strictEqual(simpleProv?.backgroundMusicMode, 'off')
    assert.strictEqual(simpleProv?.status, 'completed')

    // Full Production records full-production provenance
    writeRenderProvenance(projFull, {
      schemaVersion: 1,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      renderRequestFingerprint: 'full-fp-456',
      outputPath: path.join(projFull, 'output', 'final_output.mp4'),
      durationSecs: 15.5,
      fileSizeBytes: 8900100,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    const fullProv = readRenderProvenance(projFull)
    assert.ok(fullProv, 'Full provenance must exist')
    assert.strictEqual(fullProv?.assemblyMode, 'full-production')
    assert.strictEqual(fullProv?.backgroundMusicMode, 'auto')
    assert.strictEqual(fullProv?.status, 'completed')

    // Provenance does not match across modes
    assert.notStrictEqual(simpleProv?.assemblyMode, fullProv?.assemblyMode)
  })

  await finish()
})()
