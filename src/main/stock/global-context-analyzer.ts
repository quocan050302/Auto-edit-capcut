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
  const modelId = params.model ?? "gemini-3.8-flash"

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

  let rawJson = ""
  let aiError: string | null = null

  if (apiKey && apiKey.trim().length > 0) {
    progress("Analyzing full script for global context...", 0.05)
    try {
      const ai = new GoogleGenAI({ apiKey: apiKey.trim(), httpOptions: { apiVersion: "v1beta" } })
      const prompt = buildGeminiPrompt(fullText, projectId, language)
      const fallbackModels = [modelId, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-1.5-flash-latest"].filter((v, i, a) => a.indexOf(v) === i)
      const maxRetries = 3

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const currentModel = fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
        try {
          progress(attempt === 1
            ? `Sending full script to Gemini (${currentModel}) for global analysis...`
            : `Retry ${attempt}/${maxRetries} (${currentModel})...`, 0.05 + attempt * 0.15)
          const response = await ai.models.generateContent({
            model: currentModel,
            contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
            config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 }
          })
          rawJson = response.text ?? ""
          if (rawJson) break
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          aiError = msg
          logger.warn(`[GlobalContext] Gemini attempt ${attempt} failed: ${msg}`)

          // If authentication error or invalid key, stop retrying immediately
          if (msg.includes("401") || msg.includes("UNAUTHENTICATED") || msg.includes("API_KEY") || msg.includes("ACCESS_TOKEN_TYPE_UNSUPPORTED")) {
            break
          }

          const overloaded = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE")
          if (overloaded && attempt < maxRetries) {
            const wait = Math.min(attempt * 2, 6)
            for (let s = wait; s > 0; s--) {
              progress(`Gemini overloaded, retrying in ${s}s...`, 0.20)
              await new Promise((r) => setTimeout(r, 1000))
            }
            continue
          }
        }
      }
    } catch (outerErr: unknown) {
      aiError = outerErr instanceof Error ? outerErr.message : String(outerErr)
      logger.warn(`[GlobalContext] Gemini client initialization failed: ${aiError}`)
    }
  } else {
    logger.info("[GlobalContext] No Gemini API key provided, generating algorithmic script context")
  }

  let ctx: GlobalScriptContext
  if (rawJson) {
    try {
      const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
      ctx = JSON.parse(clean) as GlobalScriptContext
      ctx.modelUsed = modelId
    } catch {
      logger.warn("[GlobalContext] JSON parse failed, using fallback context")
      ctx = buildFallbackContext(projectId, language, fullText)
      ctx.modelUsed = "algorithmic (JSON parse fallback)"
    }
  } else {
    logger.warn(`[GlobalContext] AI analysis unavailable (${aiError ?? "No API Key"}), generating algorithmic script context`)
    progress("Gemini AI không phản hồi hoặc key lỗi. Tự động tạo phân tích bối cảnh từ kịch bản...", 0.70)
    ctx = buildFallbackContext(projectId, language, fullText)
    ctx.modelUsed = aiError ? "algorithmic (rule-based fallback)" : "algorithmic"
  }

  ctx.generatedAt = new Date().toISOString()
  ctx.version = 1
  ;(ctx as GlobalScriptContext & { _scriptHash: string })._scriptHash = hash

  fs.mkdirSync(join(projectDir, "analysis"), { recursive: true })
  fs.writeFileSync(contextPath, JSON.stringify(ctx, null, 2), "utf-8")
  logger.info("[GlobalContext] Saved", { subject: ctx.primarySubject, model: ctx.modelUsed })
  progress(`Global context ready — "${ctx.primarySubject}"`, 1.0)
  return ctx
}

function buildFallbackContext(projectId: string, language: string, text: string): GlobalScriptContext {
  const STOP_WORDS = new Set([
    "about", "above", "after", "again", "against", "all", "another", "any", "are", "aren't",
    "because", "been", "before", "being", "below", "between", "both", "but", "can", "cannot",
    "could", "couldn't", "did", "didn't", "does", "doesn't", "doing", "don't", "down", "during",
    "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't",
    "having", "here", "here's", "hers", "herself", "himself", "how", "how's", "into", "it's",
    "its", "itself", "let's", "more", "most", "mustn't", "myself", "never", "only", "other",
    "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "should",
    "shouldn't", "some", "such", "than", "that", "that's", "the", "their", "theirs", "them",
    "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
    "they've", "this", "those", "through", "until", "very", "was", "wasn't", "we'd", "we'll",
    "we're", "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's",
    "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would",
    "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself",
    "yourselves", "video", "channel", "going", "first", "today", "finally", "place", "entire",
    "exact", "thing", "things", "really", "almost", "turns", "right", "breakdown",
    // Vietnamese common stop words
    "những", "chúng", "trong", "người", "không", "được", "nhiều", "chính", "thực", "thấy",
    "video", "kênh", "hoặc", "cũng", "này", "đang", "phải", "theo", "cùng", "nhau"
  ])

  // Extract Capitalized Proper Nouns / Names (e.g. Hutterite, Canada)
  const properMatches = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []
  const properFreq: Record<string, number> = {}
  for (const p of properMatches) {
    const lower = p.toLowerCase()
    if (!STOP_WORDS.has(lower) && lower.length > 3) {
      properFreq[p] = (properFreq[p] ?? 0) + 1
    }
  }
  const topProper = Object.entries(properFreq).sort((a, b) => b[1] - a[1]).map(([w]) => w)

  // Frequency of all content words
  const words = text.split(/\s+/)
  const freq: Record<string, number> = {}
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z0-9à-ỹ]/g, "")
    if (clean.length > 3 && !STOP_WORDS.has(clean)) {
      freq[clean] = (freq[clean] ?? 0) + 1
    }
  }
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([w]) => w)

  // Derive primary subject
  const primarySubject = topProper[0] || topWords[0] || "Documentary Subject"
  const exactTopicAnchors = topProper.length > 0 ? topProper.slice(0, 5) : topWords.slice(0, 5)
  const contextualAnchors = topWords.filter((w) => !exactTopicAnchors.map((x) => x.toLowerCase()).includes(w)).slice(0, 8)

  // Sentences for synopsis & thesis
  const sentences = text.replace(/\n+/g, " ").split(/(?<=[.?!])\s+/).filter(Boolean)
  const centralThesis = sentences.slice(0, 2).join(" ") || text.slice(0, 250)
  const globalSynopsis = sentences.slice(0, 4).join(" ") || text.slice(0, 350)

  return {
    projectId,
    language,
    version: 1,
    generatedAt: new Date().toISOString(),
    modelUsed: "algorithmic-fallback",
    primarySubject,
    secondarySubjects: topWords.slice(1, 5),
    globalSynopsis,
    centralThesis,
    documentaryAngle: "observational documentary",
    targetAudience: "general audience",
    geography: {
      primaryCountry: "Not specified",
      secondaryLocations: []
    },
    timeContext: {
      primaryPeriod: "contemporary",
      historicalPeriods: []
    },
    communities: [],
    recurringPeople: [],
    visualWorld: {
      environment: [],
      architecture: [],
      clothing: [],
      occupations: [],
      machinery: [],
      recurringObjects: [],
      colorMood: "natural cinematics",
      documentaryStyle: "observational"
    },
    exactTopicAnchors,
    contextualAnchors,
    forbiddenSubstitutions: [],
    negativeKeywords: ["cartoon", "cgi", "animation", "vlog", "generic"],
    recurringVisualMotifs: [],
    storyArc: []
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
