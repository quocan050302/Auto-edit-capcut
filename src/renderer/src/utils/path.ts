/** Minimal path utilities for the renderer process (no Node.js access) */

export function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}

export function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  parts.pop()
  return parts.join('/')
}

export function extname(filePath: string): string {
  const name = basename(filePath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}
