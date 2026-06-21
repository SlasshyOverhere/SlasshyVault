// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlayConfirmDialog } from './PlayConfirmDialog'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: { div: ({ children, onClick, className }: any) => <div onClick={onClick} className={className}>{children}</div> },
  AnimatePresence: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  X: () => <span />,
  Play: () => <span />,
  Tv2: () => <span />,
  Film: () => <span />,
}))

describe('PlayConfirmDialog', () => {
  const base = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Test Movie',
    mediaType: 'movie' as const,
    onConfirm: vi.fn(),
  }

  it('renders when open', () => {
    render(<PlayConfirmDialog {...base} />)
    expect(screen.getAllByText('Test Movie').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Play')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<PlayConfirmDialog {...base} open={false} />)
    expect(screen.queryByText('Play')).toBeNull()
  })

  it('shows season/episode for tv', () => {
    render(<PlayConfirmDialog {...base} mediaType="tvepisode" seasonEpisode="S01E02" />)
    expect(screen.getAllByText(/S01E02/).length).toBeGreaterThanOrEqual(1)
  })

  it('calls onConfirm and closes on play click', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<PlayConfirmDialog {...base} onConfirm={onConfirm} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText('Play'))
    expect(onConfirm).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on cancel (X button)', () => {
    const onOpenChange = vi.fn()
    const { container } = render(<PlayConfirmDialog {...base} onOpenChange={onOpenChange} />)
    // The X button is the first button with p-2 class (header close)
    const buttons = container.querySelectorAll('button')
    const closeBtn = Array.from(buttons).find(b => b.className.includes('p-2'))
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
