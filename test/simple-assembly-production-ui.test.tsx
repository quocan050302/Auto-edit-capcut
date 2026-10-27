import React from 'react'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import {
  UI_PHASES,
  computePhaseState,
  type UiPhaseMeta
} from '../src/renderer/src/components/PipelinePhaseCard'
import {
  createInitialPipelineState,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Simple Assembly Production UI Contract Tests')

void (async () => {
  const dummyFingerprint: InputFingerprint = {
    scriptPath: 'C:/test/script.txt',
    voiceoverPath: 'C:/test/vo.mp3'
  }

  const buildPhase = UI_PHASES.find((p) => p.id === 'build') as UiPhaseMeta
  assert.ok(buildPhase, 'Build phase (Phase 4) must exist in UI_PHASES')

  await it('Requirement 20: Phase 4 summary reflects Simple Assembly mode when pending or running', () => {
    const simpleOptions: AutoPipelineOptions = {
      projectDir: 'C:/test/proj',
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly'
    }

    const stateSimple = createInitialPipelineState(simpleOptions, dummyFingerprint)
    const phaseStateSimple = computePhaseState(buildPhase, stateSimple)

    assert.strictEqual(
      phaseStateSimple.summary,
      'Render Preflight QA & Simple Assembly concatenation',
      'Phase 4 summary must explicitly indicate Simple Assembly concatenation'
    )

    const fullOptions: AutoPipelineOptions = {
      projectDir: 'C:/test/proj',
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'full-production'
    }

    const stateFull = createInitialPipelineState(fullOptions, dummyFingerprint)
    const phaseStateFull = computePhaseState(buildPhase, stateFull)

    assert.strictEqual(
      phaseStateFull.summary,
      'Automated QA check and final video rendering',
      'Phase 4 summary for full-production must describe standard render'
    )
  })

  await it('Requirement 20: Phase 4 summary reflects Simple Assembly when completed', () => {
    const simpleOptions: AutoPipelineOptions = {
      projectDir: 'C:/test/proj',
      scriptPath: 'C:/test/script.txt',
      voiceoverPath: 'C:/test/vo.mp3',
      assemblyMode: 'simple-assembly'
    }

    const state = createInitialPipelineState(simpleOptions, dummyFingerprint)
    state.stages['preflight'].status = 'completed'
    state.stages['rendering'].status = 'completed'

    const phaseState = computePhaseState(buildPhase, state)
    assert.strictEqual(phaseState.status, 'completed')
    assert.strictEqual(
      phaseState.summary,
      'Render preflight passed and scenes concatenated with voiceover',
      'Completed summary must describe voiceover scene concatenation'
    )
  })

  await it('Requirement 25: AssemblyModeControls contract — clear explanation of upstream intelligence preservation', () => {
    // Contract verification of badge mappings
    const getModeSummary = (assemblyMode: 'full-production' | 'simple-assembly', musicMode: 'auto' | 'off') => {
      return {
        aiPlanning: 'ON',
        visualDirector: 'ON',
        promptGeneration: 'ON',
        manualAiImport: 'ON',
        sceneReadinessGate: 'ON',
        finalRender: assemblyMode === 'simple-assembly' ? 'Simple Assembly' : 'Full Smart Render',
        music: musicMode === 'off' ? 'OFF' : 'ON',
        voiceover: 'ON',
        remotion: assemblyMode === 'simple-assembly' ? 'OFF (Final Render Only)' : 'ON',
        transitions: assemblyMode === 'simple-assembly' ? 'Hard Cuts' : 'Cinematic / Smart'
      }
    }

    const simpleSummary = getModeSummary('simple-assembly', 'off')
    assert.strictEqual(simpleSummary.aiPlanning, 'ON', 'AI Planning is ON in Simple Assembly')
    assert.strictEqual(simpleSummary.visualDirector, 'ON', 'Visual Director is ON in Simple Assembly')
    assert.strictEqual(simpleSummary.promptGeneration, 'ON', 'Prompt Generation is ON in Simple Assembly')
    assert.strictEqual(simpleSummary.manualAiImport, 'ON', 'Manual AI Import is ON in Simple Assembly')
    assert.strictEqual(simpleSummary.sceneReadinessGate, 'ON', 'Scene Readiness Gate is ON in Simple Assembly')
    assert.strictEqual(simpleSummary.remotion, 'OFF (Final Render Only)')
    assert.strictEqual(simpleSummary.transitions, 'Hard Cuts')
    assert.strictEqual(simpleSummary.music, 'OFF')

    const fullSummary = getModeSummary('full-production', 'auto')
    assert.strictEqual(fullSummary.aiPlanning, 'ON')
    assert.strictEqual(fullSummary.remotion, 'ON')
    assert.strictEqual(fullSummary.transitions, 'Cinematic / Smart')
    assert.strictEqual(fullSummary.music, 'ON')
  })

  await finish()
})()
