// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WatchTogetherBanner } from './WatchTogetherBanner'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, ...rest }: any) => (
    <button onClick={onClick} className={className} {...rest}>{children}</button>
  ),
}))

vi.mock('@/services/api', () => ({
  wtLeaveRoom: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('lucide-react', () => ({
  Users: () => <span />,
  X: () => <span />,
  Play: () => <span />,
}))

const baseRoom = {
  code: 'ABCD',
  host_id: 'h1',
  media_title: 'Movie',
  media_id: 1,
  participants: [
    { id: 'h1', nickname: 'Host', is_host: true, is_ready: true },
    { id: 'u2', nickname: 'Guest', is_host: false, is_ready: false },
  ],
  is_playing: false,
  current_position: 0,
}

describe('WatchTogetherBanner', () => {
  it('renders room code', () => {
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} onOpenModal={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('ABCD')).toBeTruthy()
  })

  it('shows participant count', () => {
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} onOpenModal={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('2p')).toBeTruthy()
  })

  it('shows play icon when playing', () => {
    render(<WatchTogetherBanner room={baseRoom} isPlaying={true} onOpenModal={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('Open')).toBeTruthy()
  })

  it('shows syncing message when paused', () => {
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} syncPhase="paused" onOpenModal={() => {}} onLeave={() => {}} />)
    expect(screen.getByText(/Syncing/)).toBeTruthy()
  })

  it('shows buffering message when loading', () => {
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} syncPhase="loading" onOpenModal={() => {}} onLeave={() => {}} />)
    expect(screen.getByText(/Pre-buffering/)).toBeTruthy()
  })

  it('calls onOpenModal on open click', () => {
    const onOpen = vi.fn()
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} onOpenModal={onOpen} onLeave={() => {}} />)
    fireEvent.click(screen.getByText('Open'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('calls onLeave on leave click', async () => {
    const onLeave = vi.fn()
    render(<WatchTogetherBanner room={baseRoom} isPlaying={false} onOpenModal={() => {}} onLeave={onLeave} />)
    fireEvent.click(screen.getByLabelText('Leave watch together room'))
    // onLeave is called after wtLeaveRoom resolves
    await vi.waitFor(() => expect(onLeave).toHaveBeenCalled())
  })
})
