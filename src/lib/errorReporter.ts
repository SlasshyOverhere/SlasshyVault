/**
 * Global error reporting harness.
 *
 * Architecture:
 *   All errors funnel through the Rust backend, which has the Sentry SDK.
 *   The frontend sends errors via a single Tauri command: "sentry_report_error".
 *   This avoids re-introducing @sentry/react as a dependency.
 *
 * Coverage:
 *   1. Tauri invoke wrapper — catches errors from ALL 174+ Tauri commands
 *      without touching a single command file.
 *   2. window.onerror — catches unhandled JS exceptions.
 *   3. window.onunhandledrejection — catches unhandled promise rejections.
 */

import { invoke } from '@tauri-apps/api/tauri'

/** Whether the error reporter is active (prevents infinite loops). */
let installed = false

/** Send an error to the Rust backend → Sentry. */
async function reportToSentry(context: string, error: unknown): Promise<void> {
  // Urldecode and sanitize the error to a string
  let details: string
  if (error instanceof Error) {
    details = `${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}`
  } else if (typeof error === 'string') {
    details = error
  } else if (error && typeof error === 'object') {
    try {
      details = JSON.stringify(error)
    } catch {
      details = String(error)
    }
  } else {
    details = String(error)
  }

  // Fire and forget — never throw from inside the reporter
  try {
    await invoke('sentry_report_error', { context, details })
  } catch {
    // Silently ignore failures — we can't report that the reporter failed
  }
}

/**
 * Install global error handlers:
 *  - Monkey-patches `window.__TAURI__.invoke` to capture every Tauri command error
 *  - Listens for unhandled JS errors and promise rejections
 *
 * Safe to call multiple times — only first call installs.
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return
  installed = true

  // ── 1. Monkey-patch Tauri invoke ──────────────────────────────────
  // This catches errors from ALL 174+ Tauri commands without modifying
  // a single import in any file.
  const tauri = (window as unknown as { __TAURI__?: { invoke: typeof invoke } }).__TAURI__
  if (tauri?.invoke) {
    const originalInvoke = tauri.invoke.bind(tauri)
    tauri.invoke = ((cmd: string, args?: Record<string, unknown>) => {
      return originalInvoke(cmd, args).catch((error: unknown) => {
        reportToSentry(`tauri:${cmd}`, error)
        throw error // re-throw so the caller still sees the error
      })
    }) as typeof invoke
  }

  // ── 2. Unhandled JavaScript errors ────────────────────────────────
  window.addEventListener('error', (event) => {
    reportToSentry('window.onerror', event.error ?? event.message)
  })

  // ── 3. Unhandled promise rejections ───────────────────────────────
  window.addEventListener('unhandledrejection', (event) => {
    reportToSentry('unhandledrejection', event.reason)
  })
}
