import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'

export const EDITORIAL_VERIFICATION_SCHEMA_VERSION = 1 as const

export type EmbeddedEditorialVerificationStatus = 'unverified' | 'verified' | 'rejected'

export interface EmbeddedEditorialVerificationRecord {
  sceneIndex: number
  assetFingerprint: string
  expectedText?: string
  confirmedText?: string
  status: EmbeddedEditorialVerificationStatus
  checkedByUser: boolean
  checkedAt?: string
}

export interface EmbeddedEditorialVerificationArtifact {
  schemaVersion: 1
  updatedAt: string
  scenes: Record<string, EmbeddedEditorialVerificationRecord>
}

export function getEditorialVerificationPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'embedded-editorial-verification.v1.json')
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function loadEditorialVerification(projectDir: string): EmbeddedEditorialVerificationArtifact {
  const vPath = getEditorialVerificationPath(projectDir)
  if (!fs.existsSync(vPath)) {
    return {
      schemaVersion: EDITORIAL_VERIFICATION_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      scenes: {}
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(vPath, 'utf-8'))
    if (raw && typeof raw === 'object' && raw.schemaVersion === EDITORIAL_VERIFICATION_SCHEMA_VERSION && typeof raw.scenes === 'object') {
      return raw as EmbeddedEditorialVerificationArtifact
    }
  } catch (err) {
    logger.warn(`[EditorialVerification] Error reading ${vPath}: ${String(err)}`)
  }

  return {
    schemaVersion: EDITORIAL_VERIFICATION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    scenes: {}
  }
}

export function saveEditorialVerification(
  projectDir: string,
  artifact: EmbeddedEditorialVerificationArtifact
): void {
  const vPath = getEditorialVerificationPath(projectDir)
  artifact.updatedAt = new Date().toISOString()
  writeFileAtomic(vPath, JSON.stringify(artifact, null, 2))
}

export function recordAssetVerification(
  projectDir: string,
  params: {
    sceneIndex: number
    assetFingerprint: string
    expectedText?: string
    confirmedText?: string
    status: EmbeddedEditorialVerificationStatus
    checkedByUser: boolean
  }
): EmbeddedEditorialVerificationRecord {
  const artifact = loadEditorialVerification(projectDir)
  const record: EmbeddedEditorialVerificationRecord = {
    sceneIndex: params.sceneIndex,
    assetFingerprint: params.assetFingerprint,
    expectedText: params.expectedText,
    confirmedText: params.confirmedText,
    status: params.status,
    checkedByUser: params.checkedByUser,
    checkedAt: new Date().toISOString()
  }

  artifact.scenes[String(params.sceneIndex)] = record
  saveEditorialVerification(projectDir, artifact)
  return record
}
