import { useEffect, useMemo, useState } from "react"
import { Calendar, Clock, Play, Tv, Check, Loader2, Timer, ChevronDown, Star, User, AudioLines } from "lucide-react"
import { 
  MediaItem, getCachedImageUrl, getMovieDetails, getTmdbImageUrl, 
  searchTmdb, getEpisodes, getTvSeasonEpisodes, TmdbEpisodeInfo, getTvDetails,
  getSeriesAudioPreference, setSeriesAudioPreference, getAudioTracks,
  getCachedSeriesAudioTracks, setCachedSeriesAudioTracks,
  type AudioTrackOption
} from "@/services/api"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface ContentDetailsModalProps {
  open: boolean
  item: MediaItem | null
  onOpenChange: (open: boolean) => void
  onPrimaryAction: (item: MediaItem) => void | Promise<void>
}

const heroArtworkCache = new Map<number, string | null>()
const runtimeMinutesCache = new Map<number, number | null>()
const AUTO_AUDIO_VALUE = "__auto__"
const CUSTOM_AUDIO_VALUE = "__custom__"
const MANUAL_AUDIO_OPTION = {
  label: "Manual",
  value: CUSTOM_AUDIO_VALUE,
} as const

const resolveAudioPreferenceValue = (
  selectedValue: string,
  customValue: string,
) => {
  if (selectedValue === AUTO_AUDIO_VALUE) {
    return null
  }

  if (selectedValue === CUSTOM_AUDIO_VALUE) {
    const normalized = customValue.trim()
    return normalized.length > 0 ? normalized : null
  }

  return selectedValue
}

const resolveLocalImage = async (path?: string): Promise<string | null> => {
  if (!path || typeof path !== "string") return null
  if (path.startsWith("http") || path.startsWith("asset://")) return path
  const filename = path.replace("image_cache/", "")
  return getCachedImageUrl(filename)
}

const getZipCompressionLabel = (method?: number): string | null => {
  switch (method) {
    case 0:
      return "Store"
    case 8:
      return "Deflate"
    default:
      return null
  }
}

function EpisodeThumbnailImage({
  localStillPath,
  tmdbStillUrl,
  episodeTitle,
  episodeNumber
}: {
  localStillPath?: string;
  tmdbStillUrl: string | null;
  episodeTitle: string;
  episodeNumber: number;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadImage = async () => {
      setLoading(true);
      setImageUrl(null);

      if (localStillPath) {
        let filename = localStillPath;
        if (filename.startsWith('image_cache/')) {
          filename = filename.replace('image_cache/', '');
        }

        try {
          const cachedUrl = await getCachedImageUrl(filename);
          if (cachedUrl) {
            setImageUrl(cachedUrl);
            setLoading(false);
            return;
          }
        } catch (error) {
          console.log(`[EpisodeThumbnail] Failed to load local image:`, error);
        }
      }

      if (tmdbStillUrl) {
        setImageUrl(tmdbStillUrl);
      }
      setLoading(false);
    };
    loadImage();
  }, [localStillPath, tmdbStillUrl, episodeNumber]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white/5">
        <Loader2 className="w-5 h-5 animate-spin text-white/20" />
      </div>
    );
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={episodeTitle}
        className="w-full h-full object-cover"
      />
    );
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-white/5 text-white/10 font-bold">
      {episodeNumber > 0 ? episodeNumber : '?'}
    </div>
  );
}

export function ContentDetailsModal({
  open,
  item,
  onOpenChange,
  onPrimaryAction,
}: ContentDetailsModalProps) {
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null)
  const [posterImageUrl, setPosterImageUrl] = useState<string | null>(null)
  const [runtimeMinutesOverride, setRuntimeMinutesOverride] = useState<number | null>(null)
  const [director, setDirector] = useState<string | null>(null)
  const [creator, setCreator] = useState<string | null>(null)

  const [episodes, setEpisodes] = useState<MediaItem[]>([])
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  const [selectedSeason, setSelectedSeason] = useState<number>(1)
  const [tmdbEpisodesBySeason, setTmdbEpisodesBySeason] = useState<Map<number, Map<number, TmdbEpisodeInfo>>>(new Map())
  const [selectedAudioPreference, setSelectedAudioPreference] = useState<string>(AUTO_AUDIO_VALUE)
  const [customAudioPreference, setCustomAudioPreference] = useState("")
  const [detectedAudioTracks, setDetectedAudioTracks] = useState<AudioTrackOption[]>([])
  const [audioTracksLoading, setAudioTracksLoading] = useState(false)
  const [audioTracksStatus, setAudioTracksStatus] = useState<string>("")

  const [activeItem, setActiveItem] = useState<MediaItem | null>(null)

  useEffect(() => {
    if (item) {
      setActiveItem(item)
    }
  }, [item])

  const seriesPreferenceId = useMemo(() => {
    if (!item) return null
    if (item.media_type === "tvshow") return item.id
    if (item.media_type === "tvepisode") return item.parent_id ?? null
    return null
  }, [item])

  useEffect(() => {
    if (!seriesPreferenceId) {
      setSelectedAudioPreference(AUTO_AUDIO_VALUE)
      setCustomAudioPreference("")
      return
    }

    const storedPreference = getSeriesAudioPreference(seriesPreferenceId)
    const presetMatch = detectedAudioTracks.find(
      (option) => {
        const normalizedStored = storedPreference?.trim().toLowerCase()
        if (!normalizedStored) return false

        const preferenceParts = normalizedStored
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)

        return (
          option.mpv_value?.trim().toLowerCase() === normalizedStored ||
          option.language_code?.trim().toLowerCase() === normalizedStored ||
          preferenceParts.includes(option.language_code?.trim().toLowerCase() || "")
        )
      },
    )

    if (presetMatch) {
      setSelectedAudioPreference(presetMatch.mpv_value || AUTO_AUDIO_VALUE)
      setCustomAudioPreference("")
      return
    }

    if (storedPreference) {
      setSelectedAudioPreference(CUSTOM_AUDIO_VALUE)
      setCustomAudioPreference(storedPreference)
      return
    }

    setSelectedAudioPreference(AUTO_AUDIO_VALUE)
    setCustomAudioPreference("")
  }, [detectedAudioTracks, seriesPreferenceId])

  // Reset and load episodes
  useEffect(() => {
    if (!open) {
      setEpisodes([])
      setLoadingEpisodes(false)
      setTmdbEpisodesBySeason(new Map())
      return
    }

    if (!item || item.media_type !== "tvshow") {
      setEpisodes([])
      setLoadingEpisodes(false)
      return
    }

    const loadEpisodes = async () => {
      setLoadingEpisodes(true)
      try {
        const data = await getEpisodes(item.id)
        setEpisodes(data)
        if (data.length > 0) {
          const firstSeason = data.reduce((min, ep) =>
            ep.season_number && ep.season_number < min ? ep.season_number : min,
            data[0].season_number || 1
          )
          setSelectedSeason(firstSeason)
        }
      } catch (error) {
        console.error("Failed to load episodes in modal:", error)
      } finally {
        setLoadingEpisodes(false)
      }
    }

    void loadEpisodes()
  }, [open, item?.id])

  // Fetch TMDB episode metadata
  useEffect(() => {
    if (!open || !item || !item.tmdb_id || item.media_type !== "tvshow") return

    if (tmdbEpisodesBySeason.get(selectedSeason)) return

    const loadTmdbMetadata = async () => {
      try {
        const tmdbId = parseInt(item.tmdb_id!)
        const data = await getTvSeasonEpisodes(tmdbId, selectedSeason)
        if (data) {
          const episodeMap = new Map<number, TmdbEpisodeInfo>()
          data.episodes.forEach(ep => {
            episodeMap.set(ep.episode_number, ep)
          })
          setTmdbEpisodesBySeason(prev => {
            const next = new Map(prev)
            next.set(selectedSeason, episodeMap)
            return next
          })
        }
      } catch (error) {
        console.error("Failed to load TMDB episode metadata:", error)
      }
    }

    void loadTmdbMetadata()
  }, [open, item?.id, selectedSeason])

  // Instant artwork reset and load
  useEffect(() => {
    if (!item) return;

    // Reset immediately
    setHeroImageUrl(null)
    setPosterImageUrl(null)
    setRuntimeMinutesOverride(null)
    setDirector(null)
    setCreator(null)

    const cachedHero = heroArtworkCache.get(item.id)
    if (cachedHero !== undefined) {
      setHeroImageUrl(cachedHero)
    }

    const cachedRuntime = runtimeMinutesCache.get(item.id)
    if (cachedRuntime !== undefined) {
      setRuntimeMinutesOverride(cachedRuntime)
    }

    let cancelled = false

    const loadArtworkAndDetails = async () => {
      if (!open || !item) return

      const poster = await resolveLocalImage(item.poster_path)
      if (!cancelled) setPosterImageUrl(poster)

      const expectedType = item.media_type === "movie" ? "movie" : "tv"
      const itemTmdbId = Number.parseInt(item.tmdb_id || "", 10)
      const hasItemTmdbId = Number.isFinite(itemTmdbId) && itemTmdbId > 0
      
      // Load details based on media type
      if (hasItemTmdbId) {
        if (item.media_type === "movie") {
          const movieDetails = await getMovieDetails(itemTmdbId)
          if (!cancelled && movieDetails) {
            if (movieDetails.runtime) {
              runtimeMinutesCache.set(item.id, movieDetails.runtime)
              setRuntimeMinutesOverride(movieDetails.runtime)
            }
            if (movieDetails.director) {
              setDirector(movieDetails.director)
            }
            if (!heroImageUrl && movieDetails.backdrop_path) {
              const backdrop = getTmdbImageUrl(movieDetails.backdrop_path, "original")
              setHeroImageUrl(backdrop)
              heroArtworkCache.set(item.id, backdrop)
            }
          }
        } else if (item.media_type === "tvshow") {
          const showDetails = await getTvDetails(itemTmdbId)
          if (!cancelled && showDetails) {
            if (showDetails.creator) {
              setCreator(showDetails.creator)
            }
            if (!heroImageUrl && showDetails.backdrop_path) {
              const backdrop = getTmdbImageUrl(showDetails.backdrop_path, "original")
              setHeroImageUrl(backdrop)
              heroArtworkCache.set(item.id, backdrop)
            }
          }
        }
      }

      if (heroImageUrl === null || heroArtworkCache.get(item.id) === undefined) {
        let nextHero: string | null = null
        try {
          if (item.media_type === "tvepisode" && item.still_path) {
            nextHero = await resolveLocalImage(item.still_path)
          }
          if (!nextHero) {
            const response = await searchTmdb(item.title)
            const results = Array.isArray(response?.results) ? response.results : []
            const exactMatch = results.find(r => String(r.id) === item.tmdb_id && r.media_type === expectedType)
            const chosen = exactMatch ?? results.find(r => r.media_type === expectedType && !!r.backdrop_path)
            nextHero = getTmdbImageUrl(chosen?.backdrop_path, "original")
          }
        } catch { /* ignore */ }

        if (!nextHero) nextHero = poster
        heroArtworkCache.set(item.id, nextHero)
        if (!cancelled) setHeroImageUrl(nextHero)
      }
    }

    void loadArtworkAndDetails()
    return () => { cancelled = true }
  }, [open, item?.id])

  const castList = useMemo(() => {
    const target = item || activeItem
    if (!target?.cast_names || typeof target.cast_names !== "string") return []
    return target.cast_names.split(",").map(s => s.trim()).filter(Boolean).slice(0, 8)
  }, [item?.id, activeItem?.id])

  // Memoize seasons calculation to prevent redundant set creation and sorting on every render
  const seasons = useMemo(() => {
    return [...new Set(episodes.map(ep => ep.season_number || 1))].sort((a, b) => a - b)
  }, [episodes])

  // Memoize episodes filtering and sorting to prevent redundant array operations on every render
  const filteredEpisodes = useMemo(() => {
    return episodes.filter(ep => (ep.season_number || 1) === selectedSeason).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
  }, [episodes, selectedSeason])

  const selectedSeasonHasZipEpisodes = useMemo(() => (
    filteredEpisodes.some((episode) => !!episode.parent_zip_id)
  ), [filteredEpisodes])

  useEffect(() => {
    if (!open || !item || item.media_type !== "tvshow") {
      setDetectedAudioTracks([])
      setAudioTracksLoading(false)
      setAudioTracksStatus("")
      return
    }

    if (filteredEpisodes.length === 0) {
      setDetectedAudioTracks([])
      setAudioTracksLoading(false)
      setAudioTracksStatus("")
      return
    }

    const cachedTracks = getCachedSeriesAudioTracks(item.id)
    if (cachedTracks) {
      setDetectedAudioTracks(cachedTracks)
      setAudioTracksLoading(false)
      setAudioTracksStatus(
        selectedSeasonHasZipEpisodes
          ? "Learned from playback and updates as you watch."
          : "Detected earlier for this series.",
      )
      return
    }

    if (selectedSeasonHasZipEpisodes) {
      setDetectedAudioTracks([])
      setAudioTracksLoading(false)
      setAudioTracksStatus("Play one ZIP episode once. Later episodes can expand this list.")
      return
    }

    let cancelled = false

    const loadAudioTracks = async () => {
      setAudioTracksLoading(true)
      setAudioTracksStatus("Detecting audio tracks...")

      const sampleEpisode = filteredEpisodes[0]
      const tracks = await getAudioTracks(sampleEpisode.id)
      if (cancelled) return

      const nextTracks = [...tracks].sort((left, right) =>
        left.label.localeCompare(right.label),
      )

      setDetectedAudioTracks(nextTracks)
      setCachedSeriesAudioTracks(item.id, nextTracks)
      setAudioTracksStatus(
        nextTracks.length > 0
          ? `Detected once from episode ${sampleEpisode.episode_number || 1}.`
          : "No labeled audio tracks were found in the sampled episode.",
      )
      setAudioTracksLoading(false)
    }

    void loadAudioTracks()

    return () => {
      cancelled = true
    }
  }, [filteredEpisodes, item, open, selectedSeason, selectedSeasonHasZipEpisodes])

  if (!activeItem && !item) return null
  const displayItem = item || activeItem
  if (!displayItem) return null

  const isShow = displayItem.media_type === "tvshow"
  const isEpisode = displayItem.media_type === "tvepisode"
  const runtimeMinutes = (displayItem.duration_seconds && displayItem.duration_seconds > 0
    ? Math.max(1, Math.round(displayItem.duration_seconds / 60))
    : null) ?? runtimeMinutesOverride

  const runtimeLabel = runtimeMinutes
    ? (runtimeMinutes >= 60 ? `${Math.floor(runtimeMinutes / 60)}h ${runtimeMinutes % 60}m` : `${runtimeMinutes}m`)
    : "N/A"
  const zipCompressionLabel = displayItem.parent_zip_id
    ? getZipCompressionLabel(displayItem.zip_compression_method)
    : null

  const displayTitle = isEpisode && displayItem.season_number && displayItem.episode_number
    ? `S${String(displayItem.season_number).padStart(2, "0")}E${String(displayItem.episode_number).padStart(2, "0")} · ${displayItem.title}`
    : displayItem.title

  const handleAudioPreferenceSelect = (value: string) => {
    setSelectedAudioPreference(value)
    if (!seriesPreferenceId) return

    setSeriesAudioPreference(
      seriesPreferenceId,
      resolveAudioPreferenceValue(
        value,
        value === CUSTOM_AUDIO_VALUE ? customAudioPreference : "",
      ),
    )
  }

  const handleCustomAudioPreferenceChange = (value: string) => {
    setCustomAudioPreference(value)
    if (!seriesPreferenceId || selectedAudioPreference !== CUSTOM_AUDIO_VALUE) return

    setSeriesAudioPreference(
      seriesPreferenceId,
      resolveAudioPreferenceValue(CUSTOM_AUDIO_VALUE, value),
    )
  }

  const selectedDetectedAudioTrack = detectedAudioTracks.find(
    (track) => track.mpv_value === selectedAudioPreference,
  )
  const selectedAudioSummary = selectedAudioPreference === CUSTOM_AUDIO_VALUE
    ? (customAudioPreference.trim() || "Manual")
    : selectedDetectedAudioTrack?.label || (selectedAudioPreference === AUTO_AUDIO_VALUE ? "Auto" : null)

  const audioControls = isShow ? (
    <div className="w-full max-w-[420px]">
      <div className="flex flex-col items-start gap-2.5 sm:items-end">
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/46">
            <AudioLines className="h-3.5 w-3.5" />
            Audio
          </span>

          {selectedAudioSummary && !audioTracksLoading && (
            <span className="rounded-full border border-white/12 px-2.5 py-1 text-[10px] font-medium text-white/68">
              {selectedAudioSummary}
            </span>
          )}
        </div>

        <p className="max-w-[360px] text-[11px] leading-4 text-white/34 sm:text-right">
          {audioTracksLoading ? "Detecting tracks..." : audioTracksStatus}
        </p>

        <div className="flex flex-wrap gap-2 sm:flex-nowrap sm:justify-end">
          <button
            onClick={() => handleAudioPreferenceSelect(AUTO_AUDIO_VALUE)}
            className={cn(
              "whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
              selectedAudioPreference === AUTO_AUDIO_VALUE
                ? "border-white/70 bg-white text-black"
                : "border-white/10 text-white/70 hover:border-white/24 hover:bg-white/8 hover:text-white",
            )}
          >
            Auto
          </button>

          {detectedAudioTracks.map((track) => (
            <button
              key={`${track.stream_index}-${track.mpv_value || track.label}`}
              onClick={() => track.mpv_value && handleAudioPreferenceSelect(track.mpv_value)}
              disabled={!track.mpv_value}
              className={cn(
                "whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                selectedAudioPreference === track.mpv_value
                  ? "border-white/70 bg-white text-black"
                  : "border-white/10 text-white/70 hover:border-white/24 hover:bg-white/8 hover:text-white",
                !track.mpv_value && "cursor-not-allowed opacity-45",
              )}
              title={track.detail || track.label}
            >
              {track.label}
            </button>
          ))}

        <button
          onClick={() => handleAudioPreferenceSelect(MANUAL_AUDIO_OPTION.value)}
          className={cn(
            "whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
            selectedAudioPreference === CUSTOM_AUDIO_VALUE
              ? "border-white/70 bg-white text-black"
              : "border-white/10 text-white/70 hover:border-white/24 hover:bg-white/8 hover:text-white",
            )}
          >
            Manual
          </button>
        </div>

        {selectedAudioPreference === CUSTOM_AUDIO_VALUE && (
          <div className="w-full sm:max-w-[260px]">
            <Input
              value={customAudioPreference}
              onChange={(e) => handleCustomAudioPreferenceChange(e.target.value)}
              placeholder="Language code, e.g. hi,hin,hindi"
              className="h-9 rounded-full border-white/12 bg-white/6 px-4 text-sm text-white placeholder:text-white/28"
            />
          </div>
        )}

        {!audioTracksLoading && detectedAudioTracks.length === 0 && !selectedSeasonHasZipEpisodes && (
          <p className="max-w-[320px] text-[11px] leading-4 text-white/28 sm:text-right">
            No labeled tracks found. Use Auto or Manual.
          </p>
        )}
      </div>
    </div>
  ) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1080px] w-[96vw] max-h-[92vh] h-auto bg-[#090a0d] border-white/10 text-white p-0 overflow-hidden flex flex-col shadow-2xl [&>button]:z-[100] [&>button]:bg-black/50 [&>button]:rounded-full [&>button]:p-1.5 [&>button]:hover:bg-black/80">
        <DialogTitle className="sr-only">{displayTitle}</DialogTitle>
        <DialogDescription className="sr-only">Details for {displayTitle}</DialogDescription>

        <section className={cn(
          "relative w-full overflow-hidden flex flex-col bg-[#090a0d] shrink-0",
          isShow ? "h-[90vh]" : "h-[76vh] min-h-[520px]"
        )}>
          {/* Hero Backdrop */}
          <div className="absolute inset-0 z-0">
            {heroImageUrl ? (
              <img 
                src={heroImageUrl} 
                alt="" 
                className="w-full h-full object-cover opacity-60 transition-opacity duration-500" 
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#11141d] to-[#07080b]" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-[#090a0d] via-[#090a0d]/80 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#090a0d]/90 via-transparent to-[#090a0d]/40" />
            <div className="absolute inset-0 bg-black/20" />
          </div>

          {/* Content Layer */}
          <div className="relative z-10 flex flex-col h-full min-h-0">
            <div className={cn("p-6 sm:px-10 shrink-0", isShow ? "pb-0 pt-7" : "mt-auto sm:py-10 pb-12")}>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                {posterImageUrl && !isShow && (
                  <div className="hidden sm:block w-[160px] aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl border border-white/10 shrink-0 scale-100 hover:scale-[1.02] transition-transform duration-500">
                    <img src={posterImageUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-white/50 mb-2">
                    {isShow ? "TV Series" : isEpisode ? "TV Episode" : "Movie"}
                  </p>
                  <h2 className={cn(
                    "font-bold leading-tight tracking-tight text-white",
                    isShow ? "text-3xl sm:text-5xl mb-2" : "text-4xl sm:text-6xl mb-4"
                  )}>{displayTitle}</h2>
                  
                  <div className={cn(
                    "flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-white/90",
                    isShow ? "mb-2" : "mb-5"
                  )}>
                    <span className="flex items-center gap-2"><Calendar className="w-4 h-4 text-white/60" />{displayItem.year || "N/A"}</span>
                    {!isShow && <span className="flex items-center gap-2"><Clock className="w-4 h-4 text-white/60" />{runtimeLabel}</span>}
                    {isShow && <span className="flex items-center gap-2"><Tv className="w-4 h-4 text-white/60" />{seasons.length} Seasons</span>}
                    {zipCompressionLabel && (
                      <span className="flex items-center gap-2 px-3 py-1 rounded-lg bg-white/10 border border-white/10 text-white/90">
                        ZIP: {zipCompressionLabel}
                      </span>
                    )}
                    {(director || creator) && (
                      <span className="flex items-center gap-2 px-3 py-1 rounded-lg bg-white/10 border border-white/10 text-white/90">
                        <User className="w-4 h-4 text-white/60" />
                        {isShow ? `Created by ${creator}` : `Director: ${director}`}
                      </span>
                    )}
                  </div>
                  
                  {!isShow && castList.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {castList.map(name => (
                        <span key={name} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-default">
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {audioControls && (
                  <div className="w-full sm:w-auto sm:min-w-[380px] sm:max-w-[420px] sm:self-start sm:pl-6 sm:pr-12 lg:pl-10 lg:pr-14">
                    {audioControls}
                  </div>
                )}
                
                {!isShow && (
                  <div className="shrink-0 mb-2">
                    <Button 
                      onClick={() => onPrimaryAction(displayItem)} 
                      className="h-16 px-12 rounded-2xl text-lg font-bold shadow-glow hover:scale-105 active:scale-95 transition-all duration-300 bg-white text-black hover:bg-white/90"
                    >
                      <Play className="w-6 h-6 mr-3 fill-current" /> Play Now
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {isShow && (
              <div className="flex-1 min-h-0 flex flex-col px-6 pb-6 sm:px-10 sm:pb-8 pt-0">
                <div className="flex justify-between items-center mb-2 shrink-0">
                  <div className="flex gap-2 overflow-x-auto no-scrollbar">
                    {seasons.map(s => (
                      <button 
                        key={s} 
                        onClick={() => setSelectedSeason(s)} 
                        className={cn(
                          "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-[999px] px-4 text-[9px] leading-none font-bold uppercase tracking-[0.16em] border backdrop-blur-xl transition-all duration-300 shrink-0",
                          selectedSeason === s
                            ? "bg-white text-black border-white shadow-lg"
                            : "bg-white/10 text-white/75 border-white/10 hover:bg-white/15 hover:text-white hover:border-white/20"
                        )}
                      >
                        Season {s}
                      </button>
                    ))}
                  </div>
                  
                  {filteredEpisodes.length > 3 && (
                    <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-xl border border-white/10 text-[9px] font-bold uppercase tracking-[0.22em] text-white/88 shadow-glow-sm animate-pulse">
                      <span>Scroll for next episodes</span>
                      <ChevronDown className="w-2.5 h-2.5" />
                    </div>
                  )}
                </div>
                
                <div className="flex-1 min-h-0 relative">
                  <div className="h-full w-full overflow-y-auto no-scrollbar">
                    {loadingEpisodes ? (
                      <div className="py-20 flex flex-col items-center text-white/30">
                        <Loader2 className="w-12 h-12 animate-spin mb-4" />
                        <p className="font-medium tracking-wide">Loading episodes...</p>
                      </div>
                    ) : filteredEpisodes.length === 0 ? (
                      <div className="py-20 text-center text-white/30">
                        <p className="font-medium tracking-wide">No episodes found for this season.</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 pb-8">
                        {filteredEpisodes.map(ep => {
                          const tmdbData = tmdbEpisodesBySeason.get(selectedSeason)?.get(ep.episode_number || 0)
                          const rating = tmdbData?.vote_average
                          const airDate = tmdbData?.air_date
                          const runtime = tmdbData?.runtime
                          const episodeZipCompressionLabel = ep.parent_zip_id
                            ? getZipCompressionLabel(ep.zip_compression_method)
                            : null
                          
                          return (
                            <div 
                              key={ep.id} 
                              onClick={() => onPrimaryAction(ep)} 
                              className="group flex gap-4 p-3 rounded-[1.6rem] bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.08] hover:border-white/10 transition-all duration-300 cursor-pointer shadow-sm hover:shadow-2xl"
                            >
                              <div className="relative w-36 sm:w-48 aspect-video rounded-2xl overflow-hidden shrink-0 bg-white/5 shadow-lg">
                                <EpisodeThumbnailImage 
                                  localStillPath={ep.still_path} 
                                  tmdbStillUrl={getTmdbImageUrl(ep.still_path || tmdbData?.still_path, 'w300')} 
                                  episodeTitle={tmdbData?.name || ep.title} 
                                  episodeNumber={ep.episode_number || 0} 
                                />
                                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 backdrop-blur-[2px]">
                                  <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-2xl scale-90 group-hover:scale-100 transition-transform duration-300">
                                    <Play className="w-6 h-6 text-black fill-black ml-1" />
                                  </div>
                                </div>
                                {ep.progress_percent ? (
                                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/40">
                                    <div 
                                      className="h-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" 
                                      style={{ width: `${ep.progress_percent}%` }} 
                                    />
                                  </div>
                                ) : null}
                                {ep.progress_percent && ep.progress_percent >= 95 ? (
                                  <div className="absolute top-3 right-3 p-1.5 rounded-xl bg-black/60 backdrop-blur-md text-white border border-white/10 shadow-lg">
                                    <Check className="w-4 h-4" />
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex-1 min-w-0 py-0.5">
                                <div className="flex justify-between items-start mb-1.5">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                      <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">EPISODE {ep.episode_number}</p>
                                      {episodeZipCompressionLabel && (
                                        <span className="rounded-lg border border-white/10 bg-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/80">
                                          ZIP: {episodeZipCompressionLabel}
                                        </span>
                                      )}
                                    </div>
                                    <h4 className="text-base font-bold text-white line-clamp-1 group-hover:text-white transition-colors tracking-tight">{tmdbData?.name || ep.title}</h4>
                                  </div>
                                  <div className="flex items-center gap-3 shrink-0 mt-0.5">
                                    {rating && rating > 0 && (
                                      <div className="flex items-center gap-1.5 text-xs font-bold text-white/80 bg-white/5 px-2 py-1 rounded-lg">
                                        <Star className="w-3 h-3 fill-current text-yellow-500" />
                                        {rating.toFixed(1)}
                                      </div>
                                    )}
                                    {(ep.duration_seconds || runtime) && (
                                      <div className="flex items-center gap-1.5 text-xs font-bold text-white/60">
                                        <Timer className="w-3.5 h-3.5 opacity-70" />
                                        {Math.round((ep.duration_seconds || (runtime ? runtime * 60 : 0)) / 60)}m
                                      </div>
                                    )}
                                  </div>
                                </div>
                                
                                {airDate && (
                                  <div className="flex items-center gap-2 text-[10px] font-bold text-white/30 uppercase tracking-[0.15em] mb-2">
                                    <Calendar className="w-3 h-3 opacity-50" />
                                    {new Date(airDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                  </div>
                                )}
                                
                                <p className="text-sm text-white/50 line-clamp-2 leading-snug group-hover:text-white/70 transition-colors">{ep.overview || tmdbData?.overview || "No description available."}</p>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  
                  {/* Subtle bottom fade to indicate more content */}
                  {filteredEpisodes.length > 3 && (
                    <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-[#090a0d] via-[#090a0d]/40 to-transparent pointer-events-none z-20" />
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
