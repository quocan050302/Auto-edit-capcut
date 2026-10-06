/**
 * Automated Unit Tests for Health SFX Director
 * (src/main/health/health-sfx-director.ts)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  HealthSfxDirector,
  SfxDirectorSceneInput,
  HEALTH_SFX_PARAMS,
  HEALTH_SFX_QUERIES
} from '../src/main/health/health-sfx-director'
import type { AudioPlan, HealthSfxType } from '../shared/types'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING HEALTH SFX DIRECTOR UNIT TESTS')
  console.log('==================================================\n')

  // TEST M: Health SFX density does not exceed configured maximum (~25-35%)
  await it('TEST M: Health SFX density target (25-35%, does not spam every scene)', () => {
    const scenes: SfxDirectorSceneInput[] = []
    let currentTime = 0
    for (let i = 1; i <= 30; i++) {
      const duration = 4.0
      scenes.push({
        sceneIndex: i,
        startTime: currentTime,
        endTime: currentTime + duration,
        duration,
        category: i % 2 === 0 ? 'mechanism' : 'anatomy',
        narration: `Scene ${i} details showing internal cellular pathways and biological response.`,
        motionPreset: i % 2 === 0 ? 'pan-right' : 'push-in-center'
      })
      currentTime += duration
    }

    const cues = HealthSfxDirector.planSfxCues(scenes)
    const ratio = cues.size / scenes.length

    // Density should be around 25-35%, definitely <= 40% and > 10%
    assert.ok(
      ratio <= 0.40,
      `SFX density ${cues.size}/${scenes.length} (${(ratio * 100).toFixed(1)}%) exceeded 40% maximum`
    )
    assert.ok(
      ratio >= 0.15,
      `SFX density ${cues.size}/${scenes.length} (${(ratio * 100).toFixed(1)}%) is too low`
    )
  })

  // TEST N: Health SFX cooldown works (>= 5s between cues, >= 12s for strong accents)
  await it('TEST N: Cooldown enforced between consecutive SFX cues', () => {
    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 1,
        startTime: 0,
        endTime: 3,
        duration: 3,
        category: 'anatomy',
        narration: 'Heart beating rhythmically inside chest.',
        motionPreset: 'gentle-pulse'
      },
      {
        sceneIndex: 2,
        startTime: 3,
        endTime: 6,
        duration: 3,
        category: 'anatomy',
        narration: 'Cardiac muscle contractions pump blood.',
        motionPreset: 'gentle-pulse'
      },
      {
        sceneIndex: 3,
        startTime: 6,
        endTime: 12,
        duration: 6,
        category: 'mechanism',
        narration: 'Blood moves rapidly across vessels.',
        motionPreset: 'pan-left'
      }
    ]

    const cues = HealthSfxDirector.planSfxCues(scenes)
    // Scene 1 (heartbeat) starts at 0 + 0.15 = 0.15s
    // Scene 2 starts at 3.0s, which is only 2.85s after scene 1 -> MUST be skipped by 5s cooldown!
    assert.ok(cues.has(1), 'Scene 1 should have cue')
    assert.ok(!cues.has(2), 'Scene 2 must be skipped due to 5s cooldown')
    assert.ok(cues.has(3), 'Scene 3 (at 6s, 5.85s after scene 1) should be allowed')
  })

  // TEST O: Same SFX type is not spammed consecutively
  await it('TEST O: Same SFX type is not used more than twice consecutively', () => {
    const scenes: SfxDirectorSceneInput[] = []
    let currentTime = 0
    for (let i = 1; i <= 10; i++) {
      scenes.push({
        sceneIndex: i,
        startTime: currentTime,
        endTime: currentTime + 6.0,
        duration: 6.0,
        category: 'mechanism',
        narration: 'Receptor signal scan active inside cell.',
        motionPreset: 'drift-up-left'
      })
      currentTime += 6.0
    }

    const cues = HealthSfxDirector.planSfxCues(scenes)
    let consecutiveCount = 0
    let lastType: HealthSfxType | '' = ''
    let maxConsecutive = 0

    for (const cue of cues.values()) {
      if (cue.type === lastType) {
        consecutiveCount++
      } else {
        lastType = cue.type
        consecutiveCount = 1
      }
      if (consecutiveCount > maxConsecutive) {
        maxConsecutive = consecutiveCount
      }
    }

    assert.ok(
      maxConsecutive <= 2,
      `Expected max consecutive identical SFX <= 2, got ${maxConsecutive}`
    )
  })

  // TEST P & Q: Health SFX gets auto-approved and receives valid local path
  await it('TEST P & Q: Health SFX gets auto-approved with valid local path in audio plan', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-sfx-test-'))
    const mockAudioDir = HealthSfxDirector.getAudioDir(tempDir)
    fs.mkdirSync(mockAudioDir, { recursive: true })

    // Create a mock downloaded sound file
    const mockWhooshPath = path.join(mockAudioDir, 'soft-whoosh.wav')
    fs.writeFileSync(mockWhooshPath, Buffer.alloc(2048, 0x55))

    // Pre-populate cache so it reuses local file instead of network call
    const manifest = HealthSfxDirector.loadCacheManifest(tempDir)
    manifest.entries['soft-whoosh'] = {
      assetId: 'mock-whoosh-1',
      sfxType: 'soft-whoosh',
      query: 'soft whoosh',
      localPath: mockWhooshPath,
      license: 'CC0',
      creator: 'Test Creator',
      downloadedAt: new Date().toISOString()
    }
    HealthSfxDirector.saveCacheManifest(tempDir, manifest)

    const scenes: SfxDirectorSceneInput[] = [
      {
        sceneIndex: 1,
        startTime: 0,
        endTime: 5,
        duration: 5,
        category: 'anatomy',
        narration: 'Deep inside the organ structure.',
        motionPreset: 'push-in-center'
      }
    ]

    const cues = new Map()
    cues.set(1, {
      sceneIndex: 1,
      type: 'soft-whoosh' as HealthSfxType,
      queryCandidates: HEALTH_SFX_QUERIES['soft-whoosh'],
      relativeStart: 0.15,
      duration: 0.75,
      volumeDb: -24,
      reason: 'Soft whoosh test',
      strength: 'subtle' as const
    })

    const audioPlan = await HealthSfxDirector.applyHealthSfxToAudioPlan(tempDir, cues, scenes)

    assert.ok(audioPlan.healthSfx?.enabled, 'Health SFX should be marked enabled in AudioPlan')
    assert.strictEqual(audioPlan.healthSfx?.cueCount, 1, 'Cue count should be 1')
    assert.strictEqual(audioPlan.sfxAssignments.length, 1, 'Should have 1 SFX assignment')

    const assignment = audioPlan.sfxAssignments[0]
    assert.strictEqual(assignment.approved, true, 'TEST P: Health SFX must be auto-approved')
    assert.strictEqual(assignment.approvedLocalPath, mockWhooshPath, 'TEST Q: Approved local path must be set')
    assert.strictEqual(assignment.volumeDb, -24, 'Volume DB should match cue')

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // TEST R: Cached Health SFX is reused without redundant download
  await it('TEST R: Cached Health SFX is reused from manifest', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-sfx-cache-test-'))
    const mockAudioDir = HealthSfxDirector.getAudioDir(tempDir)
    fs.mkdirSync(mockAudioDir, { recursive: true })

    const mockScanPath = path.join(mockAudioDir, 'digital-scan.wav')
    fs.writeFileSync(mockScanPath, Buffer.alloc(4096, 0x12))

    const manifest = HealthSfxDirector.loadCacheManifest(tempDir)
    manifest.entries['digital-scan'] = {
      assetId: 'mock-scan-id',
      sfxType: 'digital-scan',
      query: 'digital scan',
      localPath: mockScanPath,
      license: 'CC-BY',
      creator: 'Test Creator',
      downloadedAt: new Date().toISOString()
    }
    HealthSfxDirector.saveCacheManifest(tempDir, manifest)

    // Resolve should read from cache directly
    const resolved = await HealthSfxDirector.resolveAndDownloadSfxTypes(tempDir, ['digital-scan'])
    assert.strictEqual(resolved.get('digital-scan'), mockScanPath, 'Should reuse cached local path')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // TEST S: Default SFX behavior remains unchanged
  await it('TEST S: AudioPlan retains non-health assignments without modification', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-sfx-test-'))
    const audioPlanPath = path.join(tempDir, 'analysis', 'audio-plan.json')
    fs.mkdirSync(path.dirname(audioPlanPath), { recursive: true })

    const initialPlan: AudioPlan = {
      generatedAt: new Date().toISOString(),
      sections: [],
      sfxAssignments: [
        {
          sceneIndex: 99,
          startTime: 100,
          endTime: 102,
          sfxQuery: 'custom-explosion',
          approved: false, // Default mode remains unapproved until user action
          volumeDb: -18
        }
      ]
    }
    fs.writeFileSync(audioPlanPath, JSON.stringify(initialPlan, null, 2), 'utf-8')

    // Apply empty health cues
    const updatedPlan = await HealthSfxDirector.applyHealthSfxToAudioPlan(tempDir, new Map(), [])

    const defaultAssignment = updatedPlan.sfxAssignments.find((a) => a.sceneIndex === 99)
    assert.ok(defaultAssignment, 'Non-health SFX assignment should be retained')
    assert.strictEqual(defaultAssignment?.approved, false, 'Default SFX must remain unapproved')
    assert.strictEqual(defaultAssignment?.sfxQuery, 'custom-explosion')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  console.log('\n==================================================')
  console.log(`HEALTH SFX DIRECTOR TEST SUMMARY: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
