import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { reconcileProjectArtifacts } from '../src/main/pipeline/pipeline-artifacts'
import { writeRenderProvenance } from '../src/main/pipeline/render-provenance'
import type { AutoPipelineOptions } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Simple Assembly Output Reconciliation Tests')

void (async () => {
  const testRoot = freshDir('output-reconciliation-tests')

  await it('Section 22: Full Production MP4 does NOT satisfy Simple Assembly request', () => {
    const projDir = path.join(testRoot, 'proj-full-to-simple')
    const outputDir = path.join(projDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    // Create an existing video file
    const outputVideo = path.join(outputDir, 'final_output.mp4')
    fs.writeFileSync(outputVideo, Buffer.alloc(2000)) // > 1024 bytes

    // Record provenance as full-production
    writeRenderProvenance(projDir, {
      schemaVersion: 1,
      assemblyMode: 'full-production',
      backgroundMusicMode: 'auto',
      renderRequestFingerprint: 'full-fp',
      outputPath: outputVideo,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    // Now user requests simple-assembly
    const options: AutoPipelineOptions = {
      projectDir: projDir,
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly',
      outputName: 'final_output'
    }

    const reconciled = reconcileProjectArtifacts(projDir, options)

    // Rendering stage must NOT be valid for simple-assembly because existing file is full-production!
    assert.strictEqual(
      reconciled.renderValid,
      false,
      'Full production output must NOT satisfy simple-assembly request'
    )
    assert.strictEqual(
      reconciled.postflightValid,
      false,
      'Postflight must NOT be valid when render is invalid'
    )
  })

  await it('Section 22: Simple Assembly MP4 does NOT satisfy Full Production request', () => {
    const projDir = path.join(testRoot, 'proj-simple-to-full')
    const outputDir = path.join(projDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    const outputVideo = path.join(outputDir, 'final_output.mp4')
    fs.writeFileSync(outputVideo, Buffer.alloc(2000))

    // Record provenance as simple-assembly
    writeRenderProvenance(projDir, {
      schemaVersion: 1,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off',
      renderRequestFingerprint: 'simple-fp',
      outputPath: outputVideo,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    // Now user requests full-production
    const options: AutoPipelineOptions = {
      projectDir: projDir,
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'full-production',
      outputName: 'final_output'
    }

    const reconciled = reconcileProjectArtifacts(projDir, options)

    // Rendering stage must NOT be valid for full-production because existing file is simple-assembly!
    assert.strictEqual(
      reconciled.renderValid,
      false,
      'Simple assembly output must NOT satisfy full-production request'
    )
    assert.strictEqual(
      reconciled.postflightValid,
      false,
      'Postflight must NOT be valid when render is invalid'
    )
  })

  await it('Section 22: Matching Simple Assembly provenance allows completed rendering state reuse', () => {
    const projDir = path.join(testRoot, 'proj-matching-simple')
    const outputDir = path.join(projDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    const outputVideo = path.join(outputDir, 'final_output.mp4')
    fs.writeFileSync(outputVideo, Buffer.alloc(2000))

    // Record provenance as simple-assembly with music off
    writeRenderProvenance(projDir, {
      schemaVersion: 1,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off',
      renderRequestFingerprint: 'simple-matching-fp',
      outputPath: outputVideo,
      status: 'completed',
      completedAt: new Date().toISOString()
    })

    const options: AutoPipelineOptions = {
      projectDir: projDir,
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: 'off',
      outputName: 'final_output'
    }

    const reconciled = reconcileProjectArtifacts(projDir, options)

    // Rendering stage matches!
    assert.strictEqual(
      reconciled.renderValid,
      true,
      'Matching simple-assembly provenance must allow renderValid = true'
    )
    assert.strictEqual(
      reconciled.postflightValid,
      true,
      'Matching simple-assembly provenance must allow postflightValid = true'
    )
  })

  await finish()
})()
