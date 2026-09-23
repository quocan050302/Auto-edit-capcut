import { IpcMain, app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import {
  IPC_CHANNELS,
  ProjectState,
  ProjectSettings,
  ProjectInputs,
  ProjectStatus
} from '../../../shared/types'
import { logger } from '../logger'

const DEFAULT_PROJECTS_DIR = join(app.getPath('documents'), 'VideoFactory', 'projects')

function ensureProjectsDir(): void {
  if (!fs.existsSync(DEFAULT_PROJECTS_DIR)) {
    fs.mkdirSync(DEFAULT_PROJECTS_DIR, { recursive: true })
  }
}

function createProjectFolderStructure(projectDir: string): void {
  const dirs = [
    'source',
    'media/images',
    'media/videos',
    'media/music',
    'media/sfx',
    'analysis',
    'planning',
    'renders/segments',
    'qa',
    'output',
    'logs'
  ]
  for (const dir of dirs) {
    fs.mkdirSync(join(projectDir, dir), { recursive: true })
  }
}

function defaultSettings(): ProjectSettings {
  return {
    videoType: 'documentary',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    pacing: 'balanced'
  }
}

function saveProjectState(state: ProjectState): void {
  const statePath = join(state.projectDir, 'project-state.json')
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
}

export function registerProjectHandlers(ipcMain: IpcMain): void {
  // Create new project
  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, name: string) => {
    try {
      ensureProjectsDir()

      const safeName = name.replace(/[^a-zA-Z0-9-_\s]/g, '').trim().replace(/\s+/g, '-')
      const projectDir = join(DEFAULT_PROJECTS_DIR, safeName)

      if (fs.existsSync(projectDir)) {
        throw new Error(`Project "${safeName}" already exists at ${projectDir}`)
      }

      createProjectFolderStructure(projectDir)

      const state: ProjectState = {
        id: uuidv4(),
        name: safeName,
        projectDir,
        status: 'NEW',
        settings: defaultSettings(),
        inputs: {
          scriptPath: null,
          voiceoverPath: null,
          imagesFolder: null,
          videosFolder: null,
          musicFolder: null,
          sfxFolder: null
        },
        stats: {
          totalImages: 0,
          totalVideos: 0,
          totalMusic: 0,
          totalSfx: 0,
          voiceDurationSeconds: 0,
          estimatedScenes: 0,
          estimatedChapters: 0
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOperation: null,
        error: null
      }

      saveProjectState(state)
      logger.info(`Project created: ${safeName}`, { projectDir })
      return { success: true, state }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to create project: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // Open existing project
  ipcMain.handle(IPC_CHANNELS.PROJECT_OPEN, async (_event, projectDir: string) => {
    try {
      const statePath = join(projectDir, 'project-state.json')
      if (!fs.existsSync(statePath)) {
        throw new Error(`No project-state.json found in ${projectDir}`)
      }
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      logger.info(`Project opened: ${state.name}`, { projectDir })
      return { success: true, state }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to open project: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // Save project state
  ipcMain.handle(IPC_CHANNELS.PROJECT_SAVE, async (_event, state: ProjectState) => {
    try {
      state.updatedAt = new Date().toISOString()
      saveProjectState(state)
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to save project: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // Update inputs
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_INPUTS,
    async (_event, projectDir: string, inputs: Partial<ProjectInputs>) => {
      try {
        const statePath = join(projectDir, 'project-state.json')
        const state: ProjectState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
        state.inputs = { ...state.inputs, ...inputs }
        state.updatedAt = new Date().toISOString()
        saveProjectState(state)
        return { success: true, state }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to update inputs: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // Update settings
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
    async (_event, projectDir: string, settings: Partial<ProjectSettings>) => {
      try {
        const statePath = join(projectDir, 'project-state.json')
        const state: ProjectState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
        state.settings = { ...state.settings, ...settings }
        state.updatedAt = new Date().toISOString()
        saveProjectState(state)
        return { success: true, state }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to update settings: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // Get projects directory
  ipcMain.handle(IPC_CHANNELS.GET_PROJECTS_DIR, () => {
    ensureProjectsDir()
    return DEFAULT_PROJECTS_DIR
  })

  // Get app version
  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => app.getVersion())
}

export { DEFAULT_PROJECTS_DIR, saveProjectState }
export type { ProjectStatus }
