import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import { openverseSearchAudio } from '../../audio/openverse'
import { downloadAudio } from '../../audio/audio-director'
import type { AudioSearchResult } from '../../../shared/types'
import type { ResolvedSfx, SfxResolveRequest } from '../sfx-types'

const HEALTH_SFX_QUERIES: Record<string, string[]> = {
  'soft-whoosh': ['whoosh soft', 'cinematic whoosh', 'air swish'],
  'reverse-whoosh': ['reverse whoosh', 'whoosh reverse', 'reverse sweep'],
  'air-swish': ['air swish', 'breeze swish', 'soft whoosh'],
  'digital-scan': ['digital scan', 'electronic chirp', 'science beep subtle'],
  'soft-pulse': ['soft tone pulse', 'deep pulse subtle', 'electronic pulse'],
  'heartbeat': ['heartbeat single', 'heart beat subtle', 'heart thump'],
  'soft-impact': ['soft impact', 'subtle cinematic thud', 'gentle hit'],
  'clock-tick': ['clock tick', 'watch tick', 'clock click single'],
  'subtle-riser': ['subtle riser', 'short tension riser', 'electronic swell']
}

/**
 * Resolves SFX via Openverse audio search and download.
 * Used strictly as optional last-resort fallback.
 * Returns null if network fails, rate limited, or no candidates found.
 */
export async function resolveOpenverseSfx(
  request: SfxResolveRequest,
  openverseToken?: string
): Promise<ResolvedSfx | null> {
  if (request.type === 'none') {
    return null
  }

  const queries = HEALTH_SFX_QUERIES[request.type] || request.intents || [request.type]
  let candidate: AudioSearchResult | null = null
  let usedQuery = queries[0]

  for (const q of queries) {
    try {
      const results = await openverseSearchAudio(q, 'sound_effects', 5, openverseToken)
      const shortClips = results.filter((r) => (r.durationSecs || 1) < 5.0)
      if (shortClips.length > 0) {
        candidate = shortClips[0]
        usedQuery = q
        break
      } else if (results.length > 0) {
        candidate = results[0]
        usedQuery = q
        break
      }
    } catch (err) {
      logger.debug(`[OpenverseSFX] Search query "${q}" failed: ${err}`)
    }
  }

  if (!candidate) {
    logger.debug(`[OpenverseSFX] No candidate found for type=${request.type}`)
    return null
  }

  const destDir = path.join(request.projectDir, 'assets', 'audio', 'health-sfx')
  fs.mkdirSync(destDir, { recursive: true })

  try {
    const localPath = await downloadAudio(candidate, destDir)
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 512) {
      return null
    }

    logger.info(`[OpenverseSFX] Downloaded type=${request.type} query="${usedQuery}" -> ${localPath}`)

    return {
      type: request.type,
      provider: 'openverse',
      localPath,
      durationSecs: candidate.durationSecs || 1.0,
      sourceId: candidate.id,
      sourceLabel: `Openverse (${candidate.id})`,
      creator: candidate.creator || 'Openverse Audio',
      license: candidate.license || 'CC',
      sourceUrl: candidate.foreignLandingUrl,
      generated: false
    }
  } catch (err) {
    logger.warn(`[OpenverseSFX] Download error for ${request.type}: ${err}`)
    return null
  }
}
