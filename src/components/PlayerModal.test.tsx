// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlayerModal } from './PlayerModal'

// Mock the UI dialog and button components
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, className }: any) => <div className={className}>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children, className }: any) => <h2 className={className}>{children}</h2>,
  DialogDescription: ({ children, className }: any) => <p className={className}>{children}</p>,
  DialogTrigger: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
  DialogPortal: ({ children }: any) => <div>{children}</div>,
  DialogOverlay: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, variant }: any) => (
    <button onClick={onClick} className={className} data-variant={variant}>{children}</button>
  ),
}))

vi.mock('lucide-react', () => ({
  MonitorPlay: () => <span data-testid="icon-monitor" />,
  ExternalLink: () => <span data-testid="icon-external" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  X: () => <span data-testid="icon-x" />,
}))

describe('PlayerModal', () => {
  it('renders when open', () => {
    render(
      <PlayerModal open={true} onOpenChange={() => {}} onSelectPlayer={() => {}} title="Test Movie" />
    )
    expect(screen.getByText('Choose Player')).toBeTruthy()
    expect(screen.getByText('Test Movie')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(
      <PlayerModal open={false} onOpenChange={() => {}} onSelectPlayer={() => {}} title="Test Movie" />
    )
    expect(screen.queryByText('Choose Player')).toBeNull()
  })

  it('shows player options', () => {
    render(
      <PlayerModal open={true} onOpenChange={() => {}} onSelectPlayer={() => {}} title="Movie" />
    )
    expect(screen.getByText('Built-in Player')).toBeTruthy()
    expect(screen.getByText('External MPV')).toBeTruthy()
    expect(screen.getByText('RECOMMENDED')).toBeTruthy()
  })

  it('calls onSelectPlayer("builtin") on builtin click', () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <PlayerModal open={true} onOpenChange={onOpenChange} onSelectPlayer={onSelect} title="Movie" />
    )
    fireEvent.click(screen.getByText('Built-in Player'))
    expect(onSelect).toHaveBeenCalledWith('builtin')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onSelectPlayer("mpv") on external mpv click', () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <PlayerModal open={true} onOpenChange={onOpenChange} onSelectPlayer={onSelect} title="Movie" />
    )
    fireEvent.click(screen.getByText('External MPV'))
    expect(onSelect).toHaveBeenCalledWith('mpv')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('displays tip text', () => {
    render(
      <PlayerModal open={true} onOpenChange={() => {}} onSelectPlayer={() => {}} title="Movie" />
    )
    expect(screen.getByText(/Change default player in Settings/)).toBeTruthy()
  })
})
