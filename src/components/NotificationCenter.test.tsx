// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NotificationCenter, type NotificationCenterItem } from './NotificationCenter'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  Bell: () => <span />,
  Clapperboard: () => <span />,
  Film: () => <span />,
  Inbox: () => <span />,
  Tv: () => <span />,
}))

const makeItem = (overrides: Partial<NotificationCenterItem> = {}): NotificationCenterItem => ({
  id: '1',
  category: 'movie_add',
  title: 'New Movie',
  message: 'Added to library',
  createdAt: '2026-06-20T10:00:00Z',
  read: false,
  ...overrides,
})

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  items: [] as NotificationCenterItem[],
  activeFilter: 'all' as const,
  onFilterChange: vi.fn(),
  onClearAll: vi.fn(),
}

describe('NotificationCenter', () => {
  it('renders when open', () => {
    render(<NotificationCenter {...baseProps} />)
    expect(screen.getByText('Notifications')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<NotificationCenter {...baseProps} open={false} />)
    expect(screen.queryByText('Notifications')).toBeNull()
  })

  it('shows empty state when no items', () => {
    render(<NotificationCenter {...baseProps} />)
    expect(screen.getByText(/No notifications/)).toBeTruthy()
  })

  it('renders notification items', () => {
    const items = [makeItem(), makeItem({ id: '2', title: 'Another Movie', category: 'show_add' })]
    render(<NotificationCenter {...baseProps} items={items} />)
    expect(screen.getByText('New Movie')).toBeTruthy()
    expect(screen.getByText('Another Movie')).toBeTruthy()
  })

  it('shows filter buttons', () => {
    render(<NotificationCenter {...baseProps} />)
    expect(screen.getByText('All')).toBeTruthy()
    expect(screen.getByText('Show Add')).toBeTruthy()
    expect(screen.getByText('Movie Add')).toBeTruthy()
    expect(screen.getByText('Reminders')).toBeTruthy()
  })

  it('calls onFilterChange on filter click', () => {
    const onFilterChange = vi.fn()
    render(<NotificationCenter {...baseProps} onFilterChange={onFilterChange} />)
    fireEvent.click(screen.getByText('Reminders'))
    expect(onFilterChange).toHaveBeenCalledWith('reminder')
  })

  it('shows clear all button when items exist', () => {
    const items = [makeItem()]
    render(<NotificationCenter {...baseProps} items={items} />)
    expect(screen.getByText(/Clear/)).toBeTruthy()
  })

  it('calls onClearAll on clear click', () => {
    const onClearAll = vi.fn()
    const items = [makeItem()]
    render(<NotificationCenter {...baseProps} items={items} onClearAll={onClearAll} />)
    fireEvent.click(screen.getByText(/Clear/))
    expect(onClearAll).toHaveBeenCalled()
  })
})
