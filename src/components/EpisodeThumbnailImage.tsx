import { useEffect, useState, memo } from "react"
import { getCachedImageUrl } from "@/services/api"
import { Loader2 } from "lucide-react"
import type { EpisodeThumbnailImageProps } from "./EpisodeThumbnailImage.types"

function EpisodeThumbnailImageBase({
  localStillPath,
  tmdbStillUrl,
  episodeTitle,
  episodeNumber,
}: EpisodeThumbnailImageProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const loadImage = async () => {
      setLoading(true)
      setImageUrl(null)

      if (localStillPath) {
        let filename = localStillPath
        if (filename.startsWith("image_cache/")) {
          filename = filename.replace("image_cache/", "")
        }

        try {
          const cachedUrl = await getCachedImageUrl(filename)
          if (cachedUrl && !cancelled) {
            setImageUrl(cachedUrl)
            setLoading(false)
            return
          }
        } catch {
          // Fall through to TMDB
        }
      }

      if (!cancelled) {
        if (tmdbStillUrl) {
          setImageUrl(tmdbStillUrl)
        }
        setLoading(false)
      }
    }

    loadImage()

    return () => {
      cancelled = true
    }
  }, [localStillPath, tmdbStillUrl, episodeNumber])

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/50">
        <Loader2 className="size-6 animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={episodeTitle}
        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
      />
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/50">
      <span className="text-2xl font-bold text-muted-foreground/50">
        {episodeNumber > 0 ? episodeNumber : "?"}
      </span>
    </div>
  )
}

export const EpisodeThumbnailImage = memo(EpisodeThumbnailImageBase)
