import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { _electron as electron } from 'playwright'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'
import { pipelineOrchestrator } from '../src/main/pipeline/pipeline-orchestrator'
import {
  createInitialPipelineState,
  createLease,
  computeInputFingerprint,
  loadPipelineState,
  normalizeProjectDir,
  savePipelineStateAtomic
} from '../src/main/pipeline/pipeline-state'
import {
  saveProductionModeSettings,
  loadProductionModeSettings
} from '../src/main/simple-assembly/production-mode-settings'
import {
  ensureManualAiPromptPack,
  loadManualAiPromptPack
} from '../src/main/visual-mix/manual-ai/manual-ai-prompt-pack'
import {
  planManualAiImport,
  commitManualAiImport
} from '../src/main/visual-mix/manual-ai/manual-ai-importer'
import { getManualAiStatus } from '../src/main/visual-mix/manual-ai/manual-ai-validator'
import { prepareManualAiVisualDirection } from '../src/main/visual-mix/manual-ai/manual-ai-visual-director'
import { manualAiAssetGate } from '../src/main/visual-mix/manual-ai/manual-ai-gate'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import {
  runAudioSearchStage,
  runPreflightStage,
  runRenderStage,
  runPostflightStage
} from '../src/main/pipeline/pipeline-stage-runners'
import { readRenderProvenance } from '../src/main/pipeline/render-provenance'
import { probeMedia } from '../src/main/render-cache/ffmpeg-process'
import type { AutoPipelineOptions, AutoPipelineState } from '../src/main/pipeline/pipeline-types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic: { path: string } = require('ffprobe-static')

const { it, finish } = createRunner('Part 21 — Real E2E & Electron Validation (Live-Switch-E2E)')

void (async () => {
  const testRoot = freshDir('live-switch-e2e')
  const projectDir = normalizeProjectDir(path.join(testRoot, 'Live-Switch-E2E'))
  const analysisDir = path.join(projectDir, 'analysis')
  const outputDir = path.join(projectDir, 'output')
  const externalImportDir = path.join(testRoot, 'external-ai-renders')
  fs.mkdirSync(analysisDir, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(externalImportDir, { recursive: true })

  // 1. Create 5-scene project script, 10.0s voiceover WAV, and 5 external 1080p PNG images
  const scriptPath = path.join(projectDir, 'script.txt')
  fs.writeFileSync(
    scriptPath,
    [
      'Scene 1: Deep inside every human cell, specialized organelles coordinate energy production.',
      'Scene 2: Mitochondria convert nutrients into adenosine triphosphate along folded membranes.',
      'Scene 3: Ribosomes translate messenger RNA sequences into structural protein chains.',
      'Scene 4: The Golgi apparatus packages molecular cargo into transport vesicles.',
      'Scene 5: Together, these cellular systems sustain tissue repair and metabolic balance.'
    ].join('\n\n'),
    'utf-8'
  )

  const voiceoverPath = path.join(projectDir, 'voiceover.wav')
  spawnSync(
    ffmpegPath,
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10.0', '-c:a', 'pcm_s16le', '-y', voiceoverPath],
    { stdio: 'ignore' }
  )

  const colors = ['navy', 'teal', 'darkslateblue', 'indigo', 'darkslategray']
  for (let i = 1; i <= 5; i++) {
    const extPng = path.join(externalImportDir, `S000${i}.png`)
    spawnSync(
      ffmpegPath,
      ['-f', 'lavfi', '-i', `color=c=${colors[i - 1]}:s=1920x1080:d=1.0`, '-frames:v', '1', '-y', extPng],
      { stdio: 'ignore' }
    )
  }

  // Write master-edit-plan.json for 5 scenes (2.0s each = 10.0s total)
  const editPlan = {
    chapters: [
      {
        chapterIndex: 0,
        title: 'Cellular Architecture',
        sequences: [
          {
            sequenceIndex: 0,
            scenes: [1, 2, 3, 4, 5].map((idx) => ({
              id: `scene_00${idx}`,
              sceneId: `scene_00${idx}`,
              sceneIndex: idx,
              narration: `Scene ${idx} cellular mechanism narration`,
              visualIntent: `Scientific 3D illustration of cellular organelle ${idx}`,
              startTime: (idx - 1) * 2.0,
              endTime: idx * 2.0,
              duration: 2.0,
              searchQueries: [`cell organelle ${idx}`]
            }))
          }
        ]
      }
    ]
  }
  fs.writeFileSync(path.join(analysisDir, 'master-edit-plan.json'), JSON.stringify(editPlan, null, 2), 'utf-8')

  // Save initial project preferences (Layer A): Full Smart Render + Add Music
  saveProductionModeSettings(projectDir, {
    assemblyMode: 'full-production',
    backgroundMusicMode: 'auto'
  })

  // Build Visual Mix Plan (100% AI / 0% Stock, Prompt mode) & Canonical Prompt Pack
  const visualMixConfig = {
    mode: 'custom-mix' as const,
    aiImageRatio: 1,
    stockFootageRatio: 0,
    aiImageMode: 'prompt' as const,
    imageOutputResolution: '1080p' as const
  }
  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projectDir)
  const vmPlan = VisualMixPlanner.buildPlan({
    projectDir,
    rawScenes,
    config: visualMixConfig,
    profile: 'health'
  })
  ensureManualAiPromptPack({
    projectDir,
    plan: vmPlan,
    profile: 'health',
    outputResolution: '1080p'
  })

  const runId = 'run-live-switch-e2e-001'
  const fp = computeInputFingerprint(projectDir, scriptPath, voiceoverPath)
  const initialOptions: AutoPipelineOptions = {
    projectDir,
    scriptPath,
    voiceoverPath,
    contentType: 'health',
    contentProfileMode: 'health',
    visualSourceMode: 'custom-mix',
    visualMixConfig,
    assemblyMode: 'full-production',
    backgroundMusicMode: 'auto',
    requireBackgroundMusic: false,
    outputName: 'Live-Switch-E2E'
  }

  const state = createInitialPipelineState(initialOptions, fp, runId)
  state.overallStatus = 'running'
  state.currentStage = 'stock-search'
  state.lease = createLease(runId, 'stock-search')
  state.stages.validating.status = 'completed'
  state.stages.transcribing.status = 'completed'
  state.stages.planning.status = 'completed'
  state.stages.captions.status = 'completed'
  state.stages['global-context'].status = 'completed'

  const initialManualStatus = getManualAiStatus(projectDir)
  state.stages['stock-search'] = {
    status: 'running',
    progress: 0,
    startedAt: new Date().toISOString(),
    message: 'Waiting for 5 AI images (0/5 ready)',
    manualAiWait: {
      expected: initialManualStatus.expected,
      ready: initialManualStatus.ready,
      missingSceneIndices: initialManualStatus.rows.filter((r) => r.status !== 'ready').map((r) => r.sceneIndex),
      promptFilePath: initialManualStatus.promptFilePath,
      stockExpected: 0,
      stockReady: 0
    }
  }
  savePipelineStateAtomic(projectDir, state)

  const activeInstances = (pipelineOrchestrator as any).activeInstances as Map<string, any>
  activeInstances.set(projectDir, {
    runId,
    projectDir,
    abortController: new AbortController(),
    stageStartTime: Date.now(),
    currentStage: 'stock-search',
    state,
    promise: new Promise<AutoPipelineState>(() => {})
  })

  try {
    let promptHashesBeforeSwitch: string[] = []

    await it('21.1 & 21.2: Project starts in Full Smart Render + Add Music and enters Manual AI waiting (0 / 5 Ready)', () => {
      assert.strictEqual(state.runId, runId)
      assert.strictEqual(state.currentStage, 'stock-search')
      assert.strictEqual(state.options.assemblyMode, 'full-production')
      assert.strictEqual(state.options.backgroundMusicMode, 'auto')
      assert.strictEqual(initialManualStatus.expected, 5)
      assert.strictEqual(initialManualStatus.ready, 0)
      promptHashesBeforeSwitch = initialManualStatus.rows.map((r) => r.promptHash)
      assert.strictEqual(promptHashesBeforeSwitch.length, 5)
    })

    let gateResolved = false
    const gatePromise = manualAiAssetGate
      .waitUntilReady({
        projectDir,
        pollIntervalMs: 5000,
        isReady: () => getManualAiStatus(projectDir).allReady
      })
      .then(() => {
        gateResolved = true
      })

    await it('21.3: Import first 3 scenes -> 3 / 5 Ready, 2 Missing, pipeline still waiting in stock-search with same runId', async () => {
      const files1to3 = [1, 2, 3].map((i) => path.join(externalImportDir, `S000${i}.png`))
      const plan1to3 = planManualAiImport({
        projectDir,
        filePaths: files1to3,
        mediaType: 'image'
      })
      assert.strictEqual(plan1to3.mappings.length, 3)

      const commit1to3 = await commitManualAiImport({
        projectDir,
        mappings: plan1to3.mappings
      })
      assert.strictEqual(commit1to3.imported.length, 3)
      assert.strictEqual(commit1to3.rejections.length, 0)

      const stAfter1to3 = getManualAiStatus(projectDir)
      assert.strictEqual(stAfter1to3.ready, 3)
      assert.strictEqual(stAfter1to3.missingSceneIndices.length, 2)

      // Update active stage wait info just like stock-search progress callback does
      state.stages['stock-search'].progress = 3 / 5
      state.stages['stock-search'].manualAiWait = {
        expected: 5,
        ready: 3,
        missingSceneIndices: [4, 5],
        promptFilePath: stAfter1to3.promptFilePath,
        stockExpected: 0,
        stockReady: 0
      }
      savePipelineStateAtomic(projectDir, state)
      manualAiAssetGate.notify(projectDir)

      await new Promise((r) => setTimeout(r, 30))
      assert.strictEqual(gateResolved, false, 'Gate must continue waiting at 3 / 5 Ready')
      assert.strictEqual(state.runId, runId)
      assert.strictEqual(state.currentStage, 'stock-search')
    })

    await it('21.4: Live mode switch (Full Smart Render -> Simple Assembly + No Music) preserves runId, 3/5 Ready, prompt hashes, and Layer A defaults', async () => {
      const switchResult = await pipelineOrchestrator.updateFinalRenderOptions({
        projectDir,
        runId,
        assemblyMode: 'simple-assembly',
        backgroundMusicMode: 'off'
      })

      assert.strictEqual(switchResult.success, true)
      assert.strictEqual(switchResult.appliedToActiveRun, true)
      assert.strictEqual(switchResult.runId, runId)
      assert.strictEqual(switchResult.effectiveAssemblyMode, 'simple-assembly')
      assert.strictEqual(switchResult.effectiveBackgroundMusicMode, 'off')

      // Verify state in memory and on disk
      assert.strictEqual(state.runId, runId)
      assert.strictEqual(state.currentStage, 'stock-search')
      assert.strictEqual(state.stages['stock-search'].manualAiWait?.ready, 3)
      assert.strictEqual(state.stages['stock-search'].manualAiWait?.expected, 5)
      assert.deepStrictEqual(state.stages['stock-search'].manualAiWait?.missingSceneIndices, [4, 5])

      const statusAfterSwitch = getManualAiStatus(projectDir)
      assert.strictEqual(statusAfterSwitch.ready, 3)
      assert.strictEqual(statusAfterSwitch.missingSceneIndices.length, 2)
      assert.deepStrictEqual(
        statusAfterSwitch.rows.map((r) => r.promptHash),
        promptHashesBeforeSwitch,
        'Prompt pack hashes must remain 100% unchanged'
      )

      const persisted = loadPipelineState(projectDir)
      assert.strictEqual(persisted?.options.assemblyMode, 'simple-assembly')
      assert.strictEqual(persisted?.options.backgroundMusicMode, 'off')
      assert.strictEqual(persisted?.renderSettings?.assemblyMode, 'simple-assembly')
      assert.strictEqual(persisted?.renderSettings?.backgroundMusicMode, 'off')

      // Layer A project defaults must still be Full Smart Render + Add Music
      const projectPrefs = loadProductionModeSettings(projectDir)
      assert.strictEqual(projectPrefs.assemblyMode, 'full-production')
      assert.strictEqual(projectPrefs.backgroundMusicMode, 'auto')
    })

    await it('21.5 & 21.6: Import remaining scenes 4–5 -> 5/5 Ready, gate resolves, Audio + Preflight + Simple Assembly Render + Postflight complete, FFprobe verifies MP4', async () => {
      const files4to5 = [4, 5].map((i) => path.join(externalImportDir, `S000${i}.png`))
      const plan4to5 = planManualAiImport({
        projectDir,
        filePaths: files4to5,
        mediaType: 'image'
      })
      assert.strictEqual(plan4to5.mappings.length, 2)

      const commit4to5 = await commitManualAiImport({
        projectDir,
        mappings: plan4to5.mappings
      })
      assert.strictEqual(commit4to5.imported.length, 2)
      assert.strictEqual(commit4to5.rejections.length, 0)

      const stAfter4to5 = getManualAiStatus(projectDir)
      assert.strictEqual(stAfter4to5.ready, 5)
      assert.strictEqual(stAfter4to5.missingSceneIndices.length, 0)
      assert.strictEqual(stAfter4to5.allReady, true)

      manualAiAssetGate.notify(projectDir)
      await gatePromise
      assert.strictEqual(gateResolved, true, 'manualAiAssetGate must resolve once 5/5 scenes are Ready')

      // Mark stock-search manual wait completed and advance to Audio -> Preflight -> Rendering -> Postflight
      delete state.stages['stock-search'].manualAiWait
      state.stages['stock-search'].stats = { manualAiWaitCompleted: true }
      state.stages['stock-search'].status = 'completed'

      // Audio stage with updated state.options (Simple Assembly + No Music)
      state.currentStage = 'audio-search'
      const audioRes = await runAudioSearchStage(state.options, () => {})
      assert.strictEqual(audioRes.success, true)
      assert.strictEqual(audioRes.stats?.downloadedMusicCount, 0)
      assert.strictEqual(audioRes.stats?.sfxCount, 0)
      state.stages['audio-search'].status = 'completed'

      // Preflight stage
      state.currentStage = 'preflight'
      const preflightRes = await runPreflightStage(state.options, () => {})
      assert.strictEqual(preflightRes.success, true)
      state.stages.preflight.status = 'completed'

      // Render stage — executes REAL FFmpeg Simple Assembly using state.options
      state.currentStage = 'rendering'
      const renderRes = await runRenderStage(state.options, () => {})
      assert.strictEqual(renderRes.success, true, `Render stage failed: ${renderRes.error ?? ''}`)
      assert.strictEqual(renderRes.stats?.assemblyMode, 'simple-assembly')
      assert.strictEqual(renderRes.stats?.backgroundMusicMode, 'off')
      assert.strictEqual(renderRes.stats?.remotionUsed, false)

      const outputPath = String(renderRes.data?.outputPath ?? '')
      assert.ok(outputPath && fs.existsSync(outputPath), 'Final MP4 must exist on disk')
      state.stages.rendering.status = 'completed'

      // Postflight stage
      state.currentStage = 'postflight'
      const postflightRes = await runPostflightStage(state.options, { outputPath }, () => {})
      assert.strictEqual(postflightRes.success, true)
      state.stages.postflight.status = 'completed'
      state.overallStatus = 'completed'
      state.completedAt = new Date().toISOString()
      savePipelineStateAtomic(projectDir, state)

      // Verify provenance
      const prov = readRenderProvenance(projectDir)
      assert.ok(prov)
      assert.strictEqual(prov?.assemblyMode, 'simple-assembly')
      assert.strictEqual(prov?.backgroundMusicMode, 'off')
      assert.strictEqual(prov?.status, 'completed')

      // Inspect MP4 with probeMedia + ffprobe-static
      const probe = await probeMedia(outputPath)
      assert.strictEqual(probe.hasVideo, true)
      assert.strictEqual(probe.hasAudio, true)
      assert.strictEqual(probe.width, 1920)
      assert.strictEqual(probe.height, 1080)
      assert.ok(probe.duration && Math.abs(probe.duration - 10.0) < 0.5, `Expected ~10.0s duration, got ${probe.duration}`)

      const ffprobeRaw = spawnSync(
        ffprobeStatic.path,
        ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate:format=duration,size', '-of', 'json', outputPath],
        { encoding: 'utf-8' }
      )
      const ffprobeJson = JSON.parse(ffprobeRaw.stdout)
      const videoStream = ffprobeJson.streams.find((s: any) => s.codec_type === 'video')
      const audioStream = ffprobeJson.streams.find((s: any) => s.codec_type === 'audio')
      assert.strictEqual(videoStream?.codec_name, 'h264')
      assert.strictEqual(videoStream?.width, 1920)
      assert.strictEqual(videoStream?.height, 1080)
      assert.strictEqual(audioStream?.codec_name, 'aac')
      assert.ok(Number(ffprobeJson.format?.size) > 1000)
    })

    await it('21.7: Real Electron app launch verifies renderer window loads cleanly, renders Production live-switch modal, applies Simple Assembly + No Music over IPC, and navigates without black screen', async () => {
      const mainEntry = path.resolve(__dirname, '../out/main/index.js')
      assert.strictEqual(fs.existsSync(mainEntry), true, 'out/main/index.js must be built before launching Electron')

      const cleanEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') {
          cleanEnv[k] = v
        }
      }
      cleanEnv.NODE_ENV = 'production'

      const electronApp = await electron.launch({
        args: [mainEntry],
        env: cleanEnv
      })

      const pageErrors: string[] = []
      let uiProjectDir = ''
      try {
        const appWindow = await electronApp.firstWindow()
        appWindow.on('pageerror', (err) => {
          pageErrors.push(err.message)
        })

        await appWindow.waitForLoadState('domcontentloaded')
        await appWindow.waitForTimeout(800)

        // Verify root rendered without black screen or error boundary crash
        const rootInfo = await appWindow.evaluate(() => {
          const root = document.getElementById('root')
          const hasBridge = typeof (globalThis as any).api?.pipeline?.updateFinalRenderOptions === 'function'
          return {
            rootHtmlLength: root?.innerHTML.length ?? 0,
            bodyText: document.body.innerText.slice(0, 300),
            hasBridge
          }
        })

        assert.ok(rootInfo.rootHtmlLength > 100, 'Renderer #root must render non-empty UI (no black screen)')
        assert.strictEqual(rootInfo.hasBridge, true, 'Preload bridge must expose window.api.pipeline.updateFinalRenderOptions')
        assert.strictEqual(
          rootInfo.bodyText.includes('Application Render Error'),
          false,
          'AppErrorBoundary must not be triggered'
        )

        const baseProjectsDir = await appWindow.evaluate(async () => {
          return await (globalThis as any).api.project.getDir()
        })
        const uiProjectName = `Live-Switch-UI-E2E-${Date.now()}`

        await appWindow.click('#btn-new-project')
        await appWindow.fill('.modal-input', uiProjectName)
        await appWindow.click('button[type="submit"]')
        await appWindow.waitForTimeout(400)

        uiProjectDir = normalizeProjectDir(path.join(baseProjectsDir, uiProjectName))
        const uiAnalysisDir = path.join(uiProjectDir, 'analysis')
        fs.mkdirSync(uiAnalysisDir, { recursive: true })

        // Seed cached upstream artifacts and 3/5 ready manual AI scenes for Live-Switch-UI-E2E
        const uiScriptPath = path.join(uiProjectDir, 'script.txt')
        const uiVoPath = path.join(uiProjectDir, 'voiceover.wav')
        fs.copyFileSync(scriptPath, uiScriptPath)
        fs.copyFileSync(voiceoverPath, uiVoPath)
        const voStat = fs.statSync(uiVoPath)
        fs.writeFileSync(
          path.join(uiAnalysisDir, 'transcript.json'),
          JSON.stringify({
            language: 'en',
            duration: 10,
            segments: [{ id: 's1', text: 'Cellular architecture', start: 0, end: 10, duration: 10, words: [] }],
            fullText: 'Cellular architecture',
            wordCount: 2,
            generatedAt: new Date().toISOString()
          }),
          'utf-8'
        )
        fs.writeFileSync(
          path.join(uiAnalysisDir, 'transcript-meta.json'),
          JSON.stringify({
            hash: `${uiVoPath}:${voStat.size}:${voStat.mtimeMs}`,
            model: 'base',
            generatedAt: new Date().toISOString()
          }),
          'utf-8'
        )
        fs.copyFileSync(
          path.join(analysisDir, 'master-edit-plan.json'),
          path.join(uiAnalysisDir, 'master-edit-plan.json')
        )
        fs.writeFileSync(
          path.join(uiAnalysisDir, 'caption-plan.json'),
          JSON.stringify({ enabled: true, activeRanges: [], phrases: [] }),
          'utf-8'
        )
        fs.writeFileSync(
          path.join(uiAnalysisDir, 'global-script-context.json'),
          JSON.stringify({ primarySubject: 'Human cell', overallTheme: 'Biology' }),
          'utf-8'
        )
        const uiRawScenes = VisualMixPlanner.loadScenesFromEditPlan(uiProjectDir)
        const uiVmPlan = VisualMixPlanner.buildPlan({
          projectDir: uiProjectDir,
          rawScenes: uiRawScenes,
          config: visualMixConfig,
          profile: 'health'
        })
        const directorBundle = await prepareManualAiVisualDirection({
          projectDir: uiProjectDir,
          plan: uiVmPlan,
          profile: 'health',
          globalContext: { primarySubject: 'Human cell', overallTheme: 'Biology' } as any,
          scriptText: 'Cellular architecture',
          apiKey: ''
        })
        ensureManualAiPromptPack({
          projectDir: uiProjectDir,
          plan: uiVmPlan,
          profile: 'health',
          outputResolution: '1080p',
          directorBundle
        })
        const uiPlan1to3 = planManualAiImport({
          projectDir: uiProjectDir,
          filePaths: [1, 2, 3].map((i) => path.join(externalImportDir, `S000${i}.png`)),
          mediaType: 'image'
        })
        await commitManualAiImport({
          projectDir: uiProjectDir,
          mappings: uiPlan1to3.mappings
        })

        const uiFp = computeInputFingerprint(uiProjectDir, uiScriptPath, uiVoPath)
        const uiInitialOptions: AutoPipelineOptions = {
          projectDir: uiProjectDir,
          scriptPath: uiScriptPath,
          voiceoverPath: uiVoPath,
          contentType: 'health',
          contentProfileMode: 'health',
          visualSourceMode: 'custom-mix',
          visualMixConfig: {
            mode: 'custom-mix',
            aiImageRatio: 1,
            stockFootageRatio: 0,
            aiImageMode: 'prompt',
            imageOutputResolution: '1080p'
          },
          assemblyMode: 'full-production',
          backgroundMusicMode: 'auto'
        }
        const uiSeededState = createInitialPipelineState(uiInitialOptions, uiFp, 'run-ui-seeded')
        uiSeededState.overallStatus = 'interrupted'
        uiSeededState.stages.validating.status = 'completed'
        uiSeededState.stages.transcribing.status = 'completed'
        uiSeededState.stages.planning.status = 'completed'
        uiSeededState.stages.captions.status = 'completed'
        uiSeededState.stages['global-context'].status = 'completed'
        savePipelineStateAtomic(uiProjectDir, uiSeededState)

        // Start pipeline inside the real Electron app so it enters stock-search waiting for scenes 4 & 5
        await appWindow.evaluate(
          async (args: { projDir: string; sPath: string; vPath: string }) => {
            await (globalThis as any).api.project.updateInputs(args.projDir, {
              scriptPath: args.sPath,
              voiceoverPath: args.vPath
            })
            void (globalThis as any).api.pipeline.start({
              projectDir: args.projDir,
              scriptPath: args.sPath,
              voiceoverPath: args.vPath,
              contentType: 'health',
              contentProfileMode: 'health',
              visualSourceMode: 'custom-mix',
              visualMixConfig: {
                mode: 'custom-mix',
                aiImageRatio: 1,
                stockFootageRatio: 0,
                aiImageMode: 'prompt',
                imageOutputResolution: '1080p'
              },
              assemblyMode: 'full-production',
              backgroundMusicMode: 'auto'
            })
          },
          { projDir: uiProjectDir, sPath: uiScriptPath, vPath: uiVoPath }
        )

        // Wait for real Electron UI to show ActiveRunRenderSettings in Production
        await appWindow.waitForSelector('[data-testid="active-run-render-settings"]', { timeout: 8000 })
        await appWindow.waitForSelector('[data-testid="change-final-render-mode-btn"]', { timeout: 10000 })
        const modeBeforeText = await appWindow.textContent('[data-testid="active-run-assembly-mode-badge"]')
        const musicBeforeText = await appWindow.textContent('[data-testid="active-run-music-mode-badge"]')
        assert.strictEqual(modeBeforeText?.trim(), 'Full Smart Render')
        assert.strictEqual(musicBeforeText?.trim(), 'Add Music')

        // Click Change Final Render Mode in real Electron UI
        await appWindow.click('[data-testid="change-final-render-mode-btn"]')
        await appWindow.waitForSelector('[data-testid="change-final-render-modal"]', { timeout: 3000 })

        // Select Simple Assembly + No Music and click Apply to Current Run
        await appWindow.click('[data-testid="radio-assembly-simple"]')
        await appWindow.click('[data-testid="radio-music-off"]')
        await appWindow.click('[data-testid="modal-apply-btn"]')
        await appWindow.waitForTimeout(400)

        // Verify real Electron UI updated to Simple Assembly + No Music
        const modeAfterText = await appWindow.textContent('[data-testid="active-run-assembly-mode-badge"]')
        const musicAfterText = await appWindow.textContent('[data-testid="active-run-music-mode-badge"]')
        assert.strictEqual(modeAfterText?.trim(), 'Simple Assembly')
        assert.strictEqual(musicAfterText?.trim(), 'No Music')

        // Navigate Setup -> Production -> Export -> Production and verify no black screen and mode preserved
        await appWindow.click('text=2. Setup')
        await appWindow.waitForTimeout(250)
        await appWindow.click('text=3. Production')
        await appWindow.waitForSelector('[data-testid="active-run-render-settings"]', { timeout: 3000 })
        const modeAfterNav = await appWindow.textContent('[data-testid="active-run-assembly-mode-badge"]')
        const musicAfterNav = await appWindow.textContent('[data-testid="active-run-music-mode-badge"]')
        assert.strictEqual(modeAfterNav?.trim(), 'Simple Assembly')
        assert.strictEqual(musicAfterNav?.trim(), 'No Music')

        await appWindow.click('text=5. Export')
        await appWindow.waitForTimeout(250)
        const exportHtmlLen = await appWindow.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0)
        assert.ok(exportHtmlLen > 100, 'Export page must render without black screen')

        assert.strictEqual(pageErrors.length, 0, `Unexpected renderer page errors: ${pageErrors.join('; ')}`)
      } finally {
        if (uiProjectDir) {
          try {
            await electronApp.firstWindow().then((w) =>
              w.evaluate((dir: string) => (globalThis as any).api.pipeline.cancel(dir), uiProjectDir)
            )
          } catch {
            /* ignore */
          }
        }
        await electronApp.close()
        if (uiProjectDir && fs.existsSync(uiProjectDir)) {
          try {
            fs.rmSync(uiProjectDir, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
      }
    })
  } finally {
    activeInstances.delete(projectDir)
  }

  await finish()
})()
