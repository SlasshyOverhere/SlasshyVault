import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildZipPlaybackLoadingState,
  waitForZipLoadingOverlayPaint,
  waitForMinimumZipOverlayVisibility,
  waitForMpvPlaybackStart,
} from './zipPlayback'
import type { MediaItem } from '@/services/api'
import { getMpvStatus } from '@/services/api'

// Mock getMpvStatus so import doesn't break
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    getMpvStatus: vi.fn().mockResolvedValue({ is_playing: false, duration: 0 }),
  }
})

const baseItem: MediaItem = {
  id: 1,
  title: 'Test Episode',
  media_type: 'tvepisode',
}

describe('buildZipPlaybackLoadingState', () => {
  it('builds state for deflate-compressed item', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 8,
      zip_uncompressed_size: 1073741824, // 1 GB
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.title).toBe('Test Episode')
    expect(state.resume).toBe(false)
    expect(state.estimatedSeconds).toBeGreaterThanOrEqual(12)
    expect(state.estimatedSeconds).toBeLessThanOrEqual(120)
    expect(state.sizeLabel).toContain('GB')
    expect(state.detail).toContain('extracted')
  })

  it('builds state for store (no compression) item', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      zip_compressed_size: 536870912, // 512 MB
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.detail).toContain('being prepared')
    expect(state.sizeLabel).toContain('MB')
  })

  it('adds season/episode label when available', () => {
    const item: MediaItem = {
      ...baseItem,
      season_number: 3,
      episode_number: 7,
      zip_compression_method: 0,
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.title).toBe('Test Episode • S03E07')
  })

  it('does not add season/episode label when missing', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.title).toBe('Test Episode')
  })

  it('increases estimate for resume', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      zip_uncompressed_size: 1073741824,
    }
    const fresh = buildZipPlaybackLoadingState(item, false)
    const resumed = buildZipPlaybackLoadingState(item, true)
    expect(resumed.estimatedSeconds).toBeGreaterThanOrEqual(fresh.estimatedSeconds)
    expect(resumed.resume).toBe(true)
  })

  it('uses MKV-specific estimate for .mkv zip entries', () => {
    const mkvItem: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      zip_entry_path: 'episode.mkv',
      zip_uncompressed_size: 1073741824,
    }
    const mp4Item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      zip_entry_path: 'episode.mp4',
      zip_uncompressed_size: 1073741824,
    }
    const mkvState = buildZipPlaybackLoadingState(mkvItem, false)
    const mp4State = buildZipPlaybackLoadingState(mp4Item, false)
    // MKV gets slightly higher estimate
    expect(mkvState.estimatedSeconds).toBeGreaterThanOrEqual(mp4State.estimatedSeconds)
  })

  it('falls back to file_path for MKV detection', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      file_path: '/some/path/video.mkv',
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.estimatedSeconds).toBeGreaterThan(0)
  })

  it('handles zero-size item', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.sizeLabel).toBe('0 B')
    expect(state.estimatedSeconds).toBeGreaterThanOrEqual(7)
  })

  it('uses zip_compressed_size as fallback when uncompressed is missing', () => {
    const item: MediaItem = {
      ...baseItem,
      zip_compression_method: 0,
      zip_compressed_size: 2147483648, // 2 GB
    }
    const state = buildZipPlaybackLoadingState(item, false)
    expect(state.sizeLabel).toContain('GB')
  })
})

describe('waitForZipLoadingOverlayPaint', () => {
  it('resolves after two requestAnimationFrame calls', async () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })

    const promise = waitForZipLoadingOverlayPaint()
    callbacks[0](0)
    await vi.waitFor(() => {
      expect(callbacks.length).toBeGreaterThanOrEqual(2)
    })
    callbacks[1](0)
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('waitForMinimumZipOverlayVisibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not delay when enough time has passed', async () => {
    const now = Date.now()
    vi.setSystemTime(now + 2000)
    await waitForMinimumZipOverlayVisibility(now, 900)
  })

  it('delays when not enough time has passed', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const promise = waitForMinimumZipOverlayVisibility(now, 900)
    vi.advanceTimersByTime(900)
    await promise
  })
})

describe('waitForMpvPlaybackStart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns true when mpv starts playing', async () => {
    vi.mocked(getMpvStatus).mockResolvedValueOnce({
      is_playing: true,
      media_id: 1,
      duration: 120,
    })
    const result = await waitForMpvPlaybackStart(1, 5000)
    expect(result).toBe(true)
  })

  it('returns false on timeout', async () => {
    vi.mocked(getMpvStatus).mockResolvedValue({
      is_playing: false,
      media_id: 1,
    })
    const now = Date.now()
    const promise = waitForMpvPlaybackStart(1, 1000)
    // Advance both timers and system time past the 1000ms timeout
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(350)
      vi.setSystemTime(now + (i + 1) * 350)
      await Promise.resolve() // let microtasks flush
    }
    const result = await promise
    expect(result).toBe(false)
  })
})
