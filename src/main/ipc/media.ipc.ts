import { IpcMain, BrowserWindow } from 'electron'
import { join, extname, basename } from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import ffprobeStatic from 'ffprobe-static'
import { IPC_CHANNELS, MediaItem, ScanResult } from '../../../shared/types'
import { logger, ffmpegLogger } from '../logger'

// Use ffprobe-static binary
const FFPROBE_PATH = ffprobeStatic.path

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mxf'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac', '.opus'])

function fileHash(filePath: string): string {
  const stat = fs.statSync(filePath)
  return crypto
    .createHash('md5')
    .update(`${filePath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
}

async function probeMedia(
  filePath: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process')
    const proc = spawn(FFPROBE_PATH, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ])

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

    proc.on('close', (code: number) => {
      if (code !== 0) {
        ffmpegLogger.error(`ffprobe failed for ${filePath}: ${stderr}`)
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 200)}`))
      } else {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('Failed to parse ffprobe JSON'))
        }
      }
    })

    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`))
    })
  })
}

function buildMediaItem(
  filePath: string,
  probe: Record<string, unknown>
): Omit<MediaItem, 'id'> {
  const ext = extname(filePath).toLowerCase()
  const stat = fs.statSync(filePath)
  const streams = (probe.streams as Record<string, unknown>[]) || []
  const format = (probe.format as Record<string, unknown>) || {}

  const videoStream = streams.find((s) => s.codec_type === 'video') as Record<string, unknown> | undefined
  const audioStream = streams.find((s) => s.codec_type === 'audio') as Record<string, unknown> | undefined

  const isImage = IMAGE_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  const isAudio = AUDIO_EXTS.has(ext)

  const width = videoStream?.width as number | undefined
  const height = videoStream?.height as number | undefined
  const duration = parseFloat(
    (videoStream?.duration as string) || (format.duration as string) || '0'
  )
  const fps = videoStream?.r_frame_rate
    ? (() => {
        const parts = (videoStream.r_frame_rate as string).split('/')
        return parts.length === 2
          ? Math.round(parseFloat(parts[0]) / parseFloat(parts[1]))
          : parseFloat(videoStream.r_frame_rate as string)
      })()
    : undefined

  const ar =
    width && height ? `${Math.round((width / height) * 100) / 100}:1` : undefined

  return {
    type: isImage ? 'image' : isVideo ? 'video' : 'audio',
    path: filePath,
    filename: basename(filePath),
    fileSize: stat.size,
    width: isImage || isVideo ? width : undefined,
    height: isImage || isVideo ? height : undefined,
    duration: isVideo ? (isNaN(duration) ? undefined : duration) : undefined,
    audioDuration: isAudio ? (isNaN(duration) ? undefined : duration) : undefined,
    fps: isVideo ? fps : undefined,
    codec: videoStream?.codec_name as string | undefined,
    aspectRatio: ar,
    tags: [],
    description: '',
    usageCount: 0,
    importedAt: new Date().toISOString()
  }
}

function scanFolder(folderPath: string, extensions: Set<string>): string[] {
  const results: string[] = []
  if (!fs.existsSync(folderPath)) return results

  function recurse(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        recurse(fullPath)
      } else if (extensions.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath)
      }
    }
  }
  recurse(folderPath)
  return results
}

export function registerMediaHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_SCAN,
    async (
      event,
      params: {
        projectDir: string
        imagesFolder: string | null
        videosFolder: string | null
        musicFolder: string | null
        sfxFolder: string | null
      }
    ) => {
      const result: ScanResult = {
        images: [],
        videos: [],
        music: [],
        sfx: [],
        errors: []
      }

      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, { message, progress })
        logger.info(`[SCAN] ${message} (${Math.round(progress * 100)}%)`)
      }

      const processFiles = async (
        files: string[],
        bucket: MediaItem[],
        label: string,
        offset: number,
        range: number
      ): Promise<void> => {
        for (let i = 0; i < files.length; i++) {
          const fp = files[i]
          const progress = offset + (i / Math.max(files.length, 1)) * range
          sendProgress(`Analyzing ${label}: ${basename(fp)}`, progress)
          try {
            const probe = await probeMedia(fp)
            const item = buildMediaItem(fp, probe)
            const id = uuidv4()
            bucket.push({ id, ...item })
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            result.errors.push({ path: fp, error: msg })
            logger.warn(`Failed to probe ${fp}: ${msg}`)
          }
        }
      }

      sendProgress('Scanning image folder...', 0)
      const imageFiles = params.imagesFolder
        ? scanFolder(params.imagesFolder, IMAGE_EXTS)
        : []

      sendProgress('Scanning video folder...', 0.05)
      const videoFiles = params.videosFolder
        ? scanFolder(params.videosFolder, VIDEO_EXTS)
        : []

      sendProgress('Scanning music folder...', 0.1)
      const musicFiles = params.musicFolder
        ? scanFolder(params.musicFolder, AUDIO_EXTS)
        : []

      sendProgress('Scanning SFX folder...', 0.12)
      const sfxFiles = params.sfxFolder
        ? scanFolder(params.sfxFolder, AUDIO_EXTS)
        : []

      const total = imageFiles.length + videoFiles.length + musicFiles.length + sfxFiles.length
      logger.info(`Found ${total} media files total`, {
        images: imageFiles.length,
        videos: videoFiles.length,
        music: musicFiles.length,
        sfx: sfxFiles.length
      })

      await processFiles(imageFiles, result.images, 'image', 0.15, 0.3)
      await processFiles(videoFiles, result.videos, 'video', 0.45, 0.35)
      await processFiles(musicFiles, result.music, 'music', 0.8, 0.1)
      await processFiles(sfxFiles, result.sfx, 'sfx', 0.9, 0.08)

      // Save media-index.json
      const allMedia = [
        ...result.images,
        ...result.videos,
        ...result.music,
        ...result.sfx
      ]
      const indexPath = join(params.projectDir, 'analysis', 'media-index.json')
      fs.mkdirSync(join(params.projectDir, 'analysis'), { recursive: true })
      fs.writeFileSync(indexPath, JSON.stringify(allMedia, null, 2), 'utf-8')

      sendProgress(`Scan complete — ${total} assets indexed`, 1.0)
      logger.info('Media scan complete', {
        images: result.images.length,
        videos: result.videos.length,
        music: result.music.length,
        sfx: result.sfx.length,
        errors: result.errors.length
      })

      return result
    }
  )
}
