import { Download, CheckCircle2, AlertCircle, XCircle } from 'lucide-react'
import { formatFileSize, formatSpeed } from './remote.types'
import type { CacheStatus } from './remote.types'

interface Props {
  status: CacheStatus | null
}

export function RemoteCacheStatusBar({ status }: Props) {
  if (!status) return null

  const state = status.state

  if (state.type === 'idle') return null

  const isDownloading = state.type === 'downloading'
  const isCached = state.type === 'cached'
  const isFailed = state.type === 'failed'
  const isCancelled = state.type === 'cancelled'

  const progress = isDownloading ? state.progress : (isCached ? 100 : 0)
  const progressPercent = Math.min(Math.round(progress), 100)

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
      <div className="bg-[#0A0A0A] border border-neutral-800 rounded-2xl px-5 py-3.5 shadow-2xl min-w-[280px] sm:min-w-[340px] max-w-md shadow-black/50">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2.5">
            {isDownloading && <Download className="size-4 text-amber-400 animate-pulse" />}
            {isCached && <CheckCircle2 className="size-4 text-green-400" />}
            {isFailed && <AlertCircle className="size-4 text-red-400" />}
            {isCancelled && <XCircle className="size-4 text-neutral-500" />}
            <span className="text-sm font-semibold text-neutral-200">
              {isDownloading && 'Caching stream...'}
              {isCached && 'Cached'}
              {isFailed && 'Cache failed'}
              {isCancelled && 'Cache cancelled'}
            </span>
          </div>

          {isDownloading && (
            <span className="text-xs text-neutral-600 font-medium tabular-nums">
              {formatSpeed(status.speedBytesPerSecond)}
            </span>
          )}
        </div>

        {isDownloading && (
          <>
            <div className="h-1.5 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-800/50">
              <div
                className="h-full bg-gradient-to-r from-amber-600 to-amber-400 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[10px] text-neutral-600 font-medium tabular-nums">
                {formatFileSize(status.downloadedBytes)} / {formatFileSize(status.totalBytes)}
              </span>
              <span className="text-[10px] text-neutral-600 font-medium tabular-nums">{progressPercent}%</span>
            </div>
          </>
        )}

        {isCached && (
          <div className="flex justify-between mt-1">
            <span className="text-[11px] text-green-500/80 font-medium">
              {formatFileSize(status.totalBytes)} cached
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
