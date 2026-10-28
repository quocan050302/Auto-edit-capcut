# QA Report: Live Final Render Strategy Switch During Manual AI Import Wait (V1)

## 1. Repository, Branch, Base QA Commit SHA, and Final Commit SHA

- **Repository:** [https://github.com/quocan050302/Auto-edit-capcut](https://github.com/quocan050302/Auto-edit-capcut)
- **Feature Branch:** `feature/qa-live-render-mode-switch-v1`
- **PR Target Branch:** `QA`
- **Verified Base QA Commit SHA:** `acb43ef33d5cefb127723cd57f15126bb1f53e73`
- **Feature Implementation Commit SHA:** `200787b83608981f2d7e8974fc22fb5fb908f256`

---

## 2. Problem Summary

Previously, users selected the final video rendering strategy (`assemblyMode`: `full-production` vs `simple-assembly`) and background music mode (`backgroundMusicMode`: `auto` vs `off`) exclusively in **Step 2 — Setup** before starting Auto Production.

In long-form Custom Mix / Prompt Mode projects (e.g., 131 scenes), after **AI Planning**, **Visual Director**, and **Prompt Pack Generation** complete, the pipeline enters the `stock-search` Manual AI waiting period (`manualAiAssetGate.waitUntilReady()`) while the user imports externally generated AI images/videos. If a user had already imported 80 of 131 scenes and decided to switch the final rendering strategy from **Full Smart Render** to **Simple Assembly** (or toggle **Background Music** between **Add Music** and **No Music**), there was no safe way to update the active run's final rendering configuration without navigating to Setup or risking a pipeline restart.

The core requirement of V3 is to allow changing the **Final Render Mode** and **Background Music Mode** **live during the Manual AI asset waiting period** and applying that change directly to the **active run** without:
- Calling `startPipeline()` or `resumePipeline()`
- Cancelling or restarting the active run
- Re-running AI Planning, Visual Director, or Prompt Generation
- Changing prompt hashes or scene ownership (AI vs Stock)
- Losing or resetting already-imported Manual AI scenes (e.g., `80 / 131 Ready`)

---

## 3. Why Changing Project Settings Alone Was Insufficient

1. **Frozen Run Options at Pipeline Start:** When `pipelineOrchestrator.startPipeline(options)` starts a run, it stores `state.options` inside `AutoPipelineState` (both in memory on `ActivePipelineInstance` and on disk in `analysis/auto-pipeline-state.json`). Subsequent stages (`audio-search`, `preflight`, `rendering`, `postflight`) receive `state.options` from the active orchestrator loop—they do not re-read `analysis/production-mode-settings.v1.json`.
2. **Heartbeat Overwrite Hazard:** `PipelineOrchestrator.startHeartbeat()` periodically writes the in-memory `state` back to `analysis/auto-pipeline-state.json` every 3 seconds. Modifying the file on disk without updating the live in-memory `ActivePipelineInstance.state` would be overwritten within 3 seconds by the next heartbeat tick.
3. **Project Preferences vs Active Run Ambiguity:** Mutating `analysis/production-mode-settings.v1.json` while a run is active conflates default preferences for future runs with the committed configuration of the currently executing pipeline run.

---

## 4. Three-Layer Configuration Model

To eliminate ambiguity between project defaults, active run state, and stage execution, the system enforces three distinct layers:

| Layer | Name | Backing Store | Responsibility |
| :--- | :--- | :--- | :--- |
| **Layer A** | **Project Preferences** | `analysis/production-mode-settings.v1.json` | Default preferences initialized in Step 2 — Setup for future runs. **Not** silently mutated when applying a live change to the current run. |
| **Layer B** | **Active Run Options** | `analysis/auto-pipeline-state.json` & `ActivePipelineInstance.state.options` + `renderSettings` | Authoritative configuration for the currently executing pipeline run (`runId`). Updated atomically under `withProjectLock(projectDir)`. |
| **Layer C** | **Renderer Execution** | `runAudioSearchStage()`, `runPreflightStage()`, `runRenderStage()`, `runPostflightStage()` | Consumes `state.options` from Layer B when the Manual AI asset gate releases and downstream stages execute. |

---

## 5. Exact Eligibility Rules for Live Final Render Mode Switching

Implemented in `isLiveRenderModeSwitchEligible(state)` (`shared/types.ts`) and enforced authoritatively in `PipelineOrchestrator.updateFinalRenderOptions()` (`src/main/pipeline/pipeline-orchestrator.ts`):

A live Final Render Mode update is allowed **if and only if all** of the following hold:
1. An active pipeline run exists for the normalized `projectDir`, or a valid persisted running state exists.
2. `request.runId === state.runId` (rejects with `RUN_MISMATCH` otherwise).
3. `state.overallStatus === 'running'` (rejects with `TOO_LATE` if `completed`, or `NOT_RUNNING` if `idle`, `interrupted`, `failed`, or `cancelled`).
4. `state.currentStage === 'stock-search'` and `state.stages['stock-search'].status === 'running'`.
5. `state.stages['stock-search'].manualAiWait` is non-null, `expected > 0`, and `ready < expected` (at least one Manual AI scene is still missing).
6. `state.stages['stock-search'].stats?.manualAiWaitCompleted !== true`.
7. Downstream stages (`audio-search`, `preflight`, `rendering`, `postflight`) are all still `'pending'` (none has started or completed).
8. Real-time disk verification via `getManualAiStatus(projectDir)` confirms `expected > 0` and `!allReady` (`ready < expected`), closing any micro-window where the final scene was just committed on disk before `manualAiWait` was cleared.

---

## 6. New IPC Contract (`updateFinalRenderOptions`)

- **IPC Channel:** `IPC_CHANNELS.PIPELINE_UPDATE_FINAL_RENDER_OPTIONS = 'pipeline:update-final-render-options'`
- **Preload Bridge:** `window.api.pipeline.updateFinalRenderOptions(request: UpdateFinalRenderOptionsRequest): Promise<UpdateFinalRenderOptionsResult>`

```ts
export type UpdateFinalRenderOptionsErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_MISMATCH'
  | 'NOT_RUNNING'
  | 'NOT_WAITING_FOR_ASSETS'
  | 'TOO_LATE'
  | 'INVALID_OPTIONS'
  | 'STALE_REQUEST'
  | 'SAVE_FAILED'

export interface UpdateFinalRenderOptionsRequest {
  projectDir: string
  runId: string
  assemblyMode: VideoAssemblyMode
  backgroundMusicMode: BackgroundMusicMode
  expectedStateVersion?: number
}

export interface UpdateFinalRenderOptionsResult {
  success: boolean
  appliedToActiveRun: boolean
  runId?: string
  effectiveAssemblyMode?: VideoAssemblyMode
  effectiveBackgroundMusicMode?: BackgroundMusicMode
  stateVersion?: number
  snapshot?: PipelineSnapshot
  errorCode?: UpdateFinalRenderOptionsErrorCode
  error?: string
}
```

---

## 7. `PipelineOrchestrator` Active-Run Update Design

- `ActivePipelineInstance` now holds a direct reference to the live `state: AutoPipelineState` object used by `executePipelineLoop(state, abortController)` and `startHeartbeat(norm, runId)`.
- `updateFinalRenderOptions(request)` acquires `this.withProjectLock(norm, async () => ...)` so live option updates and pipeline stage transitions are serialized per project.
- Validates payload values (`assemblyMode` in `['full-production', 'simple-assembly']`, `backgroundMusicMode` in `['auto', 'off']`), run existence, `runId` match, lease ownership, `expectedStateVersion` (if provided), and live eligibility.
- **Idempotency:** If the requested `assemblyMode` and `backgroundMusicMode` already match the active run's effective settings, it returns `success: true, appliedToActiveRun: true` immediately without extra version increments or disk writes.
- Updates **only** final render and music fields on `state.options` (`assemblyMode`, `backgroundMusicMode`, `requireBackgroundMusic`, `initialRequireBackgroundMusic`) and refreshes `state.renderSettings`, leaving `runId`, `currentStage`, `stages['stock-search'].manualAiWait`, and all upstream stage statuses untouched.

---

## 8. Atomic State Persistence, Heartbeat Synchronization, and Failure Rollback Behavior

- **Heartbeat Synchronization:** `startHeartbeat()` reads `instance.state` directly and increments `activeState.version` on each heartbeat write. Because `updateFinalRenderOptions()` mutates `instance.state` in place, subsequent heartbeats persist the newly accepted `assemblyMode` and `backgroundMusicMode` and never revert them.
- **Atomic Save & Full Rollback on Failure:** `savePipelineStateAtomic(projectDir, state)` writes to `auto-pipeline-state.json.tmp` and renames to `auto-pipeline-state.json`. If disk persistence throws:
  - `savePipelineStateAtomic` unlinks `.tmp` if present and restores `state.projectDir`, `state.version`, `state.updatedAt`, and `state.renderSettings`.
  - `updateFinalRenderOptions()` restores `state.options`, `state.renderSettings`, `state.version`, `state.updatedAt`, and `state.lease.heartbeatAt` to their exact pre-call values, skips `broadcastProgress`, and returns `{ success: false, appliedToActiveRun: false, errorCode: 'SAVE_FAILED' }`.

---

## 9. Concurrency and Last-Scene Race Handling

When a project is at `130 / 131 Ready` and the user imports Scene 131 at the same moment they click `Apply to Current Run`, `withProjectLock(norm)` combined with real-time `getManualAiStatus(norm)` verification guarantees **strictly linearizable** outcomes:
- **Outcome A (Apply wins before Scene 131 finishes):** `updateFinalRenderOptions()` commits `simple-assembly` + `off` while `130 / 131` is still waiting. When Scene 131 finishes importing moments later, `manualAiAssetGate` releases and `executePipelineLoop` passes the updated `state.options` (`simple-assembly`, `off`) to `runAudioSearchStage`, `runPreflightStage`, and `runRenderStage`.
- **Outcome B (Scene 131 finishes and gate closes first):** Either `getManualAiStatus(norm).allReady` is `true`, `manualAiWait` is cleared (`manualAiWaitCompleted = true`), or `currentStage` has advanced to `audio-search`. `updateFinalRenderOptions()` rejects with `errorCode: 'TOO_LATE'`, leaving `state.options` completely unchanged (`full-production`, `auto`).
- Neither partial updates nor mixed states (`assemblyMode` from one setting and `backgroundMusicMode` from another) can ever occur.

---

## 10. Crash Recovery and Resume Behavior

- `handleAppQuit()` and `recoverInterruptedPipeline()` preserve `state.options.assemblyMode`, `state.options.backgroundMusicMode`, `state.options.requireBackgroundMusic`, and `state.renderSettings` from `analysis/auto-pipeline-state.json`.
- Recovery and `resumePipeline()` never overwrite an accepted active-run mode with `analysis/production-mode-settings.v1.json`.

---

## 11. Production UI (`ActiveRunRenderSettings` and Confirmation Modal)

Created `src/renderer/src/components/ActiveRunRenderSettings.tsx` and mounted it in `ClientPipelineDashboard.tsx` directly above `ManualAiPromptPanel`:
- **Active Run Card (`FINAL RENDER SETTINGS`):**
  - Displays `Current Run: Full Smart Render | Simple Assembly` and `Background Music: Add Music | No Music`.
  - When eligible (`isLiveRenderModeSwitchEligible(pipelineState)`), displays the waiting status badge (`AI Assets X / Y Ready — Waiting for Z remaining scenes`) and the `[⚙ Change Final Render Mode]` button.
  - When not eligible (e.g., during `audio-search`, `preflight`, `rendering`, or `completed`), hides the edit button and displays `Read-only for current stage`.
- **Confirmation Modal (`CHANGE FINAL RENDER SETTINGS`):**
  - Radio controls for **Final Renderer** (`Full Smart Render` vs `Simple Assembly`) and **Background Music** (`Add Music` vs `No Music`).
  - Displays clear explanations for `Simple Assembly` and `No Music`.
  - Shows a live **Current vs New** summary, **Will be preserved** list (`AI Planning • Visual Director • Prompts • Scene Ownership • Imported Scenes`), and **Will change** list.
  - Prevents double-submission while saving (`Applying...`), keeps the modal open with an inline error banner if the backend rejects the change (e.g. `TOO_LATE`), and displays a green `✓ Applied to current run` confirmation banner only after backend persistence succeeds.
- **Monotonic Snapshot Merging (`usePipeline.ts`):**
  - `mergeIncomingPipelineState()` ignores stale progress snapshots (`incoming.version < prev.version`) and preserves `options` and `renderSettings` across compact progress broadcasts and tab navigation.

---

## 12. Distinction from Existing `Change in Setup` Navigation Button

- The existing `⚙️ Change in Setup` button inside `ManualAiPromptPanel.tsx` (used for Editorial / Overlay settings navigation to Setup) remains intact and unmodified.
- The new `[⚙ Change Final Render Mode]` control in `ActiveRunRenderSettings.tsx` is a dedicated, backend-coordinated live active-run update (`Apply to Current Run`) that operates directly in Production without navigating away or mutating Setup project preferences.

---

## 13. Preservation of Manual AI Waiting State

Switching Final Render Mode during `stock-search`:
- Does **not** resolve, cancel, or reset `manualAiAssetGate.waitUntilReady()`.
- Preserves `manual-ai-prompts.json` and all scene `promptHash` values 100% unchanged.
- Preserves `manual-ai-assets.json` and all normalized media files in `assets/generated/manual-ai/`.
- Preserves `expected`, `ready`, and `missingSceneIndices` counts (e.g. `80 / 131 Ready`, `51 Missing`).
- Preserves `editorialSettings.renderOverlayMode` (`full` vs `source-only`) so switching back to `Full Smart Render` retains the user's configured overlay mode.

---

## 14. Music Off and Music On Behavior When Switched Live

- **Live Switch to `No Music` (`backgroundMusicMode: 'off'`):**
  - Sets `state.options.backgroundMusicMode = 'off'` and `state.options.requireBackgroundMusic = false` (after recording the original `initialRequireBackgroundMusic` value).
  - In `runAudioSearchStage()`, skips music search/download and skips Health SFX planning, while **preserving any pre-existing `analysis/audio-plan.json` on disk** (`if (!hadExistingPlanOnDisk) saveAudioPlan(...)`).
  - In `runSimpleAssemblyRenderStage()`, ignores any tracks in `audio-plan.json` and muxes only the voiceover audio stream (`-an` on video inputs).
- **Live Switch from `No Music` to `Add Music` (`backgroundMusicMode: 'auto'`):**
  - Sets `state.options.backgroundMusicMode = 'auto'` and restores `state.options.requireBackgroundMusic = state.options.initialRequireBackgroundMusic ?? false` (never forcing `requireBackgroundMusic = true` if it was originally `false`).

---

## 15. Render Cache and Output Provenance Protection

- `computeRenderFingerprint()` includes `assemblyMode` and `backgroundMusicMode`.
- `reconcileProjectArtifacts()` checks `readRenderProvenance(projectDir)` for matching `assemblyMode` and `backgroundMusicMode` before considering an existing MP4 valid.
- `runSimpleAssemblyRenderStage()` checks `existingProvenance.assemblyMode !== 'simple-assembly' || existingProvenance.backgroundMusicMode !== effectiveMusicMode` before choosing the output filename, ensuring pre-existing MP4 outputs from a different mode or music setting are never overwritten or deleted.

---

## 16. Modified and Created Files

### Modified Files
| File | Summary of Changes |
| :--- | :--- |
| `shared/types.ts` | Added `PIPELINE_UPDATE_FINAL_RENDER_OPTIONS`, `ActiveRunRenderSettings`, `getActiveRunRenderSettings()`, `isLiveRenderModeSwitchEligible()`, `UpdateFinalRenderOptionsRequest`, `UpdateFinalRenderOptionsResult`, `initialRequireBackgroundMusic`, and `renderSettings` on `PipelineSnapshot` / `AutoPipelineState`. |
| `src/main/pipeline/pipeline-state.ts` | Populated `renderSettings` in `toSnapshot()`, `createInitialPipelineState()`, `loadPipelineState()`, and `savePipelineStateAtomic()`; added full in-memory rollback and `.tmp` cleanup on write failure in `savePipelineStateAtomic()`. |
| `src/main/pipeline/pipeline-orchestrator.ts` | Added `state: AutoPipelineState` to `ActivePipelineInstance`; synchronized heartbeat, status, quit, and recovery with `instance.state`; tracked `manualAiWaitCompleted`; implemented `updateFinalRenderOptions()`. |
| `src/main/pipeline/pipeline-stage-runners.ts` | Preserved existing `audio-plan.json` on disk when `backgroundMusicMode === 'off'` in `runAudioSearchStage()`; passed `options.assemblyMode` to `isAudioValid()`. |
| `src/main/simple-assembly/simple-assembly-pipeline-adapter.ts` | Protected existing output files when `existingProvenance.backgroundMusicMode !== effectiveMusicMode`. |
| `src/main/ipc/pipeline.ipc.ts` | Registered `IPC_CHANNELS.PIPELINE_UPDATE_FINAL_RENDER_OPTIONS` handler. |
| `src/preload/index.ts` | Exposed `window.api.pipeline.updateFinalRenderOptions(request)`. |
| `src/renderer/src/hooks/usePipeline.ts` | Added `mergeIncomingPipelineState()` monotonic state reducer and `updateFinalRenderOptions()` hook action. |
| `src/renderer/src/components/PipelinePhaseCard.tsx` | Updated Phase 4 (`build`) summary to read `pipelineState.renderSettings?.assemblyMode ?? pipelineState.options?.assemblyMode`. |
| `src/renderer/src/components/ClientPipelineDashboard.tsx` | Mounted `ActiveRunRenderSettings` above `ManualAiPromptPanel` and wired `onUpdateFinalRenderOptions`. |
| `src/renderer/src/pages/ProductionPage.tsx` | Passed `updateFinalRenderOptions` from `usePipeline` to `ClientPipelineDashboard`. |

### Created Files
| File | Purpose |
| :--- | :--- |
| `src/renderer/src/components/ActiveRunRenderSettings.tsx` | Production UI card and confirmation modal for viewing and live-switching Final Render Settings during the Manual AI asset wait. |
| `test/live-render-mode-switch.test.ts` | Active-run switch tests (131 scenes, 80/131 ready, prompt hash & stage preservation, no restart, idempotency, `renderOverlayMode` independence). |
| `test/live-render-mode-eligibility.test.ts` | Eligibility matrix and rejection code tests (`TOO_LATE`, `RUN_MISMATCH`, `RUN_NOT_FOUND`, `NOT_WAITING_FOR_ASSETS`, `NOT_RUNNING`, `INVALID_OPTIONS`). |
| `test/live-render-mode-concurrency.test.ts` | Last-scene race (`130/131` -> `131/131` vs `Apply to Current Run`) linearizability tests and `STALE_REQUEST` version protection. |
| `test/live-render-mode-persistence.test.ts` | Heartbeat non-reversion test and simulated disk write failure (`SAVE_FAILED`) atomic rollback test. |
| `test/live-render-mode-resume.test.ts` | App close (`handleAppQuit`) and crash recovery (`recoverInterruptedPipeline`) mode preservation tests. |
| `test/live-render-mode-ui.test.tsx` | Monotonic UI reducer (`mergeIncomingPipelineState`), tab navigation persistence, read-only badge, and confirmation modal summary tests. |
| `test/live-render-mode-manual-gate.test.ts` | `manualAiAssetGate.waitUntilReady()` continuity across live switch and >100-scene (`131` scenes) zero-regeneration verification. |
| `test/live-render-mode-music.test.ts` | Live `Music Off` (`0` music, `0` SFX, existing `audio-plan.json` preserved) and `Music On` (`initialRequireBackgroundMusic` preserved) tests. |
| `test/live-render-mode-render-dispatch.test.ts` | `Full -> Simple` and `Simple -> Full` dispatch, render fingerprint isolation, and provenance/MP4 preservation tests. |
| `test/live-render-mode-regression.test.ts` | Legacy project default compatibility and IPC handler registration contract tests. |
| `test/live-render-mode-e2e.test.ts` | End-to-end `Live-Switch-E2E` 5-scene real FFmpeg + FFprobe validation and real Electron (`_electron.launch`) UI modal & navigation verification. |
| `docs/QA_LIVE_FINAL_RENDER_MODE_SWITCH_V1_REPORT.md` | Engineering and QA verification report. |

---

## 17. Automated Test Table with Pass/Fail Counts

### New V3 Live Final Render Mode Test Suites
| Test Suite | Passed | Failed | Coverage |
| :--- | :---: | :---: | :--- |
| `test/live-render-mode-switch.test.ts` | 3 | 0 | Cases 19.1–19.6, 19.23, Part 7.10 (Safe active wait, Run ID/Stage/80-of-131/Hash preservation, No restart, Source Only independence, Idempotency) |
| `test/live-render-mode-eligibility.test.ts` | 8 | 0 | Cases 19.12–19.17, 19.24, Part 5.2 & 17.7 (Audio/Preflight/Render/Completed `TOO_LATE`, `RUN_MISMATCH`, `RUN_NOT_FOUND`, Stock-only, External lease, Invalid options) |
| `test/live-render-mode-concurrency.test.ts` | 4 | 0 | Case 19.11 & Part 17.8 (Outcome A, Outcome B, 10x competing race iterations, `STALE_REQUEST` protection) |
| `test/live-render-mode-persistence.test.ts` | 2 | 0 | Case 19.18, Part 7.8 & 7.9 (Heartbeat non-reversion, `SAVE_FAILED` rollback without false success) |
| `test/live-render-mode-resume.test.ts` | 1 | 0 | Case 19.19 & Part 9.2–9.4 (Reload/crash recovery preserves accepted live mode over Layer A defaults) |
| `test/live-render-mode-ui.test.tsx` | 3 | 0 | Cases 19.20, 19.21, Part 11 (Stale progress event protection, Setup/Production tab navigation persistence, Read-only badge & modal summary) |
| `test/live-render-mode-manual-gate.test.ts` | 2 | 0 | Case 19.25 & Part 13.5 (`manualAiAssetGate` continuity across live switch, 131-scene project zero prompt/media regeneration) |
| `test/live-render-mode-music.test.ts` | 2 | 0 | Cases 19.9, 19.10, Part 8.1 & 14 (Genuine Music Off `0` music/`0` SFX + `audio-plan.json` preservation; Music On `requireBackgroundMusic` restoration) |
| `test/live-render-mode-render-dispatch.test.ts` | 3 | 0 | Cases 19.7, 19.8 & Part 16 (`Full -> Simple` & `Simple -> Full` dispatch, render fingerprint & provenance isolation, existing MP4 preservation) |
| `test/live-render-mode-regression.test.ts` | 2 | 0 | Case 19.22 & Part 5.1–5.3 (Legacy project defaults, `PIPELINE_UPDATE_FINAL_RENDER_OPTIONS` IPC handler registration) |
| `test/live-render-mode-e2e.test.ts` | 5 | 0 | Part 21 (`Live-Switch-E2E` 5-scene real FFmpeg + FFprobe + real Electron GUI modal & navigation verification) |
| **Subtotal (New V3 Suites)** | **35** | **0** | **100% Passing** |

### Regression & Build Verification Suites (Part 20)
| Command / Suite | Result | Details |
| :--- | :---: | :--- |
| `npm run typecheck` | PASS | `tsc --noEmit` — 0 errors |
| `npm run build` | PASS | `electron-vite build` — main, preload, and renderer bundles built cleanly |
| `test/auto-production-pipeline.test.ts` | 28 / 28 PASS | Core 10-stage pipeline orchestration, invalidation, mutex, crash recovery |
| `test/manual-ai-gate.test.ts` | 8 / 8 PASS | Manual AI asset gate wait, notify, abort, coalescing |
| `test/manual-ai-importer.test.ts` | 14 / 14 PASS | Scene parsing, partial imports, FFmpeg normalization |
| `test/manual-ai-resume.test.ts` | 6 / 6 PASS | Restart reuse, staleness checks, render guard |
| `test/manual-ai-ui-and-sync.test.ts` | 7 / 7 PASS | Preload bridge, broadcaster, monotonic progress |
| `test/simple-assembly-*.test.ts(x)` (13 suites) | 43 / 43 PASS | Timeline, FFmpeg, input resolver, legacy compat, gate, provenance, UI, resume |
| `test/music-mode-selection.test.ts` | 6 / 6 PASS | Music mode resolver, atomic persistence, fingerprint isolation |
| `test/render-cache-resume.test.ts` | 28 / 28 PASS | Resumable Render Engine V2 checkpoints and fingerprints |
| `test/electron-renderer-black-screen.test.ts` | 6 / 6 PASS | Renderer hook imports, error boundaries, crash diagnostics |
| `npm test` (Full Repository Suite) | PASS | All repository test suites passed with 0 failures |

---

## 18. Real Electron End-to-End Validation Steps and FFprobe Output

Executed via `npx tsx test/live-render-mode-e2e.test.ts`:
1. **Project Creation (`Live-Switch-E2E`):**
   - Created 5-scene project (`2.0s` per scene = `10.0s` total) with a real `10.0s` PCM WAV voiceover and 5 external `1920x1080` PNG scene assets (`S0001.png`–`S0005.png`).
   - Configured Custom Mix (`100% AI / 0% Stock`, `Prompt` mode) and initial project preferences `Full Smart Render` (`full-production`) + `Add Music` (`auto`).
2. **Start Auto Production & Enter Manual AI Wait (`0 / 5 Ready`):**
   - Recorded active `runId = 'run-live-switch-e2e-001'`, stage `stock-search`, `0 / 5 Ready`.
3. **Import First 3 Scenes (`S0001.png`–`S0003.png`):**
   - Verified `3 / 5 Ready`, `2 Missing` (`[4, 5]`), `manualAiAssetGate` still waiting in `stock-search`, `runId` unchanged.
4. **Live Mode Switch (`Full Smart Render` + `Add Music` → `Simple Assembly` + `No Music`):**
   - Verified both via `pipelineOrchestrator.updateFinalRenderOptions` and via a real launched Electron instance (`playwright._electron.launch` on `out/main/index.js`):
     - Clicked `[data-testid="change-final-render-mode-btn"]` (`⚙ Change Final Render Mode`) in Production.
     - Selected `[data-testid="radio-assembly-simple"]` (`Simple Assembly`) and `[data-testid="radio-music-off"]` (`No Music`).
     - Clicked `[data-testid="modal-apply-btn"]` (`Apply to Current Run`).
     - Confirmed `runId` (`run-live-switch-e2e-001`), stage (`stock-search`), ready count (`3 / 5 Ready`), and all 5 prompt hashes remained 100% unchanged, while UI badges updated to `Simple Assembly` and `No Music` and Layer A (`production-mode-settings.v1.json`) remained `full-production` + `auto`.
     - Navigated across `2. Setup` → `3. Production` → `5. Export` → `3. Production` in the real Electron window with zero page errors and zero black screens.
5. **Import Remaining Scenes (`S0004.png`–`S0005.png`) & Complete Pipeline:**
   - Imported Scenes 4 and 5 (`5 / 5 Ready`); `manualAiAssetGate` resolved automatically.
   - `runAudioSearchStage` completed with `downloadedMusicCount: 0`, `sfxCount: 0`.
   - `runPreflightStage` succeeded.
   - `runRenderStage` dispatched to `runSimpleAssemblyRenderStage` (`remotionUsed: false`) and generated `output/Live-Switch-E2E.mp4`.
   - `runPostflightStage` validated the output MP4 and marked the pipeline `completed`.
6. **FFprobe Inspection of Generated `Live-Switch-E2E.mp4`:**
   ```json
   {
     "streams": [
       {
         "codec_name": "h264",
         "codec_type": "video",
         "width": 1920,
         "height": 1080,
         "r_frame_rate": "30/1"
       },
       {
         "codec_name": "aac",
         "codec_type": "audio"
       }
     ],
     "format": {
       "duration": "10.000000",
       "size": "48724"
     }
   }
   ```

---

## 19. Git Diff Summary

- **11 modified files** (`shared/types.ts`, `src/main/pipeline/pipeline-state.ts`, `src/main/pipeline/pipeline-orchestrator.ts`, `src/main/pipeline/pipeline-stage-runners.ts`, `src/main/simple-assembly/simple-assembly-pipeline-adapter.ts`, `src/main/ipc/pipeline.ipc.ts`, `src/preload/index.ts`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/components/PipelinePhaseCard.tsx`, `src/renderer/src/components/ClientPipelineDashboard.tsx`, `src/renderer/src/pages/ProductionPage.tsx`)
- **13 created files** (`src/renderer/src/components/ActiveRunRenderSettings.tsx`, 11 test files `test/live-render-mode-*.test.ts(x)`, and `docs/QA_LIVE_FINAL_RENDER_MODE_SWITCH_V1_REPORT.md`)
- Zero unrelated subsystems modified (`AI Planning`, `Visual Director`, `Prompt Pack Hashing`, `Manual AI Importer`, `Stock Search`, `Remotion Compositor`, and `Simple Assembly Engine` remain untouched).

---

## 20. Pull Request Link

- **Pull Request (#16):** [https://github.com/quocan050302/Auto-edit-capcut/pull/16](https://github.com/quocan050302/Auto-edit-capcut/pull/16)
- **Base Branch:** `QA` (HEAD: `acb43ef33d5cefb127723cd57f15126bb1f53e73`)
- **Feature Branch:** `feature/qa-live-render-mode-switch-v1`
- **Feature Commit SHA:** `200787b83608981f2d7e8974fc22fb5fb908f256`
