import { createHash } from 'crypto'

/**
 * Computes a stable semantic fingerprint for a documentary script.
 * We normalize newlines and trim whitespace, but we do not remove
 * meaningful words. This ensures that a script file change that 
 * actually changes content will result in a new hash.
 */
export function computeSourceFingerprint(scriptText: string): string {
  if (!scriptText) {
    return 'empty_source_hash'
  }
  
  // Normalize line endings to \n, remove carriage returns
  const normalized = scriptText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
  
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}
