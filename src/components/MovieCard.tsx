import { useState, useEffect, useRef, useCallback, memo } from "react"
import { Play, Edit, Trash2, X, Clock, Check, Users, Sparkles, Download, Pin, PinOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { getCachedImageUrl, MediaItem } from "@/services/api"
import { getPinnedIds, togglePin as togglePinStorage } from "@/utils/pins"
import { motion } from "framer-motion"
import { getMediaProgressPercent, isProgressPastAutoCompleteThreshold } from "@/utils/playbackProgress"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator
} from "@/components/ui/context-menu"

export interface MovieCardProps {
  item: MediaItem
  onClick: (item: MediaItem) => void
  onFixMatch: (item: MediaItem) => void
  onRemoveFromHistory?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  onWatchTogether?: (item: MediaItem) => void
  onDownload?: (item: MediaItem) => void
  showNewBadge?: boolean
  disableEntryAnimation?: boolean
  aspectRatio?: "portrait" | "square"
  className?: string
  index?: number
  layout?: "grid" | "list"
}

// Custom comparison function for React.memo to prevent unnecessary re-renders
export function areMovieCardPropsEqual(prev: MovieCardProps, next: MovieCardProps) {
  // 1. Compare simple scalar props
  if (
    prev.index !== next.index ||
    prev.className !== next.className ||
    prev.aspectRatio !== next.aspectRatio ||
    prev.layout !== next.layout
  ) {
    return false
  }

  // 2. Callback props must remain in sync to avoid stale closures.
  if (
    prev.onClick !== next.onClick ||
    prev.onFixMatch !== next.onFixMatch ||
    prev.onRemoveFromHistory !== next.onRemoveFromHistory ||
    prev.onDelete !== next.onDelete ||
    prev.onWatchTogether !== next.onWatchTogether ||
    prev.onDownload !== next.onDownload ||
    prev.showNewBadge !== next.showNewBadge ||
    prev.disableEntryAnimation !== next.disableEntryAnimation
  ) {
    return false
  }

  // 3. Compare item fields that affect rendering
  const pItem = prev.item
  const nItem = next.item

  // Fast path: same object reference
  if (pItem === nItem) return true

  // Check unique ID first
  if (pItem.id !== nItem.id) return false

  // Check visual properties
  return (
    pItem.title === nItem.title &&
    pItem.overview === nItem.overview &&
    pItem.cast_names === nItem.cast_names &&
    pItem.file_path === nItem.file_path &&
    pItem.poster_path === nItem.poster_path &&
    pItem.progress_percent === nItem.progress_percent &&
    pItem.resume_position_seconds === nItem.resume_position_seconds &&
    pItem.duration_seconds === nItem.duration_seconds &&
    pItem.media_type === nItem.media_type &&
    pItem.is_cloud === nItem.is_cloud &&
    pItem.season_number === nItem.season_number &&
    pItem.episode_number === nItem.episode_number &&
    pItem.year === nItem.year &&
    pItem.history_group_count === nItem.history_group_count &&
    pItem.history_group_latest_label === nItem.history_group_latest_label
  )
}

function MovieCardBase({
  item,
  onClick,
  onFixMatch,
  onRemoveFromHistory,
  onDelete,
  onWatchTogether,
  onDownload,
  showNewBadge = false,
  disableEntryAnimation = false,
  aspectRatio = "portrait",
  className,
  index = 0,
  layout = "grid",
}: MovieCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [shouldLoadPoster, setShouldLoadPoster] = useState(index < 16)
  const [isHovered, setIsHovered] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const shouldAnimateEntry = !disableEntryAnimation && index < 24
  const enableMotionEffects = !disableEntryAnimation

  const progress = getMediaProgressPercent(item)
  const isFinished = isProgressPastAutoCompleteThreshold(progress)
  const hasProgress = progress > 0 && !isFinished
  const isGroupedHistorySeries = (item.history_group_count || 0) > 1
  const historyLatestLabel = item.history_group_latest_label?.trim()
  const leadActor = item.cast_names?.split(',')[0]?.trim()

  const [pinnedIds, setPinnedIds] = useState<Set<string>>(getPinnedIds);
  const isPinned = pinnedIds.has(item.id);
  const togglePin = () => {
    togglePinStorage(item.id);
    setPinnedIds(getPinnedIds());
  };
  const directorName = item.director?.trim()
  const [isLightArea, setIsLightArea] = useState<boolean | null>(null)
  const samplePosterLuminance = useCallback((img: HTMLImageElement) => {
    try {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const size = 8
      canvas.width = size
      canvas.height = size
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) return
      ctx.drawImage(img, w * 0.7, 0, w * 0.3, h * 0.2, 0, 0, size, size)
      const data = ctx.getImageData(0, 0, size, size).data
      let r = 0, g = 0, b = 0
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]
      }
      const n = data.length / 4
      const lum = (0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n)) / 255
      setIsLightArea(lum > 0.45)
    } catch { setIsLightArea(null) }
  }, [])

  useEffect(() => {
    if (shouldLoadPoster) return

    if (typeof IntersectionObserver === "undefined") {
      setShouldLoadPoster(true)
      return
    }

    const node = cardRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldLoadPoster(true)
            observer.disconnect()
            break
          }
        }
      },
      { rootMargin: "700px 0px" }
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [shouldLoadPoster])

  useEffect(() => {
    if (!shouldLoadPoster) return

    let cancelled = false
    const loadPoster = async () => {
      if (item.poster_path) {
        const filename = item.poster_path.replace('image_cache/', '')
        const url = await getCachedImageUrl(filename)
        if (!cancelled && url) {
          setPosterUrl(url)
        }
      }
    }
    loadPoster()
    return () => {
      cancelled = true
    }
  }, [item.poster_path, shouldLoadPoster])

  const handleHoverStart = () => {
    setIsHovered(true)
  }

  const handleHoverEnd = () => {
    setIsHovered(false)
  }

  const imageSrc = posterUrl || `https://placehold.co/400x600/0a0a0f/1a1a2e?text=${encodeURIComponent(item.title.slice(0, 2))}`
  const displayInfo = item.year || (item.season_number && item.episode_number ? `S${String(item.season_number).padStart(2, '0')}E${String(item.episode_number).padStart(2, '0')}` : null)

  if (layout === "list") {
    const showStatus = isFinished || hasProgress
    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger>
            <motion.div
              ref={cardRef}
              className={cn("media-card group", className)}
              data-layout="list"
              onClick={() => onClick(item)}
              onMouseEnter={handleHoverStart}
              onMouseLeave={handleHoverEnd}
              onFocus={handleHoverStart}
              onBlur={handleHoverEnd}
              tabIndex={0}
              initial={shouldAnimateEntry ? { opacity: 0, y: 12 } : false}
              animate={shouldAnimateEntry ? { opacity: 1, y: 0 } : undefined}
              transition={shouldAnimateEntry
                ? {
                  duration: 0.35,
                  delay: Math.min(index, 24) * 0.01,
                  ease: [0.22, 1, 0.36, 1]
                }
                : undefined}
            >
              <div className="media-list-card" data-has-actions={showStatus ? "true" : "false"}>
                <div className="media-list-poster">
                  {!imageLoaded && (
                    <div className="absolute inset-0 skeleton-shimmer" />
                  )}
                  <img
                    src={imageSrc}
                    alt={item.title}
                    loading="lazy"
                    onLoad={(e) => { setImageLoaded(true); samplePosterLuminance(e.currentTarget); }}
                    className={cn(
                      "media-list-image",
                      imageLoaded ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {isPinned && (
                    <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md bg-black/70 backdrop-blur-md border-2 border-white/80 flex items-center justify-center shadow-lg">
                      <Pin className="w-3 h-3 text-white" />
                    </div>
                  )}
                </div>

                <div className="media-list-info">
                  <h3 className="media-list-title">{item.title}</h3>
                  <div className="media-list-meta">
                    {!isGroupedHistorySeries && displayInfo && (
                      <span className="media-list-meta-item">{displayInfo}</span>
                    )}
                    {isGroupedHistorySeries && historyLatestLabel && (
                      <span className="media-list-meta-item">{historyLatestLabel}</span>
                    )}
                    {leadActor && (
                      <span className="media-list-meta-item">{leadActor}</span>
                    )}
                    {directorName && (
                      <span className="media-list-meta-item">Dir. {directorName}</span>
                    )}
                    {item.media_type === "tvshow" && (
                      <span className="media-list-meta-item">Series</span>
                    )}
                    {item.media_type === "tvepisode" && !displayInfo && item.season_number && item.episode_number && (
                      <span className="media-list-meta-item">
                        Season {item.season_number} · Episode {item.episode_number}
                      </span>
                    )}
                    {isGroupedHistorySeries && (
                      <span className="media-list-meta-item">{item.history_group_count} recent episodes</span>
                    )}
                  </div>
                  {item.overview && (
                    <p className="media-list-synopsis">{item.overview}</p>
                  )}
                </div>

                {showStatus && (
                  <div className="media-list-actions">
                    {isFinished && (
                      <span className="media-list-pill">Watched</span>
                    )}
                    {!isFinished && hasProgress && (
                      <span className="media-list-pill">{Math.round(progress)}%</span>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </ContextMenuTrigger>

          {/* Context Menu */}
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onClick(item)} aria-label="Open details">
              <Play className="w-4 h-4 text-foreground/70" />
              <span>Open Details</span>
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem onClick={() => onFixMatch(item)} aria-label="Fix match">
              <Edit className="w-4 h-4 text-foreground/40" />
              <span>Fix Match</span>
            </ContextMenuItem>

            {onDownload && item.is_cloud && (
              <ContextMenuItem onClick={() => onDownload(item)} aria-label="Download">
                <Download className="w-4 h-4 text-foreground/70" />
                <span>Download</span>
              </ContextMenuItem>
            )}

            {onWatchTogether && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onWatchTogether(item)} aria-label="Watch together">
                  <Users className="w-4 h-4 text-foreground/70" />
                  <span>Watch Together</span>
                </ContextMenuItem>
              </>
            )}

            {onRemoveFromHistory && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onRemoveFromHistory(item)} aria-label={isGroupedHistorySeries ? "Remove recent episodes from history" : "Remove from history"}>
                  <X className="w-4 h-4 text-foreground/40" />
                  <span>{isGroupedHistorySeries ? 'Remove Recent Episodes' : 'Remove from History'}</span>
                </ContextMenuItem>
              </>
            )}

            <ContextMenuSeparator />

            <ContextMenuItem onClick={togglePin}>
              {isPinned ? (
                <PinOff className="w-4 h-4 text-foreground/70" />
              ) : (
                <Pin className="w-4 h-4 text-foreground/70" />
              )}
              <span>{isPinned ? 'Unpin' : 'Pin'}</span>
            </ContextMenuItem>

            {onDelete && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onDelete(item)} className="text-red-400/70 focus:text-red-400" aria-label="Delete from drive">
                  <Trash2 className="w-4 h-4 text-red-400/70" />
                  <span>Delete from Drive</span>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </>
    )
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <motion.div
            ref={cardRef}
            className={cn("group relative", className)}
            onClick={() => onClick(item)}
            onMouseEnter={handleHoverStart}
            onMouseLeave={handleHoverEnd}
            onFocus={handleHoverStart}
            onBlur={handleHoverEnd}
            tabIndex={0}
            initial={shouldAnimateEntry ? { opacity: 0, y: 30, scale: 0.95 } : false}
            animate={shouldAnimateEntry ? { opacity: 1, y: 0, scale: 1 } : undefined}
            transition={shouldAnimateEntry
              ? {
                duration: 0.42,
                delay: Math.min(index, 24) * 0.015,
                ease: [0.22, 1, 0.36, 1]
              }
              : undefined}
          >
          {/* Glow Effect Behind Card */}
          <motion.div
            className={cn(
              "absolute -inset-2 rounded-3xl blur-2xl transition-opacity duration-500 pointer-events-none",
              isHovered ? "opacity-100" : "opacity-0"
            )}
            animate={enableMotionEffects ? { opacity: isHovered ? 1 : 0 } : undefined}
            style={{
              background: `radial-gradient(circle at center, rgba(255, 255, 255, 0.2) 0%, transparent 70%)`,
            }}
          />

          {/* Card Container */}
          <motion.div
            className={cn(
              "relative overflow-hidden rounded-2xl cursor-pointer",
              "bg-card/80 backdrop-blur-sm",
              "border border-white/[0.08]",
              "transition-all duration-500 ease-out",
              isHovered && "border-white/30"
            )}
            animate={enableMotionEffects
              ? {}
              : undefined}
            style={{
              boxShadow: isHovered
                ? '0 20px 42px -14px rgba(0,0,0,0.58), 0 0 32px -12px rgba(255, 255, 255, 0.16)'
                : '0 4px 6px -1px rgba(0,0,0,0.2)',
            }}
          >
            {/* Poster Container */}
            <div className={cn(
              "relative overflow-hidden",
              aspectRatio === "portrait" ? "aspect-[2/3]" : "aspect-square"
            )}>
              {/* Skeleton while loading */}
              {!imageLoaded && (
                <div className="absolute inset-0 skeleton-shimmer" />
              )}

              {/* Poster Image */}
              <motion.img
                src={imageSrc}
                alt={item.title}
                loading="lazy"
                onLoad={(e) => { setImageLoaded(true); samplePosterLuminance(e.currentTarget); }}
                className={cn(
                  "w-full h-full object-cover",
                  "transition-all duration-700 ease-out will-change-transform",
                  imageLoaded ? "opacity-100" : "opacity-0"
                )}
                animate={enableMotionEffects
                  ? {
                    filter: isHovered ? 'brightness(1.08) saturate(1.12)' : 'brightness(1) saturate(1)',
                  }
                  : undefined}
                transition={enableMotionEffects ? { duration: 0.7, ease: [0.22, 1, 0.36, 1] } : undefined}
                style={!enableMotionEffects ? {
                  filter: isHovered ? 'brightness(1.08) saturate(1.12)' : 'brightness(1) saturate(1)',
                } : undefined}
              />

              {/* Gradient Overlay */}
              <motion.div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: 'linear-gradient(to top, hsl(240 6% 4%) 0%, hsl(240 6% 4% / 0.85) 15%, hsl(240 6% 4% / 0.3) 50%, transparent 100%)',
                  opacity: enableMotionEffects ? undefined : (isHovered ? 1 : 0.7),
                }}
                animate={enableMotionEffects ? { opacity: isHovered ? 1 : 0.7 } : undefined}
                transition={enableMotionEffects ? { duration: 0.4 } : undefined}
              />

              {/* Top Badges */}
              <div className="absolute top-3 left-3 right-3 flex items-start justify-between z-20">
                <div className="flex max-w-[calc(100%-3rem)] flex-wrap items-center gap-2">
                  {/* NEW Badge */}
                  {showNewBadge && (
                    <motion.div
                      initial={enableMotionEffects ? { opacity: 0, scale: 0.8, x: -10 } : false}
                      animate={enableMotionEffects ? { opacity: 1, scale: 1, x: 0 } : undefined}
                      exit={enableMotionEffects ? { opacity: 0, scale: 0.8 } : undefined}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/25 backdrop-blur-xl border border-white/40 text-xs font-bold text-amber-300 shadow-xl"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>NEW</span>
                    </motion.div>
                  )}
                  {/* Progress or Finished Badge */}
                  {hasProgress && (
                    <motion.div
                      initial={enableMotionEffects ? { opacity: 0, scale: 0.8, x: -10 } : false}
                      animate={enableMotionEffects ? { opacity: 1, scale: 1, x: 0 } : undefined}
                      exit={enableMotionEffects ? { opacity: 0, scale: 0.8 } : undefined}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur-xl border border-white/10 text-xs font-bold text-white shadow-xl"
                    >
                      <Clock className="w-3 h-3 text-white" />
                      <span>{Math.round(progress)}%</span>
                    </motion.div>
                  )}
                  {isFinished && (
                    <motion.div
                      initial={enableMotionEffects ? { opacity: 0, scale: 0.8, x: -10 } : false}
                      animate={enableMotionEffects ? { opacity: 1, scale: 1, x: 0 } : undefined}
                      exit={enableMotionEffects ? { opacity: 0, scale: 0.8 } : undefined}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-500/20 backdrop-blur-xl border border-gray-500/30 text-gray-400 text-xs font-bold shadow-xl"
                    >
                      <Check className="w-3 h-3" />
                      <span>Watched</span>
                    </motion.div>
                  )}
                  {isGroupedHistorySeries && (
                    <motion.div
                      initial={enableMotionEffects ? { opacity: 0, scale: 0.8, x: -10 } : false}
                      animate={enableMotionEffects ? { opacity: 1, scale: 1, x: 0 } : undefined}
                      exit={enableMotionEffects ? { opacity: 0, scale: 0.8 } : undefined}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 backdrop-blur-xl border border-white/15 text-xs font-bold text-white shadow-xl"
                    >
                      <span>{item.history_group_count} recent eps</span>
                    </motion.div>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-1.5">
                  {isPinned && (
                    <div className={cn(
                      "p-1.5 rounded-lg backdrop-blur-xl border-2 shadow-xl transition-all duration-300",
                      isLightArea === null
                        ? "bg-white/10 border-white/20"
                        : isLightArea
                          ? "bg-black/75 border-white/90"
                          : "bg-white/90 border-black/40"
                    )}>
                      <Pin className={cn(
                        "w-3.5 h-3.5 transition-colors duration-300",
                        isLightArea === null
                          ? "text-white/80"
                          : isLightArea
                            ? "text-white"
                            : "text-black"
                      )} />
                    </div>
                  )}

                </div>
              </div>

              {/* Progress Bar */}
              {hasProgress && (
                <motion.div
                  className="absolute bottom-0 left-0 right-0 h-1 bg-white/10 backdrop-blur-sm z-20"
                  initial={enableMotionEffects ? { opacity: 0 } : false}
                  animate={enableMotionEffects ? { opacity: 1 } : undefined}
                  exit={enableMotionEffects ? { opacity: 0 } : undefined}
                >
                  <motion.div
                    className="h-full bg-white relative"
                    initial={enableMotionEffects ? { width: 0 } : false}
                    animate={enableMotionEffects ? { width: `${progress}%` } : undefined}
                    transition={enableMotionEffects ? { duration: 0.8, delay: 0.2, ease: "easeOut" } : undefined}
                    style={!enableMotionEffects ? { width: `${progress}%` } : undefined}
                  >
                    {/* Shimmer on progress bar */}
                    <div className="absolute inset-0 overflow-hidden">
                      <div className={cn(
                        "absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent",
                        enableMotionEffects ? "-translate-x-full animate-shimmer" : ""
                      )} />
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </div>
          </motion.div>

          {/* Info Below Card */}
          <motion.div
            className="mt-4 space-y-1.5 px-1"
            animate={enableMotionEffects ? { y: isHovered ? 2 : 0 } : undefined}
            transition={enableMotionEffects ? { duration: 0.3 } : undefined}
            style={!enableMotionEffects ? { transform: isHovered ? 'translateY(2px)' : 'translateY(0)' } : undefined}
          >
            <h3 className={cn(
              "font-semibold text-sm leading-tight line-clamp-1 tracking-tight",
              "transition-colors duration-300",
              isHovered ? "text-white" : "text-white/80"
            )}>
              {item.title}
            </h3>
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground/70">
              {!isGroupedHistorySeries && displayInfo && (
                <span className="text-muted-foreground">{displayInfo}</span>
              )}
              {isGroupedHistorySeries && historyLatestLabel && (
                <span className="text-muted-foreground">{historyLatestLabel}</span>
              )}
              {isGroupedHistorySeries && !historyLatestLabel && (
                <span className="text-muted-foreground">{item.history_group_count} recent episodes</span>
              )}
              {item.media_type === 'tvshow' && (
                <>
                  <span className="w-1 h-1 rounded-full bg-white/50" />
                  <span className="text-white/70 font-semibold">Series</span>
                </>
              )}
              {isGroupedHistorySeries && (
                <>
                  <span className="w-1 h-1 rounded-full bg-white/50" />
                  <span className="text-white/70 font-semibold">{item.history_group_count} episodes</span>
                </>
              )}
            </div>
          </motion.div>

          </motion.div>
        </ContextMenuTrigger>

      {/* Context Menu */}
        <ContextMenuContent>
        <ContextMenuItem onClick={() => onClick(item)} aria-label="Open details">
          <Play className="w-4 h-4 text-foreground/70" />
          <span>Open Details</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => onFixMatch(item)} aria-label="Fix match">
          <Edit className="w-4 h-4 text-foreground/40" />
          <span>Fix Match</span>
        </ContextMenuItem>

        {onDownload && item.is_cloud && (
          <ContextMenuItem onClick={() => onDownload(item)} aria-label="Download">
            <Download className="w-4 h-4 text-foreground/70" />
            <span>Download</span>
          </ContextMenuItem>
        )}

        {onWatchTogether && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onWatchTogether(item)} aria-label="Watch together">
              <Users className="w-4 h-4 text-foreground/70" />
              <span>Watch Together</span>
            </ContextMenuItem>
          </>
        )}

        {onRemoveFromHistory && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRemoveFromHistory(item)} aria-label={isGroupedHistorySeries ? "Remove recent episodes from history" : "Remove from history"}>
              <X className="w-4 h-4 text-foreground/40" />
              <span>{isGroupedHistorySeries ? 'Remove Recent Episodes' : 'Remove from History'}</span>
            </ContextMenuItem>
          </>
        )}

        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onDelete(item)} className="text-red-400/70 focus:text-red-400" aria-label="Delete from drive">
              <Trash2 className="w-4 h-4 text-red-400/70" />
              <span>Delete from Drive</span>
            </ContextMenuItem>
          </>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem onClick={togglePin}>
          {isPinned ? (
            <PinOff className="w-4 h-4 text-foreground/70" />
          ) : (
            <Pin className="w-4 h-4 text-foreground/70" />
          )}
          <span>{isPinned ? 'Unpin' : 'Pin'}</span>
        </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

    </>
  )
}

export const MovieCard = memo(MovieCardBase, areMovieCardPropsEqual)

// Horizontal Continue Watching Card
export interface ContinueCardProps {
  item: MediaItem
  onClick: (item: MediaItem) => void
  index?: number
}

// Custom comparison for ContinueCard
export function areContinueCardPropsEqual(prev: ContinueCardProps, next: ContinueCardProps) {
  if (prev.index !== next.index) return false
  if (prev.onClick !== next.onClick) return false

  const pItem = prev.item
  const nItem = next.item

  if (pItem === nItem) return true
  if (pItem.id !== nItem.id) return false

  return (
    pItem.title === nItem.title &&
    pItem.poster_path === nItem.poster_path &&
    pItem.progress_percent === nItem.progress_percent &&
    pItem.resume_position_seconds === nItem.resume_position_seconds &&
    pItem.duration_seconds === nItem.duration_seconds
  )
}

function ContinueCardBase({ item, onClick, index = 0 }: ContinueCardProps) {
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [isHovered, setIsHovered] = useState(false)

  const progress = item.progress_percent || (item.resume_position_seconds && item.duration_seconds ? (item.resume_position_seconds / item.duration_seconds) * 100 : 0)

  useEffect(() => {
    const loadPoster = async () => {
      if (item.poster_path) {
        const filename = item.poster_path.replace('image_cache/', '')
        const url = await getCachedImageUrl(filename)
        if (url) {
          setPosterUrl(url)
        }
      }
    }
    loadPoster()
  }, [item.poster_path])

  const imageSrc = posterUrl || `https://placehold.co/200x300/0a0a0f/1a1a2e?text=${encodeURIComponent(item.title.slice(0, 2))}`

  // Calculate remaining time
  const remainingSeconds = item.duration_seconds && item.resume_position_seconds
    ? item.duration_seconds - item.resume_position_seconds
    : null
  const remainingMinutes = remainingSeconds ? Math.ceil(remainingSeconds / 60) : null
  const formatRemaining = (mins: number) => {
    if (mins < 60) return `${mins}m left`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m > 0 ? `${h}h ${m}m left` : `${h}h left`
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -30, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.5, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => onClick(item)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative group"
    >
      {/* Glow effect */}
      <motion.div
        className="absolute -inset-2 rounded-3xl opacity-0 blur-2xl transition-opacity duration-500 pointer-events-none"
        style={{
          background: `radial-gradient(circle at center, rgba(255, 255, 255, 0.15) 0%, transparent 70%)`,
        }}
        animate={{ opacity: isHovered ? 1 : 0 }}
      />

      <motion.div
        className={cn(
          "relative flex rounded-2xl overflow-hidden cursor-pointer",
          "h-[155px] min-w-[300px] max-w-[380px]",
          "border border-white/[0.08]",
          "transition-all duration-400",
          isHovered && "border-white/25"
        )}
        animate={{
          scale: isHovered ? 1.02 : 1,
        }}
        transition={{ duration: 0.35 }}
        style={{
          boxShadow: isHovered
            ? '0 24px 48px -12px rgba(0,0,0,0.6), 0 0 40px -8px rgba(255,255,255,0.1)'
            : '0 8px 12px -4px rgba(0,0,0,0.3)',
        }}
      >
        {/* Full-bleed poster background */}
        <motion.img
          src={imageSrc}
          alt={item.title}
          className="absolute inset-0 w-full h-full object-cover"
          animate={{ scale: isHovered ? 1.08 : 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        />

        {/* Dark gradient overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 via-40% to-black/10 z-[1]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent z-[1]" />

        {/* Content overlay */}
        <div className="relative flex flex-col justify-end z-10 p-4 w-full h-full">
          <h4 className="text-base font-black text-white leading-tight line-clamp-1">
            {item.title}
          </h4>

          {(item.media_type === 'movie' || (item.season_number && item.episode_number) || item.episode_title) && (
            <div className="flex items-center gap-1.5 text-[11px] text-white/50 min-w-0 mt-0.5">
              {item.media_type === 'movie' ? (
                <span className="text-amber-400/80">Movie</span>
              ) : item.season_number && item.episode_number ? (
                <span className="text-amber-400/80">S{item.season_number} · E{item.episode_number}</span>
              ) : null}
              {item.episode_title && (
                <>
                  <span className="text-white/30">—</span>
                  <span className="italic text-white/50 truncate min-w-0">{item.episode_title}</span>
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between mt-1.5">
            {remainingMinutes && (
              <div className="flex items-center gap-1 text-[11px] text-white/35 font-medium">
                <Clock className="w-3 h-3" />
                <span>{formatRemaining(remainingMinutes)}</span>
              </div>
            )}
            <span className="text-[10px] font-medium text-white/50 tabular-nums">{Math.round(progress)}%</span>
          </div>
        </div>

        {/* Progress bar at very bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/[0.06] z-[2]">
          <motion.div
            className="h-full bg-gradient-to-r from-amber-600 to-amber-500"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          />
        </div>
      </motion.div>
    </motion.div>
  )
}

export const ContinueCard = memo(ContinueCardBase, areContinueCardPropsEqual)
