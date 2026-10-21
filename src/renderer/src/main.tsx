import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PreviewApp } from './PreviewApp'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './index.css'

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    console.error('[Renderer Global Error]:', event.error || event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Renderer Unhandled Rejection]:', event.reason)
  })
}

const isPreviewMode =
  typeof window !== 'undefined' &&
  (!window.api || window.location.search.includes('preview='))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary
      fallbackTitle="Application Interface Error"
      fallbackMessage="A critical user interface error occurred. Your video assets, project state, and rendered files are preserved."
    >
      {isPreviewMode ? <PreviewApp /> : <App />}
    </AppErrorBoundary>
  </React.StrictMode>
)
