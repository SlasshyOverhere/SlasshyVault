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
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-gray-950 text-white font-sans p-5 text-center">
          <div className="w-[72px] h-[72px] rounded-full bg-white/10 flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(255,255,255,0.1)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-[22px] font-semibold mb-3">Something went wrong</h1>
          <p className="text-white/50 text-sm leading-relaxed mb-6 max-w-[400px]">
            An unexpected error occurred. Please try reloading the app.
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            className="px-6 py-3 rounded-xl border-none bg-white text-black text-sm font-semibold cursor-pointer shadow-[0_8px_32px_rgba(255,255,255,0.15)]"
          >
            Reload App
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
