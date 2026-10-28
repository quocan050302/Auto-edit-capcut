import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { probeMedia, throwIfAborted } from '../render-cache/ffmpeg-process'
import { renderJobCoordinator } from '../render-cache/render-job-coordinator'
import { cleanupOrphanOutputPartials } from '../render-cache/render-cache-manager'
import { executeSimpleAssembly } from './simple-assembly-engine'
import {
  resolvePreparedProductionScenes,
  assertAllProductionScenesReady
} from './simple-assembly-input-resolver'
import {
  writeRenderProvenance,
  readRenderProvenance
} from '../pipeline/render-provenance'
import type { AutoPipelineOptions, StageProgressCallback, StageRunResult } from '../pipeline/pipeline-types'
import type { SimpleAssemblyResult } from './simple-assembly-types'

export interface SimpleAssemblyRenderOutput {
  outputPath: string
  durationSecs: number
  fileSizeBytes: number
  reused?: boolean
}

/**
 * Pipeline Adapter for Simple Assembly: executes lightweight scene assembly strictly
 * at the final rendering stage of the 10-stage Auto Production pipeline.
 *
 * Guarantees:
 *  - 100% of upstream Smart Intelligence (Script, Transcription, Planning, Captions,
 *    Visual Director, Manual AI Gate, Stock) is preserved and authoritative.
 *  - Master edit plan chapter -> sequence -> scene timeline order is strictly preserved.
 *  - Asserts all planned scenes are ready before rendering.
 *  - Hard-cuts only, muting clip audio (-an) and applying voiceover and optional background music.
 *  - 0 Remotion / Chromium processes spawned during render.
 *  - Coordinated via renderJobCoordinator to prevent race conditions.
 *  - Respects pipeline AbortSignal for immediate cancellation.
 *  - Persists mode-aware render provenance for cache reconciliation.
 */
export async function runSimpleAssemblyRenderStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult<SimpleAssemblyRenderOutput>> {
  throwIfAborted(signal)
  const projectDir = options.projectDir
  const outputDir = path.join(projectDir, 'output')
  fs.mkdirSync(outputDir, { recursive: true })

  // Clean orphan partial files from interrupted previous runs
  if (!renderJobCoordinator.isActive(projectDir)) {
    try {
      for (const removed of cleanupOrphanOutputPartials(projectDir)) {
        logger.info(`[SimpleAssemblyAdapter] Cleaned stale partial file: ${path.basename(removed)}`)
      }
    } catch {
      /* ignore */
    }
  }

  // 1. Authoritative Scene Resolution & Completeness Assertion
  onProgress('Resolving finalized production scenes and edit plan order...', 0.05)
  const resolved = resolvePreparedProductionScenes(projectDir)
  assertAllProductionScenesReady(resolved)
  logger.info(
    `[SimpleAssemblyAdapter] All ${resolved.scenes.length} planned scenes verified ready in authoritative timeline order`
  )

  const effectiveMusicMode = options.backgroundMusicMode ?? 'off'
  const baseTargetName = options.outputName || 'simple_assembly'
  const candidateOutputPath = path.join(outputDir, `${baseTargetName}.mp4`)

  // 2. Check for reusable completed output with matching provenance
  const existingProvenance = readRenderProvenance(projectDir)
  if (
    existingProvenance &&
    existingProvenance.assemblyMode === 'simple-assembly' &&
    existingProvenance.backgroundMusicMode === effectiveMusicMode &&
    fs.existsSync(candidateOutputPath)
  ) {
    try {
      const stat = fs.statSync(candidateOutputPath)
      if (stat.size > 1024) {
        const probe = await probeMedia(candidateOutputPath, { signal })
        if (probe && probe.hasVideo && probe.duration > 0) {
          logger.info(`[SimpleAssemblyAdapter] Reusing verified existing output: ${candidateOutputPath}`)
          onProgress('Found verified completed Simple Assembly output matching settings, skipping render', 1.0)
          return {
            success: true,
            cached: true,
            artifactPath: candidateOutputPath,
            data: {
              outputPath: candidateOutputPath,
              durationSecs: probe.duration,
              fileSizeBytes: stat.size,
              reused: true
            },
            stats: {
              outputPath: candidateOutputPath,
              fileSizeBytes: stat.size,
              reused: true,
              assemblyMode: 'simple-assembly'
            }
          }
        }
      }
    } catch {
      /* ignore cache read error and proceed to fresh render */
    }
  }

  // 3. Resolve background music track if enabled
  let musicFilePath: string | undefined
  if (effectiveMusicMode !== 'off') {
    const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
    if (fs.existsSync(audioPlanPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8'))
        const approvedTrack = plan.sections?.find(
          (s: { approved?: boolean; approvedLocalPath?: string }) =>
            s.approved && s.approvedLocalPath && fs.existsSync(s.approvedLocalPath)
        )
        if (approvedTrack?.approvedLocalPath) {
          musicFilePath = approvedTrack.approvedLocalPath
          logger.info(`[SimpleAssemblyAdapter] Using approved music track: ${musicFilePath}`)
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Ensure unique target output name if needed
  let targetName = baseTargetName
  let targetPath = path.join(outputDir, `${targetName}.mp4`)
  let counter = 1
  while (
    fs.existsSync(targetPath) &&
    (!existingProvenance ||
      existingProvenance.assemblyMode !== 'simple-assembly' ||
      existingProvenance.backgroundMusicMode !== effectiveMusicMode)
  ) {
    targetName = `${baseTargetName}_${counter}`
    targetPath = path.join(outputDir, `${targetName}.mp4`)
    counter++
  }

  onProgress(`Starting Simple Assembly render (${targetName}.mp4)...`, 0.08)
  throwIfAborted(signal)

  const requestKey = `simple-assembly-pipeline:${projectDir}:${effectiveMusicMode}:${targetName}`

  // 4. Coordinated Execution via RenderJobCoordinator
  const { promise } = renderJobCoordinator.run<SimpleAssemblyResult>({
    projectDir,
    requestKey,
    source: 'pipeline',
    externalSignal: signal,
    starter: async (jobSignal) => {
      return await executeSimpleAssembly({
        projectDir,
        voiceoverPath: options.voiceoverPath,
        sceneSources: resolved.scenes,
        backgroundMusicMode: effectiveMusicMode,
        musicFilePath,
        outputName: targetName,
        width: options.resolution?.width ?? 1920,
        height: options.resolution?.height ?? 1080,
        fps: options.fps ?? 30,
        shortClipPolicy: options.shortClipPolicy ?? 'freeze-last-frame',
        signal: jobSignal,
        onProgress: (p) => {
          if (signal?.aborted) return
          onProgress(p.message || p.stage, p.progress)
        }
      })
    }
  })

  const result = await promise
  throwIfAborted(signal)

  if (!result.success || !result.outputPath || !fs.existsSync(result.outputPath)) {
    throw new Error(result.error || 'Simple Assembly failed to produce valid MP4.')
  }

  // 5. Output Verification
  const finalProbe = await probeMedia(result.outputPath, { signal })
  if (!finalProbe || !finalProbe.hasVideo || finalProbe.duration <= 0) {
    throw new Error('Produced MP4 failed media probe inspection (invalid streams or zero duration).')
  }

  const stat = fs.statSync(result.outputPath)

  // 6. Record Mode-Aware Output Provenance
  writeRenderProvenance(projectDir, {
    schemaVersion: 1,
    assemblyMode: 'simple-assembly',
    backgroundMusicMode: effectiveMusicMode,
    renderRequestFingerprint: requestKey,
    outputPath: result.outputPath,
    status: 'completed',
    completedAt: new Date().toISOString(),
    durationSecs: finalProbe.duration,
    fileSizeBytes: stat.size,
    resolution: {
      width: options.resolution?.width ?? 1920,
      height: options.resolution?.height ?? 1080
    },
    fps: options.fps ?? 30,
    engineVersion: 'simple-assembly-v2.0'
  })

  onProgress('Simple Assembly completed successfully', 1.0)

  return {
    success: true,
    artifactPath: result.outputPath,
    data: {
      outputPath: result.outputPath,
      durationSecs: finalProbe.duration,
      fileSizeBytes: stat.size
    },
    stats: {
      outputPath: result.outputPath,
      durationSecs: finalProbe.duration,
      fileSizeBytes: stat.size,
      sceneCount: resolved.scenes.length,
      assemblyMode: 'simple-assembly',
      backgroundMusicMode: effectiveMusicMode,
      remotionUsed: false
    }
  }
}
