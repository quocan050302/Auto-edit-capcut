import * as fs from 'fs'
import * as path from 'path'
import { assert, createRunner } from './manual-ai-test-utils'

const { it, finish } = createRunner('Electron Renderer Black Screen & Diagnostics Tests')

async function main(): Promise<void> {
  console.log('\n--- Electron Renderer Black Screen Prevention & Diagnostics Tests ---')

  await it('Section 01: ManualAiPromptPanel imports React hooks explicitly (preventing ReferenceError: useState is not defined)', async () => {
    const panelPath = path.join(__dirname, '../src/renderer/src/components/ManualAiPromptPanel.tsx')
    const content = fs.readFileSync(panelPath, 'utf-8')

    // Must import useState, useEffect, useRef, useCallback, useMemo from 'react'
    assert.match(
      content,
      /import\s+React,\s*\{[^}]*useState[^}]*\}\s+from\s+['"]react['"]/,
      'ManualAiPromptPanel must import useState from react'
    )
    assert.match(
      content,
      /import\s+React,\s*\{[^}]*useEffect[^}]*\}\s+from\s+['"]react['"]/,
      'ManualAiPromptPanel must import useEffect from react'
    )
    assert.match(
      content,
      /import\s+React,\s*\{[^}]*useRef[^}]*\}\s+from\s+['"]react['"]/,
      'ManualAiPromptPanel must import useRef from react'
    )
    assert.match(
      content,
      /import\s+React,\s*\{[^}]*useCallback[^}]*\}\s+from\s+['"]react['"]/,
      'ManualAiPromptPanel must import useCallback from react'
    )
    assert.match(
      content,
      /import\s+React,\s*\{[^}]*useMemo[^}]*\}\s+from\s+['"]react['"]/,
      'ManualAiPromptPanel must import useMemo from react'
    )
  })

  await it('Section 02: Bundled renderer output contains reactExports.useState for ManualAiPromptPanel', async () => {
    const outAssetsDir = path.join(__dirname, '../out/renderer/assets')
    if (fs.existsSync(outAssetsDir)) {
      const jsFiles = fs.readdirSync(outAssetsDir).filter((f) => f.endsWith('.js'))
      assert.ok(jsFiles.length > 0, 'Compiled JS bundle exists in out/renderer/assets')
      const latestJs = fs.readFileSync(path.join(outAssetsDir, jsFiles[0]), 'utf-8')
      const manualAiIdx = latestJs.indexOf('function ManualAiPromptPanel')
      if (manualAiIdx !== -1) {
        const snippet = latestJs.slice(manualAiIdx, manualAiIdx + 600)
        // Must NOT use bare undefined 'useState(null)'
        assert.ok(
          snippet.includes('reactExports.useState') || snippet.includes('.useState('),
          'Compiled ManualAiPromptPanel must use React useState reference rather than bare undefined variable'
        )
      }
    }
  })

  await it('Section 03: Electron main process implements crash diagnostics (render-process-gone, unresponsive, console-message)', async () => {
    const mainIndexPath = path.join(__dirname, '../src/main/index.ts')
    const content = fs.readFileSync(mainIndexPath, 'utf-8')

    assert.ok(
      content.includes('render-process-gone'),
      'Main process must register render-process-gone crash listener'
    )
    assert.ok(
      content.includes("'unresponsive'"),
      'Main process must register unresponsive window listener'
    )
    assert.ok(
      content.includes("'responsive'"),
      'Main process must register responsive window listener'
    )
    assert.ok(
      content.includes('did-fail-load'),
      'Main process must register did-fail-load URL loading diagnostic'
    )
    assert.ok(
      content.includes('console-message'),
      'Main process must forward renderer console warnings/errors to logger'
    )
    assert.ok(
      content.includes('F12'),
      'Main process must support F12 DevTools toggle in development'
    )
  })

  await it('Section 04: Root and Route-level AppErrorBoundary are deployed across entrypoint and main shell', async () => {
    const mainTsxPath = path.join(__dirname, '../src/renderer/src/main.tsx')
    const mainTsx = fs.readFileSync(mainTsxPath, 'utf-8')

    assert.ok(
      mainTsx.includes('AppErrorBoundary'),
      'main.tsx must mount AppErrorBoundary around root React application'
    )
    assert.ok(
      mainTsx.includes("window.addEventListener('error'"),
      'main.tsx must register global window error listener'
    )
    assert.ok(
      mainTsx.includes("window.addEventListener('unhandledrejection'"),
      'main.tsx must register global unhandledrejection listener'
    )

    const appTsxPath = path.join(__dirname, '../src/renderer/src/App.tsx')
    const appTsx = fs.readFileSync(appTsxPath, 'utf-8')

    assert.ok(
      appTsx.includes('<AppErrorBoundary'),
      'App.tsx must mount route-level AppErrorBoundary around main-content views'
    )
    assert.ok(
      appTsx.includes('isRouteLevel={true}'),
      'App.tsx route-level boundary must set isRouteLevel={true} to preserve outer layout shell'
    )
  })

  await it('Section 05: ConfirmDialog uses valid CSS modal classes and index.css defines backward-compatible aliases', async () => {
    const dialogPath = path.join(__dirname, '../src/renderer/src/components/ConfirmDialog.tsx')
    const dialogContent = fs.readFileSync(dialogPath, 'utf-8')

    assert.ok(
      dialogContent.includes('modal-overlay'),
      'ConfirmDialog must include modal-overlay class'
    )
    assert.ok(
      dialogContent.includes('modal'),
      'ConfirmDialog must include modal class'
    )

    const cssPath = path.join(__dirname, '../src/renderer/src/index.css')
    const cssContent = fs.readFileSync(cssPath, 'utf-8')

    assert.ok(
      cssContent.includes('.modal-backdrop'),
      'index.css must provide .modal-backdrop alias'
    )
    assert.ok(
      cssContent.includes('.modal-box'),
      'index.css must provide .modal-box alias'
    )
  })

  await it('Section 06: App media safe protocol and Electron window security are strictly preserved', async () => {
    const mainIndexPath = path.join(__dirname, '../src/main/index.ts')
    const content = fs.readFileSync(mainIndexPath, 'utf-8')

    assert.ok(
      content.includes("contextIsolation: true"),
      'contextIsolation must remain true'
    )
    assert.ok(
      content.includes("nodeIntegration: false"),
      'nodeIntegration must remain false'
    )
    assert.ok(
      content.includes("protocol.handle('app-media'"),
      'app-media custom protocol must remain registered'
    )
  })

  finish()
}

main().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
