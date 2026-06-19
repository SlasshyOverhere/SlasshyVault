import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorHandlers } from './lib/errorReporter'
import './index.css'

// Install global Tauri invoke wrapper + unhandled error handlers.
// This catches EVERY Tauri command error (all 174 commands) and reports
// it to the Rust backend → Sentry, without modifying individual files.
installGlobalErrorHandlers()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
