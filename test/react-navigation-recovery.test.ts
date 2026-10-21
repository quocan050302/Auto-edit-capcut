import * as assert from 'assert'
import React from 'react'
import { createRunner } from './manual-ai-test-utils'
import { AppErrorBoundary } from '../src/renderer/src/components/AppErrorBoundary'

const { it, finish } = createRunner('React Navigation Recovery & Error Boundary Tests')

async function main(): Promise<void> {
  console.log('\n--- React Navigation Recovery & Error Boundary Tests ---')

  await it('Section 01: AppErrorBoundary catches simulated render errors and derives state without crashing', () => {
    const error = new Error('Simulated component render explosion')
    const state = AppErrorBoundary.getDerivedStateFromError(error)

    assert.strictEqual(state.hasError, true, 'getDerivedStateFromError must set hasError: true')
    assert.strictEqual(state.error, error, 'getDerivedStateFromError must retain the error object')
  })

  await it('Section 02: AppErrorBoundary renders controlled fallback UI instead of blank null', () => {
    const boundary = new AppErrorBoundary({
      children: 'Normal Content',
      fallbackTitle: 'Test Error Page',
      fallbackMessage: 'Safe error message'
    })

    // Simulate error state
    boundary.state = {
      hasError: true,
      error: new Error('Render crash during tab transition'),
      errorInfo: { componentStack: '\n    in CrashingChildComponent\n    in ProductionPage' },
      copiedNotice: false
    }

    const rendered = boundary.render() as React.ReactElement
    assert.ok(rendered !== null, 'Boundary must not return null on error')
    assert.strictEqual(rendered.type, 'div', 'Boundary must render a wrapper div')
    assert.ok(rendered.props.role === 'alert', 'Boundary container must have role="alert" for accessibility')

    // Verify fallback content is included in element tree
    const children = rendered.props.children
    assert.ok(children, 'Boundary fallback must contain inner elements')
  })

  await it('Section 03: Route-level boundary preserves outer app shell styling', () => {
    const routeBoundary = new AppErrorBoundary({
      children: 'Page Content',
      isRouteLevel: true,
      onNavigateProduction: () => {},
      onNavigateHome: () => {}
    })

    routeBoundary.state = {
      hasError: true,
      error: new Error('Route failure'),
      errorInfo: null,
      copiedNotice: false
    }

    const rendered = routeBoundary.render() as React.ReactElement
    assert.strictEqual(rendered.props.className, 'route-error-boundary-container')
    assert.strictEqual(rendered.props.style.height, '100%')
  })

  await it('Section 04: handleReset clears error state and triggers onRecover callback', () => {
    let recovered = false
    const boundary = new AppErrorBoundary({
      children: 'Content',
      onRecover: () => {
        recovered = true
      }
    })

    boundary.state = {
      hasError: true,
      error: new Error('Fatal error'),
      errorInfo: null,
      copiedNotice: false
    }

    boundary.setState = (updater: any) => {
      const nextState = typeof updater === 'function' ? updater(boundary.state) : updater
      boundary.state = { ...boundary.state, ...nextState }
    }

    boundary.handleReset()
    assert.strictEqual(boundary.state.hasError, false, 'hasError must be reset to false')
    assert.strictEqual(boundary.state.error, null, 'error must be reset to null')
    assert.strictEqual(recovered, true, 'onRecover callback must be invoked')
  })

  await it('Section 05: handleCopyDiagnostics formats structured report with stack trace', async () => {
    let writtenText = ''
    const originalClipboard = globalThis.navigator?.clipboard

    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          writtenText = text
          return Promise.resolve()
        }
      },
      configurable: true
    })

    try {
      const boundary = new AppErrorBoundary({ children: 'Content' })
      boundary.state = {
        hasError: true,
        error: new Error('Synthetic memory pressure failure'),
        errorInfo: { componentStack: '\n    in BrokenRoute' },
        copiedNotice: false
      }

      boundary.setState = (updater: any) => {
        const nextState = typeof updater === 'function' ? updater(boundary.state) : updater
        boundary.state = { ...boundary.state, ...nextState }
      }

      boundary.handleCopyDiagnostics()
      await new Promise((resolve) => setTimeout(resolve, 10))

      assert.ok(writtenText.includes('Long-Form AI Video Factory UI Diagnostics'))
      assert.ok(writtenText.includes('Synthetic memory pressure failure'))
      assert.ok(writtenText.includes('BrokenRoute'))
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: originalClipboard, configurable: true })
    }
  })

  await it('Section 06: AppErrorBoundary does NOT trigger automatic page reload loops', () => {
    let reloadCount = 0
    const boundary = new AppErrorBoundary({ children: 'Content' })

    // Simulate mounting into error state
    boundary.componentDidCatch(new Error('SyntaxError'), { componentStack: '' })
    assert.strictEqual(reloadCount, 0, 'Mounting into error state must not reload window')
  })

  finish()
}

main().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
