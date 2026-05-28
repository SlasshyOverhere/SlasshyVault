import { useEffect, useState, useMemo, useCallback, useRef } from "react"
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event"
import {
  ChevronLeft, Loader2, RefreshCw, FileText,
  SlidersHorizontal, Info, EyeOff, Eye,
} from "lucide-react"
import {
  MediaItem, getEpisodes, playMedia, getResumeInfo,
  ResumeInfo, getTvSeasonEpisodes, TmdbEpisodeInfo,
  ImdbEpisodeRating, getEpisodeImdbRatings,
  markAsComplete, clearProgress, refreshSeriesMetadata, updateEpisodeDuration,
  resolveSeriesAudioPreferenceForPlayback,
  resolveSeriesSubtitlePreferenceForPlayback,
  getSeriesSpoilerEnabled, setSeriesSpoilerEnabled,
} from "@/services/api"
import { useToast } from "@/components/ui/use-toast"
import { ResumeDialog } from "@/components/ResumeDialog"
import { ContentDetailsModal } from "@/components/ContentDetailsModal"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ZipPlaybackLoadingOverlay } from "@/components/ZipPlaybackLoadingOverlay"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"
import {
  buildZipPlaybackLoadingState,
  type ZipPlaybackLoadingState,
  waitForMinimumZipOverlayVisibility,
  waitForMpvPlaybackStart,
  waitForZipLoadingOverlayPaint,
} from "@/utils/zipPlayback"
import {
  isProgressPastAutoCompleteThreshold,
  isMediaMarkedWatched,
} from "@/utils/playbackProgress"
import { EpisodeItem } from "@/components/EpisodeItem"

interface EpisodeBrowserProps {
  show: MediaItem
  onBack: () => void
  onWatchTogether?: (episode: MediaItem) => void
  onDownload?: (episode: MediaItem) => void | Promise<void>
}

export function EpisodeBrowser({
  show,
  onBack,
  onWatchTogether: _onWatchTogether,
  onDownload,
}: EpisodeBrowserProps) {
  const [episodes, setEpisodes] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSeason, setSelectedSeason] = useState<number>(1)
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(20)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  const [tmdbEpisodesBySeason, setTmdbEpisodesBySeason] = useState<
    Map<number, Map<number, TmdbEpisodeInfo>>
  >(new Map())
  const [imdbRatings, setImdbRatings] = useState<Record<number, ImdbEpisodeRating>>({})
  const [expandedEpisode, setExpandedEpisode] = useState<number | null>(null)
  const [contentDetailsOpen, setContentDetailsOpen] = useState(false)
  const [contentDetailsItem, setContentDetailsItem] = useState<MediaItem | null>(null)
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const [resumeDialogData, setResumeDialogData] = useState<{
    episode: MediaItem
    resumeInfo: ResumeInfo
  } | null>(null)
  const [zipPlaybackLoading, setZipPlaybackLoading] =
    useState<ZipPlaybackLoadingState | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showEpisodeUrls, setShowEpisodeUrls] = useState(false)
  const [spoilerEnabled, setSpoilerEnabled] = useState(() => getSeriesSpoilerEnabled(show.id))
  const [revealedEpisodes, setRevealedEpisodes] = useState<Set<number>>(new Set())
  const isInitialLoadRef = useRef(true)


  const loadTmdb = useCallback(async (season: number) => {
    if (!show.tmdb_id) return
    const tmdbId = parseInt(show.tmdb_id)

    // Load TMDB episodes
    const cached = tmdbEpisodesBySeason.has(season)
    if (!cached) {
      try {
        const sd = await getTvSeasonEpisodes(tmdbId, season)
        if (sd) {
          const m = new Map<number, TmdbEpisodeInfo>()
          sd.episodes.forEach(e => m.set(e.episode_number, e))
          setTmdbEpisodesBySeason(p => { const n = new Map(p); n.set(season, m); return n })

          // Write TMDB runtime back to DB for episodes missing duration
          const localEpisodesByNumber = new Map<number, MediaItem>()
          for (const e of episodes) {
            if ((e.season_number || 1) === season && e.episode_number) {
              localEpisodesByNumber.set(e.episode_number, e)
            }
          }
          for (const tmdbEp of sd.episodes) {
            if (!tmdbEp.runtime || tmdbEp.runtime <= 0) continue
            const localEp = localEpisodesByNumber.get(tmdbEp.episode_number)
            if (localEp && (!localEp.duration_seconds || localEp.duration_seconds <= 0)) {
              updateEpisodeDuration(localEp.id, tmdbEp.runtime * 60)
            }
          }
        }
      } catch {
        /* skip tmdb for this season */
      }
    }

    // Fetch IMDb ratings for episodes in this season
    try {
      const epNums = episodes.reduce<number[]>((acc, e) => {
        if ((e.season_number || 1) === season) {
          const num = e.episode_number || 0
          if (num > 0) acc.push(num)
        }
        return acc
      }, [])
      if (epNums.length > 0) {
        const ratings = await getEpisodeImdbRatings(tmdbId, season, epNums, show.imdb_id)
        if (Object.keys(ratings).length > 0) {
          setImdbRatings(p => ({ ...p, ...ratings }))
        }
      }
    } catch {
      /* imdb ratings unavailable */
    }
  }, [show.tmdb_id, tmdbEpisodesBySeason, episodes])

  const loadEpisodes = useCallback(async () => {
    try {
      const data = await getEpisodes(show.id)
      setEpisodes(data)
      if (data.length > 0 && isInitialLoadRef.current) {
        isInitialLoadRef.current = false
        const first = data.reduce((min, ep) =>
          ep.season_number && ep.season_number < min ? ep.season_number : min,
          data[0].season_number || 1,
        )
        setSelectedSeason(first)
      }
    } catch {
      toast({ title: "Error", description: "Failed to load episodes", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [show.id, toast])

  useEffect(() => {
    loadEpisodes()
    setTmdbEpisodesBySeason(new Map())

    let unlistenMpvEnded: UnlistenFn | undefined
    let unlistenMarkedComplete: UnlistenFn | undefined
    let unlistenLibraryUpdated: UnlistenFn | undefined

    const setup = async () => {
      unlistenMpvEnded = await listen("mpv-playback-ended", loadEpisodes)
      unlistenMarkedComplete = await listen("media-marked-complete", loadEpisodes)
      unlistenLibraryUpdated = await listen("library-updated", () => {
        loadEpisodes()
      })
    }
    setup()
    return () => {
      unlistenMpvEnded?.()
      unlistenMarkedComplete?.()
      unlistenLibraryUpdated?.()
    }
  }, [show.id, loadEpisodes])

  useEffect(() => {
    loadTmdb(selectedSeason)
    setVisibleEpisodeCount(20)
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [selectedSeason, loadTmdb])

  const handleRefreshMetadata = async () => {
    if (!show.tmdb_id || isRefreshing) return
    setIsRefreshing(true)
    try {
      const result = await refreshSeriesMetadata(parseInt(show.tmdb_id), show.title)
      toast({ title: "Refreshed", description: result })
      await loadEpisodes()
    } catch {
      toast({ title: "Error", description: "Refresh failed", variant: "destructive" })
    } finally {
      setIsRefreshing(false)
    }
  }

  const seasons = useMemo(
    () => [...new Set(episodes.map(e => e.season_number || 1))].sort((a, b) => a - b),
    [episodes],
  )

  const filteredEpisodes = useMemo(
    () =>
      episodes
        .filter(e => (e.season_number || 1) === selectedSeason)
        .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)),
    [episodes, selectedSeason],
  )

  const toggleSpoiler = useCallback(() => {
    setSpoilerEnabled(prev => {
      const next = !prev
      setSeriesSpoilerEnabled(show.id, next)
      return next
    })
  }, [show.id])

  const handleToggleSpoiler = useCallback((ep: MediaItem) => {
    setRevealedEpisodes(prev => {
      const next = new Set(prev)
      if (next.has(ep.id)) {
        next.delete(ep.id)
      } else {
        next.add(ep.id)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const s = loadMoreRef.current
    if (!s || filteredEpisodes.length <= visibleEpisodeCount) return
    const obs = new IntersectionObserver(
      ([e]) => e.isIntersecting && setVisibleEpisodeCount(p => Math.min(p + 20, filteredEpisodes.length)),
      { rootMargin: "200px 0px" },
    )
    obs.observe(s)
    return () => obs.disconnect()
  }, [filteredEpisodes.length, visibleEpisodeCount])

  const episodesToRender = useMemo(
    () => filteredEpisodes.slice(0, visibleEpisodeCount),
    [filteredEpisodes, visibleEpisodeCount],
  )

  const handleEpisodeClick = useCallback((ep: MediaItem) => {
    setContentDetailsItem(ep)
    setContentDetailsOpen(true)
  }, [])

  const handleToggleExpand = useCallback((id: number) => {
    setExpandedEpisode(p => (p === id ? null : id))
  }, [])

  const handleMarkWatched = useCallback(async (ep: MediaItem) => {
    // Optimistic: reload episodes immediately to reflect the change
    void loadEpisodes()
    toast({
      title: "Watched",
      description: `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")} marked`,
    })
    // Fire server call in background
    try {
      await Promise.all([markAsComplete(ep.id), emit("media-marked-complete", { media_id: ep.id })])
    } catch {
      toast({ title: "Error", description: "Failed to mark watched", variant: "destructive" })
    }
  }, [toast, loadEpisodes])

  const handleUnwatch = useCallback(async (ep: MediaItem) => {
    // Optimistic: reload episodes immediately
    void loadEpisodes()
    toast({
      title: "Removed from watched",
      description: `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")} unmarked`,
    })
    // Fire server call in background
    try {
      await clearProgress(ep.id)
    } catch {
      toast({ title: "Error", description: "Failed to remove watched status", variant: "destructive" })
    }
  }, [toast, loadEpisodes])

  const handleDetailsPrimaryAction = (ep: MediaItem) => {
    setContentDetailsOpen(false)
    setContentDetailsItem(null)
    handlePlay(ep)
  }

  const launchWithZip = useCallback(
    async (ep: MediaItem, resume: boolean, audio: string | null, sub: string | null) => {
      const ls = ep.parent_zip_id ? buildZipPlaybackLoadingState(ep, resume) : null
      let t = 0
      if (ls) { setZipPlaybackLoading(ls); await waitForZipLoadingOverlayPaint(); t = Date.now() }
      const tmdbEp = tmdbEpisodesBySeason
        .get(ep.season_number || 1)
        ?.get(ep.episode_number || 0)
      const effectiveDuration = (ep.duration_seconds && ep.duration_seconds > 0
        ? ep.duration_seconds
        : (tmdbEp?.runtime && tmdbEp.runtime > 0 ? tmdbEp.runtime * 60 : null))
      const effectiveSize = ep.zip_uncompressed_size ?? ep.zip_compressed_size ?? ep.file_size_bytes ?? null
      try {
        await playMedia(ep.id, resume, audio, sub, effectiveDuration, effectiveSize)
        if (ls) { await waitForMpvPlaybackStart(ep.id); await waitForMinimumZipOverlayVisibility(t) }
      } finally { if (ls) setZipPlaybackLoading(null) }
    },
    [tmdbEpisodesBySeason],
  )

  const handlePlay = async (ep: MediaItem) => {
    try {
      const ri = await getResumeInfo(ep.id)
      if (ri.has_progress && !isProgressPastAutoCompleteThreshold(ri.progress_percent)) {
        setResumeDialogData({ episode: ep, resumeInfo: ri })
        setResumeDialogOpen(true)
      } else {
        await startPlayback(ep, 0)
      }
    } catch {
      toast({ title: "Error", description: "Playback failed", variant: "destructive" })
    }
  }

  const handleResumeChoice = async (resume: boolean) => {
    const data = resumeDialogData
    if (!data) return
    await startPlayback(data.episode, resume ? data.resumeInfo.position : 0)
  }

  const startPlayback = async (ep: MediaItem, rt: number) => {
    try {
      await launchWithZip(
        ep, rt > 0,
        resolveSeriesAudioPreferenceForPlayback(show.id, ep.season_number),
        resolveSeriesSubtitlePreferenceForPlayback(show.id, ep.season_number),
      )
      toast({
        title: "Now Playing",
        description: `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`,
      })
    } catch {
      toast({ title: "Error", description: "Playback failed", variant: "destructive" })
    }
  }

  return (
    <>
      <ZipPlaybackLoadingOverlay loadingState={zipPlaybackLoading} zIndexClassName="z-[200]" />

      <div className="h-full flex flex-col overflow-hidden bg-[#07080a]">
        {/* Top bar: Back + show title + season pills */}
        <div className="shrink-0 px-6 pt-5 pb-3 sm:px-10 sm:pt-6 sm:pb-4">
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider uppercase text-zinc-500 hover:text-zinc-300 bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 transition-all duration-200 shrink-0"
            >
              <ChevronLeft className="size-3.5" />
              Back
            </button>

            <h1 className="text-lg sm:text-xl font-black text-white tracking-tight leading-none truncate">
              {show.title}
            </h1>

            <div className="flex items-center gap-2">
              {seasons.map(s => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setSelectedSeason(s)}
                  className={cn(
                    "h-8 px-3.5 rounded-lg text-[10px] font-extrabold uppercase tracking-wider border transition-all duration-200 shrink-0",
                    selectedSeason === s
                      ? "bg-amber-500 text-black border-amber-500 shadow-lg shadow-amber-500/20"
                      : "bg-zinc-900/50 text-zinc-500 border-zinc-800/50 hover:bg-zinc-800/50 hover:border-zinc-700/50 hover:text-zinc-300",
                  )}
                >
                  S{s}
                </button>
              ))}
            </div>

            {/* Action Bar */}
            <div className="hidden sm:flex items-center gap-1.5 ml-auto">
              <button
                type="button"
                onClick={handleRefreshMetadata}
                disabled={isRefreshing}
                className="size-9 flex items-center justify-center rounded-xl bg-zinc-900/80 border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all duration-200 disabled:opacity-30 group relative shadow-sm"
              >
                <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
                <span className="absolute top-full mt-2.5 right-0 px-2.5 py-1 rounded-lg bg-zinc-900 text-[8px] font-bold tracking-widest uppercase text-zinc-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-zinc-800 shadow-xl z-[100]">
                  Refresh
                </span>
              </button>

              {filteredEpisodes.some(e => e.file_path || e.zip_entry_path) && (
                <button
                  type="button"
                  onClick={() => setShowEpisodeUrls(true)}
                  className="size-9 flex items-center justify-center rounded-xl bg-zinc-900/80 border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all duration-200 group relative shadow-sm"
                >
                  <FileText className="size-3.5" />
                  <span className="absolute top-full mt-2.5 right-0 px-2.5 py-1 rounded-lg bg-zinc-900 text-[8px] font-bold tracking-widest uppercase text-zinc-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-zinc-800 shadow-xl z-[100]">
                    Files
                  </span>
                </button>
              )}

              <button type="button" className="size-9 flex items-center justify-center rounded-xl bg-zinc-900/80 border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all duration-200 group relative shadow-sm">
                <SlidersHorizontal className="size-3.5" />
                <span className="absolute top-full mt-2.5 right-0 px-2.5 py-1 rounded-lg bg-zinc-900 text-[8px] font-bold tracking-widest uppercase text-zinc-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-zinc-800 shadow-xl z-[100]">
                  Audio
                </span>
              </button>

              <button
                type="button"
                onClick={toggleSpoiler}
                className={cn(
                  "size-9 flex items-center justify-center rounded-xl border transition-all duration-200 group relative shadow-sm",
                  spoilerEnabled
                    ? "bg-zinc-900/80 border-zinc-700 text-white hover:bg-zinc-800"
                    : "bg-zinc-900/80 border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800",
                )}
              >
                {spoilerEnabled ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                <span className="absolute top-full mt-2.5 right-0 px-2.5 py-1 rounded-lg bg-zinc-900 text-[8px] font-bold tracking-widest uppercase text-zinc-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-zinc-800 shadow-xl z-[100]">
                  Spoiler {spoilerEnabled ? "On" : "Off"}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Episode grid */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-6 pb-8 sm:px-10"
        >
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-32 flex flex-col items-center"
              >
                <div className="relative">
                  <Loader2 className="size-10 animate-spin text-zinc-600" />
                  <div className="absolute inset-0 size-10 rounded-full bg-amber-500/5 blur-xl animate-pulse" />
                </div>
                <p className="mt-4 text-[10px] font-bold tracking-[0.3em] uppercase text-zinc-600">
                  Loading episodes
                </p>
              </motion.div>
            ) : filteredEpisodes.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-32 flex flex-col items-center text-zinc-600"
              >
                <Info className="size-10 mb-4 opacity-40" />
                <p className="text-[10px] font-bold tracking-[0.3em] uppercase">
                  No episodes found
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={selectedSeason}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-8">
                  {episodesToRender.map((ep, i) => {
                    const tmdb = tmdbEpisodesBySeason
                      .get(selectedSeason)
                      ?.get(ep.episode_number || 0)
                    const epNum = ep.episode_number || 0
                    const imdb = imdbRatings[epNum]
                    const imdbRatingProp = imdb
                      ? { rating: imdb.imdb_rating, votes: imdb.imdb_votes }
                      : null
                    return (
                      <EpisodeItem
                        key={ep.id}
                        episode={ep}
                        index={i}
                        tmdbData={tmdb}
                        imdbRating={imdbRatingProp}
                        isExpanded={expandedEpisode === ep.id}
                        spoilerProtected={spoilerEnabled && !isMediaMarkedWatched(ep)}
                        isRevealed={revealedEpisodes.has(ep.id)}
                        onEpisodeClick={handleEpisodeClick}
                        onToggleExpand={handleToggleExpand}
                        onMarkWatched={handleMarkWatched}
                        onUnwatch={handleUnwatch}
                        onToggleSpoiler={handleToggleSpoiler}
                        onDownload={onDownload}
                      />
                    )
                  })}
                  {filteredEpisodes.length > visibleEpisodeCount && (
                    <div
                      ref={loadMoreRef}
                      className="col-span-full h-14 flex items-center justify-center"
                    >
                      <div className="flex items-center gap-2 text-[9px] font-bold tracking-[0.25em] uppercase text-zinc-600">
                        <Loader2 className="size-3 animate-spin" />
                        Loading more
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Modals */}
      {resumeDialogData && (
        <ResumeDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          title={show.title}
          mediaType={resumeDialogData.episode.media_type}
          seasonEpisode={`S${String(resumeDialogData.episode.season_number).padStart(2, "0")}E${String(resumeDialogData.episode.episode_number).padStart(2, "0")}`}
          currentPosition={resumeDialogData.resumeInfo.position}
          duration={resumeDialogData.resumeInfo.duration}
          onResume={() => handleResumeChoice(true)}
          onStartOver={() => handleResumeChoice(false)}
        />
      )}

      <ContentDetailsModal
        open={contentDetailsOpen}
        onOpenChange={setContentDetailsOpen}
        item={contentDetailsItem}
        onPrimaryAction={handleDetailsPrimaryAction}
        onDownloadAction={onDownload}
        downloadActionLabel="Download"
        onSecondaryAction={handleMarkWatched}
        secondaryActionLabel="Mark as watched"
      />

      <Dialog open={showEpisodeUrls} onOpenChange={setShowEpisodeUrls}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] !h-[80vh] flex flex-col bg-[#0c0d10] border-white/8">
          <DialogTitle className="text-sm font-bold tracking-tight text-white/90 px-1 shrink-0">
            Episode Files: {show.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            File names for each episode in season {selectedSeason}
          </DialogDescription>
          <ScrollArea className="flex-1 min-h-0 -mx-6 px-6">
            <div className="flex flex-col gap-2 py-2">
              {filteredEpisodes
                .filter(ep => ep.file_path || ep.zip_entry_path)
                .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
                .map(ep => {
                  const label = `S${String(ep.season_number || selectedSeason).padStart(2, "0")}E${String(ep.episode_number || 0).padStart(2, "0")}: ${ep.episode_title || ep.title}`
                  const name = (() => {
                    const p = ep.file_path || ep.zip_entry_path
                    if (!p) return ""
                    const n = p.replace(/\\/g, "/")
                    const i = n.lastIndexOf("/")
                    return i >= 0 ? n.slice(i + 1) : n
                  })()
                  return (
                    <div
                      key={ep.id}
                      className="flex items-start gap-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-white/80 truncate">{label}</p>
                        <p className="text-[11px] text-white/30 break-all mt-0.5 select-all">{name}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(name)}
                        className="shrink-0 size-7 flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
                      >
                        <FileText className="size-3" />
                      </button>
                    </div>
                  )
                })}
              {filteredEpisodes.filter(ep => ep.file_path || ep.zip_entry_path).length === 0 && (
                <p className="text-xs text-white/30 text-center py-8">No file info available.</p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
