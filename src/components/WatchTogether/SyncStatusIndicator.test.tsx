// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SyncStatusIndicator } from './SyncStatusIndicator'

vi.mock('lucide-react', () => ({
  Wifi: () => <span />,
  WifiOff: () => <span />,
  AlertCircle: () => <span />,
}))

describe('SyncStatusIndicator', () => {
  it('shows buffering when loading phase', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="loading" />)
    expect(screen.getByText(/Pre-buffering/)).toBeTruthy()
  })

  it('shows syncing when paused phase', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="paused" />)
    expect(screen.getByText(/Syncing…/)).toBeTruthy()
  })

  it('shows connecting when lobby phase', () => {
    render(<SyncStatusIndicator isConnected={false} syncPhase="lobby" />)
    expect(screen.getByText('Connecting...')).toBeTruthy()
  })

  it('shows disconnected when not connected', () => {
    render(<SyncStatusIndicator isConnected={false} syncPhase="playing" lastSyncTime={Date.now()} />)
    expect(screen.getByText('Disconnected')).toBeTruthy()
  })

  it('shows in sync when connected with low drift', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="playing" positionDrift={0.5} lastSyncTime={Date.now()} />)
    expect(screen.getByText('In sync')).toBeTruthy()
  })

  it('shows out of sync when drift > 5', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="playing" positionDrift={6} lastSyncTime={Date.now()} />)
    expect(screen.getByText('Out of sync')).toBeTruthy()
  })

  it('shows syncing when drift > 2', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="playing" positionDrift={3} lastSyncTime={Date.now()} />)
    expect(screen.getByText('Syncing...')).toBeTruthy()
  })

  it('shows drift value when poor', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="playing" positionDrift={-6.5} lastSyncTime={Date.now()} />)
    expect(screen.getByText(/6\.5s/)).toBeTruthy()
  })

  it('shows positive drift with + prefix', () => {
    render(<SyncStatusIndicator isConnected={true} syncPhase="playing" positionDrift={8} lastSyncTime={Date.now()} />)
    expect(screen.getByText(/8\.0s/)).toBeTruthy()
  })
})
