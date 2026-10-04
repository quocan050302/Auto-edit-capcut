import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { logger } from '../logger'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import {
  classifyGeminiErrorKind,
  normalizePreferredTextModel
} from '../utils/gemini-fallback'
import { getModelRoute } from '../ai/model-router'
import {
  recordModelRateLimit,
  recordModelUnavailable,
  recordModelSuccess,
  recordModelFailure
} from '../ai/model-health'
import { thumbnailTemplateStore } from './thumbnail-template-store'
import { loadProjectThumbnailSettings } from './thumbnail-settings-manager'
import type {
  ThumbnailPlan,
  ThumbnailPlanOption,
  ThumbnailPlanScriptInsight
} from '../../../shared/types'

export interface ThumbnailPlannerParams {
  projectDir: string
  templateId?: string
  templateSnapshot?: string
  generationRound?: number
  previousConcepts?: string
  preferredModel?: string
  apiKeyOverride?: string
}

export function getThumbnailPlanPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'thumbnail-plan.json')
}

export function cleanJsonFence(raw: string): string {
  if (!raw) return ''
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

export function validateThumbnailPlanSchema(obj: unknown): { valid: boolean; error?: string; plan?: ThumbnailPlan } {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, error: 'Output must be a JSON object' }
  }

  const p = obj as Record<string, unknown>

  // Validate scriptInsight
  if (!p.scriptInsight || typeof p.scriptInsight !== 'object') {
    return { valid: false, error: 'Missing "scriptInsight" object in response' }
  }
  const insight = p.scriptInsight as Record<string, unknown>
  if (typeof insight.mainTopic !== 'string' || !insight.mainTopic.trim()) {
    return { valid: false, error: 'scriptInsight.mainTopic is missing or empty' }
  }

  // Validate options array
  if (!Array.isArray(p.options)) {
    return { valid: false, error: '"options" must be an array' }
  }

  if (p.options.length !== 5) {
    return { valid: false, error: `Expected exactly 5 thumbnail options, got ${p.options.length}` }
  }

  const requiredIds = ['A', 'B', 'C', 'D', 'E'] as const
  const validatedOptions: ThumbnailPlanOption[] = []

  for (let i = 0; i < 5; i++) {
    const opt = p.options[i] as Record<string, unknown>
    const expectedId = requiredIds[i]

    if (!opt || typeof opt !== 'object') {
      return { valid: false, error: `Option at index ${i} is not a valid object` }
    }

    if (String(opt.id || '').toUpperCase() !== expectedId) {
      return { valid: false, error: `Option at index ${i} must have id "${expectedId}", got "${opt.id}"` }
    }

    const conceptName = typeof opt.conceptName === 'string' ? opt.conceptName.trim() : ''
    const yellowText = typeof opt.yellowText === 'string' ? opt.yellowText.trim() : ''
    const whiteText = typeof opt.whiteText === 'string' ? opt.whiteText.trim() : ''
    const visualConcept = typeof opt.visualConcept === 'string' ? opt.visualConcept.trim() : ''
    const imagePrompt = typeof opt.imagePrompt === 'string' ? opt.imagePrompt.trim() : ''
    const titleClear = typeof opt.titleClear === 'string' ? opt.titleClear.trim() : ''
    const titleCuriosity = typeof opt.titleCuriosity === 'string' ? opt.titleCuriosity.trim() : ''
    const whyItWorks = typeof opt.whyItWorks === 'string' ? opt.whyItWorks.trim() : ''

    if (!conceptName) return { valid: false, error: `Option ${expectedId}: conceptName cannot be empty` }
    if (!yellowText) return { valid: false, error: `Option ${expectedId}: yellowText cannot be empty` }
    if (!whiteText) return { valid: false, error: `Option ${expectedId}: whiteText cannot be empty` }
    if (!imagePrompt) return { valid: false, error: `Option ${expectedId}: imagePrompt cannot be empty` }
    if (imagePrompt.toLowerCase().includes('same as above')) {
      return { valid: false, error: `Option ${expectedId}: imagePrompt cannot reference previous option or use "same as above"` }
    }

    validatedOptions.push({
      id: expectedId,
      conceptName,
      yellowText,
      whiteText,
      visualConcept,
      imagePrompt,
      titleClear,
      titleCuriosity,
      whyItWorks
    })
  }

  const scriptInsight: ThumbnailPlanScriptInsight = {
    mainTopic: String(insight.mainTopic || '').trim(),
    groundedHook: String(insight.groundedHook || '').trim(),
    strongestVisualDetail: String(insight.strongestVisualDetail || '').trim(),
    viewerConcernOrGoal: String(insight.viewerConcernOrGoal || '').trim(),
    unsupportedClaimsToAvoid: Array.isArray(insight.unsupportedClaimsToAvoid)
      ? (insight.unsupportedClaimsToAvoid as unknown[]).map(String)
      : []
  }

  const plan: ThumbnailPlan = {
    scriptInsight,
    options: validatedOptions,
    recommendedOptionId: String(p.recommendedOptionId || 'A').toUpperCase(),
    recommendationReason: String(p.recommendationReason || ''),
    postGenerationCheck: String(p.postGenerationCheck || '')
  }

  return { valid: true, plan }
}

export function substituteTemplateVariables(templateText: string, vars: {
  script: string
  videoTitle?: string
  globalVisualContext?: string
  variantCount?: number
  previousConcepts?: string
  outputLanguage?: string
}): string {
  let prompt = templateText

  prompt = prompt.replace(/\{\{SCRIPT\}\}/g, vars.script || '')
  prompt = prompt.replace(/\{\{VIDEO_TITLE\}\}/g, vars.videoTitle || 'Untitled Documentary')
  prompt = prompt.replace(/\{\{GLOBAL_VISUAL_CONTEXT\}\}/g, vars.globalVisualContext || 'None specified')
  prompt = prompt.replace(/\{\{VARIANT_COUNT\}\}/g, String(vars.variantCount || 5))
  prompt = prompt.replace(/\{\{PREVIOUS_CONCEPTS\}\}/g, vars.previousConcepts || 'None')
  prompt = prompt.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, vars.outputLanguage || 'en-US')

  // Enforce exactly 5 options wrapper if prompt somehow missed {{VARIANT_COUNT}}
  if (!templateText.includes('{{VARIANT_COUNT}}') && !prompt.includes('exactly 5')) {
    prompt += '\n\nIMPORTANT SYSTEM REQUIREMENT: You MUST generate exactly 5 distinct options with IDs A, B, C, D, and E.'
  }

  return prompt
}

export class ThumbnailPlanner {
  public async plan(params: ThumbnailPlannerParams): Promise<ThumbnailPlan> {
    const { projectDir } = params

    // 1. Read script file
    const script = this.readScript(projectDir)
    if (!script || !script.trim()) {
      throw new Error(`Cannot plan thumbnails: script file is missing or empty in project "${projectDir}"`)
    }

    // 2. Read context & settings
    const settings = await loadProjectThumbnailSettings(projectDir)
    const globalContext = this.readGlobalContext(projectDir)

    // 3. Resolve template prompt snapshot
    let templatePrompt = params.templateSnapshot || settings.templateSnapshot
    if (!templatePrompt) {
      if (settings.selectedTemplateId) {
        const tpl = await thumbnailTemplateStore.getById(settings.selectedTemplateId)
        if (tpl) templatePrompt = tpl.promptText
      }
      if (!templatePrompt) {
        const defTpl = await thumbnailTemplateStore.getDefault()
        templatePrompt = defTpl.promptText
      }
    }

    // 4. Substitute variables
    const prompt = substituteTemplateVariables(templatePrompt, {
      script,
      videoTitle: settings.existingVideoTitle,
      globalVisualContext: globalContext,
      variantCount: 5,
      previousConcepts: params.previousConcepts,
      outputLanguage: settings.outputLanguage || 'en-US'
    })

    // 5. Setup AI model router and Gemini client
    const config = loadConfig()
    const apiKey = normalizeApiKey(params.apiKeyOverride || config.geminiApiKey || process.env.GEMINI_API_KEY)
    if (!apiKey) {
      throw new Error('THUMBNAIL_PLAN_INVALID: Gemini API key is missing. Please set your Gemini API key in Settings.')
    }

    const ai = new GoogleGenAI({ apiKey })
    const candidateModels = getModelRoute('planning', params.preferredModel || config.preferredModel)

    let rawOutput = ''
    let usedModel = ''
    let lastError = ''

    for (const modelId of candidateModels) {
      const normalized = normalizePreferredTextModel(modelId)
      try {
        logger.info(`[ThumbnailPlanner] Requesting 5 thumbnail concepts from ${normalized}...`)
        const response = await ai.models.generateContent({
          model: normalized,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 8192
          }
        })

        const text = response.text || ''
        if (text.trim()) {
          rawOutput = text
          usedModel = normalized
          recordModelSuccess(normalized)
          break
        }
      } catch (err) {
        const classified = classifyGeminiErrorKind(err)
        recordModelFailure(normalized, classified.kind)
        lastError = classified.message
        logger.warn(`[ThumbnailPlanner] Model ${normalized} failed: ${classified.message}`)

        if (classified.kind === 'RATE_LIMIT') {
          recordModelRateLimit(normalized)
        } else if (classified.kind === 'SERVICE_UNAVAILABLE') {
          recordModelUnavailable(normalized)
        }
      }
    }

    if (!rawOutput) {
      throw new Error(`THUMBNAIL_PLAN_INVALID: All AI models failed to generate thumbnail plan. Last error: ${lastError}`)
    }

    // 6. Defensive parsing & Validation
    let parsed: unknown
    try {
      parsed = JSON.parse(cleanJsonFence(rawOutput))
    } catch (parseErr) {
      logger.warn(`[ThumbnailPlanner] Initial JSON parse failed: ${parseErr}. Attempting repair with ${usedModel}...`)
      rawOutput = await this.repairJson(ai, usedModel, rawOutput, String(parseErr))
      try {
        parsed = JSON.parse(cleanJsonFence(rawOutput))
      } catch (secondErr) {
        throw new Error(`THUMBNAIL_PLAN_INVALID: Model returned malformed JSON that could not be parsed: ${secondErr}`)
      }
    }

    let validation = validateThumbnailPlanSchema(parsed)
    if (!validation.valid) {
      logger.warn(`[ThumbnailPlanner] Schema validation failed: ${validation.error}. Attempting repair with ${usedModel}...`)
      rawOutput = await this.repairJson(ai, usedModel, rawOutput, validation.error || 'Invalid schema')
      try {
        parsed = JSON.parse(cleanJsonFence(rawOutput))
        validation = validateThumbnailPlanSchema(parsed)
      } catch (secondErr) {
        throw new Error(`THUMBNAIL_PLAN_INVALID: Repaired JSON failed to parse: ${secondErr}`)
      }
    }

    if (!validation.valid || !validation.plan) {
      throw new Error(`THUMBNAIL_PLAN_INVALID: ${validation.error || 'Failed schema validation'}`)
    }

    const finalPlan: ThumbnailPlan = {
      ...validation.plan,
      generatedAt: new Date().toISOString(),
      modelUsed: usedModel,
      generationRound: params.generationRound || 1
    }

    // 7. Save analysis/thumbnail-plan.json
    const outPath = getThumbnailPlanPath(projectDir)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(finalPlan, null, 2), 'utf-8')
    logger.info(`[ThumbnailPlanner] Successfully created and saved thumbnail plan to ${outPath}`)

    return finalPlan
  }

  private async repairJson(ai: GoogleGenAI, model: string, badJson: string, errorMsg: string): Promise<string> {
    const repairPrompt = `The previous JSON response for YouTube thumbnail plan was invalid.
Error reported: ${errorMsg}

Raw output:
${badJson.slice(0, 4000)}

Please output the corrected, valid JSON matching the exact schema with 5 options (A, B, C, D, E).
Return ONLY the raw JSON object. No markdown code fence. No commentary.`

    try {
      const resp = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192
        }
      })
      return resp.text || badJson
    } catch {
      return badJson
    }
  }

  private readScript(projectDir: string): string {
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
            const p = st?.inputs?.scriptPath
            if (p && fs.existsSync(p)) {
              return fs.readFileSync(p, 'utf-8')
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

  private readGlobalContext(projectDir: string): string {
    const candidates = [
      path.join(projectDir, 'analysis', 'global-script-context.json'),
      path.join(projectDir, 'analysis', 'global-visual-context.json')
    ]

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try {
          return fs.readFileSync(c, 'utf-8')
        } catch {
          // ignore
        }
      }
    }
    return ''
  }
}

export const thumbnailPlanner = new ThumbnailPlanner()
