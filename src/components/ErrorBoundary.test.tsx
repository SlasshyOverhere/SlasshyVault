// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

// Component that throws
function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test error')
  return <div>Child rendered</div>
}

// Suppress console.error in tests
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Child rendered')).toBeTruthy()
  })

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Test error')).toBeTruthy()
    expect(screen.getByText('stack trace')).toBeTruthy()
    expect(screen.getByText('Reload')).toBeTruthy()
  })

  it('calls window.location.reload on reload click', () => {
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>
    )
    fireEvent.click(screen.getByText('Reload'))
    expect(reloadMock).toHaveBeenCalled()
  })
})
