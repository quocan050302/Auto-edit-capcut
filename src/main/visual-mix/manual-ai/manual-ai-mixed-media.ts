/**
 * manual-ai-mixed-media.ts
 *
 * Media classification and recursive mixed-media folder scanner for manual AI imports.
 * Supports importing images (PNG, JPG, JPEG, WEBP) and videos (MP4, MOV, WEBM, MKV)
 * together in one folder or file selection.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import {
  MANUAL_AI_MIXED_EXTENSIONS,
  MANUAL_AI_SUPPORTED_EXTENSIONS,
  MANUAL_AI_VIDEO_EXTENSIONS
} from './manual-ai-types'
import { naturalCompare } from './manual-ai-importer'

export const MAX_DISCOVERED_MIXED_MEDIA = 250
export const MAX_MIXED_FOLDER_DEPTH = 3

/**
 * Classifies a file path into 'image', 'video', or 'unsupported' using
 * the authoritative extension lists.
 */
export function detectManualImportMediaType(filePath: string): 'image' | 'video' | 'unsupported' {
  const ext = path.extname(filePath).toLowerCase()
  if (MANUAL_AI_SUPPORTED_EXTENSIONS.includes(ext)) {
    return 'image'
  }
  if (MANUAL_AI_VIDEO_EXTENSIONS.includes(ext)) {
    return 'video'
  }
  return 'unsupported'
}

/**
 * Helper to count images and videos in a list of file paths.
 */
export function countMixedMedia(filePaths: string[]): { imageCount: number; videoCount: number } {
  let imageCount = 0
  let videoCount = 0
  for (const f of filePaths) {
    const kind = detectManualImportMediaType(f)
    if (kind === 'image') imageCount++
    else if (kind === 'video') videoCount++
  }
  return { imageCount, videoCount }
}

/**
 * Bounded recursive discovery of mixed media files (images + videos) up to maxDepth.
 * Skips symlinks and hidden directories. Sorts deterministically using naturalCompare.
 * Implements a safety limit of MAX_DISCOVERED_MIXED_MEDIA (250).
 */
export function listMixedMediaInFolder(
  folder: string,
  maxDepth = MAX_MIXED_FOLDER_DEPTH,
  warningsOut?: string[]
): string[] {
  if (!fs.existsSync(folder)) {
    throw new Error(`Folder does not exist: ${folder}`)
  }
  const rootStat = fs.statSync(folder)
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folder}`)
  }

  const discovered: string[] = []
  let hitLimit = false

  function traverse(currentDir: string, currentDepth: number): void {
    if (hitLimit || currentDepth > maxDepth) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch (err) {
      const msg = `Unable to read directory: ${currentDir} (${err instanceof Error ? err.message : String(err)})`
      logger.warn(`[ManualAI:MixedFolder] ${msg}`)
      warningsOut?.push(msg)
      return
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (currentDepth < maxDepth) {
          traverse(fullPath, currentDepth + 1)
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (MANUAL_AI_MIXED_EXTENSIONS.includes(ext)) {
          if (discovered.length >= MAX_DISCOVERED_MIXED_MEDIA) {
            hitLimit = true
            const limitMsg = `Discovered media files reached safety limit of ${MAX_DISCOVERED_MIXED_MEDIA}. Extra files omitted.`
            logger.warn(`[ManualAI:MixedFolder] ${limitMsg}`)
            warningsOut?.push(limitMsg)
            break
          }
          discovered.push(fullPath)
        }
      }
    }
  }

  traverse(folder, 0)
  return discovered.sort((a, b) => {
    const baseCmp = naturalCompare(path.basename(a), path.basename(b))
    return baseCmp !== 0 ? baseCmp : naturalCompare(a, b)
  })
}
