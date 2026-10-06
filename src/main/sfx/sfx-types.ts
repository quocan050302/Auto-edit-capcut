/**
 * sfx-types.ts — Shared Types for the Local-First SFX Architecture
 */

import type { HealthSfxType, HealthSfxCuePlan } from '../../shared/types'

export type SfxProvider = 'cache' | 'hyperframes' | 'procedural' | 'openverse'

export interface SfxResolveRequest {
  type: HealthSfxType
  intents?: string[]
  durationSecs?: number
  intensity?: 'subtle' | 'accent'
  projectDir: string
  openverseToken?: string
}

export interface ResolvedSfx {
  type: HealthSfxType
  provider: SfxProvider
  localPath: string
  durationSecs: number
  sourceId?: string
  sourceLabel?: string
  license?: string
  creator?: string
  sourceUrl?: string
  generated?: boolean
}

export interface SfxProviderAttempt {
  provider: SfxProvider
  success: boolean
  reason?: string
}

export interface SfxResolverResult {
  resolved?: ResolvedSfx
  attempts: SfxProviderAttempt[]
}

export interface HealthSfxCacheEntry {
  assetId: string
  sfxType: HealthSfxType
  query: string
  localPath: string
  license?: string
  creator?: string
  pageUrl?: string
  downloadedAt: string
  provider?: SfxProvider
  sourceLabel?: string
  durationSecs?: number
  generated?: boolean
}

export interface HealthSfxCacheManifest {
  schemaVersion: number
  updatedAt: string
  entries: Record<string, HealthSfxCacheEntry>
}

export interface HyperFramesCapability {
  available: boolean
  nodeBinary?: string
  nodeVersion?: string
  npxBinary?: string
  reason?: string
  checkedAt: number
}
