import { Component, type ReactNode, type ErrorInfo } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-[#0a0a0a] text-white font-sans p-5 text-center">
          {/* Minimal icon */}
          <div className="mb-8 opacity-30">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" />
            </svg>
          </div>

          {/* Error message — the actual error, not generic */}
          <p className="text-sm text-white/40 font-mono mb-2 max-w-lg break-all leading-relaxed">
            {this.state.error?.message || 'Unknown error'}
          </p>

          {/* Stack trace — subtle, collapsed */}
          {this.state.error?.stack && (
            <details className="mb-10 max-w-lg">
              <summary className="text-[11px] text-white/20 cursor-pointer hover:text-white/40 transition-colors">
                stack trace
              </summary>
              <p className="text-[11px] text-white/15 font-mono mt-2 text-left whitespace-pre-wrap break-all leading-relaxed">
                {this.state.error.stack.split('\n').slice(0, 6).join('\n')}
              </p>
            </details>
          )}

          {/* Reload button — ghost minimal */}
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            className="px-5 py-2 rounded-lg border border-white/10 text-white/30 text-xs tracking-widest uppercase hover:border-white/30 hover:text-white/60 transition-all duration-300"
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
