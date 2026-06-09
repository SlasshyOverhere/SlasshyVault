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
  const isComplete = state.type === 'complete'
  const isFailed = state.type === 'failed'
  const isCancelled = state.type === 'cancelled'

  const progress = isDownloading ? state.progress : (isComplete ? 100 : 0)
  const progressPercent = Math.min(Math.round(progress), 100)

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
      <div className="bg-[#141414] border border-white/[0.08] rounded-xl px-4 py-3 shadow-2xl min-w-[320px] max-w-md">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {isDownloading && <Download className="size-4 text-blue-400 animate-pulse" />}
            {isComplete && <CheckCircle2 className="size-4 text-green-400" />}
            {isFailed && <AlertCircle className="size-4 text-red-400" />}
            {isCancelled && <XCircle className="size-4 text-neutral-400" />}
            <span className="text-sm font-semibold text-white">
              {isDownloading && 'Caching...'}
              {isComplete && 'Cached'}
              {isFailed && 'Cache failed'}
              {isCancelled && 'Cache cancelled'}
            </span>
          </div>

          {isDownloading && (
            <span className="text-xs text-neutral-400">
              {formatSpeed(status.speedBytesPerSecond)}
            </span>
          )}
        </div>

        {/* Progress bar */}
        {isDownloading && (
          <>
            <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-neutral-500">
                {formatFileSize(status.downloadedBytes)} / {formatFileSize(status.totalBytes)}
              </span>
              <span className="text-[10px] text-neutral-500">{progressPercent}%</span>
            </div>
          </>
        )}

        {isComplete && (
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-green-500">
              {formatFileSize(status.totalBytes)} cached
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
