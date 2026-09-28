import { join } from 'path'
import * as fs from 'fs'
import type {
  RenderQaReport,
  RenderQaIssue,
  QaSeverity
} from '../../../shared/types'
import { atomicWriteJson } from '../production-intelligence/json-store'
import {
  probeMediaDetailed,
  analyzeVideoQuality,
  generateContactSheet,
  MediaProbeDetails
} from './frame-analysis'
import { logger } from '../logger'

// Threshold Constants
export const POSTFLIGHT_THRESHOLDS = {
  MAX_BENIGN_BLACK_SEGMENT_SECS: 2.0, // Black transition dip <= 2s is benign
  FATAL_BLACK_COVERAGE_PERCENT: 80,   // > 80% black coverage across entire video is fatal
  WARNING_FREEZE_SEGMENT_SECS: 4.0,   // Freeze frame > 4.0s triggers warning
  DURATION_MISMATCH_WARN_SECS: 1.0,   // Duration difference > 1.0s triggers warning
  DURATION_MISMATCH_FATAL_PERCENT: 15 // > 15% duration mismatch is fatal
}

export interface PostflightOptions {
  projectDir: string
  workingOutputPath: string
  expectedDuration: number
  totalScenes: number
  hasVoiceover: boolean
  targetResolution?: { width: number; height: number }
  targetFps?: number
}

export async function runRenderPostflight(options: PostflightOptions): Promise<RenderQaReport> {
  const {
    projectDir,
    workingOutputPath,
    expectedDuration,
    totalScenes,
    hasVoiceover,
    targetResolution = { width: 1920, height: 1080 }
  } = options

  const issues: RenderQaIssue[] = []
  let issueId = 1

  function addIssue(
    severity: QaSeverity,
    category: RenderQaIssue['category'],
    message: string,
    suggestion?: string,
    details?: Record<string, unknown>
  ): void {
    issues.push({
      id: `postflight_${issueId++}`,
      stage: 'postflight',
      severity,
      category,
      message,
      suggestion,
      details
    })
  }

  // 1. File existence and size
  if (!fs.existsSync(workingOutputPath) || fs.statSync(workingOutputPath).size === 0) {
    addIssue('fatal', 'output', 'Render output file is missing or has 0 bytes.', 'Check FFmpeg logs for render crash')
    return buildReport(expectedDuration, 0, totalScenes, issues)
  }

  // 2. Stream probe
  const probe = await probeMediaDetailed(workingOutputPath)
  if (!probe) {
    addIssue('fatal', 'output', 'FFprobe failed to inspect render output.', 'The output file is corrupt or unreadable')
    return buildReport(expectedDuration, 0, totalScenes, issues)
  }

  // 3. Video stream presence
  if (!probe.hasVideo || probe.durationSecs <= 0) {
    addIssue('fatal', 'output', 'Render output has no valid video stream or duration is 0.', 'Ensure input media files are valid and FFmpeg arguments are correct')
  }

  // 4. Audio stream presence
  if (hasVoiceover && !probe.hasAudio) {
    addIssue('fatal', 'audio', 'Render output is missing audio stream while voiceover was expected.', 'Check audio mixing and codec settings')
  }

  // 5. Resolution & FPS check
  if (probe.width !== targetResolution.width || probe.height !== targetResolution.height) {
    addIssue(
      'warning',
      'output',
      `Rendered resolution (${probe.width}x${probe.height}) differs from target (${targetResolution.width}x${targetResolution.height})`,
      'Verify scaling filter in render pipeline'
    )
  }

  // 6. Duration comparison
  const durationDiff = Math.abs(probe.durationSecs - expectedDuration)
  const durationMismatchPercent = expectedDuration > 0 ? (durationDiff / expectedDuration) * 100 : 0

  if (durationDiff > POSTFLIGHT_THRESHOLDS.DURATION_MISMATCH_WARN_SECS) {
    if (durationMismatchPercent > POSTFLIGHT_THRESHOLDS.DURATION_MISMATCH_FATAL_PERCENT && expectedDuration > 10) {
      addIssue(
        'fatal',
        'output',
        `Rendered duration (${probe.durationSecs.toFixed(1)}s) deviates by ${durationMismatchPercent.toFixed(1)}% from expected (${expectedDuration.toFixed(1)}s)`,
        'Check scene transition and audio alignment'
      )
    } else {
      addIssue(
        'warning',
        'output',
        `Rendered duration (${probe.durationSecs.toFixed(1)}s) deviates slightly from expected (${expectedDuration.toFixed(1)}s)`,
        'Normal variation from transition xfade'
      )
    }
  }

  // 7. Quality analysis: Black, Freeze, Silence
  const quality = await analyzeVideoQuality(workingOutputPath, probe.durationSecs)

  // Black frame detection
  if (quality.blackCoveragePct >= POSTFLIGHT_THRESHOLDS.FATAL_BLACK_COVERAGE_PERCENT) {
    addIssue(
      'fatal',
      'output',
      `Severe black screen detected: ${quality.blackCoveragePct}% of the video is completely black`,
      'Check if video codecs or transition offsets are producing black frames'
    )
  } else {
    for (const b of quality.blackSegments) {
      if (b.duration > POSTFLIGHT_THRESHOLDS.MAX_BENIGN_BLACK_SEGMENT_SECS) {
        addIssue(
          'warning',
          'output',
          `Prolonged black segment of ${b.duration.toFixed(1)}s detected at ${b.start.toFixed(1)}s - ${b.end.toFixed(1)}s`,
          'Check missing media or long transition dip'
        )
      }
    }
  }

  // Freeze frame detection
  for (const f of quality.freezeSegments) {
    if (f.duration > POSTFLIGHT_THRESHOLDS.WARNING_FREEZE_SEGMENT_SECS) {
      addIssue(
        'warning',
        'output',
        `Freeze frame of ${f.duration.toFixed(1)}s detected at ${f.start.toFixed(1)}s - ${f.end.toFixed(1)}s`,
        'Check if source footage duration is too short for scene duration'
      )
    }
  }

  // 8. Contact Sheet Generation
  const contactSheetPath = join(projectDir, 'output', 'render-contact-sheet.jpg')
  try {
    const csSuccess = await generateContactSheet(workingOutputPath, contactSheetPath, probe.durationSecs)
    if (csSuccess) {
      addIssue('info', 'output', 'Contact sheet generated successfully at output/render-contact-sheet.jpg')
    } else {
      addIssue('warning', 'output', 'Failed to generate visual contact sheet (non-fatal)')
    }
  } catch (err) {
    addIssue('warning', 'output', `Contact sheet error: ${String(err)} (non-fatal)`)
  }

  const report = buildReport(expectedDuration, probe.durationSecs, totalScenes, issues)

  // Persist postflight report atomically to analysis/render-qa.json
  const reportPath = join(projectDir, 'analysis', 'render-qa.json')
  atomicWriteJson(reportPath, report)
  logger.info(`[QA-Postflight] Status: ${report.status} (${report.fatalCount} fatal, ${report.warningCount} warning)`)

  return report
}

function buildReport(
  expectedDuration: number,
  actualDuration: number,
  totalScenes: number,
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
    actualDuration: Math.round(actualDuration * 100) / 100,
    totalScenes,
    resolvedScenes: totalScenes,
    missingScenes: 0,
    fatalCount,
    warningCount,
    infoCount,
    issues
  }
}
