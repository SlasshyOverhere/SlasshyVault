import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HardDrive, Download, ThumbsUp } from 'lucide-react'
import { formatFileSize } from './remote.types'
import { cn } from '@/lib/utils'
import type { GroupedStreams, RemoteStreamData, QualityFilter } from './remote.types'

const QUALITY_FILTERS: QualityFilter[] = ['all', '4K', '1080p', '720p']

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  groupedStreams: GroupedStreams[]
  onSelect: (stream: RemoteStreamData) => void
  loading?: boolean
  error?: string | null
}

export function RemoteQualitySelector({
  open, onOpenChange, title, groupedStreams, onSelect, loading, error,
}: Props) {
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>('all')

  const filtered = useMemo(() => {
    if (qualityFilter === 'all') return groupedStreams
    return groupedStreams
      .map((g) => ({
        ...g,
        streams: g.streams.filter((s) => s.parsedQuality === qualityFilter),
      }))
      .filter((g) => g.streams.length > 0)
  }, [groupedStreams, qualityFilter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-[#141414] border-white/[0.08] text-white">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">
            Select Quality — {title}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="size-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span className="ml-3 text-sm text-neutral-400">Loading available streams...</span>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            {error}
          </div>
        )}

        {!loading && !error && groupedStreams.length > 0 && (
          <>
            <div className="flex gap-2">
              {QUALITY_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setQualityFilter(f)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all duration-200',
                    qualityFilter === f
                      ? 'bg-white/15 text-white border border-white/20'
                      : 'bg-white/[0.04] text-neutral-400 border border-transparent hover:bg-white/[0.08] hover:text-neutral-200',
                  )}
                >
                  {f === 'all' ? 'All' : f}
                </button>
              ))}
            </div>

            {filtered.length === 0 && (
              <div className="text-sm text-neutral-500 text-center py-8">
                No {qualityFilter} streams available
              </div>
            )}

            {filtered.length > 0 && (
              <ScrollArea className="max-h-96">
                <div className="space-y-3 pr-4">
                  {filtered.map((group) => (
                    <div key={group.quality}>
                      <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">
                        {group.quality}
                      </h4>
                      <div className="space-y-2">
                        {group.streams.map((stream, idx) => (
                          <button
                            key={idx}
                            onClick={() => onSelect(stream)}
                            className="w-full text-left p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/20 transition-all duration-200 group"
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-white/10 text-neutral-300 uppercase">
                                  {stream.parsedSource}
                                </span>
                                <span className="text-sm font-semibold text-white truncate">
                                  {stream.name}
                                </span>
                                {stream.recommended && (
                                  <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-green-500/15 text-green-400 border border-green-500/20">
                                    <ThumbsUp className="size-3" />
                                    Recommended
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-3 shrink-0">
                                {stream.videoSize > 0 && (
                                  <span className="flex items-center gap-1 text-xs text-neutral-400">
                                    <HardDrive className="size-3" />
                                    {formatFileSize(stream.videoSize)}
                                  </span>
                                )}
                                <Download className="size-4 text-neutral-600 group-hover:text-white transition-colors" />
                              </div>
                            </div>

                            {stream.description && (
                              <p className="mt-1 text-[11px] text-neutral-500 leading-relaxed line-clamp-2">
                                {stream.description}
                              </p>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </>
        )}

        {!loading && !error && groupedStreams.length === 0 && (
          <div className="text-sm text-neutral-500 text-center py-8">
            No streams available
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
