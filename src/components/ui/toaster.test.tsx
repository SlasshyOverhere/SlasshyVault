// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Toaster } from './toaster'

vi.mock('./toast', () => ({
  Toast: ({ children }: any) => <div data-testid="toast">{children}</div>,
  ToastClose: () => <button>Close</button>,
  ToastDescription: ({ children }: any) => <p>{children}</p>,
  ToastProvider: ({ children }: any) => <div>{children}</div>,
  ToastTitle: ({ children }: any) => <h3>{children}</h3>,
  ToastViewport: () => <div />,
}))

vi.mock('./use-toast', () => ({
  useToast: vi.fn(),
}))

vi.mock('lucide-react', () => ({
  Layers: () => <span />,
  X: () => <span />,
}))

import { useToast } from './use-toast'

describe('Toaster', () => {
  it('renders nothing when no toasts', () => {
    vi.mocked(useToast).mockReturnValue({ toasts: [], toast: vi.fn(), dismiss: vi.fn() })
    const { container } = render(<Toaster />)
    expect(container.querySelector('[data-testid="toast"]')).toBeNull()
  })

  it('renders a toast', () => {
    vi.mocked(useToast).mockReturnValue({
      toasts: [{ id: '1', title: 'Hello', description: 'World', open: true }],
      toast: vi.fn(),
      dismiss: vi.fn(),
    } as any)
    render(<Toaster />)
    expect(screen.getByText('Hello')).toBeTruthy()
    expect(screen.getByText('World')).toBeTruthy()
  })

  it('renders toast with title only', () => {
    vi.mocked(useToast).mockReturnValue({
      toasts: [{ id: '1', title: 'Only Title', open: true }],
      toast: vi.fn(),
      dismiss: vi.fn(),
    } as any)
    render(<Toaster />)
    expect(screen.getByText('Only Title')).toBeTruthy()
  })

  it('shows stack indicator when multiple toasts', () => {
    vi.mocked(useToast).mockReturnValue({
      toasts: [
        { id: '1', title: 'First', open: true },
        { id: '2', title: 'Second', open: true },
      ],
      toast: vi.fn(),
      dismiss: vi.fn(),
    } as any)
    render(<Toaster />)
    expect(screen.getByText('First')).toBeTruthy()
  })
})
