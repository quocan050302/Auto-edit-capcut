#!/usr/bin/env node
/**
 * Standalone diagnostic tool for HyperFrames environment detection.
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'

console.log('==================================================')
console.log('HYPERFRAMES ENVIRONMENT DOCTOR')
console.log('==================================================\n')

const envNodeBin = process.env.HYPERFRAMES_NODE_BIN
console.log(`HYPERFRAMES_NODE_BIN: ${envNodeBin || '(not set)'}`)
const envNpxBin = process.env.HYPERFRAMES_NPX_BIN
console.log(`HYPERFRAMES_NPX_BIN:  ${envNpxBin || '(not set)'}`)

const candidateNode = envNodeBin || 'node'
let nodeVersion = ''
let nodeMajor = 0

try {
  const res = spawnSync(candidateNode, ['--version'], { encoding: 'utf-8' })
  if (res.status === 0) {
    nodeVersion = res.stdout.trim()
    const match = nodeVersion.match(/^v?(\d+)\./)
    if (match) nodeMajor = parseInt(match[1], 10)
  }
} catch (err) {
  console.log(`Node candidate probe failed: ${err.message}`)
}

console.log(`Resolved Node Binary:  ${candidateNode}`)
console.log(`Detected Node Version: ${nodeVersion || 'unknown'} (major: ${nodeMajor})`)

if (nodeMajor >= 22) {
  console.log('  ✓ Node version is >= 22 (Compatible with HyperFrames)')
} else {
  console.log('  ✗ Node version is < 22 (HyperFrames will be skipped; Procedural FFmpeg SFX will be used)')
}

// Check npx / hyperframes CLI
const candidateNpx = envNpxBin || 'npx'
let hyperframesAvailable = false

try {
  const hfRes = spawnSync(candidateNpx, ['hyperframes', '--help'], { encoding: 'utf-8', timeout: 8000 })
  if (hfRes.status === 0 || (hfRes.stdout && hfRes.stdout.includes('hyperframes'))) {
    hyperframesAvailable = true
    console.log('  ✓ HyperFrames CLI detected')
  } else {
    console.log('  - HyperFrames CLI not installed globally (will execute on-demand via npx if needed)')
  }
} catch {
  console.log('  - HyperFrames CLI probe timed out or failed')
}

console.log('\nSummary:')
if (nodeMajor >= 22) {
  console.log('  -> Status: READY for HyperFrames SFX resolution.')
} else {
  console.log('  -> Status: READY for Local Procedural SFX resolution (100% offline fallback).')
}
console.log('==================================================\n')
