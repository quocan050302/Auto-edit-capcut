import { logger } from '../logger'
import type { HealthSfxType } from '../../shared/types'
import type {
  ResolvedSfx,
  SfxProviderAttempt,
  SfxResolverResult,
  SfxResolveRequest
} from './sfx-types'
import { SfxCacheManager } from './sfx-cache'
import { resolveHyperframesSfx } from './providers/hyperframes-sfx-provider'
import { generateProceduralSfx } from './providers/procedural-sfx-provider'
import { resolveOpenverseSfx } from './providers/openverse-sfx-provider'

export interface SfxResolverOptions {
  openverseToken?: string
  skipHyperframes?: boolean
  skipProcedural?: boolean
  skipOpenverse?: boolean
}

export class SfxResolver {
  /**
   * Resolves a single SFX type through the prioritized provider cascade:
   * 1. Project Cache
   * 2. HyperFrames CLI (Node >= 22 required, external isolated process)
   * 3. Procedural FFmpeg synthesis (local, deterministic lavfi, zero API)
   * 4. Openverse audio search (optional last resort)
   * Returns SfxResolverResult containing the resolved SFX and diagnostic attempts.
   */
  public static async resolveSfxType(
    request: SfxResolveRequest,
    options: SfxResolverOptions = {}
  ): Promise<SfxResolverResult> {
    const attempts: SfxProviderAttempt[] = []

    if (request.type === 'none') {
      return { attempts }
    }

    // 1. Valid Project Cache
    try {
      const cached = SfxCacheManager.getCachedSfx(request.projectDir, request.type)
      if (cached) {
        attempts.push({ provider: 'cache', success: true })
        return { resolved: cached, attempts }
      }
      attempts.push({ provider: 'cache', success: false, reason: 'Cache miss or file invalid' })
    } catch (err) {
      attempts.push({ provider: 'cache', success: false, reason: String(err) })
    }

    // 2. HyperFrames Bundled / Library Resolver
    if (!options.skipHyperframes) {
      try {
        const hfResolved = await resolveHyperframesSfx(request)
        if (hfResolved) {
          SfxCacheManager.recordCachedSfx(request.projectDir, hfResolved)
          attempts.push({ provider: 'hyperframes', success: true })
          return { resolved: hfResolved, attempts }
        }
        attempts.push({ provider: 'hyperframes', success: false, reason: 'Unavailable, failed, or timed out' })
      } catch (err) {
        attempts.push({ provider: 'hyperframes', success: false, reason: String(err) })
      }
    } else {
      attempts.push({ provider: 'hyperframes', success: false, reason: 'Skipped by options' })
    }

    // 3. Deterministic Procedural FFmpeg Synthesis (Local, zero API)
    if (!options.skipProcedural) {
      try {
        const procResolved = await generateProceduralSfx(request)
        if (procResolved) {
          SfxCacheManager.recordCachedSfx(request.projectDir, procResolved)
          attempts.push({ provider: 'procedural', success: true })
          return { resolved: procResolved, attempts }
        }
        attempts.push({ provider: 'procedural', success: false, reason: 'Synthesis failed or binary missing' })
      } catch (err) {
        attempts.push({ provider: 'procedural', success: false, reason: String(err) })
      }
    } else {
      attempts.push({ provider: 'procedural', success: false, reason: 'Skipped by options' })
    }

    // 4. Openverse (Optional Last Fallback)
    if (!options.skipOpenverse) {
      try {
        const ovResolved = await resolveOpenverseSfx(request, options.openverseToken)
        if (ovResolved) {
          SfxCacheManager.recordCachedSfx(request.projectDir, ovResolved)
          attempts.push({ provider: 'openverse', success: true })
          return { resolved: ovResolved, attempts }
        }
        attempts.push({ provider: 'openverse', success: false, reason: 'No result or download failed' })
      } catch (err) {
        attempts.push({ provider: 'openverse', success: false, reason: String(err) })
      }
    } else {
      attempts.push({ provider: 'openverse', success: false, reason: 'Skipped by options' })
    }

    return { attempts }
  }

  /**
   * Resolves unique SFX types for a project.
   * Resolves sequentially or bounded to avoid runaway child processes.
   */
  public static async resolveUniqueTypes(
    projectDir: string,
    types: HealthSfxType[],
    options: SfxResolverOptions = {}
  ): Promise<Map<HealthSfxType, ResolvedSfx>> {
    const unique = Array.from(new Set(types.filter((t) => t !== 'none')))
    const resultMap = new Map<HealthSfxType, ResolvedSfx>()

    const stats = {
      needed: unique.length,
      cache: 0,
      hyperframes: 0,
      procedural: 0,
      openverse: 0,
      failed: 0
    }

    for (const type of unique) {
      const req: SfxResolveRequest = {
        type,
        intents: [type],
        projectDir
      }

      const res = await this.resolveSfxType(req, options)
      if (res.resolved) {
        resultMap.set(type, res.resolved)
        const prov = res.resolved.provider
        if (prov === 'cache') stats.cache++
        else if (prov === 'hyperframes') stats.hyperframes++
        else if (prov === 'procedural') stats.procedural++
        else if (prov === 'openverse') stats.openverse++
      } else {
        stats.failed++
        logger.warn(`[SfxResolver] All providers failed for SFX type=${type}`)
      }
    }

    logger.info(
      `[SfxResolver] needed=${stats.needed} cache=${stats.cache} hyperframes=${stats.hyperframes} procedural=${stats.procedural} openverse=${stats.openverse} failed=${stats.failed}`
    )

    return resultMap
  }
}
