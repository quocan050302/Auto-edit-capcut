import { IpcMain } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ResearchSidecarStatus, ResearchProjectHandoffPayload, ProjectState } from '../../../shared/types'
import { researchSidecar } from '../research/research-sidecar'
import { logger } from '../logger'

export function registerResearchHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.RESEARCH_SIDECAR_STATUS, async (): Promise<ResearchSidecarStatus> => {
    return researchSidecar.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.RESEARCH_SIDECAR_RESTART, async (): Promise<ResearchSidecarStatus> => {
    logger.info('[IPC:Research] User requested sidecar restart')
    return await researchSidecar.restart()
  })

  ipcMain.handle(
    IPC_CHANNELS.RESEARCH_CREATE_PROJECT_HANDOFF,
    async (
      _event,
      payload: ResearchProjectHandoffPayload
    ): Promise<{ success: boolean; projectDir?: string; error?: string }> => {
      try {
        logger.info('[IPC:Research] Creating Video Project from research handoff', {
          name: payload.projectName,
          keyword: payload.keyword,
          angle: payload.angle
        })

        // Delegate to existing project creation mechanism or write research brief draft
        const projectsDir = process.platform === 'win32'
          ? 'D:\\Video_factory_hutteries'
          : join(process.env.HOME || '', 'Video_factory_hutteries')

        const safeProjectName = payload.projectName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || 'Research_Video_Project'
        const projectDir = join(projectsDir, safeProjectName)

        if (!fs.existsSync(projectDir)) {
          fs.mkdirSync(projectDir, { recursive: true })
          fs.mkdirSync(join(projectDir, 'source'), { recursive: true })
          fs.mkdirSync(join(projectDir, 'media/images'), { recursive: true })
          fs.mkdirSync(join(projectDir, 'media/videos'), { recursive: true })
          fs.mkdirSync(join(projectDir, 'media/music'), { recursive: true })
          fs.mkdirSync(join(projectDir, 'media/sfx'), { recursive: true })
        }

        // Create research brief text file in project source directory for reference
        const briefPath = join(projectDir, 'source', 'research_brief.txt')
        const briefContent = [
          `RESEARCH-BACKED VIDEO BRIEF: ${payload.projectName}`,
          `Target Market: ${payload.market}`,
          `Primary Keyword: ${payload.keyword}`,
          `Angle / Hook: ${payload.angle || 'Not specified'}`,
          `Opportunity Score: ${payload.researchData.opportunityScore ?? 'N/A'}/100`,
          `Market Fit Signal: ${payload.researchData.marketFitScore ?? 'N/A'}/100`,
          `Confidence: ${payload.researchData.confidence ?? 'N/A'}`,
          '',
          'WINNING TITLE PATTERNS:',
          ...(payload.researchData.topTitles || []).map((t) => `- ${t}`),
          '',
          'IDENTIFIED CONTENT GAPS:',
          ...(payload.researchData.contentGaps || []).map((g) => `- ${g}`),
          '',
          'RELATED KEYWORDS:',
          ...(payload.researchData.relatedKeywords || []).map((k) => `- ${k}`),
          '',
          'AI / STRATEGIC IDEAS:',
          ...(payload.researchData.aiContentIdeas || []).map((i) => `- ${i}`),
          '',
          'TOP BREAKOUT REFERENCE VIDEOS (PUBLIC YOUTUBE INSPIRATION ONLY - NOT MEDIA ASSETS):',
          ...(payload.researchData.breakoutVideos || []).map(
            (b) => `- "${b.title}" by ${b.channel || 'Unknown'} (${(b.views || 0).toLocaleString()} views)`
          )
        ].join('\n')

        fs.writeFileSync(briefPath, briefContent, 'utf-8')

        // Generate draft script template in source/script.txt if none exists
        const scriptPath = join(projectDir, 'source', 'script.txt')
        if (!fs.existsSync(scriptPath)) {
          const draftScript = [
            `# ${payload.projectName}`,
            `## Target Topic: ${payload.keyword}`,
            `## Hook Angle: ${payload.angle || 'Investigative Documentary'}`,
            '',
            '[SCENE 1: COLD OPEN]',
            `Why does everyone seem to be talking about ${payload.keyword}?`,
            'The data tells a story that mainstream media is missing completely.',
            '',
            '[SCENE 2: THE REALITY]',
            'Here is what is really happening behind closed doors.',
            '',
            '[SCENE 3: EVIDENCE & NUMBERS]',
            'Let us look at the actual statistics and historical comparisons.',
            '',
            '[SCENE 4: CONCLUSION]',
            'What happens next, and what can you do about it?'
          ].join('\n')
          fs.writeFileSync(scriptPath, draftScript, 'utf-8')
        }

        // Build base project.json
        const statePath = join(projectDir, 'project.json')
        const projectState: ProjectState = {
          name: safeProjectName,
          projectDir,
          status: 'NEW',
          settings: {
            videoType: 'documentary',
            aspectRatio: '16:9',
            resolution: { width: 1920, height: 1080 },
            fps: 30,
            pacing: 'balanced'
          },
          inputs: {
            scriptPath,
            voiceoverPath: null,
            imagesFolder: join(projectDir, 'media/images'),
            videosFolder: join(projectDir, 'media/videos'),
            musicFolder: join(projectDir, 'media/music'),
            sfxFolder: join(projectDir, 'media/sfx')
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }

        fs.writeFileSync(statePath, JSON.stringify(projectState, null, 2), 'utf-8')

        logger.info(`[IPC:Research] Successfully created project draft at ${projectDir}`)
        return { success: true, projectDir }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[IPC:Research] Failed creating project from research: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )
}
