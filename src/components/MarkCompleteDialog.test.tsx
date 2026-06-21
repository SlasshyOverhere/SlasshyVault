// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MarkCompleteDialog } from './MarkCompleteDialog'

vi.mock('framer-motion', () => ({
  LazyMotion: ({ children }: any) => <div>{children}</div>,
  domAnimation: {},
  m: {
    div: ({ children, onClick, className, ...rest }: any) => <div onClick={onClick} className={className}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  X: () => <span />,
  CheckCircle: () => <span />,
  RotateCcw: () => <span />,
  HelpCircle: () => <span />,
}))

describe('MarkCompleteDialog', () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Test Movie',
    progressPercent: 85,
    onMarkComplete: vi.fn(),
    onKeepProgress: vi.fn(),
  }

  it('renders when open', () => {
    render(<MarkCompleteDialog {...baseProps} />)
    expect(screen.getByText('Almost Finished!')).toBeTruthy()
    expect(screen.getByText(/Test Movie/)).toBeTruthy()
    expect(screen.getByText('85% watched')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<MarkCompleteDialog {...baseProps} open={false} />)
    expect(screen.queryByText('Almost Finished!')).toBeNull()
  })

  it('renders completion confirmation mode', () => {
    render(<MarkCompleteDialog {...baseProps} isCompletionConfirmation />)
    expect(screen.getByText('Did you complete your playback?')).toBeTruthy()
    expect(screen.getByText('End of video detected')).toBeTruthy()
    expect(screen.getByText('Yes, Mark Complete')).toBeTruthy()
    expect(screen.getByText('No, Keep Progress')).toBeTruthy()
  })

  it('renders season/episode label', () => {
    render(<MarkCompleteDialog {...baseProps} seasonEpisode="S01E05" />)
    expect(screen.getByText(/S01E05/)).toBeTruthy()
  })

  it('calls onMarkComplete and onOpenChange on "Mark as Complete"', () => {
    const onMark = vi.fn()
    const onChange = vi.fn()
    render(<MarkCompleteDialog {...baseProps} onMarkComplete={onMark} onOpenChange={onChange} />)
    fireEvent.click(screen.getByText('Mark as Complete'))
    expect(onMark).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('calls onOpenChange and onKeepProgress on close', () => {
    const onChange = vi.fn()
    const onKeep = vi.fn()
    render(<MarkCompleteDialog {...baseProps} onOpenChange={onChange} onKeepProgress={onKeep} />)
    fireEvent.click(screen.getByText(/Keep Progress/))
    expect(onChange).toHaveBeenCalledWith(false)
    expect(onKeep).toHaveBeenCalled()
  })
})
