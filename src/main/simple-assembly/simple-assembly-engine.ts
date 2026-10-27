import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import {
  ffmpegRun,
  probeMedia,
  throwIfAborted,
  isRenderCancelledError,
  RenderCancelledError,
  type MediaProbe
} from '../render-cache/ffmpeg-process'
import { fileSignature } from '../render-cache/render-fingerprint'
import { resolveSimpleAssemblyInputs } from './simple-assembly-input-resolver'
import { resolveAssemblyTimeline, type TimelineResolutionResult } from './simple-assembly-timeline'
import {
  SimpleAssemblyCacheManager,
  computeSceneClipFingerprint,
  computeAssemblyVideoFingerprint,
  computeSimpleAssemblyFingerprint
} from './simple-assembly-cache'
import type {
  SimpleAssemblyRequest,
  SimpleAssemblyResult,
  SimpleAssemblyProgressPayload,
  SimpleAssemblySceneInfo
} from './simple-assembly-types'

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function escapeConcatPath(p: string): string {
  // Concat demuxer expects forward slashes and escaped single quotes
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

/**
 * Executes lightweight, low-memory scene assembly synchronized to voiceover.
 * Guarantees:
 *  - 0 Remotion / Chromium processes launched.
 *  - Hard cuts only — no extra transitions, no dynamic captions, no visual grammar overlays.
 *  - Source video audio is strictly muted (-an).
 *  - True No Music mode prevents any background music from entering the final mix.
 *  - Atomic output publishing via .partial.mp4.
 *  - Bounded concurrency and low RAM usage.
 */
export async function executeSimpleAssembly(request: SimpleAssemblyRequest): Promise<SimpleAssemblyResult> {
  const {
    projectDir,
    voiceoverPath,
    sceneFolder,
    backgroundMusicMode,
    musicFilePath,
    outputName = 'simple_assembly',
    width = 1920,
    height = 1080,
    fps = 30,
    shortClipPolicy = 'freeze-last-frame',
    signal,
    onProgress
  } = request

  const reportProgress = (
    phase: SimpleAssemblyProgressPayload['phase'],
    progress: number,
    stage: string,
    extra?: { sceneIndex?: number; totalScenes?: number; message?: string; error?: string; outputPath?: string; duration?: number }
  ): void => {
    const clampedProgress = Math.max(0, Math.min(1, progress))
    onProgress?.({
      stage,
      phase,
      status: phase,
      progress: clampedProgress,
      percent: Math.round(clampedProgress * 100),
      sceneIndex: extra?.sceneIndex,
      totalScenes: extra?.totalScenes,
      message: extra?.message ?? stage,
      error: extra?.error,
      outputPath: extra?.outputPath,
      duration: extra?.duration
    })
  }

  const cache = new SimpleAssemblyCacheManager(projectDir)
  cache.ensureDirs()

  const outputDir = path.join(projectDir, 'output')
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  const finalOutputPath = path.join(outputDir, `${outputName}.mp4`)
  const partialOutputPath = path.join(outputDir, `${outputName}.partial.mp4`)
  safeUnlink(partialOutputPath)

  try {
    throwIfAborted(signal)

    // ── Phase 1: Validate Input Voiceover ──────────────────────────────────
    reportProgress('validating-voiceover', 0.05, '[1/8] Validating input voiceover audio...')
    if (!voiceoverPath || !fs.existsSync(voiceoverPath)) {
      throw new Error(`Voiceover audio file does not exist: ${voiceoverPath}`)
    }
    const voProbe = await probeMedia(voiceoverPath, { signal })
    if (!voProbe || !voProbe.duration || voProbe.duration <= 0) {
      throw new Error(`Invalid or unreadable voiceover audio: ${voiceoverPath}`)
    }
    const voiceoverDuration = voProbe.duration
    logger.info(`[SimpleAssembly] Voiceover duration: ${voiceoverDuration.toFixed(3)}s`)

    // ── Phase 2: Validate Imported Scenes ──────────────────────────────────
    reportProgress('validating-scenes', 0.12, '[2/8] Validating imported scene media...')
    let sceneInputs = request.sceneSources
    if (!sceneInputs || sceneInputs.length === 0) {
      const resolved = resolveSimpleAssemblyInputs(projectDir, sceneFolder)
      sceneInputs = resolved.scenes
    }

    if (sceneInputs.length === 0) {
      throw new Error('Import your scenes to begin Simple Assembly. No valid scene media found.')
    }

    // Verify all source files exist and are readable
    for (const sc of sceneInputs) {
      throwIfAborted(signal)
      if (!fs.existsSync(sc.filePath)) {
        throw new Error(`Scene ${sc.sceneIndex} file not found: ${sc.filePath}`)
      }
      const st = fs.statSync(sc.filePath)
      if (st.size === 0) {
        throw new Error(`Scene ${sc.sceneIndex} file is empty (0 bytes): ${sc.filePath}`)
      }
    }
    logger.info(`[SimpleAssembly] Validated ${sceneInputs.length} scene source files`)

    // ── Phase 3: Resolve Scene Timing ──────────────────────────────────────
    reportProgress('resolving-timing', 0.18, '[3/8] Resolving scene timing and frame allocation...')
    const timeline: TimelineResolutionResult = await resolveAssemblyTimeline({
      scenes: sceneInputs,
      voiceoverPath,
      fps,
      signal
    })
    logger.info(
      `[SimpleAssembly] Timeline resolved: ${timeline.scenes.length} scenes, totalFrames=${timeline.targetTotalFrames}, method=${timeline.allocationMethod}`
    )

    // ── Phase 4: Normalize Media If Needed ─────────────────────────────────
    reportProgress('normalizing-scenes', 0.22, `[4/8] Normalizing scene clips (0/${timeline.scenes.length})...`)

    // Probe scenes to evaluate Fast Path eligibility
    const sceneProbes: Array<{ scene: SimpleAssemblySceneInfo; probe: MediaProbe | null }> = []
    for (let i = 0; i < timeline.scenes.length; i++) {
      throwIfAborted(signal)
      const sc = timeline.scenes[i]
      const probe = await probeMedia(sc.sourcePath, { signal })
      sceneProbes.push({ scene: sc, probe })
    }

    // Fast Path check: All videos, matching format/fps/resolution/duration exactly
    let canUseFastPath = true
    for (const item of sceneProbes) {
      if (!item.probe || item.scene.mediaType !== 'video') {
        canUseFastPath = false
        break
      }
      const durDiff = Math.abs(item.probe.duration - item.scene.durationSecs)
      const isExactFormat =
        item.probe.width === width &&
        item.probe.height === height &&
        Math.abs(item.probe.fps - fps) < 0.1 &&
        durDiff <= 0.05
      if (!isExactFormat) {
        canUseFastPath = false
        break
      }
    }

    const normalizedClipPaths: string[] = []
    const sceneFingerprints: string[] = []

    if (canUseFastPath) {
      logger.info('[SimpleAssembly] Fast Path eligible: all source clips match target format. Skipping normalization.')
      for (const item of sceneProbes) {
        normalizedClipPaths.push(item.scene.sourcePath)
        sceneFingerprints.push(fileSignature(item.scene.sourcePath)?.hash || path.basename(item.scene.sourcePath))
      }
    } else {
      logger.info('[SimpleAssembly] Normalizing scene clips with compatibility pipeline...')
      const totalScenes = timeline.scenes.length

      for (let i = 0; i < totalScenes; i++) {
        throwIfAborted(signal)
        const sc = timeline.scenes[i]
        const probe = sceneProbes[i].probe
        const sourceSig = fileSignature(sc.sourcePath)

        const clipFp = computeSceneClipFingerprint({
          sourcePath: sc.sourcePath,
          sourceSig,
          targetWidth: width,
          targetHeight: height,
          targetFps: fps,
          targetFrames: sc.targetFrames,
          targetDurationSecs: sc.durationSecs,
          shortClipPolicy
        })
        sceneFingerprints.push(clipFp)

        const clipPath = cache.getClipPath(clipFp)
        normalizedClipPaths.push(clipPath)

        // Check cache reuse
        const isCached = await cache.isClipValid(clipPath, sc.targetFrames, fps, signal)
        if (isCached) {
          const pct = 0.22 + ((i + 1) / totalScenes) * 0.38
          reportProgress('normalizing-scenes', pct, `[4/8] Normalized scene ${i + 1}/${totalScenes} (cached)`, {
            sceneIndex: sc.sceneIndex,
            totalScenes
          })
          continue
        }

        // Render normalized clip
        const pct = 0.22 + ((i + 1) / totalScenes) * 0.38
        reportProgress('normalizing-scenes', pct, `[4/8] Normalizing scene ${i + 1}/${totalScenes}...`, {
          sceneIndex: sc.sceneIndex,
          totalScenes
        })

        const workingClip = clipPath + '.partial.mp4'
        safeUnlink(workingClip)

        const allocatedDurationStr = sc.durationSecs.toFixed(3)

        if (sc.mediaType === 'image') {
          // Static image: hold frame for allocated duration with aspect-ratio preserving pad
          const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
          await ffmpegRun(
            [
              '-y',
              '-loop', '1',
              '-t', allocatedDurationStr,
              '-i', sc.sourcePath,
              '-vf', vf,
              '-c:v', 'libx264',
              '-preset', 'veryfast',
              '-crf', '20',
              '-movflags', '+faststart',
              workingClip
            ],
            { signal, threads: 2 }
          )
        } else {
          // Video source: handle long vs short duration
          const srcDur = probe?.duration ?? sc.durationSecs
          if (srcDur >= sc.durationSecs - 0.05) {
            // Long clip or exact: trim from start
            const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
            await ffmpegRun(
              [
                '-y',
                '-ss', '0',
                '-t', allocatedDurationStr,
                '-i', sc.sourcePath,
                '-an', // strictly mute source audio!
                '-vf', vf,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '20',
                '-movflags', '+faststart',
                workingClip
              ],
              { signal, threads: 2 }
            )
          } else {
            // Short clip: freeze last frame to fill remaining duration
            const missingSecs = Math.max(0.01, sc.durationSecs - srcDur)
            const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${missingSecs.toFixed(3)},trim=0:${allocatedDurationStr},setpts=PTS-STARTPTS,format=yuv420p`
            await ffmpegRun(
              [
                '-y',
                '-i', sc.sourcePath,
                '-an', // strictly mute source audio!
                '-vf', vf,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '20',
                '-movflags', '+faststart',
                workingClip
              ],
              { signal, threads: 2 }
            )
          }
        }

        // Commit working clip to final clip cache path
        if (fs.existsSync(workingClip)) {
          fs.renameSync(workingClip, clipPath)
        }
      }
    }

    // ── Phase 5: Join Scenes ───────────────────────────────────────────────
    reportProgress('joining-scenes', 0.65, `[5/8] Concatenating ${normalizedClipPaths.length} scene clips...`)
    throwIfAborted(signal)

    const assemblyFingerprint = computeAssemblyVideoFingerprint({
      sceneFingerprints,
      width,
      height,
      fps
    })
    const assembledVideoPath = cache.getAssembledVideoPath(assemblyFingerprint)
    const isAssembledCached = await cache.isAssembledVideoValid(
      assembledVideoPath,
      timeline.targetTotalFrames,
      fps,
      signal
    )

    if (isAssembledCached) {
      logger.info(`[SimpleAssembly] Reusing cached assembled video: ${assembledVideoPath}`)
    } else {
      const concatListPath = path.join(projectDir, '.cache', 'simple-assembly', `concat_${Date.now()}.txt`)
      const concatContent = normalizedClipPaths.map((p) => `file '${escapeConcatPath(p)}'`).join('\n')
      fs.writeFileSync(concatListPath, concatContent, 'utf-8')

      const workingAssembled = assembledVideoPath + '.partial.mp4'
      safeUnlink(workingAssembled)

      try {
        await ffmpegRun(
          [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatListPath,
            '-c', 'copy',
            '-movflags', '+faststart',
            workingAssembled
          ],
          { signal }
        )
      } finally {
        safeUnlink(concatListPath)
      }

      if (fs.existsSync(workingAssembled)) {
        fs.renameSync(workingAssembled, assembledVideoPath)
      }
    }

    // ── Phase 6: Attach Voiceover & Optional Background Music ───────────────
    reportProgress('mixing-audio', 0.78, '[6/8] Attaching voiceover and configuring soundtrack...')
    throwIfAborted(signal)

    // Resolve effective music track if Add Music is enabled
    let effectiveMusicPath: string | null = null
    if (backgroundMusicMode === 'auto') {
      if (musicFilePath && fs.existsSync(musicFilePath)) {
        effectiveMusicPath = musicFilePath
      } else {
        // Look for approved music in assets/audio
        const audioDir = path.join(projectDir, 'assets', 'audio')
        if (fs.existsSync(audioDir)) {
          const files = fs.readdirSync(audioDir).filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f))
          if (files.length > 0) {
            effectiveMusicPath = path.join(audioDir, files[0])
          }
        }
      }

      if (!effectiveMusicPath) {
        throw new Error(
          'Add Background Music was enabled, but no background music track was found. Please select a music file or choose No Background Music.'
        )
      }
      logger.info(`[SimpleAssembly] Using background music track: ${effectiveMusicPath}`)
    } else {
      logger.info('[SimpleAssembly] True No Music mode active: final output will contain input voiceover ONLY.')
    }

    const finalDurationStr = voiceoverDuration.toFixed(3)

    if (backgroundMusicMode === 'off' || !effectiveMusicPath) {
      // Voiceover-only soundtrack
      // Assembled video + voiceover with AAC audio
      await ffmpegRun(
        [
          '-y',
          '-i', assembledVideoPath,
          '-i', voiceoverPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-t', finalDurationStr,
          '-movflags', '+faststart',
          partialOutputPath
        ],
        { signal }
      )
    } else {
      // Voiceover + ducked background music soundtrack
      const filterComplex =
        `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo];` +
        `[2:a]volume=0.035,afade=t=in:ss=0:d=2,afade=t=out:st=${Math.max(0, voiceoverDuration - 3).toFixed(3)}:d=3,apad[bgm];` +
        `[vo][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]`

      await ffmpegRun(
        [
          '-y',
          '-i', assembledVideoPath,
          '-i', voiceoverPath,
          '-i', effectiveMusicPath,
          '-filter_complex', filterComplex,
          '-map', '0:v:0',
          '-map', '[a]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-t', finalDurationStr,
          '-movflags', '+faststart',
          partialOutputPath
        ],
        { signal }
      )
    }

    // ── Phase 7: Validate Final Output ─────────────────────────────────────
    reportProgress('validating-output', 0.92, '[7/8] Validating final output MP4...')
    throwIfAborted(signal)

    if (!fs.existsSync(partialOutputPath)) {
      throw new Error('Final output file was not produced by FFmpeg.')
    }

    const outProbe = await probeMedia(partialOutputPath, { signal })
    if (!outProbe || !outProbe.duration || outProbe.duration <= 0) {
      throw new Error('Produced MP4 failed probe validation (zero duration or invalid media).')
    }

    const durDiff = Math.abs(outProbe.duration - voiceoverDuration)
    // Allow up to 0.3s tolerance for audio priming / container overhead
    if (durDiff > 0.5) {
      logger.warn(
        `[SimpleAssembly] Output duration (${outProbe.duration.toFixed(2)}s) differs from voiceover (${voiceoverDuration.toFixed(2)}s) by ${durDiff.toFixed(2)}s`
      )
    }

    const stat = fs.statSync(partialOutputPath)
    if (stat.size < 1024) {
      throw new Error(`Produced MP4 is corrupt or too small (${stat.size} bytes).`)
    }

    // Atomic promotion
    safeUnlink(finalOutputPath)
    fs.renameSync(partialOutputPath, finalOutputPath)

    logger.info(
      `[SimpleAssembly] Complete! Published ${finalOutputPath} (size=${stat.size} bytes, duration=${outProbe.duration.toFixed(2)}s)`
    )

    // ── Phase 8: Complete ──────────────────────────────────────────────────
    reportProgress('completed', 1.0, '[8/8] Simple Assembly complete!', {
      outputPath: finalOutputPath,
      duration: outProbe.duration
    })

    return {
      success: true,
      outputPath: finalOutputPath,
      durationSecs: outProbe.duration,
      fileSizeBytes: stat.size,
      sceneCount: timeline.scenes.length,
      fastPathUsed: canUseFastPath
    }
  } catch (err: unknown) {
    safeUnlink(partialOutputPath)
    if (isRenderCancelledError(err)) {
      logger.info('[SimpleAssembly] Assembly cancelled by user.')
      reportProgress('cancelled', 0, 'Simple Assembly cancelled.')
      return { success: false, cancelled: true, error: 'Simple Assembly cancelled' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[SimpleAssembly] Failed: ${msg}`)
    reportProgress('failed', 0, `Simple Assembly failed: ${msg}`, { message: msg })
    return { success: false, error: msg }
  }
}
