/**
 * Smart Audio Director — Core Engine
 *
 * Pipeline:
 *  1. Load master-edit-plan.json → flatten all scenes
 *  2. Analyse narration + visual intent per scene → cluster into narrative sections
 *  3. For each section: search Openverse for a music track
 *  4. Per-scene SFX pass: search for action-specific sound effects
 *  5. Download approved audio, save manifest
 *  6. Write audio-plan.json (sections + sfx assignments) for render + preview
 */

import { join, basename, extname } from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import { logger } from '../logger'
import { openverseSearchAudio } from './openverse'
import type {
  AudioSearchResult,
  AudioSection,
  AudioSfxAssignment,
  AudioPlan,
  AudioRunResult
} from '../../../shared/types'

export type AudioProgressCallback = (msg: string, pct: number) => void

// ─── Scene data shapes ────────────────────────────────────────────────────────

interface ScenePlan {
  sceneIndex: number
  narrativeText?: string
  visualIntent?: string
  startTime: number
  endTime: number
  duration: number
  [key: string]: unknown
}

interface EditPlan {
  chapters: Array<{
    title?: string
    mood?: string
    sequences?: Array<{ scenes?: ScenePlan[] }>
    chapters_seq?: Array<{ scenes?: ScenePlan[] }>
  }>
  [key: string]: unknown
}

function flattenScenes(plan: EditPlan): ScenePlan[] {
  return plan.chapters
    .flatMap((ch) => ch.chapters_seq ?? ch.sequences ?? [])
    .flatMap((seq: { scenes?: ScenePlan[] }) => seq.scenes ?? [])
}

// ─── Narrative Section Grouper ────────────────────────────────────────────────

/**
 * Groups scenes into musical "sections" based on chapters.
 * Each chapter becomes one music section (one background track).
 * Scenes without chapter context get grouped by time-proximity (60 s windows).
 */
function groupScenesIntoSections(plan: EditPlan): Array<{
  sectionLabel: string
  mood: string
  narrativeSummary: string
  scenes: ScenePlan[]
  startTime: number
  endTime: number
}> {
  const sections: ReturnType<typeof groupScenesIntoSections> = []

  for (const ch of plan.chapters) {
    const scenes = (ch.chapters_seq ?? ch.sequences ?? [])
      .flatMap((seq: { scenes?: ScenePlan[] }) => seq.scenes ?? [])

    if (scenes.length === 0) continue

    const startTime = Math.min(...scenes.map((s) => s.startTime))
    const endTime = Math.max(...scenes.map((s) => s.endTime))
    const narrativeSummary = scenes
      .map((s) => s.narrativeText ?? s.visualIntent ?? '')
      .filter(Boolean)
      .join('. ')
      .slice(0, 300)

    sections.push({
      sectionLabel: ch.title ?? `Section ${sections.length + 1}`,
      mood: ch.mood ?? 'neutral',
      narrativeSummary,
      scenes,
      startTime,
      endTime
    })
  }

  // Fallback: single section for all scenes if no chapters found
  if (sections.length === 0) {
    const allScenes = flattenScenes(plan)
    if (allScenes.length > 0) {
      sections.push({
        sectionLabel: 'Main',
        mood: 'neutral',
        narrativeSummary: allScenes
          .map((s) => s.narrativeText ?? '')
          .filter(Boolean)
          .join('. ')
          .slice(0, 300),
        scenes: allScenes,
        startTime: allScenes[0].startTime,
        endTime: allScenes[allScenes.length - 1].endTime
      })
    }
  }

  return sections
}

// ─── Music query builder ──────────────────────────────────────────────────────

function buildMusicQuery(mood: string, _narrativeSummary: string, _sectionLabel: string): string[] {
  // Short, simple queries work best on Openverse's music category
  const moodMap: Record<string, string[]> = {
    tense:         ['dramatic tension', 'suspense', 'thriller'],
    emotional:     ['emotional piano', 'sad piano', 'cinematic emotional'],
    inspirational: ['uplifting', 'motivational', 'inspiring'],
    peaceful:      ['calm ambient', 'peaceful', 'relaxing'],
    dramatic:      ['cinematic epic', 'dramatic orchestral', 'epic'],
    melancholic:   ['melancholic', 'sad ambient', 'nostalgic'],
    hopeful:       ['hopeful', 'uplifting acoustic', 'positive'],
    neutral:       ['ambient', 'background music', 'instrumental'],
    action:        ['action', 'driving', 'energetic'],
    mysterious:    ['mysterious', 'dark ambient', 'eerie']
  }

  const queries = moodMap[mood.toLowerCase()] ?? moodMap.neutral
  return queries
}

// ─── SFX query builder ────────────────────────────────────────────────────────

function buildSfxQuery(visualIntent: string): string | null {
  const text = (visualIntent ?? '').toLowerCase()

  // Match common visual actions to SFX
  const patterns: Array<[RegExp, string]> = [
    [/crowd|audience|people|group/i, 'crowd ambience'],
    [/rain|storm|thunder/i, 'rain storm sound'],
    [/ocean|sea|wave|beach/i, 'ocean waves'],
    [/forest|bird|nature|park/i, 'forest nature ambience'],
    [/city|traffic|urban|street/i, 'city street ambience'],
    [/wind|breeze/i, 'wind sound effect'],
    [/fire|flame/i, 'fire crackling'],
    [/music|concert|instrument/i, 'live music crowd'],
    [/whisper|quiet|silence/i, 'subtle ambient'],
    [/footstep|walk|run/i, 'footsteps walking'],
    [/door|enter|exit/i, 'door sound effect'],
    [/phone|call|ring/i, 'phone notification'],
    [/car|vehicle|drive/i, 'car engine driving'],
    [/explosion|crash|impact/i, 'impact crash sound'],
    [/water|river|stream/i, 'flowing water stream']
  ]

  for (const [pattern, sfxQuery] of patterns) {
    if (pattern.test(text)) return sfxQuery
  }

  return null // no relevant SFX for this scene
}

// ─── Audio downloader ─────────────────────────────────────────────────────────

async function downloadAudio(
  asset: AudioSearchResult,
  audioDir: string,
  timeoutMs = 45000
): Promise<string> {
  const ext = (asset.filetype ?? extname(asset.downloadUrl).slice(1)) || 'mp3'
  const filename = `${asset.audioType}_${asset.assetId.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.${ext}`
  const destPath = join(audioDir, filename)

  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return destPath

  // Follow redirects manually with proper timeout
  const fetchUrl = (url: string, redirectsLeft = 8): Promise<string> =>
    new Promise((resolve, reject) => {
      const u = new URL(url)
      const protocol = u.protocol === 'https:' ? https : http
      const req = protocol.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers: { 'User-Agent': 'VideoFactory/1.0' },
          timeout: timeoutMs
        },
        (res) => {
          // Follow redirects
          const loc = res.headers.location
          if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && loc) {
            res.resume()  // consume + discard the redirect body
            if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return }
            // Resolve relative redirects
            const nextUrl = loc.startsWith('http') ? loc : `${u.protocol}//${u.host}${loc}`
            fetchUrl(nextUrl, redirectsLeft - 1).then(resolve).catch(reject)
            return
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume()
            reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
            return
          }

          const tmp = destPath + '.tmp'
          const out = fs.createWriteStream(tmp)
          res.pipe(out)

          out.on('finish', () => {
            // Sanity check — make sure we got actual audio data
            const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0
            if (size < 1024) {
              fs.unlinkSync(tmp)
              reject(new Error(`Downloaded file too small (${size} bytes) — likely an error page`))
              return
            }
            fs.rename(tmp, destPath, (err) => {
              if (err) reject(err)
              else resolve(destPath)
            })
          })
          out.on('error', (err) => {
            try { fs.unlinkSync(tmp) } catch { /* ignore */ }
            reject(err)
          })
          res.on('error', (err) => {
            try { fs.unlinkSync(tmp) } catch { /* ignore */ }
            reject(err)
          })
        }
      )

      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Download timed out after ${timeoutMs}ms: ${url}`))
      })
      req.on('error', reject)
      req.end()
    })

  return fetchUrl(asset.downloadUrl)
}

// ─── Main engine ──────────────────────────────────────────────────────────────

export async function runAudioDirector(
  projectDir: string,
  onProgress: AudioProgressCallback = () => {},
  openverseToken?: string
): Promise<AudioRunResult> {
  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) {
    return { success: false, error: 'No edit plan found. Run AI Planning first.', sections: [], sfxAssignments: [] }
  }

  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
  const audioDir = join(projectDir, 'assets', 'audio')
  fs.mkdirSync(audioDir, { recursive: true })

  onProgress('Analysing narrative structure…', 0.05)
  const rawSections = groupScenesIntoSections(plan)
  logger.info(`[AudioDirector] Found ${rawSections.length} narrative sections`)

  const sections: AudioSection[] = []
  const sfxAssignments: AudioSfxAssignment[] = []

  // ── Music search pass ───────────────────────────────────────────────────────
  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i]
    const pct = 0.08 + (i / rawSections.length) * 0.50
    onProgress(`[${i + 1}/${rawSections.length}] Music search: "${sec.sectionLabel}"`, pct)

    const queries = buildMusicQuery(sec.mood, sec.narrativeSummary, sec.sectionLabel)

    const sectionDuration = sec.endTime - sec.startTime

    /** Pick best result from a list — prefer longer tracks that cover the section */
    const pickBest = (results: AudioSearchResult[]): AudioSearchResult | null => {
      if (results.length === 0) return null
      const sorted = results.sort((a, b) => {
        const aDiff = Math.abs((a.durationSecs || 120) - sectionDuration)
        const bDiff = Math.abs((b.durationSecs || 120) - sectionDuration)
        return aDiff - bDiff
      })
      return sorted[0]
    }

    let musicResult: AudioSearchResult | null = null

    // Pass 1: try each query WITH category=music
    for (const q of queries) {
      const results = await openverseSearchAudio(q, 'music', 6, openverseToken)
      const best = pickBest(results)
      if (best) {
        musicResult = { ...best, searchQuery: q }
        logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → "${q}" (music category): ${best.title}`)
        break
      }
    }

    // Pass 2: fallback — search WITHOUT category restriction
    if (!musicResult) {
      for (const q of queries) {
        const results = await openverseSearchAudio(q, undefined, 6, openverseToken)
        const best = pickBest(results)
        if (best) {
          musicResult = { ...best, searchQuery: q }
          logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → "${q}" (no category): ${best.title}`)
          break
        }
      }
    }

    // Pass 3: last resort — broad generic query
    if (!musicResult) {
      const results = await openverseSearchAudio('ambient background music', undefined, 6, openverseToken)
      const best = pickBest(results)
      if (best) {
        musicResult = { ...best, searchQuery: 'ambient background music' }
        logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → fallback generic: ${best.title}`)
      }
    }

    if (!musicResult) {
      logger.warn(`[AudioDirector] Section "${sec.sectionLabel}": no music found after all passes`)
    }

    const section: AudioSection = {
      sectionId: `section_${i}`,
      sectionLabel: sec.sectionLabel,
      mood: sec.mood,
      startTime: sec.startTime,
      endTime: sec.endTime,
      durationSecs: sec.endTime - sec.startTime,
      sceneIndexes: sec.scenes.map((s) => s.sceneIndex),
      musicCandidate: musicResult,
      approved: false,
      status: musicResult ? 'found' : 'failed'
    }

    sections.push(section)
  }

  // ── SFX pass ────────────────────────────────────────────────────────────────
  const allScenes = flattenScenes(plan)
  let sfxCount = 0

  for (let i = 0; i < allScenes.length; i++) {
    const scene = allScenes[i]
    const sfxQuery = buildSfxQuery(scene.visualIntent ?? scene.narrativeText ?? '')
    if (!sfxQuery) continue

    const pct = 0.60 + (i / allScenes.length) * 0.30
    onProgress(`[SFX] Scene ${scene.sceneIndex}: ${sfxQuery}`, pct)

    try {
      const results = await openverseSearchAudio(sfxQuery, 'sound_effects', 3, openverseToken)
      if (results.length > 0) {
        sfxAssignments.push({
          sceneIndex: scene.sceneIndex,
          startTime: scene.startTime,
          endTime: scene.endTime,
          sfxQuery,
          sfxCandidate: results[0],
          approved: false,
          volumeDb: -12,
          fadeInSecs: 0.5,
          fadeOutSecs: 0.5
        })
        sfxCount++
      }
    } catch {
      // Non-fatal — skip SFX for this scene
    }
  }

  // ── Auto-download all found + approved music ─────────────────────────────
  // Auto-approve all found sections and download immediately —
  // users can still un-approve/change volume in the UI after the fact.
  const foundSections = sections.filter((s) => s.status === 'found' && s.musicCandidate)
  for (let i = 0; i < foundSections.length; i++) {
    const sec = foundSections[i]
    sec.approved = true
    const pct = 0.62 + (i / Math.max(foundSections.length, 1)) * 0.30
    onProgress(`Downloading music [${i + 1}/${foundSections.length}]: ${sec.sectionLabel}…`, pct)
    try {
      const localPath = await downloadAudio(sec.musicCandidate!, audioDir)
      sec.approvedLocalPath = localPath
      sec.approvedFilename = basename(localPath)
      logger.info(`[AudioDirector] Downloaded: ${sec.sectionLabel} → ${localPath}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`[AudioDirector] Download failed for ${sec.sectionLabel}: ${msg}`)
      // Don't set approvedLocalPath — renderer will skip this section gracefully
    }
  }

  // ── Save audio plan ────────────────────────────────────────────────────────
  const audioPlan: AudioPlan = {
    generatedAt: new Date().toISOString(),
    sections,
    sfxAssignments
  }
  const audioPlanPath = join(projectDir, 'analysis', 'audio-plan.json')
  fs.writeFileSync(audioPlanPath, JSON.stringify(audioPlan, null, 2), 'utf-8')

  const downloadedCount = sections.filter((s) => s.approvedLocalPath).length
  onProgress(`Complete — ${sections.filter((s) => s.status === 'found').length}/${sections.length} music found, ${downloadedCount} downloaded, ${sfxCount} SFX`, 1.0)

  return {
    success: true,
    sections,
    sfxAssignments
  }
}

/** Download approved audio tracks and return local paths */
export async function downloadApprovedAudio(
  projectDir: string,
  plan: AudioPlan,
  onProgress: AudioProgressCallback = () => {}
): Promise<AudioPlan> {
  const audioDir = join(projectDir, 'assets', 'audio')
  fs.mkdirSync(audioDir, { recursive: true })

  const total = plan.sections.filter((s) => s.approved && s.musicCandidate).length
    + plan.sfxAssignments.filter((s) => s.approved && s.sfxCandidate).length
  let done = 0

  // Download approved music
  for (const section of plan.sections) {
    if (!section.approved || !section.musicCandidate) continue
    try {
      onProgress(`Downloading music: ${section.sectionLabel}`, done / total)
      const localPath = await downloadAudio(section.musicCandidate, audioDir)
      section.approvedLocalPath = localPath
      section.approvedFilename = basename(localPath)
      done++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[AudioDirector] Failed to download music for ${section.sectionLabel}: ${msg}`)
    }
  }

  // Download approved SFX
  for (const sfx of plan.sfxAssignments) {
    if (!sfx.approved || !sfx.sfxCandidate) continue
    try {
      onProgress(`Downloading SFX: Scene ${sfx.sceneIndex}`, done / total)
      const localPath = await downloadAudio(sfx.sfxCandidate, audioDir)
      sfx.approvedLocalPath = localPath
      sfx.approvedFilename = basename(localPath)
      done++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[AudioDirector] Failed to download SFX for scene ${sfx.sceneIndex}: ${msg}`)
    }
  }

  // Update plan on disk
  const audioPlanPath = join(projectDir, 'analysis', 'audio-plan.json')
  fs.writeFileSync(audioPlanPath, JSON.stringify(plan, null, 2), 'utf-8')

  return plan
}

/** Load saved audio plan from disk */
export function loadAudioPlan(projectDir: string): AudioPlan | null {
  const audioPlanPath = join(projectDir, 'analysis', 'audio-plan.json')
  if (!fs.existsSync(audioPlanPath)) return null
  try {
    return JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8')) as AudioPlan
  } catch {
    return null
  }
}

/** Save audio plan to disk */
export function saveAudioPlan(projectDir: string, plan: AudioPlan): void {
  const audioPlanPath = join(projectDir, 'analysis', 'audio-plan.json')
  fs.writeFileSync(audioPlanPath, JSON.stringify(plan, null, 2), 'utf-8')
}
