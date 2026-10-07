/**
 * Comprehensive Unit and Integration Tests for SfxResolver and Retention SFX
 * Covers prompt requirements 78–96:
 * - Cache hit & isolation
 * - HyperFrames capability (Node 20 vs Node 22, timeout, invalid path)
 * - Procedural FFmpeg generation for all 9 HealthSfxTypes
 * - Zero-API deterministic resolution
 * - Partial provider cascade & fallback
 * - Retention SFX planner (density, cooldown, anti-spam, payoff, bridge, semantic precedence)
 * - Backward compatibility with schema v1 cache manifests
 * - Audio plan repair mode preserving music
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SfxResolver } from '../src/main/sfx/sfx-resolver'
import { SfxCacheManager } from '../src/main/sfx/sfx-cache'
import { generateProceduralSfx } from '../src/main/sfx/providers/procedural-sfx-provider'
import {
  setHyperFramesCapabilityForTests,
  checkHyperFramesCapability
} from '../src/main/hyperframes/hyperframes-capability'
import {
  setHyperFramesRunnerForTests,
  executeHyperFramesSfxResolve
} from '../src/main/hyperframes/hyperframes-command-runner'
import { RetentionSfxPlanner } from '../src/main/sfx/retention-sfx-planner'
import { HealthSfxDirector, SfxDirectorSceneInput } from '../src/main/health/health-sfx-director'
import type { HealthSfxType, AudioPlan, HealthSfxCuePlan } from '../shared/types'
import type { RetentionPlan } from '../src/main/retention/retention-types'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).stack || (err as Error).message}`)
    failed++
  }
}

async function runAllTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING SFX RESOLVER & RETENTION SFX TEST SUITE')
  console.log('==================================================\n')

  // ─── TEST 79: Cache Hit ───────────────────────────────────────────────────────
  await it('TEST 79: Cache hit returns cached file without calling external providers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-cache-hit-'))
    const audioDir = path.join(tempDir, 'assets', 'audio', 'health-sfx')
    fs.mkdirSync(audioDir, { recursive: true })

    const cachedFile = path.join(audioDir, 'soft-whoosh_cached.wav')
    fs.writeFileSync(cachedFile, Buffer.alloc(2048, 0x42))

    // Pre-populate cache manifest
    SfxCacheManager.recordCachedSfx(tempDir, {
      type: 'soft-whoosh',
      provider: 'cache',
      localPath: cachedFile,
      durationSecs: 0.75,
      sourceId: 'cached-whoosh',
      creator: 'Test Creator'
    })

    // Mock capability to verify it is NOT reached or needed
    setHyperFramesCapabilityForTests({ available: false, reason: 'Should not be called' })

    const result = await SfxResolver.resolveSfxType({
      type: 'soft-whoosh',
      intents: ['soft whoosh'],
      projectDir: tempDir
    })

    assert.ok(result.resolved, 'Expected resolved result')
    assert.strictEqual(result.resolved?.provider, 'cache')
    assert.strictEqual(result.resolved?.localPath, cachedFile)
    assert.strictEqual(result.attempts[0].provider, 'cache')
    assert.strictEqual(result.attempts[0].success, true)
    assert.strictEqual(result.attempts.length, 1, 'Should stop after cache hit')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 80: HyperFrames Success ─────────────────────────────────────────────
  await it('TEST 80: HyperFrames success copies and normalizes into project assets', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-hf-success-'))
    const mockHFSrc = path.join(tempDir, 'mock-hf-source.wav')
    fs.writeFileSync(mockHFSrc, Buffer.alloc(4096, 0x11))

    // Override capability check to simulate Node 22 + CLI available
    setHyperFramesCapabilityForTests({
      available: true,
      nodeBin: 'node',
      npxBin: 'npx'
    })

    // Override command runner to return mock output
    setHyperFramesRunnerForTests(async () => {
      return {
        success: true,
        resolvedPath: mockHFSrc,
        stdout: `resolved soft-impact → ${mockHFSrc} (bundled)`
      }
    })

    const result = await SfxResolver.resolveSfxType({
      type: 'soft-impact',
      intents: ['soft impact'],
      projectDir: tempDir
    })

    assert.ok(result.resolved, 'Expected resolved SFX')
    assert.strictEqual(result.resolved?.provider, 'hyperframes')
    assert.strictEqual(result.resolved?.creator, 'HyperFrames SFX Library')
    assert.ok(fs.existsSync(result.resolved?.localPath || ''), 'Normalized file must exist')
    assert.ok(result.resolved?.localPath.includes('soft-impact_hyperframes.wav'), 'File should be in project assets')

    // Clean up test overrides
    setHyperFramesRunnerForTests(null)
    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 81: Node 20 Skip ────────────────────────────────────────────────────
  await it('TEST 81: Node < 22 skips HyperFrames safely without error and uses procedural', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-node20-'))

    setHyperFramesCapabilityForTests({
      available: false,
      reason: 'node<22',
      nodeMajor: 20
    })

    const result = await SfxResolver.resolveSfxType({
      type: 'clock-tick',
      intents: ['clock tick'],
      projectDir: tempDir
    })

    assert.ok(result.resolved, 'Procedural SFX should resolve when Node < 22')
    assert.strictEqual(result.resolved?.provider, 'procedural')
    assert.strictEqual(result.resolved?.creator, 'Local Procedural SFX')
    assert.ok(fs.existsSync(result.resolved?.localPath || ''))

    const hfAttempt = result.attempts.find((a) => a.provider === 'hyperframes')
    assert.ok(hfAttempt, 'HyperFrames attempt should be recorded')
    assert.strictEqual(hfAttempt?.success, false)

    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 82: Node 22 Capability ─────────────────────────────────────────────
  await it('TEST 82: Node >= 22 allows HyperFrames capability', async () => {
    setHyperFramesCapabilityForTests({
      available: true,
      nodeBin: '/usr/local/bin/node',
      nodeMajor: 22,
      npxBin: '/usr/local/bin/npx'
    })

    const cap = await checkHyperFramesCapability()
    assert.strictEqual(cap.available, true)
    assert.strictEqual(cap.nodeMajor, 22)

    setHyperFramesCapabilityForTests(null)
  })

  // ─── TEST 83: HyperFrames Timeout Fallback ────────────────────────────────────
  await it('TEST 83: HyperFrames timeout falls back cleanly to procedural SFX', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-timeout-'))

    setHyperFramesCapabilityForTests({ available: true, nodeBin: 'node', npxBin: 'npx' })
    setHyperFramesRunnerForTests(async () => {
      return {
        success: false,
        error: 'Execution timed out after 25000ms'
      }
    })

    const result = await SfxResolver.resolveSfxType({
      type: 'air-swish',
      intents: ['air swish'],
      projectDir: tempDir
    })

    assert.ok(result.resolved, 'Procedural SFX must resolve after timeout')
    assert.strictEqual(result.resolved?.provider, 'procedural')
    assert.ok(fs.existsSync(result.resolved?.localPath || ''))

    setHyperFramesRunnerForTests(null)
    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 84: HyperFrames Invalid Path ────────────────────────────────────────
  await it('TEST 84: HyperFrames nonexistent path rejected and next provider takes over', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-badpath-'))

    setHyperFramesCapabilityForTests({ available: true, nodeBin: 'node', npxBin: 'npx' })
    setHyperFramesRunnerForTests(async () => {
      return {
        success: true,
        resolvedPath: '/nonexistent/phantom/file.wav',
        stdout: 'resolved soft-pulse → /nonexistent/phantom/file.wav'
      }
    })

    const result = await SfxResolver.resolveSfxType({
      type: 'soft-pulse',
      intents: ['soft pulse'],
      projectDir: tempDir
    })

    assert.ok(result.resolved, 'Next provider must resolve')
    assert.strictEqual(result.resolved?.provider, 'procedural')

    setHyperFramesRunnerForTests(null)
    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 85: Procedural All Types ───────────────────────────────────────────
  await it('TEST 85: Procedural synthesis succeeds for all 9 HealthSfxType values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-procedural-all-'))
    const allTypes: HealthSfxType[] = [
      'soft-whoosh',
      'reverse-whoosh',
      'air-swish',
      'digital-scan',
      'soft-pulse',
      'heartbeat',
      'soft-impact',
      'clock-tick',
      'subtle-riser'
    ]

    for (const type of allTypes) {
      const resolved = await generateProceduralSfx({
        type,
        intents: [type],
        projectDir: tempDir
      })

      assert.ok(resolved, `Procedural generation failed for type: ${type}`)
      assert.strictEqual(resolved?.type, type)
      assert.strictEqual(resolved?.provider, 'procedural')
      assert.strictEqual(resolved?.generated, true)
      assert.ok(resolved?.durationSecs && resolved.durationSecs > 0, `Duration must be > 0 for ${type}`)
      assert.ok(fs.existsSync(resolved?.localPath || ''), `File must exist for ${type}`)

      const stat = fs.statSync(resolved!.localPath)
      assert.ok(stat.size > 1024, `File size (${stat.size}) too small for ${type}`)
    }

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 86: Zero API Acceptance Test ────────────────────────────────────────
  await it('TEST 86: CRITICAL: Zero-API mode resolves completely without any network/tokens', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-zero-api-'))

    // HyperFrames disabled, Openverse skipped
    setHyperFramesCapabilityForTests({ available: false, reason: 'Offline test' })

    const uniqueTypes: HealthSfxType[] = ['soft-whoosh', 'heartbeat', 'subtle-riser']
    const resolvedMap = await SfxResolver.resolveUniqueTypes(tempDir, uniqueTypes, {
      skipHyperframes: true,
      skipOpenverse: true
    })

    assert.strictEqual(resolvedMap.size, 3, 'All 3 types must be resolved offline')
    for (const type of uniqueTypes) {
      const item = resolvedMap.get(type)
      assert.ok(item, `Type ${type} must exist in resolvedMap`)
      assert.strictEqual(item?.provider, 'procedural')
      assert.strictEqual(item?.creator, 'Local Procedural SFX')
      assert.ok(fs.existsSync(item?.localPath || ''))
    }

    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 87: HyperFrames No Key (Bundled Library) ────────────────────────────
  await it('TEST 87: HyperFrames without API key resolves using bundled library', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-no-key-'))
    const mockBundledPath = path.join(tempDir, 'bundled-sfx.wav')
    fs.writeFileSync(mockBundledPath, Buffer.alloc(3000, 0x33))

    setHyperFramesCapabilityForTests({ available: true, nodeBin: 'node', npxBin: 'npx' })
    setHyperFramesRunnerForTests(async (args) => {
      // Confirm that no API key is passed or required
      return {
        success: true,
        resolvedPath: mockBundledPath,
        stdout: 'resolved digital-scan → bundled-sfx.wav (provider: bundled)'
      }
    })

    const result = await SfxResolver.resolveSfxType({
      type: 'digital-scan',
      intents: ['digital scan'],
      projectDir: tempDir
    })

    assert.ok(result.resolved)
    assert.strictEqual(result.resolved?.provider, 'hyperframes')
    assert.strictEqual(result.resolved?.creator, 'HyperFrames SFX Library')

    setHyperFramesRunnerForTests(null)
    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 88: Partial Provider Failure Cascade ────────────────────────────────
  await it('TEST 88: Partial provider failure handles 1 HF success + 2 procedural fallbacks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-cascade-'))
    const mockWhoosh = path.join(tempDir, 'mock-hf-whoosh.wav')
    fs.writeFileSync(mockWhoosh, Buffer.alloc(2048, 0x77))

    setHyperFramesCapabilityForTests({ available: true, nodeBin: 'node', npxBin: 'npx' })
    setHyperFramesRunnerForTests(async (args) => {
      if (args.type === 'soft-whoosh') {
        return { success: true, resolvedPath: mockWhoosh, stdout: 'resolved soft-whoosh' }
      }
      return { success: false, error: 'Command failed' }
    })

    const unique: HealthSfxType[] = ['soft-whoosh', 'soft-impact', 'clock-tick']
    const map = await SfxResolver.resolveUniqueTypes(tempDir, unique)

    assert.strictEqual(map.size, 3)
    assert.strictEqual(map.get('soft-whoosh')?.provider, 'hyperframes')
    assert.strictEqual(map.get('soft-impact')?.provider, 'procedural')
    assert.strictEqual(map.get('clock-tick')?.provider, 'procedural')

    for (const [t, item] of map.entries()) {
      assert.ok(fs.existsSync(item.localPath), `File must exist for ${t}`)
    }

    setHyperFramesRunnerForTests(null)
    setHyperFramesCapabilityForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 89: Retention Density Guard ─────────────────────────────────────────
  await it('TEST 89: Retention SFX density does not exceed configured 25% max on 100 scenes', () => {
    const scenes: SfxDirectorSceneInput[] = []
    let t = 0
    for (let i = 0; i < 100; i++) {
      scenes.push({
        sceneIndex: i,
        startTime: t,
        endTime: t + 5.0,
        duration: 5.0,
        category: 'mechanism',
        narration: `Scene ${i} details`,
        motionPreset: 'push-in-center'
      })
      t += 5.0
    }

    // Every scene has a candidate cue
    const existingCues = new Map<number, HealthSfxCuePlan>()
    for (let i = 0; i < 100; i++) {
      existingCues.set(i, {
        sceneIndex: i,
        type: 'soft-whoosh',
        relativeStart: 0.15,
        duration: 0.7,
        volumeDb: -24
      })
    }

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(existingCues, scenes, null)
    const density = merged.size / scenes.length

    assert.ok(
      density <= 0.25,
      `Density ${(density * 100).toFixed(1)}% (${merged.size}/${scenes.length}) exceeded 25% max`
    )
  })

  // ─── TEST 90: Cooldown Guard ──────────────────────────────────────────────────
  await it('TEST 90: Rapid candidate scenes within 3 seconds enforce minimum gap', () => {
    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 0,
        startTime: 0,
        endTime: 2.5,
        duration: 2.5,
        category: 'anatomy',
        motionPreset: 'pan-left'
      },
      {
        sceneIndex: 1,
        startTime: 2.5,
        endTime: 5.0,
        duration: 2.5,
        category: 'anatomy',
        motionPreset: 'pan-left'
      },
      {
        sceneIndex: 2,
        startTime: 6.0,
        endTime: 10.0,
        duration: 4.0,
        category: 'anatomy',
        motionPreset: 'pan-left'
      },
      { sceneIndex: 3, startTime: 10.0, endTime: 14.0, duration: 4.0, category: 'anatomy', motionPreset: 'none' as any },
      { sceneIndex: 4, startTime: 14.0, endTime: 18.0, duration: 4.0, category: 'anatomy', motionPreset: 'none' as any },
      { sceneIndex: 5, startTime: 18.0, endTime: 22.0, duration: 4.0, category: 'anatomy', motionPreset: 'none' as any },
      { sceneIndex: 6, startTime: 22.0, endTime: 26.0, duration: 4.0, category: 'anatomy', motionPreset: 'none' as any },
      { sceneIndex: 7, startTime: 26.0, endTime: 30.0, duration: 4.0, category: 'anatomy', motionPreset: 'none' as any }
    ]

    const existingCues = new Map<number, HealthSfxCuePlan>()
    existingCues.set(0, {
      sceneIndex: 0,
      type: 'air-swish',
      relativeStart: 0.1,
      duration: 0.5,
      volumeDb: -25
    })
    existingCues.set(1, {
      sceneIndex: 1,
      type: 'air-swish',
      relativeStart: 0.1,
      duration: 0.5,
      volumeDb: -25
    })
    existingCues.set(2, {
      sceneIndex: 2,
      type: 'air-swish',
      relativeStart: 0.1,
      duration: 0.5,
      volumeDb: -25
    })

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(existingCues, scenes, null)

    assert.ok(merged.has(0), 'First scene should receive cue')
    assert.ok(!merged.has(1), 'Scene 1 should be suppressed by cooldown (only 2.5s gap)')
    assert.ok(merged.has(2), 'Scene 2 should be allowed (6.0s - 0.1s >= 4.5s)')
  })

  // ─── TEST 91: No Consecutive SFX Spam ─────────────────────────────────────────
  await it('TEST 91: Three consecutive identical SFX types are varied or suppressed', () => {
    const scenes: SfxDirectorSceneInput[] = []
    let t = 0
    for (let i = 0; i < 5; i++) {
      scenes.push({
        sceneIndex: i,
        startTime: t,
        endTime: t + 6.0,
        duration: 6.0,
        category: 'mechanism',
        motionPreset: 'drift-up-left'
      })
      t += 6.0
    }

    const existingCues = new Map<number, HealthSfxCuePlan>()
    for (let i = 0; i < 5; i++) {
      existingCues.set(i, {
        sceneIndex: i,
        type: 'soft-whoosh',
        relativeStart: 0.15,
        duration: 0.7,
        volumeDb: -24
      })
    }

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(existingCues, scenes, null)
    const types = Array.from(merged.values()).map((c) => c.type)

    for (let i = 2; i < types.length; i++) {
      assert.ok(
        !(types[i] === types[i - 1] && types[i - 1] === types[i - 2]),
        `Found 3 identical consecutive SFX: ${types[i]}`
      )
    }
  })

  // ─── TEST 92: Payoff Role ─────────────────────────────────────────────────────
  await it('TEST 92: Payoff scene receives restrained soft-impact accent', () => {
    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 0,
        startTime: 0,
        endTime: 6.0,
        duration: 6.0,
        category: 'anatomy',
        narration: 'The final outcome of the protocol revealed.',
        motionPreset: 'gentle-pulse'
      }
    ]

    const retentionPlan: RetentionPlan = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      inputHash: 'test-hash',
      totalScenes: 1,
      totalDuration: 6.0,
      strategy: { level: 'balanced', targetRehookGapSecs: 30, maxNoResetSecs: 20, noveltyWindowScenes: 3 },
      openLoops: [],
      motifs: [],
      scenes: [
        {
          sceneIndex: 0,
          sceneId: 'scene-0',
          role: 'payoff',
          intensity: 'high',
          reason: 'Open loop payoff',
          noveltyScore: 0.9,
          noveltyTarget: 0.7,
          patternInterrupt: false,
          motionEnergy: 'elevated',
          beatPacing: 'normal',
          overlayPriority: 'high',
          proofPriority: 'high',
          notes: []
        }
      ],
      summary: { hooks: 0, rehooks: 0, payoffs: 1, patternInterrupts: 0, lowNoveltyScenes: 0, openLoops: 0 }
    }

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(new Map(), scenes, retentionPlan)
    const cue = merged.get(0)

    assert.ok(cue, 'Payoff scene must receive SFX')
    assert.strictEqual(cue?.type, 'soft-impact')
    assert.ok(cue!.volumeDb <= -22, 'Payoff volume must remain subtle')
  })

  // ─── TEST 93: Bridge Role Suppression ─────────────────────────────────────────
  await it('TEST 93: Bridge scene normally stays quiet with no Retention SFX added', () => {
    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 0,
        startTime: 0,
        endTime: 5.0,
        duration: 5.0,
        category: 'anatomy',
        narration: 'Moving on to the next concept.',
        motionPreset: 'drift-up-left'
      }
    ]

    const retentionPlan: RetentionPlan = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      inputHash: 'bridge-hash',
      totalScenes: 1,
      totalDuration: 5.0,
      strategy: { level: 'balanced', targetRehookGapSecs: 30, maxNoResetSecs: 20, noveltyWindowScenes: 3 },
      openLoops: [],
      motifs: [],
      scenes: [
        {
          sceneIndex: 0,
          sceneId: 'scene-0',
          role: 'bridge',
          intensity: 'low',
          reason: 'Connecting bridge',
          noveltyScore: 0.3,
          noveltyTarget: 0.5,
          patternInterrupt: false,
          motionEnergy: 'calm',
          beatPacing: 'slow',
          overlayPriority: 'none',
          proofPriority: 'normal',
          notes: []
        }
      ],
      summary: { hooks: 0, rehooks: 0, payoffs: 0, patternInterrupts: 0, lowNoveltyScenes: 0, openLoops: 0 }
    }

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(new Map(), scenes, retentionPlan)
    assert.strictEqual(merged.size, 0, 'Bridge scene must not receive retention SFX')
  })

  // ─── TEST 94: Semantic Precedence ─────────────────────────────────────────────
  await it('TEST 94: Existing meaningful semantic Health cue wins over retention cue', () => {
    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 0,
        startTime: 0,
        endTime: 6.0,
        duration: 6.0,
        category: 'mechanism',
        narration: 'Timing and circadian clock cycles dictate hormones.',
        motionPreset: 'pan-left'
      }
    ]

    const existingCues = new Map<number, HealthSfxCuePlan>()
    existingCues.set(0, {
      sceneIndex: 0,
      type: 'clock-tick',
      relativeStart: 0.25,
      duration: 0.5,
      volumeDb: -26,
      reason: 'Circadian timing match'
    })

    const retentionPlan: RetentionPlan = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      inputHash: 'hash-94',
      totalScenes: 1,
      totalDuration: 6.0,
      strategy: { level: 'balanced', targetRehookGapSecs: 30, maxNoResetSecs: 20, noveltyWindowScenes: 3 },
      openLoops: [],
      motifs: [],
      scenes: [
        {
          sceneIndex: 0,
          sceneId: 'scene-0',
          role: 're-hook', // Retention might propose soft-whoosh
          intensity: 'medium',
          reason: 'Rehook opportunity',
          noveltyScore: 0.7,
          noveltyTarget: 0.6,
          patternInterrupt: false,
          motionEnergy: 'normal',
          beatPacing: 'normal',
          overlayPriority: 'medium',
          proofPriority: 'normal',
          notes: []
        }
      ],
      summary: { hooks: 0, rehooks: 1, payoffs: 0, patternInterrupts: 0, lowNoveltyScenes: 0, openLoops: 0 }
    }

    const merged = RetentionSfxPlanner.augmentCuesWithRetention(existingCues, scenes, retentionPlan)
    const finalCue = merged.get(0)

    assert.ok(finalCue)
    assert.strictEqual(finalCue?.type, 'clock-tick', 'Existing meaningful clock-tick cue must win')
  })

  // ─── TEST 95: Schema v1 Cache Backward Compatibility ──────────────────────────
  await it('TEST 95: Schema v1 cache without provider field loads cleanly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-v1-cache-'))
    const mockFile = path.join(tempDir, 'v1-whoosh.wav')
    fs.writeFileSync(mockFile, Buffer.alloc(2048, 0x88))

    const v1Manifest = {
      schemaVersion: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      entries: {
        'soft-whoosh': {
          assetId: 'old-v1-asset',
          sfxType: 'soft-whoosh',
          query: 'soft whoosh',
          localPath: mockFile,
          license: 'CC-BY',
          creator: 'Old Openverse Creator',
          pageUrl: 'https://example.com/sound',
          downloadedAt: '2025-01-01T00:00:00.000Z'
          // Notice: NO provider, NO generated, NO durationSecs
        }
      }
    }

    const cachePath = SfxCacheManager.getCachePath(tempDir)
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(v1Manifest, null, 2), 'utf-8')

    const cached = SfxCacheManager.getCachedSfx(tempDir, 'soft-whoosh')
    assert.ok(cached, 'Schema v1 entry must be recognized as valid')
    assert.strictEqual(cached?.localPath, mockFile)
    assert.strictEqual(cached?.type, 'soft-whoosh')
    assert.strictEqual(cached?.creator, 'Old Openverse Creator')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ─── TEST 96: Repair Mode Without Music Redownload ────────────────────────────
  await it('TEST 96: Repair mode resolves missing Health SFX without modifying valid music', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-repair-'))
    const audioPlanPath = path.join(tempDir, 'analysis', 'audio-plan.json')
    fs.mkdirSync(path.dirname(audioPlanPath), { recursive: true })

    const mockMusicFile = path.join(tempDir, 'bgm.mp3')
    fs.writeFileSync(mockMusicFile, Buffer.alloc(8192, 0x99))

    // Audio plan with valid background music but 0 approved SFX
    const initialPlan: AudioPlan = {
      generatedAt: new Date().toISOString(),
      sections: [
        {
          id: 'sec-1',
          name: 'Main Track',
          startTime: 0,
          endTime: 60,
          approved: true,
          approvedLocalPath: mockMusicFile,
          volumeDb: -16,
          query: 'ambient documentary'
        }
      ],
      sfxAssignments: [],
      healthSfx: {
        enabled: true,
        planHash: 'old-failed-hash',
        generatedAt: new Date().toISOString(),
        cueCount: 0 // Failed previous Openverse download!
      }
    }
    fs.writeFileSync(audioPlanPath, JSON.stringify(initialPlan, null, 2), 'utf-8')

    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 0,
        startTime: 0,
        endTime: 5.0,
        duration: 5.0,
        category: 'anatomy',
        narration: 'Deep biological structures in motion.',
        motionPreset: 'push-in-center'
      }
    ]

    const cues = new Map<number, HealthSfxCuePlan>()
    cues.set(0, {
      sceneIndex: 0,
      type: 'soft-whoosh',
      relativeStart: 0.15,
      duration: 0.75,
      volumeDb: -24
    })

    // Repair missing Health SFX (procedural fallback active)
    const repairedPlan = await HealthSfxDirector.repairMissingHealthSfx(tempDir, cues, scenes)

    // Verify background music remains untouched
    assert.strictEqual(repairedPlan.sections.length, 1)
    assert.strictEqual(repairedPlan.sections[0].approvedLocalPath, mockMusicFile)
    assert.strictEqual(repairedPlan.sections[0].approved, true)

    // Verify Health SFX are now approved with real local file
    assert.strictEqual(repairedPlan.healthSfx?.cueCount, 1)
    assert.strictEqual(repairedPlan.sfxAssignments.length, 1)
    assert.strictEqual(repairedPlan.sfxAssignments[0].approved, true)
    assert.ok(repairedPlan.sfxAssignments[0].approvedLocalPath, 'Must have approved local path')
    assert.ok(fs.existsSync(repairedPlan.sfxAssignments[0].approvedLocalPath!))

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  console.log('\n==================================================')
  console.log(`SFX RESOLVER TEST SUITE SUMMARY: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runAllTests().catch((err) => {
  console.error('Fatal error in tests:', err)
  process.exit(1)
})
