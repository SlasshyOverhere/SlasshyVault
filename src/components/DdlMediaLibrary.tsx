import { useState, useEffect } from "react"
import { Loader2 } from "lucide-react"
import { getDdlMedia, MediaItem } from "@/services/api"
import { MovieCard } from "./MovieCard"

interface DdlMediaLibraryProps {
  viewMode: "grid" | "list"
  onItemClick: (item: MediaItem) => void
  onFixMatch: (item: MediaItem) => void
  onDownload?: (item: MediaItem) => void | Promise<void>
  onDelete?: (item: MediaItem) => void
  onWatchTogether?: (item: MediaItem) => void
  onAskAI?: (item: MediaItem) => void
}

export function DdlMediaLibrary({
  viewMode,
  onItemClick,
  onFixMatch,
  onDownload,
  onDelete,
  onWatchTogether,
  onAskAI,
}: DdlMediaLibraryProps) {
  const [tvShows, setTvShows] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const tvItems = await getDdlMedia("tv")
      if (cancelled) return
      setTvShows(tvItems)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (tvShows.length === 0) {
    return null
  }

  return (
    <div className={viewMode === "grid" ? "grid-media" : "list-media"}>
      {tvShows.map((item, index) => (
        <MovieCard
          key={item.id}
          item={item}
          index={index}
          layout={viewMode}
          onClick={onItemClick}
          onFixMatch={onFixMatch}
          onDownload={onDownload}
          onDelete={onDelete}
          onWatchTogether={onWatchTogether}
          onAskAI={onAskAI}
        />
      ))}
    </div>
  )
}
