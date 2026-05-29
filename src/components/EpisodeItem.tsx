import { memo } from "react"
import { Play, Check, Download, Share2, Star, Timer, Calendar, EyeOff, Eye } from "lucide-react"
import {
  MediaItem,
  TmdbEpisodeInfo,
  getTmdbImageUrl,
} from "@/services/api"
import { EpisodeThumbnailImage } from "@/components/EpisodeThumbnailImage"
import { KebabMenu } from "@/components/KebabMenu"
import { getZipCompressionLabel } from "@/utils/zip"
import { m as motion, LazyMotion, domAnimation } from "framer-motion"
import { cn } from "@/lib/utils"
import {
  getMediaProgressPercent,
  isMediaMarkedWatched,
} from "@/utils/playbackProgress"

export interface EpisodeItemProps {
  episode: MediaItem
  index: number
  tmdbData?: TmdbEpisodeInfo
  imdbRating?: { rating: number | null; votes: number | null } | null
  imdbTitle?: string | null
  imdbPlot?: string | null
  imdbStillUrl?: string | null
  isExpanded: boolean
  spoilerProtected: boolean
  isRevealed: boolean
  onEpisodeClick: (episode: MediaItem) => void
  onToggleExpand: (episodeId: number) => void
  onMarkWatched: (episode: MediaItem) => void
  onUnwatch?: (episode: MediaItem) => void
  onToggleSpoiler?: (episode: MediaItem) => void
  onDownload?: (episode: MediaItem) => void | Promise<void>
}

function EpisodeItemBase({
  episode,
  index,
  tmdbData,
  imdbRating,
  imdbTitle,
  imdbPlot,
  imdbStillUrl,
  isExpanded,
  spoilerProtected,
  isRevealed,
  onEpisodeClick,
  onToggleExpand,
  onMarkWatched,
  onUnwatch,
  onToggleSpoiler,
  onDownload,
}: EpisodeItemProps) {
  const spoilerActive = spoilerProtected && !isRevealed
  const progress = getMediaProgressPercent(episode)
  const isFinished = isMediaMarkedWatched(episode)
  const hasProgress = progress > 0 && !isFinished

  const localStillPath = episode.still_path || imdbStillUrl || undefined
  const stillUrl = localStillPath
    ? null
    : getTmdbImageUrl(tmdbData?.still_path, "w300")

  const episodeTitle =
    episode.episode_title ||
    tmdbData?.name ||
    imdbTitle ||
    episode.title ||
    `Episode ${episode.episode_number}`

  const localRuntimeMinutes =
    episode.duration_seconds && episode.duration_seconds >= 60
      ? Math.round(episode.duration_seconds / 60)
      : null
  const tmdbRuntimeMinutes =
    tmdbData?.runtime && tmdbData.runtime > 0 ? tmdbData.runtime : null
  const runtimeMinutes = localRuntimeMinutes ?? tmdbRuntimeMinutes
  const displayRuntime = runtimeMinutes ? `${runtimeMinutes}m` : null

  const zipCompressionLabel = episode.parent_zip_id
    ? getZipCompressionLabel(episode.zip_compression_method)
    : null

  const imdbRatingValue = imdbRating?.rating && imdbRating.rating > 0
    ? imdbRating.rating.toFixed(1)
    : null

  const tmdbRatingValue = tmdbData?.vote_average && tmdbData.vote_average > 0
    ? tmdbData.vote_average.toFixed(1)
    : null

  const rating = imdbRatingValue ?? tmdbRatingValue

  const airDateLabel = tmdbData?.air_date
    ? new Date(tmdbData.air_date).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).replace(",", "")
    : null

  const containerFormat = (() => {
    const p = episode.file_path || episode.zip_entry_path
    if (!p) return null
    const i = p.lastIndexOf(".")
    if (i < 0 || i === p.length - 1) return null
    return p.slice(i + 1).toUpperCase()
  })()

  const fileSize = episode.file_size_bytes ?? episode.zip_uncompressed_size ?? episode.zip_compressed_size
  const fileSizeLabel = fileSize && Number.isFinite(fileSize) && fileSize > 0
    ? (() => {
        const units = ["B", "KB", "MB", "GB", "TB"]
        let v = fileSize
        let u = 0
        while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
        const d = v >= 100 ? 0 : v >= 10 ? 1 : 2
        return `${v.toFixed(d)} ${units[u]}`
      })()
    : null

  const descriptionText = episode.overview || tmdbData?.overview || imdbPlot || null
  const showExpandToggle = (descriptionText?.length || 0) > 120

  const handlePlayClick = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    onEpisodeClick(episode)
  }

  const handleToggleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggleExpand(episode.id)
  }

  const menuItems = [
    ...(isFinished && onUnwatch ? [{ icon: Check, label: "Unmark Watched", onClick: () => onUnwatch(episode) }] : []),
    ...(!isFinished ? [{ icon: Check, label: "Mark Watched", onClick: () => onMarkWatched(episode) }] : []),
    ...(onDownload ? [{ icon: Download, label: "Download", onClick: () => onDownload(episode) }] : []),
    { icon: Share2, label: "Share", onClick: () => {} },
  ]

  return (
    <LazyMotion features={domAnimation}>
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={handlePlayClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePlayClick() } }}
        className={cn(
          "group relative bg-zinc-900/80 border border-zinc-800/80",
          "hover:border-zinc-700/80 rounded-xl overflow-hidden",
          "transition-all duration-400 cursor-pointer",
          "hover:shadow-2xl hover:shadow-black/50 hover:-translate-y-1",
        )}
      >
        {/* Thumbnail */}
        <div className="relative aspect-video overflow-hidden bg-zinc-800/50">
          <div className={cn(
            "absolute inset-0 transition-transform duration-500 group-hover:scale-105",
            spoilerActive && "blur-md",
          )}>
            <EpisodeThumbnailImage
              localStillPath={localStillPath}
              tmdbStillUrl={stillUrl}
              episodeTitle={episodeTitle}
              episodeNumber={episode.episode_number || 0}
            />
          </div>

          {/* Gradient overlay + Play button (on hover) */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="size-14 rounded-xl bg-white flex items-center justify-center shadow-2xl shadow-black/50 scale-90 group-hover:scale-100 transition-transform duration-300 ease-out">
                <Play className="size-6 text-black fill-black ml-0.5" />
              </div>
            </div>
          </div>

          {/* Episode number badge */}
          <div className="absolute top-3 left-3 px-2.5 py-1 rounded-lg bg-black/70 backdrop-blur-sm text-[10px] font-extrabold text-white/90 tracking-wider">
            E{episode.episode_number}
          </div>

          {/* Rating badge */}
          {rating && (
            <div className="absolute top-3 right-3 px-2 py-1 rounded-lg bg-amber-500/20 backdrop-blur-sm text-[10px] font-extrabold text-amber-400 flex items-center gap-1">
              <Star className="size-3 fill-amber-400" />
              {rating}
            </div>
          )}

          {/* Progress bar */}
          {hasProgress && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
              <div
                className="h-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)] transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {/* Finished indicator */}
          {isFinished && (
            <div className="absolute bottom-2 left-3 px-2 py-0.5 rounded-md bg-emerald-500/20 backdrop-blur-sm text-[9px] font-extrabold text-emerald-400 tracking-wider uppercase">
              Watched
            </div>
          )}

          {/* ZIP badge */}
          {zipCompressionLabel && (
            <div className="absolute bottom-2 right-3 px-2 py-0.5 rounded-md bg-zinc-900/70 backdrop-blur-sm text-[9px] font-extrabold text-zinc-400 tracking-wider uppercase">
              ZIP: {zipCompressionLabel}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-4 space-y-2.5">
          <h3 className="text-sm font-bold text-white/90 line-clamp-1 group-hover:text-amber-400 transition-colors duration-300">
            {episodeTitle}
          </h3>

          {/* Metadata row */}
          <div className="flex items-center gap-2 text-[10px] font-semibold text-white/30 uppercase tracking-wider flex-wrap">
            {airDateLabel && (
              <span className="flex items-center gap-1">
                <Calendar className="size-3 opacity-60" />
                {airDateLabel}
              </span>
            )}
            {containerFormat && (
              <>
                <span className="text-white/12">|</span>
                <span>{containerFormat}</span>
              </>
            )}
            {fileSizeLabel && (
              <>
                <span className="text-white/12">|</span>
                <span>{fileSizeLabel}</span>
              </>
            )}
          </div>

          {/* Spoiler toggle pill */}
          {spoilerProtected && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleSpoiler?.(episode)
              }}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-wider transition-all duration-200 w-fit",
                isRevealed
                  ? "bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white/50 hover:text-white"
                  : "bg-white/10 hover:bg-white/20 border border-white/20 hover:border-white/30 text-white/70 hover:text-white",
              )}
            >
              {isRevealed ? (
                <>
                  <Eye className="size-3" />
                  Hide Spoilers
                </>
              ) : (
                <>
                  <EyeOff className="size-3" />
                  Show Spoilers
                </>
              )}
            </button>
          )}

          {/* Description */}
          {descriptionText && (
            <p className={cn(
              "text-xs text-white/40 leading-relaxed",
              isExpanded ? "" : "line-clamp-2",
              spoilerActive && "blur-sm",
            )}>
              {descriptionText}
            </p>
          )}
          {showExpandToggle && !spoilerActive && (
            <button
              type="button"
              onClick={handleToggleExpandClick}
              className="text-[10px] font-bold uppercase tracking-wider text-amber-400/60 hover:text-amber-400 transition-colors"
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
          )}

          {/* Actions row */}
          <div className="flex items-center gap-2 pt-1">
            <KebabMenu items={menuItems} />
            {displayRuntime && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-white/40 ml-auto">
                <Timer className="size-3 opacity-60" />
                {displayRuntime}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
    </LazyMotion>
  )
}

const areEpisodeItemPropsEqual = (
  prevProps: EpisodeItemProps,
  nextProps: EpisodeItemProps,
) =>
  prevProps.episode === nextProps.episode &&
  prevProps.isExpanded === nextProps.isExpanded &&
  prevProps.spoilerProtected === nextProps.spoilerProtected &&
  prevProps.isRevealed === nextProps.isRevealed &&
  prevProps.index === nextProps.index &&
  prevProps.tmdbData === nextProps.tmdbData &&
  prevProps.imdbRating === nextProps.imdbRating &&
  prevProps.onEpisodeClick === nextProps.onEpisodeClick &&
  prevProps.onToggleExpand === nextProps.onToggleExpand &&
  prevProps.onMarkWatched === nextProps.onMarkWatched &&
  prevProps.onUnwatch === nextProps.onUnwatch &&
  prevProps.onToggleSpoiler === nextProps.onToggleSpoiler &&
  prevProps.onDownload === nextProps.onDownload

export const EpisodeItem = memo(EpisodeItemBase, areEpisodeItemPropsEqual)
