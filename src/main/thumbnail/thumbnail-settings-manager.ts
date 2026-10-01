import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { ProjectThumbnailSettings, ThumbnailPromptTemplate } from '../../../shared/types'
import { thumbnailTemplateStore } from './thumbnail-template-store'
import { logger } from '../logger'

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content.trim(), 'utf-8').digest('hex')
}

export function getDefaultProjectThumbnailSettings(template?: ThumbnailPromptTemplate): ProjectThumbnailSettings {
  const tpl = template || thumbnailTemplateStore.getDefault()
  const snapshot = typeof (tpl as any).then === 'function' ? '' : (tpl as ThumbnailPromptTemplate).promptText
  const tplId = typeof (tpl as any).then === 'function' ? undefined : (tpl as ThumbnailPromptTemplate).id

  return {
    enabled: true,
    autoGenerateAfterRender: true,
    selectedTemplateId: tplId,
    templateSnapshot: snapshot,
    templateSnapshotHash: snapshot ? computeSha256(snapshot) : undefined,
    existingVideoTitle: '',
    variantCount: 5,
    outputLanguage: 'en-US',
    provider: 'google-flow',
    imageModel: 'GEM_PIX_2',
    outputQuality: '4k'
  }
}

export function getProjectThumbnailSettingsPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'thumbnail-settings.json')
}

export async function loadProjectThumbnailSettings(projectDir: string): Promise<ProjectThumbnailSettings> {
  const filePath = getProjectThumbnailSettingsPath(projectDir)
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ProjectThumbnailSettings>
      return {
        enabled: parsed.enabled !== undefined ? parsed.enabled : true,
        autoGenerateAfterRender: parsed.autoGenerateAfterRender !== undefined ? parsed.autoGenerateAfterRender : true,
        selectedTemplateId: parsed.selectedTemplateId,
        templateSnapshot: parsed.templateSnapshot,
        templateSnapshotHash: parsed.templateSnapshotHash,
        existingVideoTitle: parsed.existingVideoTitle || '',
        variantCount: 5,
        outputLanguage: 'en-US',
        provider: 'google-flow',
        imageModel: parsed.imageModel || 'GEM_PIX_2',
        outputQuality: '4k'
      }
    } catch (err) {
      logger.warn(`[ThumbnailSettings] Failed to parse ${filePath}: ${err}. Falling back to defaults.`)
    }
  }

  // Load default template snapshot
  const defTpl = await thumbnailTemplateStore.getDefault()
  const settings: ProjectThumbnailSettings = {
    enabled: true,
    autoGenerateAfterRender: true,
    selectedTemplateId: defTpl.id,
    templateSnapshot: defTpl.promptText,
    templateSnapshotHash: computeSha256(defTpl.promptText),
    existingVideoTitle: '',
    variantCount: 5,
    outputLanguage: 'en-US',
    provider: 'google-flow',
    imageModel: 'GEM_PIX_2',
    outputQuality: '4k'
  }

  await saveProjectThumbnailSettings(projectDir, settings)
  return settings
}

export async function saveProjectThumbnailSettings(
  projectDir: string,
  settings: ProjectThumbnailSettings
): Promise<void> {
  const filePath = getProjectThumbnailSettingsPath(projectDir)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // If templateSnapshot exists but hash is missing, compute it
  if (settings.templateSnapshot && !settings.templateSnapshotHash) {
    settings.templateSnapshotHash = computeSha256(settings.templateSnapshot)
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  try {
    fs.renameSync(tmpPath, filePath)
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // ignore
      }
    }
  }
}

export async function selectTemplateForProject(
  projectDir: string,
  templateId: string
): Promise<ProjectThumbnailSettings> {
  const template = await thumbnailTemplateStore.getById(templateId)
  if (!template) {
    throw new Error(`Template not found: ${templateId}`)
  }

  const current = await loadProjectThumbnailSettings(projectDir)
  const updated: ProjectThumbnailSettings = {
    ...current,
    selectedTemplateId: template.id,
    templateSnapshot: template.promptText,
    templateSnapshotHash: computeSha256(template.promptText)
  }

  await saveProjectThumbnailSettings(projectDir, updated)
  return updated
}
