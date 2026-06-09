import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HardDrive, Download, ThumbsUp, Film } from 'lucide-react'
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
      <DialogContent className="sm:max-w-xl bg-[#0A0A0A] border-neutral-800 text-neutral-100 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-neutral-100 flex items-center gap-2">
            <Film className="size-4 text-amber-500/70" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12 gap-3">
            <div className="size-5 rounded-full border-2 border-neutral-700 border-t-amber-600/60 animate-spin" />
            <span className="text-sm text-neutral-500 font-medium">Loading available streams...</span>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400 bg-red-500/5 border border-red-800/30 rounded-xl p-4 font-medium">
            {error}
          </div>
        )}

        {!loading && !error && groupedStreams.length > 0 && (
          <>
            <div className="flex gap-1.5">
              {QUALITY_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setQualityFilter(f)}
                  className={cn(
                    'px-3.5 py-1.5 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all duration-200 border',
                    qualityFilter === f
                      ? 'bg-amber-600/15 text-amber-400 border-amber-700/30'
                      : 'bg-[#0D0D0D] text-neutral-500 border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300 hover:border-neutral-700',
                  )}
                >
                  {f === 'all' ? 'All' : f}
                </button>
              ))}
            </div>

            {filtered.length === 0 && (
              <div className="text-sm text-neutral-600 text-center py-10 font-medium">
                No {qualityFilter} streams available
              </div>
            )}

            {filtered.length > 0 && (
              <ScrollArea className="max-h-[420px]">
                <div className="space-y-3 pr-3">
                  {filtered.map((group) => (
                    <div key={group.quality}>
                      <h4 className="text-[11px] font-bold text-neutral-600 uppercase tracking-widest mb-2.5 px-1">
                        {group.quality}
                      </h4>
                      <div className="space-y-2">
                        {group.streams.map((stream, idx) => (
                          <button
                            key={idx}
                            onClick={() => onSelect(stream)}
                            className="w-full text-left p-4 rounded-2xl bg-[#0D0D0D] border border-neutral-800 hover:bg-neutral-900 hover:border-neutral-700/60 transition-all duration-200 group"
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <span className="shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-neutral-800 text-neutral-400 uppercase tracking-wider">
                                  {stream.parsedSource}
                                </span>
                                <span className="text-sm font-semibold text-neutral-200 truncate">
                                  {stream.name}
                                </span>
                                {stream.recommended && (
                                  <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-amber-600/10 text-amber-500/80 border border-amber-700/20">
                                    <ThumbsUp className="size-3" />
                                    Recommended
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-3 shrink-0">
                                {stream.videoSize > 0 && (
                                  <span className="flex items-center gap-1.5 text-xs text-neutral-600 font-medium">
                                    <HardDrive className="size-3.5" />
                                    {formatFileSize(stream.videoSize)}
                                  </span>
                                )}
                                <div className="size-9 flex items-center justify-center rounded-xl bg-neutral-800/50 text-neutral-500 group-hover:bg-amber-600/10 group-hover:text-amber-400 transition-all duration-200">
                                  <Download className="size-4" />
                                </div>
                              </div>
                            </div>

                            {stream.description && (
                              <p className="mt-2 text-[12px] text-neutral-600 leading-relaxed line-clamp-2 border-t border-neutral-800/50 pt-2">
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
          <div className="text-sm text-neutral-600 text-center py-10 font-medium">
            No streams available
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
