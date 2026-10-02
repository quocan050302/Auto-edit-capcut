import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PreviewApp } from './PreviewApp'
import './index.css'

const isPreviewMode =
  typeof window !== 'undefined' &&
  (!window.api || window.location.search.includes('preview='))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
