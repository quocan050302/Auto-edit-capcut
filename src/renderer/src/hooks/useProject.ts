import { useState, useCallback, useRef } from 'react'
import type { ProjectState, ProjectSettings, ProjectInputs, LogEntry, ScanResult } from '../../../../shared/types'

interface ProjectHook {
  project: ProjectState | null
  logs: LogEntry[]
  scanResult: ScanResult | null
  scanProgress: { message: string; progress: number } | null
  isScanning: boolean
  createProject: (name: string) => Promise<boolean>
  openProject: () => Promise<boolean>
  updateInputs: (inputs: Partial<ProjectInputs>) => Promise<void>
  updateSettings: (settings: Partial<ProjectSettings>) => Promise<void>
  scanMedia: () => Promise<void>
  addLog: (entry: Omit<LogEntry, 'timestamp'>) => void
}

export function useProject(): ProjectHook {
  const [project, setProject] = useState<ProjectState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanProgress, setScanProgress] = useState<{ message: string; progress: number } | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const scanUnsubRef = useRef<(() => void) | null>(null)

  const addLog = useCallback((entry: Omit<LogEntry, 'timestamp'>) => {
    const logEntry: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString()
    }
    setLogs((prev) => [...prev.slice(-199), logEntry]) // keep last 200
  }, [])

  const createProject = useCallback(
    async (name: string): Promise<boolean> => {
      addLog({ level: 'info', message: `Creating project: ${name}`, category: 'project' })
      const result = await window.api.project.create(name)
      if (result.success && result.state) {
        setProject(result.state)
        addLog({ level: 'success', message: `Project "${name}" created successfully`, category: 'project' })
        return true
      } else {
        addLog({ level: 'error', message: result.error ?? 'Failed to create project', category: 'project' })
        return false
      }
    },
    [addLog]
  )

  const openProject = useCallback(async (): Promise<boolean> => {
    const folder = await window.api.selectFolder({ title: 'Open Project Folder' })
    if (!folder) return false

    addLog({ level: 'info', message: `Opening project from: ${folder}`, category: 'project' })
    const result = await window.api.project.open(folder)
    if (result.success && result.state) {
      setProject(result.state)
      addLog({
        level: 'success',
        message: `Project "${result.state.name}" loaded`,
        category: 'project'
      })
      return true
    } else {
      const errMsg = result.error ?? 'Failed to open project'
      addLog({ level: 'error', message: errMsg, category: 'project' })
      // Show a clear popup so user knows why it failed
      window.alert(
        `❌ Cannot open project\n\n` +
        `Selected folder: ${folder}\n\n` +
        `Reason: The selected folder does not contain a project-state.json file.\n\n` +
        `Please select a VideoFactory project folder (e.g. VideoFactory/projects/my-video)`
      )
      return false
    }
  }, [addLog])

  const updateInputs = useCallback(
    async (inputs: Partial<ProjectInputs>): Promise<void> => {
      if (!project) return
      const result = await window.api.project.updateInputs(project.projectDir, inputs)
      if (result.success && result.state) {
        setProject(result.state)
      }
    },
    [project]
  )

  const updateSettings = useCallback(
    async (settings: Partial<ProjectSettings>): Promise<void> => {
      if (!project) return
      const result = await window.api.project.updateSettings(project.projectDir, settings)
      if (result.success && result.state) {
        setProject(result.state)
      }
    },
    [project]
  )

  const scanMedia = useCallback(async (): Promise<void> => {
    if (!project) return
    setIsScanning(true)
    setScanResult(null)
    setScanProgress({ message: 'Starting scan...', progress: 0 })

    // Subscribe to progress
    if (scanUnsubRef.current) scanUnsubRef.current()
    scanUnsubRef.current = window.api.media.onScanProgress((data) => {
      setScanProgress(data)
      addLog({ level: 'info', message: data.message, category: 'scan' })
    })

    addLog({ level: 'info', message: 'Starting media scan...', category: 'scan' })

    try {
      const result = await window.api.media.scan({
        projectDir: project.projectDir,
        imagesFolder: project.inputs.imagesFolder,
        videosFolder: project.inputs.videosFolder,
        musicFolder: project.inputs.musicFolder,
        sfxFolder: project.inputs.sfxFolder
      })

      setScanResult(result)

      const total =
        result.images.length + result.videos.length + result.music.length + result.sfx.length

      addLog({
        level: 'success',
        message: `Scan complete: ${total} assets indexed (${result.images.length} images, ${result.videos.length} videos, ${result.music.length} music, ${result.sfx.length} sfx)`,
        category: 'scan'
      })

      if (result.errors.length > 0) {
        addLog({
          level: 'warn',
          message: `${result.errors.length} file(s) could not be processed`,
          category: 'scan'
        })
      }

      // Update project stats
      const updatedState: ProjectState = {
        ...project,
        stats: {
          ...project.stats,
          totalImages: result.images.length,
          totalVideos: result.videos.length,
          totalMusic: result.music.length,
          totalSfx: result.sfx.length
        },
        status: 'ANALYZING_MEDIA',
        updatedAt: new Date().toISOString()
      }
      await window.api.project.save(updatedState)
      setProject(updatedState)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      addLog({ level: 'error', message: `Scan failed: ${msg}`, category: 'scan' })
    } finally {
      setIsScanning(false)
      setScanProgress(null)
      if (scanUnsubRef.current) {
        scanUnsubRef.current()
        scanUnsubRef.current = null
      }
    }
  }, [project, addLog])

  return {
    project,
    logs,
    scanResult,
    scanProgress,
    isScanning,
    createProject,
    openProject,
    updateInputs,
    updateSettings,
    scanMedia,
    addLog
  }
}
