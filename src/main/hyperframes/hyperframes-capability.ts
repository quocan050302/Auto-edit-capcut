/**
 * hyperframes-capability.ts — Cached Capability Check for External Node 22+ & HyperFrames CLI
 *
 * Enforces Node >= 22 safety rule:
 * - Electron 30 runtime is Node 20.
 * - HyperFrames requires Node >= 22.
 * - HyperFrames must NEVER run under Node < 22 or inside the Electron process.
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { HyperFramesCapability } from '../sfx/sfx-types'

let cachedCapability: HyperFramesCapability | null = null
let testCapabilityOverride: HyperFramesCapability | null | undefined = undefined

/**
 * Allows automated tests to simulate Node 20, Node 22, or HyperFrames missing/available.
 */
export function setHyperFramesCapabilityForTests(cap: HyperFramesCapability | null | undefined): void {
  testCapabilityOverride = cap
}

export function resetHyperFramesCapabilityCache(): void {
  cachedCapability = null
  testCapabilityOverride = undefined
}

/**
 * Inspects a Node binary to determine its major version.
 */
export function inspectNodeVersion(nodeBin: string): { major: number; full: string } | null {
  try {
    const res = spawnSync(nodeBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
    if (res.status === 0 && res.stdout) {
      const full = res.stdout.trim()
      const match = full.match(/^v?(\d+)\./)
      if (match) {
        return { major: parseInt(match[1], 10), full }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Finds a suitable Node binary with version >= 22.
 * 1. HYPERFRAMES_NODE_BIN environment variable
 * 2. System PATH 'node'
 * 3. Common installation paths (Homebrew, nvm, fnm, standard paths)
 */
export function findNode22Binary(): { bin: string; version: string } | null {
  // 1. Explicit environment variable override
  if (process.env.HYPERFRAMES_NODE_BIN) {
    const customBin = process.env.HYPERFRAMES_NODE_BIN
    if (fs.existsSync(customBin)) {
      const v = inspectNodeVersion(customBin)
      if (v && v.major >= 22) {
        return { bin: customBin, version: v.full }
      }
      logger.warn(`[HyperFrames:Cap] HYPERFRAMES_NODE_BIN points to node ${v?.full || 'unknown'} (< 22)`)
    }
  }

  // 2. System `node` from PATH (DO NOT use process.execPath which is Electron!)
  const systemNodeCandidates = process.platform === 'win32'
    ? ['node.exe', 'node']
    : ['node']

  for (const candidate of systemNodeCandidates) {
    const v = inspectNodeVersion(candidate)
    if (v && v.major >= 22) {
      return { bin: candidate, version: v.full }
    }
  }

  // 3. Common Unix / macOS locations (nvm, brew, fnm, standard usr/local)
  if (process.platform !== 'win32') {
    const home = process.env.HOME || ''
    const fallbackLocations: string[] = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      path.join(home, '.nvm/versions/node/v22/bin/node'),
      path.join(home, '.fnm/current/bin/node'),
      path.join(home, '.volta/bin/node')
    ]

    for (const loc of fallbackLocations) {
      if (fs.existsSync(loc)) {
        const v = inspectNodeVersion(loc)
        if (v && v.major >= 22) {
          return { bin: loc, version: v.full }
        }
      }
    }
  }

  return null
}

/**
 * Resolves the npx binary corresponding to the Node installation or on PATH.
 */
export function findNpxBinary(nodeBin: string): string | null {
  if (process.env.HYPERFRAMES_NPX_BIN && fs.existsSync(process.env.HYPERFRAMES_NPX_BIN)) {
    return process.env.HYPERFRAMES_NPX_BIN
  }

  // Check same directory as node binary
  if (nodeBin.includes(path.sep)) {
    const dir = path.dirname(nodeBin)
    const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const adjacent = path.join(dir, npxName)
    if (fs.existsSync(adjacent)) {
      return adjacent
    }
  }

  // Check system npx
  const defaultNpx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  try {
    const res = spawnSync(defaultNpx, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
    if (res.status === 0) {
      return defaultNpx
    }
  } catch {
    // ignore
  }

  return null
}

/**
 * Checks whether HyperFrames CLI is callable and supports the media-use command.
 * Caches the result in-memory for the current application session.
 */
export async function checkHyperFramesCapability(forceFresh = false): Promise<HyperFramesCapability> {
  if (testCapabilityOverride !== undefined) {
    return testCapabilityOverride || { available: false, checkedAt: Date.now(), reason: 'Test override: unavailable' }
  }

  if (cachedCapability && !forceFresh) {
    return cachedCapability
  }

  const nodeInfo = findNode22Binary()
  if (!nodeInfo) {
    cachedCapability = {
      available: false,
      reason: 'No Node.js binary >= 22 found on system or via HYPERFRAMES_NODE_BIN'
    }
    logger.info(`[HyperFrames:Cap] unavailable: ${cachedCapability.reason}`)
    return cachedCapability
  }

  const npxBin = findNpxBinary(nodeInfo.bin)
  if (!npxBin) {
    cachedCapability = {
      available: false,
      nodeBin: nodeInfo.bin,
      nodeMajor: parseInt(nodeInfo.version.replace(/^v/, '').split('.')[0], 10) || 0,
      reason: 'Node >= 22 found, but npx is not accessible'
    }
    logger.info(`[HyperFrames:Cap] unavailable: ${cachedCapability.reason}`)
    return cachedCapability
  }

  // Test executing hyperframes via npx
  try {
    const testRes = spawnSync(npxBin, ['hyperframes', '--version'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: nodeInfo.bin.includes(path.sep)
          ? `${path.dirname(nodeInfo.bin)}${path.delimiter}${process.env.PATH || ''}`
          : process.env.PATH
      }
    })

    const nodeMajor = parseInt(nodeInfo.version.replace(/^v/, '').split('.')[0], 10) || 0

    if (testRes.status === 0 || (testRes.stdout && testRes.stdout.includes('.'))) {
      cachedCapability = {
        available: true,
        nodeBin: nodeInfo.bin,
        nodeMajor,
        npxBin: npxBin
      }
      logger.info(`[HyperFrames:Cap] available=true node=${nodeInfo.version} npx=${npxBin}`)
      return cachedCapability
    }

    cachedCapability = {
      available: false,
      nodeBin: nodeInfo.bin,
      nodeMajor,
      npxBin: npxBin,
      reason: `hyperframes command probe returned status ${testRes.status}: ${testRes.stderr || testRes.stdout || 'unknown'}`
    }
    return cachedCapability
  } catch (err) {
    const nodeMajor = parseInt(nodeInfo.version.replace(/^v/, '').split('.')[0], 10) || 0
    cachedCapability = {
      available: false,
      nodeBin: nodeInfo.bin,
      nodeMajor,
      npxBin: npxBin,
      reason: `hyperframes probe failed: ${String(err)}`
    }
    return cachedCapability
  }
}
