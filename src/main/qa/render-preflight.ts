import { join, dirname } from 'path'
import * as fs from 'fs'
import type {
  RenderQaReport,
  RenderQaIssue,
  QaSeverity,
  CaptionPlan,
  ProductionIntelligenceSettings
} from '../../../shared/types'
import { flattenEditPlanScenes } from '../utils/scene-plan'
import { atomicWriteJson, readJsonSafe } from '../production-intelligence/json-store'
import { loadProductionSettings } from '../production-intelligence/production-settings'
import { resolveSceneMediaWithSource } from '../renderer'
import { probeMediaDetailed } from './frame-analysis'
import { logger } from '../logger'

export interface PreflightOptions {
  projectDir: string
  voiceoverPath?: string
  captionPlan?: CaptionPlan
  resolution?: { width: number; height: number }
  fps?: number
  strictMissingMedia?: boolean
  settings?: ProductionIntelligenceSettings
}

export async function runRenderPreflight(options: PreflightOptions): Promise<RenderQaReport> {
  const {
    projectDir,
    voiceoverPath,
    captionPlan,
    resolution = { width: 1920, height: 1080 },
    fps = 30
  } = options

  const prodSettings = options.settings ?? loadProductionSettings(projectDir)
  const strictMode = options.strictMissingMedia ?? prodSettings.strictMissingMedia ?? false

  const issues: RenderQaIssue[] = []
  let issueId = 1

  function addIssue(
    severity: QaSeverity,
    category: RenderQaIssue['category'],
    message: string,
    suggestion?: string,
    sceneId?: string,
    sceneIndex?: number,
    details?: Record<string, unknown>
  ): void {
    issues.push({
      id: `preflight_${issueId++}`,
      stage: 'preflight',
      severity,
      category,
      message,
      suggestion,
      sceneId,
      sceneIndex,
      details
    })
  }

  // 1. Output & Directory Checks
  const outputDir = join(projectDir, 'output')
  try {
    fs.mkdirSync(outputDir, { recursive: true })
    const testFile = join(outputDir, `.qa_write_test_${Date.now()}`)
    fs.writeFileSync(testFile, 'ok', 'utf-8')
    fs.unlinkSync(testFile)
  } catch (err) {
    addIssue('fatal', 'output', `Output directory is not writable: ${outputDir} (${String(err)})`, 'Check folder permissions')
  }

  if (resolution.width <= 0 || resolution.height <= 0 || fps <= 0) {
    addIssue('fatal', 'output', `Invalid render output configuration: ${resolution.width}x${resolution.height} @ ${fps}fps`, 'Use standard resolution (e.g. 1920x1080 @ 30fps)')
  }

  // 2. Plan Validation
  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) {
    addIssue('fatal', 'plan', 'master-edit-plan.json not found. Run AI Planning first.', 'Generate an edit plan in AI Planning step')
    return buildReport(0, 0, 0, issues)
  }

  let plan: Record<string, unknown>
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
  } catch (err) {
    addIssue('fatal', 'plan', `Failed to parse master-edit-plan.json: ${String(err)}`, 'Re-run AI Planning')
    return buildReport(0, 0, 0, issues)
  }

  const flattened = flattenEditPlanScenes<{
    narrativeText?: string
    visualIntent?: string
    startTime?: number
    endTime?: number
    duration?: number
    localPath?: string
    localAsset?: string
    mediaFile?: string
    mediaType?: 'video' | 'image'
    transitionIn?: string
  }>(plan)

  if (flattened.length === 0) {
    addIssue('fatal', 'plan', 'Edit plan contains 0 scenes.', 'Run AI Planning to generate scenes')
    return buildReport(0, 0, 0, issues)
  }

  // Check scene indices and ordering
  const seenIndices = new Set<number>()
  let expectedTotalDuration = 0

  for (let i = 0; i < flattened.length; i++) {
    const entry = flattened[i]
    const { scene, sceneIndex, sceneId } = entry

    if (seenIndices.has(sceneIndex)) {
      addIssue('fatal', 'plan', `Duplicate sceneIndex ${sceneIndex} detected.`, 'Ensure all scenes have unique scene indices', sceneId, sceneIndex)
    }
    seenIndices.add(sceneIndex)

    const dur = scene.duration ?? ((scene.endTime ?? 0) - (scene.startTime ?? 0))
    if (dur <= 0) {
      addIssue('fatal', 'plan', `Scene ${sceneIndex} has invalid duration: ${dur}s`, 'Ensure scene duration is greater than 0', sceneId, sceneIndex)
    } else {
      expectedTotalDuration += dur
    }
  }

  // 3. Media Resolution Checks
  let mediaIndex: Array<{ filename: string; path: string }> = []
  const mediaIndexPath = join(projectDir, 'analysis', 'media-index.json')
  if (fs.existsSync(mediaIndexPath)) {
    mediaIndex = readJsonSafe<Array<{ filename: string; path: string }>>(mediaIndexPath, [])
  }

  let resolvedScenesCount = 0
  let missingScenesCount = 0

  for (const entry of flattened) {
    const { scene, sceneIndex, sceneId } = entry
    const resolved = resolveSceneMediaWithSource(
      scene as Parameters<typeof resolveSceneMediaWithSource>[0],
      mediaIndex,
      projectDir
    )

    if (resolved.mediaPath && fs.existsSync(resolved.mediaPath) && fs.statSync(resolved.mediaPath).size > 0) {
      resolvedScenesCount++
      const probe = await probeMediaDetailed(resolved.mediaPath)
      if (probe) {
        if (probe.hasVideo && probe.durationSecs < (scene.duration ?? 2) * 0.5) {
          addIssue('warning', 'media', `Scene ${sceneIndex} video asset duration (${probe.durationSecs.toFixed(1)}s) is shorter than scene duration`, 'Stock video may loop or freeze', sceneId, sceneIndex)
        }
        if (probe.hasVideo && (probe.width < 720 || probe.height < 480)) {
          addIssue('warning', 'media', `Scene ${sceneIndex} has low resolution asset: ${probe.width}x${probe.height}`, 'Replace with higher quality footage in Stock Media', sceneId, sceneIndex)
        }
      }
    } else {
      missingScenesCount++
      const severity: QaSeverity = strictMode ? 'fatal' : 'warning'
      addIssue(
        severity,
        'media',
        `Scene ${sceneIndex} media is missing (${resolved.source}). ${strictMode ? 'Strict mode on: render blocked.' : 'Black placeholder fallback will be used.'}`,
        'Search or upload media in Stock Media tab',
        sceneId,
        sceneIndex
      )
    }
  }

  // If 100% of scenes are missing media, fatal even with strict mode off
  if (resolvedScenesCount === 0 && flattened.length > 0) {
    addIssue('fatal', 'media', 'All scenes are missing media files. Cannot render video without footage.', 'Run Stock Media search or upload media')
  }

  // 4. Audio Checks
  if (voiceoverPath) {
    if (!fs.existsSync(voiceoverPath) || fs.statSync(voiceoverPath).size === 0) {
      addIssue('fatal', 'audio', `Specified voiceover file not found or empty: ${voiceoverPath}`, 'Check Voiceover path in Inputs step')
    } else {
      const voProbe = await probeMediaDetailed(voiceoverPath)
      if (!voProbe || !voProbe.hasAudio) {
        addIssue('warning', 'audio', 'Voiceover file could not be verified as valid audio stream', 'Check audio format')
      }
    }
  }

  const audioPlanPath = join(projectDir, 'analysis', 'audio-plan.json')
  if (fs.existsSync(audioPlanPath)) {
    const audioPlan = readJsonSafe<{ musicTrack?: { filePath?: string }; sfxCues?: Array<{ filePath?: string }> }>(audioPlanPath, {})
    if (audioPlan.musicTrack?.filePath && !fs.existsSync(audioPlan.musicTrack.filePath)) {
      addIssue('warning', 'audio', `Approved background music file missing: ${audioPlan.musicTrack.filePath}`, 'Check audio library')
    }
  }

  // 5. Captions & Overlays Checks
  if (captionPlan?.enabled && captionPlan.phrases) {
    for (const phrase of captionPlan.phrases) {
      if (phrase.startTime < 0 || phrase.endTime < 0 || phrase.endTime < phrase.startTime) {
        addIssue('warning', 'caption', `Caption phrase "${phrase.text.slice(0, 30)}" has invalid timing: ${phrase.startTime}s - ${phrase.endTime}s`, 'Adjust timing in Captions step')
      }
      if (expectedTotalDuration > 0 && phrase.startTime > expectedTotalDuration + 2) {
        addIssue('warning', 'caption', `Caption phrase starts after video ends (${phrase.startTime.toFixed(1)}s > ${expectedTotalDuration.toFixed(1)}s)`, 'Trim caption plan')
      }
    }
  }

  // 6. Transition Checks
  for (const entry of flattened) {
    const { scene, sceneIndex, sceneId } = entry
    if (scene.transitionIn && scene.transitionIn !== 'none' && scene.transitionIn !== 'cut') {
      const dur = scene.duration ?? ((scene.endTime ?? 0) - (scene.startTime ?? 0))
      if (dur < 1.0) {
        addIssue('info', 'transition', `Scene ${sceneIndex} is short (${dur.toFixed(1)}s). Transition will automatically fallback to clean cut.`, undefined, sceneId, sceneIndex)
      }
    }
  }

  const report = buildReport(expectedTotalDuration, flattened.length, resolvedScenesCount, issues)

  // Persist preflight report atomically to analysis/render-preflight.json
  const reportPath = join(projectDir, 'analysis', 'render-preflight.json')
  atomicWriteJson(reportPath, report)
  logger.info(`[QA-Preflight] Status: ${report.status} (${report.fatalCount} fatal, ${report.warningCount} warning, ${report.infoCount} info)`)

  return report
}

function buildReport(
  expectedDuration: number,
  totalScenes: number,
  resolvedScenes: number,
  issues: RenderQaIssue[]
): RenderQaReport {
  const fatalCount = issues.filter((i) => i.severity === 'fatal').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length
  const infoCount = issues.filter((i) => i.severity === 'info').length

  let status: RenderQaReport['status'] = 'passed'
  if (fatalCount > 0) {
    status = 'failed'
  } else if (warningCount > 0) {
    status = 'passed_with_warnings'
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status,
    expectedDuration: Math.round(expectedDuration * 100) / 100,
    totalScenes,
    resolvedScenes,
    missingScenes: totalScenes - resolvedScenes,
    fatalCount,
    warningCount,
    infoCount,
    issues
  }
}
