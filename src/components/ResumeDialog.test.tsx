// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResumeDialog } from './ResumeDialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, className }: any) => (
    <button onClick={onClick} className={className}>{children}</button>
  ),
}))

vi.mock('lucide-react', () => ({
  Play: () => <span />,
  RotateCcw: () => <span />,
  Clock: () => <span />,
  Film: () => <span />,
  Tv2: () => <span />,
  Sparkles: () => <span />,
}))

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: {
    div: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  },
}))

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  title: 'Test Movie',
  mediaType: 'movie' as const,
  currentPosition: 3600,
  duration: 7200,
  onResume: vi.fn(),
  onStartOver: vi.fn(),
}

describe('ResumeDialog', () => {
  it('renders when open with progress', () => {
    render(<ResumeDialog {...baseProps} />)
    expect(screen.getByText('Test Movie')).toBeTruthy()
    expect(screen.getByText(/Resume/)).toBeTruthy()
    expect(screen.getByText(/Start Over/)).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<ResumeDialog {...baseProps} open={false} />)
    expect(screen.queryByText('Test Movie')).toBeNull()
  })

  it('shows season/episode for TV', () => {
    render(<ResumeDialog {...baseProps} mediaType="tvepisode" seasonEpisode="S01E03" />)
    expect(screen.getByText(/S01E03/)).toBeTruthy()
  })

  it('calls onResume on resume click', () => {
    const onResume = vi.fn()
    const onOpenChange = vi.fn()
    render(<ResumeDialog {...baseProps} onResume={onResume} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText(/Resume/))
    expect(onResume).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onStartOver on start over click', () => {
    const onStartOver = vi.fn()
    const onOpenChange = vi.fn()
    render(<ResumeDialog {...baseProps} onStartOver={onStartOver} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText(/Start Over/))
    expect(onStartOver).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('handles zero duration gracefully', () => {
    render(<ResumeDialog {...baseProps} duration={0} currentPosition={0} />)
    expect(screen.getByText('Test Movie')).toBeTruthy()
  })
})
