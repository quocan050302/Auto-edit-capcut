import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { thumbnailOrchestrator } from './thumbnail-orchestrator'
import { loadProjectThumbnailSettings } from './thumbnail-settings-manager'
import {
  loadThumbnailJobState,
  saveThumbnailJobStateAtomic,
  createInitialThumbnailJobState,
  computeThumbnailJobKey
} from './thumbnail-state'
import { computeSha256 } from './thumbnail-settings-manager'
import type { ThumbnailJobState } from '../../../shared/types'

export interface ThumbnailAutoTriggerParams {
  projectDir: string
  renderOutputPath?: string
  scriptPath?: string
}

export class ThumbnailAutoTrigger {
  private triggeredKeys = new Set<string>()

  /**
   * Safe, non-blocking auto-trigger entry point.
   * NEVER throws an error to the caller, never interferes with video pipeline status.
   */
  public async startIfEligible(params: ThumbnailAutoTriggerParams): Promise<boolean> {
    try {
      const { projectDir } = params

      if (!projectDir || !fs.existsSync(projectDir)) {
        logger.info('[ThumbnailAutoTrigger] Project directory does not exist. Skipping.')
        return false
      }

      // 1. Check project thumbnail settings
      const settings = await loadProjectThumbnailSettings(projectDir)
      if (!settings.enabled || !settings.autoGenerateAfterRender) {
        logger.info(`[ThumbnailAutoTrigger] Thumbnail automation disabled for ${projectDir}. Skipping.`)
        return false
      }

      // 2. Resolve render output path
      const renderPath = params.renderOutputPath || this.findRenderOutput(projectDir)
      if (!renderPath || !fs.existsSync(renderPath)) {
        logger.warn(`[ThumbnailAutoTrigger] Render output file not found at "${renderPath}". Skipping thumbnail generation.`)
        return false
      }

      const st = fs.statSync(renderPath)
      const renderFileSize = st.size
      const renderMtimeMs = st.mtimeMs

      // 3. Resolve script text & hash
      const script = this.readScriptText(projectDir, params.scriptPath)
      const scriptHash = computeSha256(script || 'no-script')
      const templateSnapshotHash = settings.templateSnapshotHash || computeSha256(settings.templateSnapshot || '')

      // 4. Compute Idempotency Key
      const round = 1
      const jobKey = computeThumbnailJobKey({
        renderOutputPath: renderPath,
        renderFileSize,
        renderMtimeMs,
        scriptHash,
        templateSnapshotHash,
        generationRound: round
      })

      if (this.triggeredKeys.has(jobKey)) {
        logger.info(`[ThumbnailAutoTrigger] Job key ${jobKey} already triggered in-memory. Skipping duplicate trigger.`)
        return false
      }

      const existingState = loadThumbnailJobState(projectDir)
      if (existingState && existingState.jobKey === jobKey) {
        if (existingState.status === 'completed' || existingState.status === 'generating') {
          logger.info(`[ThumbnailAutoTrigger] Job with key ${jobKey} is already ${existingState.status}. Skipping duplicate.`)
          return false
        }
      }

      // 5. Check if template is selected
      if (!settings.selectedTemplateId || !settings.templateSnapshot) {
        logger.warn(`[ThumbnailAutoTrigger] Automation enabled but no template selected for ${projectDir}. Setting status to needs-attention.`)
        const attentionState: ThumbnailJobState = existingState || createInitialThumbnailJobState({
          projectDir,
          renderOutputPath: renderPath,
          renderFileSize,
          renderMtimeMs,
          scriptHash,
          templateSnapshotHash,
          generationRound: round
        })
        attentionState.status = 'needs-attention'
        attentionState.warnings.push('No master prompt template selected. Please choose a template in Thumbnail Studio.')
        saveThumbnailJobStateAtomic(projectDir, attentionState)
        return false
      }

      // Mark triggered key
      this.triggeredKeys.add(jobKey)

      logger.info(`[ThumbnailAutoTrigger] Video completed. Spawning companion thumbnail generation for ${projectDir}...`)

      // Fire and forget without blocking
      void (async () => {
        try {
          await thumbnailOrchestrator.startJob({
            projectDir,
            renderOutputPath: renderPath,
            scriptPath: params.scriptPath,
            templateId: settings.selectedTemplateId,
            templateSnapshot: settings.templateSnapshot,
            generationRound: round
          })
        } catch (jobErr) {
          logger.error(`[ThumbnailAutoTrigger] Companion thumbnail run failed: ${jobErr}`)
          const state = loadThumbnailJobState(projectDir)
          if (state && state.status !== 'completed') {
            state.status = 'failed'
            state.errors.push(jobErr instanceof Error ? jobErr.message : String(jobErr))
            saveThumbnailJobStateAtomic(projectDir, state)
          }
        }
      })()

      return true
    } catch (outerErr) {
      // GUARANTEE: Never throw to caller, never disrupt video pipeline
      logger.error(`[ThumbnailAutoTrigger] Unexpected error in startIfEligible: ${outerErr}`)
      return false
    }
  }

  private findRenderOutput(projectDir: string): string | null {
    const candidates = [
      path.join(projectDir, 'output', 'final_video.mp4'),
      path.join(projectDir, 'output', 'video.mp4'),
      path.join(projectDir, 'output', 'render.mp4')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return null
  }

  private readScriptText(projectDir: string, customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      try {
        return fs.readFileSync(customPath, 'utf-8')
      } catch {
        // ignore
      }
    }
    const candidates = [
      path.join(projectDir, 'script.txt'),
      path.join(projectDir, 'inputs', 'script.txt'),
      path.join(projectDir, 'project-state.json'),
      path.join(projectDir, 'project.json')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        if (c.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(c, 'utf-8')
            const st = JSON.parse(raw) as { inputs?: { scriptPath?: string } }
            if (st?.inputs?.scriptPath && fs.existsSync(st.inputs.scriptPath)) {
              return fs.readFileSync(st.inputs.scriptPath, 'utf-8')
            }
          } catch {
            // ignore
          }
        } else {
          return fs.readFileSync(c, 'utf-8')
        }
      }
    }
    return ''
  }
}

export const thumbnailAutoTrigger = new ThumbnailAutoTrigger()
