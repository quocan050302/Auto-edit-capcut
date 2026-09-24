import { GoogleGenAI } from "@google/genai"
import * as fs from "fs"
import { join } from "path"
import { createHash } from "crypto"
import { logger } from "../logger"
import type { GlobalScriptContext, TranscriptResult } from "../../../shared/types"

export type ProgressCallback = (msg: string, pct: number) => void

export function getContextPath(projectDir: string): string {
  return join(projectDir, "analysis", "global-script-context.json")
}

function scriptHash(text: string): string {
  return createHash("md5").update(text).digest("hex").slice(0, 16)
}

const SYSTEM_PROMPT = `You are the Context-Aware Visual Research Engine for a long-form documentary.
Analyze the ENTIRE script and produce a GlobalScriptContext JSON object used by every scene to generate stock-media search queries.
Rules:
- Identify primary subject, central thesis, geography, time period, communities from the script.
- List exactTopicAnchors (proper nouns) that MUST appear in exact-match queries.
- List contextualAnchors (broader descriptors) for when exact results are unavailable.
- List forbiddenSubstitutions (visually similar but factually wrong subjects).
- List negativeKeywords (terms that would return wrong stock).
- Map the storyArc per chapter.
- Do NOT invent facts not in the script.
- Return ONLY valid JSON. No markdown. No explanation.`

function buildGeminiPrompt(fullScriptText: string, projectId: string, language: string): string {
  return `FULL SCRIPT (analyze completely before responding):
---
${fullScriptText.slice(0, 40000)}
---
PROJECT ID: ${projectId}
LANGUAGE: ${language}

Return ONLY valid JSON matching this schema:
{
  "projectId": "${projectId}",
  "language": "${language}",
  "version": 1,
  "primarySubject": "the single most important subject",
  "secondarySubjects": ["string"],
  "globalSynopsis": "2-3 sentence summary",
  "centralThesis": "the main argument",
  "documentaryAngle": "journalistic angle",
  "targetAudience": "audience description",
  "geography": { "primaryCountry": null, "primaryRegion": null, "secondaryLocations": [] },
  "timeContext": { "primaryPeriod": "contemporary", "historicalPeriods": [] },
  "communities": [{ "name": "name", "role": "protagonist", "visualDescription": "desc", "mustNotConfuseWith": [] }],
  "recurringPeople": [{ "id": "p1", "role": "narrator", "ageRange": null, "gender": null, "appearance": null, "clothing": null }],
  "visualWorld": { "environment": [], "architecture": [], "clothing": [], "occupations": [], "machinery": [], "recurringObjects": [], "colorMood": "natural", "documentaryStyle": "observational" },
  "exactTopicAnchors": [],
  "contextualAnchors": [],
  "forbiddenSubstitutions": [],
  "negativeKeywords": [],
  "recurringVisualMotifs": [],
  "storyArc": [{ "chapterId": "CH1", "title": "title", "purpose": "purpose", "startText": "first words", "endText": "last words" }]
}`
}

export async function analyzeGlobalContext(params: {
  projectDir: string
  apiKey: string
  model?: string
  scriptText?: string | null
  transcript?: TranscriptResult | null
  forceRegenerate?: boolean
  onProgress?: ProgressCallback
}): Promise<GlobalScriptContext> {
  const { projectDir, apiKey, forceRegenerate = false } = params
  const progress = params.onProgress ?? (() => {})
  const modelId = params.model ?? "gemini-2.0-flash"

  const fullText = params.scriptText
    ?? params.transcript?.fullText
    ?? params.transcript?.segments.map((s) => s.text).join(" ")
    ?? ""

  if (!fullText.trim()) throw new Error("No script or transcript text for global context analysis.")

  let projectId = "unknown"
  const language = params.transcript?.language ?? "en"
  try {
    const stateFile = fs.existsSync(join(projectDir, "project-state.json"))
      ? join(projectDir, "project-state.json") : join(projectDir, "project.json")
    const st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    projectId = st?.id ?? st?.name ?? "unknown"
  } catch { /* ignore */ }

  const contextPath = getContextPath(projectDir)
  const hash = scriptHash(fullText)

  if (!forceRegenerate && fs.existsSync(contextPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(contextPath, "utf-8")) as GlobalScriptContext & { _scriptHash?: string }
      if (cached._scriptHash === hash) {
        logger.info("[GlobalContext] Cache hit")
        progress("Using cached global script context...", 1.0)
        return cached
      }
    } catch { /* regenerate */ }
  }

  progress("Analyzing full script for global context...", 0.05)
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } })
  const prompt = buildGeminiPrompt(fullText, projectId, language)
  const fallbackModels = [modelId, "gemini-2.0-flash", "gemini-1.5-flash"].filter((v, i, a) => a.indexOf(v) === i)
  let rawJson = ""
  const maxRetries = 5

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const currentModel = fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
    try {
      progress(attempt === 1
        ? `Sending full script to Gemini (${currentModel}) for global analysis...`
        : `Retry ${attempt}/${maxRetries} (${currentModel})...`, 0.05 + attempt * 0.10)
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 }
      })
      rawJson = response.text ?? ""
      break
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const overloaded = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE")
      if (overloaded && attempt < maxRetries) {
        const wait = Math.min(attempt * 3, 12)
        for (let s = wait; s > 0; s--) {
          progress(`Gemini overloaded, retrying in ${s}s...`, 0.20)
          await new Promise((r) => setTimeout(r, 1000))
        }
        continue
      }
      throw new Error(`Global context analysis failed: ${msg}`)
    }
  }

  let ctx: GlobalScriptContext
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
    ctx = JSON.parse(clean) as GlobalScriptContext
  } catch {
    logger.warn("[GlobalContext] JSON parse failed, using fallback context")
    ctx = buildFallbackContext(projectId, language, fullText)
  }

  ctx.generatedAt = new Date().toISOString()
  ctx.modelUsed = modelId
  ctx.version = 1
  ;(ctx as GlobalScriptContext & { _scriptHash: string })._scriptHash = hash

  fs.mkdirSync(join(projectDir, "analysis"), { recursive: true })
  fs.writeFileSync(contextPath, JSON.stringify(ctx, null, 2), "utf-8")
  logger.info("[GlobalContext] Saved", { subject: ctx.primarySubject })
  progress(`Global context ready -- "${ctx.primarySubject}"`, 1.0)
  return ctx
}

function buildFallbackContext(projectId: string, language: string, text: string): GlobalScriptContext {
  const words = text.split(/\s+/).filter((w) => w.length > 4)
  const freq: Record<string, number> = {}
  for (const w of words) {
    const key = w.toLowerCase().replace(/[^a-z]/g, "")
    if (key) freq[key] = (freq[key] ?? 0) + 1
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w)
  return {
    projectId, language, version: 1,
    generatedAt: new Date().toISOString(), modelUsed: "fallback",
    primarySubject: top[0] ?? "documentary subject",
    secondarySubjects: top.slice(1, 4),
    globalSynopsis: text.slice(0, 200), centralThesis: "See script",
    documentaryAngle: "documentary", targetAudience: "general audience",
    geography: { secondaryLocations: [] },
    timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
    communities: [], recurringPeople: [],
    visualWorld: { environment: [], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "observational" },
    exactTopicAnchors: top.slice(0, 3), contextualAnchors: top.slice(3, 6),
    forbiddenSubstitutions: [], negativeKeywords: [], recurringVisualMotifs: [], storyArc: []
  }
}

export function loadGlobalContext(projectDir: string): GlobalScriptContext | null {
  const p = getContextPath(projectDir)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as GlobalScriptContext }
  catch { return null }
}

export function saveGlobalContext(projectDir: string, ctx: GlobalScriptContext): void {
  const p = getContextPath(projectDir)
  fs.mkdirSync(join(projectDir, "analysis"), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(ctx, null, 2), "utf-8")
}
