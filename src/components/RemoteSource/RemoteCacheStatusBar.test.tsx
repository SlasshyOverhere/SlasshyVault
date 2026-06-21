// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RemoteCacheStatusBar } from './RemoteCacheStatusBar'

vi.mock('lucide-react', () => ({
  Download: () => <span />,
  CheckCircle2: () => <span />,
  AlertCircle: () => <span />,
  XCircle: () => <span />,
}))

describe('RemoteCacheStatusBar', () => {
  it('renders nothing when status is null', () => {
    const { container } = render(<RemoteCacheStatusBar status={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when idle', () => {
    const { container } = render(
      <RemoteCacheStatusBar status={{ cacheKey: 'k', state: { type: 'idle' }, downloadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, targetPath: '' }} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows downloading state', () => {
    render(
      <RemoteCacheStatusBar status={{ cacheKey: 'k', state: { type: 'downloading', progress: 50 }, downloadedBytes: 500, totalBytes: 1000, speedBytesPerSecond: 100, targetPath: '' }} />
    )
    expect(screen.getByText('Caching stream...')).toBeTruthy()
    expect(screen.getByText(/50%/)).toBeTruthy()
  })

  it('shows cached state', () => {
    render(
      <RemoteCacheStatusBar status={{ cacheKey: 'k', state: { type: 'cached', path: '/tmp/file' }, downloadedBytes: 1000, totalBytes: 1000, speedBytesPerSecond: 0, targetPath: '' }} />
    )
    expect(screen.getByText('Cached')).toBeTruthy()
  })

  it('shows failed state', () => {
    render(
      <RemoteCacheStatusBar status={{ cacheKey: 'k', state: { type: 'failed', error: 'disk full' }, downloadedBytes: 0, totalBytes: 1000, speedBytesPerSecond: 0, targetPath: '' }} />
    )
    expect(screen.getByText('Cache failed')).toBeTruthy()
  })

  it('shows cancelled state', () => {
    render(
      <RemoteCacheStatusBar status={{ cacheKey: 'k', state: { type: 'cancelled' }, downloadedBytes: 0, totalBytes: 1000, speedBytesPerSecond: 0, targetPath: '' }} />
    )
    expect(screen.getByText('Cache cancelled')).toBeTruthy()
  })
})
