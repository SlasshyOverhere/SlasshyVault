import { useState, useEffect, useMemo } from "react"
import { Loader2, Download, Check, Captions } from "lucide-react"
import { fetchSubtitles, downloadSubtitle, type SubtitleEntry, type MediaItem } from "@/services/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SubtitleSelectorProps {
  item: MediaItem
  onSubtitleReady: (filePath: string) => void
}

interface GroupedSubtitles {
  lang: string
  entries: SubtitleEntry[]
}

export function SubtitleSelector({ item, onSubtitleReady }: SubtitleSelectorProps) {
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadedId, setDownloadedId] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!item.imdb_id) {
      setSubtitles([])
      setError(null)
      return
    }

    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const results = await fetchSubtitles(item.imdb_id!, item.media_type)
        if (!cancelled) {
          setSubtitles(results)
          if (results.length === 0) {
            setError("No subtitles found for this title.")
          }
        }
      } catch {
        if (!cancelled) setError("Failed to fetch subtitles.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [item.imdb_id, item.media_type])

  const grouped = useMemo((): GroupedSubtitles[] => {
    const map = new Map<string, SubtitleEntry[]>()
    for (const entry of subtitles) {
      const key = entry.lang || "unknown"
      const arr = map.get(key) ?? []
      arr.push(entry)
      map.set(key, arr)
    }
    return Array.from(map, ([lang, entries]) => ({ lang, entries }))
      .sort((a, b) => a.lang.localeCompare(b.lang))
  }, [subtitles])

  const handleDownload = async (entry: SubtitleEntry) => {
    setDownloadingId(entry.id)
    try {
      const ext = entry.url.match(/\.(srt|vtt|sub|ass)(?:\?|$)/i)?.[1] ?? "srt"
      const safeName = `${item.imdb_id || "sub"}_${entry.lang}_${entry.id}.${ext}`
      const path = await downloadSubtitle(entry.url, safeName)
      setDownloadedId(entry.id)
      setSelectedPath(path)
    } catch (err) {
      console.error("Subtitle download failed:", err)
    } finally {
      setDownloadingId(null)
    }
  }

  const handleUseSubtitle = () => {
    if (selectedPath) onSubtitleReady(selectedPath)
  }

  if (!item.imdb_id) return null

  return (
    <div className="w-full overflow-hidden rounded-lg border border-white/12 bg-black/38 shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-white/48">
            OpenSubtitles
          </p>
          <p className="mt-1 max-w-[260px] truncate text-[11px] font-medium text-white/36">
            External subtitles for cloud playback
          </p>
        </div>
      </div>

      <div className="px-3.5 py-3">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-white/40">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">Fetching available subtitles...</span>
          </div>
        )}

        {error && !loading && (
          <p className="py-3 text-xs text-white/30">{error}</p>
        )}

        {!loading && !error && grouped.length > 0 && (
          <div className="max-h-[200px] space-y-2 overflow-y-auto no-scrollbar">
            {grouped.map(({ lang, entries }) => (
              <div key={lang}>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                  {lang}
                </p>
                <div className="space-y-1">
                  {entries.map((entry) => {
                    const isDownloaded = downloadedId === entry.id
                    const isDownloading = downloadingId === entry.id
                    return (
                      <div
                        key={entry.id}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs",
                          isDownloaded
                            ? "bg-green-500/10 border border-green-500/20"
                            : "bg-white/[0.04] border border-white/[0.06]"
                        )}
                      >
                        <span className="truncate text-white/60">{entry.id}</span>
                        <button
                          type="button"
                          disabled={isDownloading}
                          onClick={() => void handleDownload(entry)}
                          className={cn(
                            "shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                            isDownloaded
                              ? "bg-green-500/20 text-green-300"
                              : "bg-white/10 text-white/60 hover:bg-white/15 hover:text-white"
                          )}
                        >
                          {isDownloading ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : isDownloaded ? (
                            <Check className="size-3" />
                          ) : (
                            <Download className="size-3" />
                          )}
                          {isDownloaded ? "Done" : isDownloading ? "..." : "Get"}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedPath && (
        <div className="border-t border-white/10 px-3.5 py-2.5">
          <Button
            onClick={handleUseSubtitle}
            className="h-9 w-full rounded-md bg-white text-black text-xs font-bold hover:bg-white/90"
          >
            <Captions className="size-3.5 mr-1.5" />
            Use Subtitle in Playback
          </Button>
        </div>
      )}
    </div>
  )
}
