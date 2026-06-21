// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ZipPlaybackLoadingOverlay } from './ZipPlaybackLoadingOverlay'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: {
    div: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  Play: () => <span />,
  Loader2: () => <span />,
  Info: () => <span />,
}))

describe('ZipPlaybackLoadingOverlay', () => {
  const loadingState = {
    title: 'Test Episode',
    resume: false,
    estimatedSeconds: 15,
    sizeLabel: '1 GB',
    detail: 'ZIP extraction info',
  }

  it('renders when loadingState is provided', () => {
    render(<ZipPlaybackLoadingOverlay loadingState={loadingState} />)
    expect(screen.getByText('Starting Playback')).toBeTruthy()
    expect(screen.getByText('Preparing Playback')).toBeTruthy()
  })

  it('does not render when loadingState is null', () => {
    render(<ZipPlaybackLoadingOverlay loadingState={null} />)
    expect(screen.queryByText('Preparing Playback')).toBeNull()
  })

  it('shows "Resuming Playback" when resume is true', () => {
    render(<ZipPlaybackLoadingOverlay loadingState={{ ...loadingState, resume: true }} />)
    expect(screen.getByText('Resuming Playback')).toBeTruthy()
  })

  it('shows Note text', () => {
    render(<ZipPlaybackLoadingOverlay loadingState={loadingState} />)
    expect(screen.getByText(/Note:/)).toBeTruthy()
  })

  it('applies custom zIndexClassName', () => {
    const { container } = render(
      <ZipPlaybackLoadingOverlay loadingState={loadingState} zIndexClassName="z-[999]" />
    )
    expect(container.querySelector('.z-\\[999\\]')).toBeTruthy()
  })
})
