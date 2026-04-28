import { useState, useEffect, useRef, memo } from "react"
import { Play, Edit, Trash2, X, Clock, Check, Users, Bot, Sparkles, Cloud } from "lucide-react"
import { cn } from "@/lib/utils"
import { getCachedImageUrl, MediaItem } from "@/services/api"
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
  onAskAI?: (item: MediaItem) => void
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
    prev.onAskAI !== next.onAskAI ||
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
  onAskAI,
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
  const directorName = item.director?.trim()

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
                    onLoad={() => setImageLoaded(true)}
                    className={cn(
                      "media-list-image",
                      imageLoaded ? "opacity-100" : "opacity-0"
                    )}
                  />
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
          <ContextMenuContent className="min-w-[200px] bg-card/95 backdrop-blur-2xl border-white/10 rounded-xl p-2 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <ContextMenuItem
              onClick={() => onClick(item)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <Play className="w-4 h-4 text-white" />
              </div>
              <span>Open Details</span>
            </ContextMenuItem>

            <ContextMenuSeparator className="bg-white/[0.08] my-2" />

            <ContextMenuItem
              onClick={() => onFixMatch(item)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center">
                <Edit className="w-4 h-4 text-muted-foreground" />
              </div>
              <span>Fix Match</span>
            </ContextMenuItem>

            {onAskAI && item.is_cloud && (
              <ContextMenuItem
                onClick={() => onAskAI(item)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-amber-500/10 focus:text-amber-300 text-amber-300 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-400/35 flex items-center justify-center">
                  <Bot className="w-4 h-4 text-amber-300" />
                </div>
                <span>Ask AI (New)</span>
              </ContextMenuItem>
            )}

            {onWatchTogether && (
              <>
                <ContextMenuSeparator className="bg-white/[0.08] my-2" />
                <ContextMenuItem
                  onClick={() => onWatchTogether(item)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-white" />
                  </div>
                  <span>Watch Together</span>
                </ContextMenuItem>
              </>
            )}

            {onRemoveFromHistory && (
              <>
                <ContextMenuSeparator className="bg-white/[0.08] my-2" />
                <ContextMenuItem
                  onClick={() => onRemoveFromHistory(item)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center">
                    <X className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <span>{isGroupedHistorySeries ? 'Remove Recent Episodes' : 'Remove from History'}</span>
                </ContextMenuItem>
              </>
            )}

            {onDelete && (
              <>
                <ContextMenuSeparator className="bg-white/[0.08] my-2" />
                <ContextMenuItem
                  onClick={() => onDelete(item)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-red-500/10 focus:text-red-400 text-red-400/80 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </div>
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
            style={{
              background: `radial-gradient(circle at center, rgba(255, 255, 255, 0.2) 0%, transparent 70%)`,
            }}
            animate={enableMotionEffects ? { opacity: isHovered ? 1 : 0 } : undefined}
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
              ? {
                y: isHovered ? -6 : 0,
              }
              : undefined}
            transition={enableMotionEffects ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] } : undefined}
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
                onLoad={() => setImageLoaded(true)}
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
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/25 backdrop-blur-xl border border-amber-400/40 text-xs font-bold text-amber-300 shadow-xl"
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

                {/* Options button on hover - REMOVED 3-DOT AS PER USER REQUEST */}
                <motion.div
                  initial={enableMotionEffects ? { opacity: 0, scale: 0.5 } : false}
                  animate={enableMotionEffects
                    ? {
                      opacity: isHovered ? 1 : 0,
                      scale: isHovered ? 1 : 0.5
                    }
                    : undefined}
                  transition={enableMotionEffects ? { duration: 0.2 } : undefined}
                  className="ml-auto flex items-center gap-1.5"
                  style={!enableMotionEffects ? {
                    opacity: isHovered ? 1 : 0,
                    transform: isHovered ? 'scale(1)' : 'scale(0.9)',
                  } : undefined}
                >
                  {onAskAI && item.is_cloud && (
                    <button
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onAskAI(item);
                      }}
                      className="p-2 rounded-xl bg-amber-500/15 backdrop-blur-xl border border-amber-300/45 text-amber-200 hover:text-amber-100 hover:bg-amber-500/30 hover:border-amber-200/70 transition-all shadow-xl"
                      title="Ask AI about this title"
                      aria-label={`Ask AI about ${item.title}`}
                    >
                      <Bot className="w-4 h-4" />
                    </button>
                  )}
                </motion.div>
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
        <ContextMenuContent className="min-w-[200px] bg-card/95 backdrop-blur-2xl border-white/10 rounded-xl p-2 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <ContextMenuItem
          onClick={() => onClick(item)}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
        >
          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <Play className="w-4 h-4 text-white" />
          </div>
          <span>Open Details</span>
        </ContextMenuItem>

        <ContextMenuSeparator className="bg-white/[0.08] my-2" />

        <ContextMenuItem
          onClick={() => onFixMatch(item)}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
        >
          <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center">
            <Edit className="w-4 h-4 text-muted-foreground" />
          </div>
          <span>Fix Match</span>
        </ContextMenuItem>

        {onAskAI && item.is_cloud && (
          <ContextMenuItem
            onClick={() => onAskAI(item)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-amber-500/10 focus:text-amber-300 text-amber-300 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-400/35 flex items-center justify-center">
              <Bot className="w-4 h-4 text-amber-300" />
            </div>
            <span>Ask AI (New)</span>
          </ContextMenuItem>
        )}

        {onWatchTogether && (
          <>
            <ContextMenuSeparator className="bg-white/[0.08] my-2" />
            <ContextMenuItem
              onClick={() => onWatchTogether(item)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <Users className="w-4 h-4 text-white" />
              </div>
              <span>Watch Together</span>
            </ContextMenuItem>
          </>
        )}

        {onRemoveFromHistory && (
          <>
            <ContextMenuSeparator className="bg-white/[0.08] my-2" />
            <ContextMenuItem
              onClick={() => onRemoveFromHistory(item)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-white/10 focus:text-white transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center">
                <X className="w-4 h-4 text-muted-foreground" />
              </div>
              <span>{isGroupedHistorySeries ? 'Remove Recent Episodes' : 'Remove from History'}</span>
            </ContextMenuItem>
          </>
        )}

        {onDelete && (
          <>
            <ContextMenuSeparator className="bg-white/[0.08] my-2" />
            <ContextMenuItem
              onClick={() => onDelete(item)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm font-medium focus:bg-red-500/10 focus:text-red-400 text-red-400/80 transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-4 h-4 text-red-400" />
              </div>
              <span>Delete from Drive</span>
            </ContextMenuItem>
          </>
        )}
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
          "h-[155px] min-w-[340px] max-w-[420px]",
          "bg-card/80 backdrop-blur-sm border border-white/[0.08]",
          "transition-all duration-400",
          isHovered && "border-white/30"
        )}
        animate={{
          y: isHovered ? -5 : 0,
          scale: isHovered ? 1.01 : 1,
        }}
        transition={{ duration: 0.3 }}
        style={{
          boxShadow: isHovered
            ? '0 20px 40px -12px rgba(0,0,0,0.5), 0 0 30px -5px rgba(255, 255, 255, 0.15)'
            : '0 4px 6px -1px rgba(0,0,0,0.2)',
        }}
      >
        {/* Blurred background effect */}
        {posterUrl && (
          <div
            className="absolute inset-0 opacity-15 blur-3xl scale-125 pointer-events-none"
            style={{ backgroundImage: `url(${posterUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
          />
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-card via-card/95 to-card/80 z-0" />

        {/* Poster */}
        <div className="relative w-[110px] h-full flex-shrink-0 overflow-hidden z-10">
          <motion.img
            src={imageSrc}
            alt={item.title}
            className="w-full h-full object-cover"
            animate={{
              scale: isHovered ? 1.1 : 1,
            }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />

          {/* Poster gradient fade */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-card pointer-events-none" />

        </div>

        {/* Content */}
        <div className="relative flex-1 p-5 flex flex-col justify-between z-10 min-w-0">
          <div>
            <div className="flex items-center gap-2 mb-2">
              {item.media_type === 'tvshow' && (
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
                  TV Series
                </span>
              )}
            </div>

            <h4 className="font-bold text-[15px] text-white leading-snug line-clamp-1 mb-1 group-hover:text-white transition-colors">
              {item.title}
            </h4>
            {item.season_number && item.episode_number && (
              <p className="text-xs text-muted-foreground/70 font-medium">
                Season {item.season_number} · Episode {item.episode_number}
              </p>
            )}

            {/* Added informative content in the gap */}
            <div className="mt-2.5 flex flex-col gap-1.5">
              {item.episode_title && (
                <p className="text-[11px] text-white/50 font-bold line-clamp-1 group-hover:text-white/80 transition-colors tracking-tight">
                  {item.episode_title}
                </p>
              )}
              
              <div className="flex items-center gap-2">
                {item.is_cloud && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/5 border border-white/10 group-hover:bg-white/10 transition-colors">
                    <Cloud className="w-2.5 h-2.5 text-white/40 group-hover:text-white/60" />
                    <span className="text-[8px] font-black text-white/30 group-hover:text-white/50 uppercase tracking-widest">Cloud</span>
                  </div>
                )}
                {item.last_watched && (
                  <span className="text-[9px] font-bold text-white/20 uppercase tracking-[0.15em] group-hover:text-white/40 transition-colors">
                    Active Recently
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2.5">
            {/* Progress bar */}
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full bg-white relative"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.8, delay: 0.3 }}
              >
                {/* Shimmer effect */}
                <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-white/40 to-transparent" />
              </motion.div>
            </div>

            {/* Time info */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/80 font-semibold">{Math.round(progress)}% complete</span>
              {remainingMinutes && (
                <span className="text-muted-foreground/70 flex items-center gap-1.5 font-medium">
                  <Clock className="w-3 h-3" />
                  {remainingMinutes}m left
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

export const ContinueCard = memo(ContinueCardBase, areContinueCardPropsEqual)
