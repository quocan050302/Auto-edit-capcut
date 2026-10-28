import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { assert, createRunner } from './manual-ai-test-utils'
import {
  ActiveRunRenderSettings,
  resolveActiveRunEffectiveSettings,
  formatAssemblyModeLabel,
  formatMusicModeLabel,
  computeWillChangeSummary,
  SIMPLE_ASSEMBLY_EXPLANATION,
  NO_MUSIC_EXPLANATION,
  PRESERVED_PRODUCTION_ITEMS
} from '../src/renderer/src/components/ActiveRunRenderSettings'
import { mergeIncomingPipelineState } from '../src/renderer/src/hooks/usePipeline'
import { computePhaseState, UI_PHASES, type UiPhaseMeta } from '../src/renderer/src/components/PipelinePhaseCard'
import {
  createInitialPipelineState,
  toSnapshot,
  type InputFingerprint
} from '../src/main/pipeline/pipeline-state'
import type { AutoPipelineOptions } from '../src/main/pipeline/pipeline-types'

const { it, finish } = createRunner('Live Final Render Mode Production UI Tests')

void (async () => {
  const fp: InputFingerprint = {
    scriptPath: 'C:/test/script.txt',
    voiceoverPath: 'C:/test/vo.wav'
  }

  const baseOptions: AutoPipelineOptions = {
    projectDir: 'C:/test/proj',
    scriptPath: 'C:/test/script.txt',
    voiceoverPath: 'C:/test/vo.wav',
    assemblyMode: 'full-production',
    backgroundMusicMode: 'off'
  }

  await it('19.20: Stale progress event with older version never reverts the newly accepted mode in UI state', () => {
    const initialState = createInitialPipelineState(baseOptions, fp, 'run-ui-1')
    initialState.version = 5
    initialState.overallStatus = 'running'
    initialState.currentStage = 'stock-search'

    // Stale snapshot from version 5 (still Full Production)
    const staleSnapshot = toSnapshot(initialState)

    // Accepted live update advances version to 6 with Simple Assembly + No Music
    const updatedState = {
      ...initialState,
      version: 6,
      options: {
        ...initialState.options,
        assemblyMode: 'simple-assembly' as const,
        backgroundMusicMode: 'off' as const
      },
      renderSettings: {
        assemblyMode: 'simple-assembly' as const,
        backgroundMusicMode: 'off' as const
      }
    }

    const afterAccept = mergeIncomingPipelineState(initialState, updatedState)
    assert.strictEqual(afterAccept?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(afterAccept?.options?.assemblyMode, 'simple-assembly')

    // Late arrival of staleSnapshot (version 5 < version 6) must be ignored
    const afterStaleEvent = mergeIncomingPipelineState(afterAccept, staleSnapshot)
    assert.strictEqual(afterStaleEvent?.version, 6)
    assert.strictEqual(afterStaleEvent?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(afterStaleEvent?.options?.assemblyMode, 'simple-assembly')

    // Newer progress snapshot (version 7) without full options preserves options and renderSettings
    const newerProgressSnapshot = {
      ...toSnapshot(updatedState),
      version: 7
    }
    const afterNewerProgress = mergeIncomingPipelineState(afterStaleEvent, newerProgressSnapshot)
    assert.strictEqual(afterNewerProgress?.version, 7)
    assert.strictEqual(afterNewerProgress?.renderSettings?.assemblyMode, 'simple-assembly')
    assert.strictEqual(afterNewerProgress?.options?.assemblyMode, 'simple-assembly')
  })

  await it('19.21: UI unmount / navigation to Setup and back keeps accepted active-run mode visible', () => {
    const waitingState = createInitialPipelineState(
      {
        ...baseOptions,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      },
      fp,
      'run-nav-persist'
    )
    waitingState.overallStatus = 'running'
    waitingState.currentStage = 'stock-search'
    waitingState.stages['stock-search'] = {
      status: 'running',
      progress: 80 / 131,
      manualAiWait: {
        expected: 131,
        ready: 80,
        missingSceneIndices: [81],
        promptFilePath: 'C:/test/proj/analysis/manual-ai-prompts.v1.json',
        stockExpected: 0,
        stockReady: 0
      }
    }

    // First mount in Production
    const htmlMount1 = renderToStaticMarkup(
      React.createElement(ActiveRunRenderSettings, {
        projectDir: waitingState.projectDir,
        pipelineState: waitingState
      })
    )
    assert.ok(htmlMount1.includes('FINAL RENDER SETTINGS'))
    assert.ok(htmlMount1.includes('Simple Assembly'))
    assert.ok(htmlMount1.includes('No Music'))
    assert.ok(htmlMount1.includes('Change Final Render Mode'))
    assert.ok(htmlMount1.includes('AI Assets 80 / 131 Ready'))

    // Simulate navigating to Setup (unmount) and re-mounting Production with snapshot from getStatus
    const snapshotReloaded = toSnapshot(waitingState) as any
    const htmlMount2 = renderToStaticMarkup(
      React.createElement(ActiveRunRenderSettings, {
        projectDir: waitingState.projectDir,
        pipelineState: snapshotReloaded
      })
    )
    assert.ok(htmlMount2.includes('Simple Assembly'))
    assert.ok(htmlMount2.includes('No Music'))
    assert.ok(htmlMount2.includes('Change Final Render Mode'))

    const effective = resolveActiveRunEffectiveSettings(snapshotReloaded)
    assert.strictEqual(effective.assemblyMode, 'simple-assembly')
    assert.strictEqual(effective.backgroundMusicMode, 'off')
  })

  await it('Part 11.2 & 11.8–11.9: Read-only mode when not eligible, and accurate confirmation summary & explanations', () => {
    const renderingState = createInitialPipelineState(baseOptions, fp, 'run-rendering')
    renderingState.overallStatus = 'running'
    renderingState.currentStage = 'rendering'
    renderingState.stages['stock-search'].status = 'completed'
    renderingState.stages['audio-search'].status = 'completed'
    renderingState.stages.preflight.status = 'completed'
    renderingState.stages.rendering.status = 'running'

    const htmlReadOnly = renderToStaticMarkup(
      React.createElement(ActiveRunRenderSettings, {
        projectDir: renderingState.projectDir,
        pipelineState: renderingState
      })
    )
    assert.ok(htmlReadOnly.includes('Read-only for current stage'))
    assert.strictEqual(
      htmlReadOnly.includes('Change Final Render Mode'),
      false,
      'Live-edit button must NOT render when stage is rendering'
    )

    // Verify explanations and preservation list
    assert.ok(SIMPLE_ASSEMBLY_EXPLANATION.includes('All intelligent production stages remain unchanged'))
    assert.ok(NO_MUSIC_EXPLANATION.includes('without background music'))
    assert.strictEqual(PRESERVED_PRODUCTION_ITEMS.includes('AI Planning'), true)
    assert.strictEqual(PRESERVED_PRODUCTION_ITEMS.includes('Imported Scenes'), true)
    assert.strictEqual(formatAssemblyModeLabel('full-production'), 'Full Smart Render')
    assert.strictEqual(formatAssemblyModeLabel('simple-assembly'), 'Simple Assembly')
    assert.strictEqual(formatMusicModeLabel('auto'), 'Add Music')
    assert.strictEqual(formatMusicModeLabel('off'), 'No Music')

    const changes = computeWillChangeSummary(
      { assemblyMode: 'full-production', backgroundMusicMode: 'off' },
      { assemblyMode: 'simple-assembly', backgroundMusicMode: 'off' }
    )
    assert.deepStrictEqual(changes, ['Final Rendering Strategy'])

    // Verify Phase 4 build card also reads snapshot.renderSettings
    const buildPhase = UI_PHASES.find((p) => p.id === 'build') as UiPhaseMeta
    const snapshotOnly = {
      ...toSnapshot(renderingState),
      currentStage: 'stock-search' as const,
      stages: {
        ...renderingState.stages,
        preflight: { ...renderingState.stages.preflight, status: 'pending' as const },
        rendering: { ...renderingState.stages.rendering, status: 'pending' as const }
      },
      renderSettings: {
        assemblyMode: 'simple-assembly' as const,
        backgroundMusicMode: 'off' as const
      }
    } as any
    const phaseSummary = computePhaseState(buildPhase, snapshotOnly)
    assert.strictEqual(
      phaseSummary.summary,
      'Render Preflight QA & Simple Assembly concatenation'
    )
  })

  await finish()
})()

