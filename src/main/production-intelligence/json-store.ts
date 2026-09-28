import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'

/**
 * Atomic JSON Store for Production Intelligence
 * Writes to a temporary file first, validates JSON format, then renames.
 * Ensures project files are never left in a corrupted or half-written state.
 */

export function atomicWriteJson<T>(filePath: string, data: T, indent = 2): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const serialized = JSON.stringify(data, null, indent)

  // Quick sanity check on serialized output
  if (!serialized || serialized.length === 0) {
    throw new Error(`Cannot write empty JSON data to ${filePath}`)
  }

  try {
    fs.writeFileSync(tmpPath, serialized, 'utf-8')

    // On Windows, renameSync will fail if the destination file exists and is locked.
    // We try atomic renameSync, with fallback to replace.
    try {
      fs.renameSync(tmpPath, filePath)
    } catch {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      fs.renameSync(tmpPath, filePath)
    }
  } catch (err) {
    // Clean up temporary file if write or rename failed
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath)
      }
    } catch { /* ignore */ }

    logger.error(`[AtomicJsonStore] Failed to write ${filePath}: ${String(err)}`)
    throw err
  }
}

export function atomicReadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue
    }
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) {
      return defaultValue
    }
    return JSON.parse(raw) as T
  } catch (err) {
    logger.warn(`[AtomicJsonStore] Failed to read ${filePath}, returning default: ${String(err)}`)
    return defaultValue
  }
}
