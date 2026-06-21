// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ParticipantList } from './ParticipantList'

vi.mock('lucide-react', () => ({
  User: () => <span />,
  Crown: () => <span />,
  Check: () => <span />,
  Clock: () => <span />,
}))

const participants = [
  { id: 'h1', nickname: 'Host', is_host: true, is_ready: true },
  { id: 'u2', nickname: 'Guest', is_host: false, is_ready: false },
]

describe('ParticipantList', () => {
  it('shows empty state', () => {
    render(<ParticipantList participants={[]} />)
    expect(screen.getByText('No participants')).toBeTruthy()
  })

  it('renders participants', () => {
    render(<ParticipantList participants={participants} />)
    expect(screen.getAllByText('Host').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Guest')).toBeTruthy()
  })

  it('shows host badge', () => {
    render(<ParticipantList participants={participants} />)
    expect(screen.getAllByText('Host').length).toBeGreaterThanOrEqual(1)
  })

  it('shows ready status', () => {
    render(<ParticipantList participants={participants} />)
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('Waiting')).toBeTruthy()
  })

  it('shows (you) for current user', () => {
    render(<ParticipantList participants={participants} currentUserId="h1" />)
    expect(screen.getByText('(you)')).toBeTruthy()
  })

  it('shows buffering sync state', () => {
    const syncStates = new Map([['u2', 'loading']])
    render(<ParticipantList participants={participants} syncStates={syncStates} />)
    expect(screen.getByText('buffering…')).toBeTruthy()
  })

  it('shows ready sync state', () => {
    const syncStates = new Map([['u2', 'ready']])
    render(<ParticipantList participants={participants} syncStates={syncStates} />)
    expect(screen.getByText('ready')).toBeTruthy()
  })

  it('shows syncing (paused) sync state', () => {
    const syncStates = new Map([['u2', 'paused']])
    render(<ParticipantList participants={participants} syncStates={syncStates} />)
    expect(screen.getByText('syncing')).toBeTruthy()
  })

  it('handles null participants', () => {
    render(<ParticipantList participants={null as any} />)
    expect(screen.getByText('No participants')).toBeTruthy()
  })
})
