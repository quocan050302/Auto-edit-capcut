/**
 * hyperframes-command-runner.ts — Safe, Isolated External Process Runner for HyperFrames SFX
 *
 * Runs `npx hyperframes media-use resolve --type sfx --intent "<intent>" --project "<workspace>"`
 * in an isolated workspace under external Node 22+.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { HyperFramesCapability } from '../sfx/sfx-types'

export interface HyperFramesRunOptions {
  intent: string
  projectDir: string
  capability: HyperFramesCapability
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HyperFramesRunResult {
  success: boolean
  resolvedPath?: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut?: boolean
  error?: string
}

type CommandRunnerOverride = (options: HyperFramesRunOptions) => Promise<HyperFramesRunResult>
let runnerOverride: CommandRunnerOverride | null = null

export function setHyperFramesRunnerForTests(runner: CommandRunnerOverride | null): void {
  runnerOverride = runner
}

/**
 * Parses stdout from `hyperframes media-use resolve`
 * Expected format: `resolved <id> → <path> (...)` or `resolved <id> -> <path>`
 */
export function parseHyperFramesResolvedPath(stdout: string): string | null {
  const lines = stdout.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Match `resolved <id> → <path>` or `resolved <id> -> <path>`
    const arrowMatch = trimmed.match(/resolved\s+([^\s]+)\s+(?:→|->)\s+([^\s(]+)/i)
    if (arrowMatch && arrowMatch[2]) {
      return arrowMatch[2]
    }

    // Match generic path after arrow
    const genericArrow = trimmed.match(/(?:→|->)\s+([^\s(]+(?:\.wav|\.mp3|\.ogg|\.flac|\.aac|\.m4a))/i)
    if (genericArrow && genericArrow[1]) {
      return genericArrow[1]
    }
  }

  // Fallback: search for absolute or relative audio file path mentioned in resolved output
  for (const line of lines) {
    if (line.includes('resolved')) {
      const pathMatch = line.match(/(['"])?([A-Za-z0-9_.\-\/\\]+\.(?:wav|mp3|ogg|flac|aac|m4a))\1?/i)
      if (pathMatch && pathMatch[2]) {
        return pathMatch[2]
      }
    }
  }

  return null
}

/**
 * Executes HyperFrames media-use resolve in a safe isolated subfolder.
 */
export async function executeHyperFramesSfxResolve(
  options: HyperFramesRunOptions
): Promise<HyperFramesRunResult> {
  if (runnerOverride) {
    return runnerOverride(options)
  }

  const { intent, projectDir, capability, timeoutMs = 25000, signal } = options

  if (!capability.available || !capability.npxBinary) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      error: capability.reason || 'HyperFrames is not available'
    }
  }

  // Isolated workspace for HyperFrames media-use
  const workspaceDir = path.join(projectDir, '.cache', 'hyperframes-sfx')
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true })
  }

  const npxBin = capability.npxBinary
  const args = [
    'hyperframes',
    'media-use',
    'resolve',
    '--type',
    'sfx',
    '--intent',
    intent,
    '--project',
    workspaceDir
  ]

  const env = {
    ...process.env,
    PATH: capability.nodeBinary && capability.nodeBinary.includes(path.sep)
      ? `${path.dirname(capability.nodeBinary)}${path.delimiter}${process.env.PATH || ''}`
      : process.env.PATH
  }

  logger.info(`[HyperFrames:SFX] Running external command: intent="${intent}" timeout=${timeoutMs}ms`)

  return new Promise<HyperFramesRunResult>((resolve) => {
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let timedOut = false
    let completed = false

    const isWindows = process.platform === 'win32'
    const child = spawn(npxBin, args, {
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows // needed for npx.cmd on windows
    })

    const timer = setTimeout(() => {
      if (completed) return
      timedOut = true
      logger.warn(`[HyperFrames:SFX] Command timed out after ${timeoutMs}ms, terminating child process`)
      try {
        child.kill('SIGTERM')
        setTimeout(() => {
          try {
            if (!child.killed) child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }, 2000)
      } catch {
        // ignore
      }
    }, timeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => {
        if (!completed) {
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore
          }
        }
      })
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString()
      // Guard against unbounded memory consumption
      if (stdoutBuffer.length > 50000) {
        stdoutBuffer = stdoutBuffer.slice(-50000)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > 50000) {
        stderrBuffer = stderrBuffer.slice(-50000)
      }
    })

    child.on('error', (err) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      logger.warn(`[HyperFrames:SFX] Process error: ${err.message}`)
      resolve({
        success: false,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: null,
        error: err.message
      })
    })

    child.on('close', (code) => {
      if (completed) return
      completed = true
      clearTimeout(timer)

      if (timedOut) {
        resolve({
          success: false,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: code,
          timedOut: true,
          error: `Execution timed out after ${timeoutMs}ms`
        })
        return
      }

      if (code !== 0) {
        logger.warn(`[HyperFrames:SFX] CLI exited with code ${code}`)
        resolve({
          success: false,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: code,
          error: `Process exited with code ${code}`
        })
        return
      }

      const parsedPath = parseHyperFramesResolvedPath(stdoutBuffer)
      if (!parsedPath) {
        logger.warn(`[HyperFrames:SFX] Could not parse output file from stdout: ${stdoutBuffer.slice(0, 300)}`)
        resolve({
          success: false,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: code,
          error: 'No resolved path in stdout'
        })
        return
      }

      // Check if path is relative to workspaceDir or absolute
      const absolutePath = path.isAbsolute(parsedPath)
        ? parsedPath
        : path.resolve(workspaceDir, parsedPath)

      if (!fs.existsSync(absolutePath)) {
        logger.warn(`[HyperFrames:SFX] Output path does not exist on disk: ${absolutePath}`)
        resolve({
          success: false,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: code,
          error: `Resolved file not found: ${absolutePath}`
        })
        return
      }

      const stat = fs.statSync(absolutePath)
      if (stat.size < 512) {
        logger.warn(`[HyperFrames:SFX] Output file is suspiciously small (${stat.size} bytes): ${absolutePath}`)
        resolve({
          success: false,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: code,
          error: `Resolved file too small (${stat.size}b)`
        })
        return
      }

      resolve({
        success: true,
        resolvedPath: absolutePath,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: code
      })
    })
  })
}
