import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HardDrive, ThumbsUp, Film, Subtitles, AudioLines, Monitor, Database, Play, Copy, Check } from 'lucide-react'
import { formatFileSize } from './remote.types'
import { cn } from '@/lib/utils'
import type { GroupedStreams, RemoteStreamData, QualityFilter } from './remote.types'

interface ParsedMeta {
  codec: string | null
  hdr: string | null
  audio: string | null
  source: string | null
  hoster: string | null
  group: string | null
  size: string | null
}

function StreamMetaTags({ description, videoSize }: { description: string; videoSize: number }) {
  const meta = useMemo(() => parseStreamDescription(description), [description])
  const sizeLabel = videoSize > 0 ? formatFileSize(videoSize) : meta.size
  const tags: { key: string; label: string | null; icon: React.ComponentType<{ className?: string }> | null }[] = [
    ...(sizeLabel ? [{ key: 'size' as const, label: sizeLabel, icon: HardDrive }] : []),
    { key: 'source', label: meta.source, icon: Monitor },
    { key: 'codec', label: meta.codec, icon: Database },
    { key: 'hdr', label: meta.hdr, icon: Subtitles },
    { key: 'audio', label: meta.audio, icon: AudioLines },
    { key: 'hoster', label: meta.hoster, icon: null },
    { key: 'group', label: meta.group, icon: null },
  ].filter((t) => t.label)

  if (tags.length === 0) {
    return (
      <p className="text-[12px] text-neutral-600 leading-relaxed line-clamp-2">
        {description}
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span
          key={t.key}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-neutral-800/60 text-neutral-400"
        >
          {t.icon && <t.icon className="size-3" />}
          {t.label}
        </span>
      ))}
    </div>
  )
}

function parseStreamDescription(desc: string): ParsedMeta {
  const m: ParsedMeta = { codec: null, hdr: null, audio: null, source: null, hoster: null, group: null, size: null }

  const codecs = desc.match(/x265|x264|HEVC|AVC|AV1|VP9|MPEG-2/i)
  if (codecs) m.codec = codecs[0].toUpperCase()

  const hdrs = desc.match(/\b(SDR|HDR10?|Dolby\s*Vision|HLG|HDR)\b/i)
  if (hdrs) m.hdr = hdrs[1] || hdrs[0]

  const audios = desc.match(/(?:DDP?|TrueHD|FLAC|AAC|AC3|E-?AC-?3|DTS(?:\s*[-\s]?HD)?)\s*[\d.]+\s*ch/i)
  if (audios) m.audio = audios[0]

  const sources = desc.match(/\b(WEB-?DL|BluRay|WEBRip|BRRip|DVDRip|HDTV|HDRip|CAM|TS|TC)\b/i)
  if (sources) m.source = sources[1] || sources[0]

  const hosters = desc.match(/\|\s*([A-Za-z0-9]+)\s*$/)
  if (hosters) m.hoster = hosters[1]

  const groups = desc.match(/^\[([^\]]+)\]/)
  if (groups) m.group = groups[1]

  const sizes = desc.match(/(?:💾\s*)?([\d.]+)\s*(GB|GiB|MB|MiB)\b/i)
  if (sizes) m.size = `${sizes[1]} ${sizes[2].toUpperCase()}`

  return m
}

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
  const [copiedStreamUrl, setCopiedStreamUrl] = useState<string | null>(null)

  const filtered = useMemo(() => {
    if (qualityFilter === 'all') return groupedStreams
    return groupedStreams.filter((g) => g.quality === qualityFilter)
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
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(stream.url).then(() => { setCopiedStreamUrl(stream.url); setTimeout(() => setCopiedStreamUrl(null), 2000) }) }}
                                  className="size-9 flex items-center justify-center rounded-xl bg-neutral-800/50 text-neutral-500 hover:bg-neutral-700/50 hover:text-neutral-300 transition-all duration-200 cursor-pointer"
                                >
                                  {copiedStreamUrl === stream.url ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                                </div>
                                <div className="size-9 flex items-center justify-center rounded-xl bg-amber-600/10 text-amber-500 group-hover:bg-amber-600/20 group-hover:text-amber-400 transition-all duration-200">
                                  <Play className="size-4" />
                                </div>
                              </div>
                            </div>

                            {stream.description && (
                              <div className="mt-1.5 border-t border-neutral-800/50 pt-1.5">
                                <StreamMetaTags description={stream.description} videoSize={stream.videoSize} />
                              </div>
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
