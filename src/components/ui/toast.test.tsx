// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Toast, ToastTitle, ToastDescription, ToastClose, ToastAction, ToastProvider, ToastViewport } from './toast'

vi.mock('@radix-ui/react-toast', () => ({
  Provider: ({ children }: any) => <div data-testid="provider">{children}</div>,
  Root: ({ children, ...p }: any) => <div data-testid="root" {...p}>{children}</div>,
  Title: ({ children }: any) => <h3>{children}</h3>,
  Description: ({ children }: any) => <p>{children}</p>,
  Close: ({ children, ...p }: any) => <button {...p}>{children}</button>,
  Action: ({ children, ...p }: any) => <button {...p}>{children}</button>,
  Viewport: () => <div data-testid="viewport" />,
}))

vi.mock('lucide-react', () => ({ X: () => <span /> }))

describe('toast exports', () => {
  it('Toast renders with children', () => {
    render(<Toast>Content</Toast>)
    expect(screen.getByText('Content')).toBeTruthy()
  })

  it('ToastTitle renders', () => {
    render(<ToastTitle>Title</ToastTitle>)
    expect(screen.getByText('Title')).toBeTruthy()
  })

  it('ToastDescription renders', () => {
    render(<ToastDescription>Desc</ToastDescription>)
    expect(screen.getByText('Desc')).toBeTruthy()
  })

  it('ToastClose renders', () => {
    const { container } = render(<ToastClose />)
    expect(container.firstChild).toBeTruthy()
  })

  it('ToastAction renders', () => {
    render(<ToastAction>Undo</ToastAction>)
    expect(screen.getByText('Undo')).toBeTruthy()
  })

  it('ToastProvider renders', () => {
    render(<ToastProvider>Child</ToastProvider>)
    expect(screen.getByText('Child')).toBeTruthy()
  })

  it('ToastViewport renders', () => {
    render(<ToastViewport />)
    expect(screen.getByTestId('viewport')).toBeTruthy()
  })
})
