export interface RemoteStreamData {
  name: string
  description: string
  url: string
  videoSize: number
  notWebReady: boolean
  parsedQuality: string
  parsedSource: string
  recommended: boolean
}

export type QualityFilter = 'all' | '4K' | '1080p' | '720p'

export interface GroupedStreams {
  quality: string
  streams: RemoteStreamData[]
}

export type CacheState =
  | { type: 'idle' }
  | { type: 'downloading'; progress: number }
  | { type: 'complete' }
  | { type: 'cancelled' }
  | { type: 'failed'; error: string }

export interface CacheStatus {
  cacheKey: string
  state: CacheState
  downloadedBytes: number
  totalBytes: number
  speedBytesPerSecond: number
  targetPath: string
}

export interface TmdbSearchResult {
  id: number
  title?: string
  name?: string
  media_type: 'movie' | 'tv'
  poster_path?: string
  backdrop_path?: string
  overview?: string
  release_date?: string
  first_air_date?: string
  vote_average?: number
  imdb_id?: string
}

export type StreamStatus = 'pending' | 'active' | 'inactive'

export interface StreamVerification {
  url: string
  active: boolean
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIdx = 0
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024
    unitIdx++
  }
  return `${size.toFixed(2)} ${units[unitIdx]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let speed = bytesPerSec
  let unitIdx = 0
  while (speed >= 1024 && unitIdx < units.length - 1) {
    speed /= 1024
    unitIdx++
  }
  return `${speed.toFixed(1)} ${units[unitIdx]}`
}

export function getYear(dateStr?: string): string {
  if (!dateStr) return ''
  return dateStr.substring(0, 4)
}
