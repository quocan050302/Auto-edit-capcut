import * as fs from 'fs'
import * as path from 'path'
import {
  fingerprintOf,
  fileSignature,
  type FileSignature
} from '../render-cache/render-fingerprint'
import { probeMedia } from '../render-cache/ffmpeg-process'
import type { BackgroundMusicMode, ShortClipPolicy, SimpleAssemblySceneInfo } from './simple-assembly-types'

export const SIMPLE_ASSEMBLY_ENGINE_VERSION = 1

export interface SceneClipCacheKeyParams {
  sourcePath: string
  sourceSig: FileSignature | null
  targetWidth: number
  targetHeight: number
  targetFps: number
  targetFrames: number
  targetDurationSecs: number
  shortClipPolicy: ShortClipPolicy
}

export function computeSceneClipFingerprint(params: SceneClipCacheKeyParams): string {
  return fingerprintOf({
    v: SIMPLE_ASSEMBLY_ENGINE_VERSION,
    kind: 'scene-clip',
    source: params.sourceSig,
    w: params.targetWidth,
    h: params.targetHeight,
    fps: params.targetFps,
    frames: params.targetFrames,
    dur: Math.round(params.targetDurationSecs * 1000) / 1000,
    policy: params.shortClipPolicy
  })
}

export interface AssemblyVideoCacheKeyParams {
  sceneFingerprints: string[]
  width: number
  height: number
  fps: number
}

export function computeAssemblyVideoFingerprint(params: AssemblyVideoCacheKeyParams): string {
  return fingerprintOf({
    v: SIMPLE_ASSEMBLY_ENGINE_VERSION,
    kind: 'assembled-video',
    scenes: params.sceneFingerprints,
    w: params.width,
    h: params.height,
    fps: params.fps
  })
}

export interface FinalAssemblyCacheKeyParams {
  assemblyFingerprint: string
  voiceoverSig: FileSignature | null
  backgroundMusicMode: BackgroundMusicMode
  musicSig: FileSignature | null
  shortClipPolicy: ShortClipPolicy
}

export function computeSimpleAssemblyFingerprint(params: FinalAssemblyCacheKeyParams): string {
  return fingerprintOf({
    v: SIMPLE_ASSEMBLY_ENGINE_VERSION,
    kind: 'simple-assembly-output',
    assembly: params.assemblyFingerprint,
    voiceover: params.voiceoverSig,
    musicMode: params.backgroundMusicMode,
    music: params.musicSig,
    policy: params.shortClipPolicy
  })
}

export class SimpleAssemblyCacheManager {
  private cacheDir: string
  private clipsDir: string

  constructor(private projectDir: string) {
    this.cacheDir = path.join(projectDir, '.cache', 'simple-assembly')
    this.clipsDir = path.join(this.cacheDir, 'clips')
  }

  ensureDirs(): void {
    if (!fs.existsSync(this.clipsDir)) {
      fs.mkdirSync(this.clipsDir, { recursive: true })
    }
  }

  getClipPath(fingerprint: string): string {
    return path.join(this.clipsDir, `clip_${fingerprint.slice(0, 16)}.mp4`)
  }

  getAssembledVideoPath(assemblyFingerprint: string): string {
    return path.join(this.cacheDir, `assembled_${assemblyFingerprint.slice(0, 16)}.mp4`)
  }

  async isClipValid(clipPath: string, expectedFrames: number, fps: number, signal?: AbortSignal): Promise<boolean> {
    if (!fs.existsSync(clipPath)) return false
    try {
      const stat = fs.statSync(clipPath)
      if (stat.size < 1024) return false
      const probe = await probeMedia(clipPath, { signal })
      if (!probe || !probe.duration || probe.duration <= 0) return false
      // Frame count or duration within 1-2 frames
      const expectedDur = expectedFrames / fps
      const diff = Math.abs(probe.duration - expectedDur)
      return diff <= Math.max(0.1, 2 / fps)
    } catch {
      return false
    }
  }

  async isAssembledVideoValid(
    videoPath: string,
    expectedTotalFrames: number,
    fps: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!fs.existsSync(videoPath)) return false
    try {
      const stat = fs.statSync(videoPath)
      if (stat.size < 1024) return false
      const probe = await probeMedia(videoPath, { signal })
      if (!probe || !probe.duration || probe.duration <= 0) return false
      const expectedDur = expectedTotalFrames / fps
      const diff = Math.abs(probe.duration - expectedDur)
      return diff <= Math.max(0.2, 3 / fps)
    } catch {
      return false
    }
  }
}
