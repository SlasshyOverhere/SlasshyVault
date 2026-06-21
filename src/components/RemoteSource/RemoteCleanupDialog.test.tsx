// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RemoteCleanupDialog } from './RemoteCleanupDialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, variant }: any) => (
    <button onClick={onClick} className={className} data-variant={variant}>{children}</button>
  ),
}))

vi.mock('lucide-react', () => ({
  Trash2: () => <span />,
  FolderOpen: () => <span />,
}))

describe('RemoteCleanupDialog', () => {
  const base = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Test Movie',
    onCleanup: vi.fn(),
    onKeep: vi.fn(),
  }

  it('renders when open', () => {
    render(<RemoteCleanupDialog {...base} />)
    expect(screen.getByText('Playback Complete')).toBeTruthy()
    expect(screen.getByText('Test Movie')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<RemoteCleanupDialog {...base} open={false} />)
    expect(screen.queryByText('Playback Complete')).toBeNull()
  })

  it('calls onCleanup on clean up click', () => {
    const onCleanup = vi.fn()
    const onOpenChange = vi.fn()
    render(<RemoteCleanupDialog {...base} onCleanup={onCleanup} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText('Clean Up'))
    expect(onCleanup).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onKeep on keep click', () => {
    const onKeep = vi.fn()
    const onOpenChange = vi.fn()
    render(<RemoteCleanupDialog {...base} onKeep={onKeep} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText('Keep It'))
    expect(onKeep).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on Ask Later click', () => {
    const onOpenChange = vi.fn()
    render(<RemoteCleanupDialog {...base} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText('Ask Later'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
