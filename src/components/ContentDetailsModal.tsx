import { useCallback, useEffect, useMemo, useState } from "react"
import { Calendar, Clock, Play, Tv, Check, Loader2, Timer, ChevronDown, Star, User, AudioLines, Captions, SlidersHorizontal, X, RefreshCw, Download } from "lucide-react"
import { 
  MediaItem, getCachedImageUrl, getMovieDetails, getTmdbImageUrl, 
  searchTmdb, getEpisodes, getTvSeasonEpisodes, TmdbEpisodeInfo, TmdbMovieDetails, TmdbShowDetails, getTvDetails, getMediaInfo, refreshSeriesMetadata,
  getSeriesAudioPreference, setSeriesAudioPreference, getSeriesSubtitlePreference, setSeriesSubtitlePreference, getAudioTracks, getSubtitleTracks,
  getCachedSeriesAudioTracks, setCachedSeriesAudioTracks,
  getCachedSeriesSubtitleTracks, setCachedSeriesSubtitleTracks,
  getMediaTechnicalDetails,
  type AudioTrackOption, type SubtitleTrackOption, type MediaTechnicalDetails
} from "@/services/api"
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isMediaMarkedWatched } from "@/utils/playbackProgress"
import { useToast } from "@/components/ui/use-toast"

interface ContentDetailsModalProps {
  open: boolean
  item: MediaItem | null
  onOpenChange: (open: boolean) => void
  onPrimaryAction: (item: MediaItem) => void | Promise<void>
  onSecondaryAction?: (item: MediaItem) => void | Promise<void>
  onDownloadAction?: (item: MediaItem) => void | Promise<void>
  downloadActionLabel?: string
  secondaryActionLabel?: string
  onEpisodeSecondaryAction?: (item: MediaItem) => void | Promise<void>
  episodeSecondaryActionLabel?: string
  onMetadataRefresh?: (itemId: number) => Promise<MediaItem | null> | MediaItem | null
}

const heroArtworkCache = new Map<number, string | null>()
const runtimeMinutesCache = new Map<number, number | null>()
const movieDetailsCache = new Map<number, TmdbMovieDetails | null>()
const tvDetailsCache = new Map<number, TmdbShowDetails | null>()
const technicalDetailsCache = new Map<number, MediaTechnicalDetails | null>()
const tvSeasonEpisodesCache = new Map<number, Map<number, Map<number, TmdbEpisodeInfo>>>()
const AUTO_AUDIO_VALUE = "__auto__"
const CUSTOM_AUDIO_VALUE = "__custom__"
const AUTO_SUBTITLE_VALUE = "__subtitle_auto__"
const OFF_SUBTITLE_VALUE = "__subtitle_off__"
const CUSTOM_SUBTITLE_VALUE = "__subtitle_custom__"
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

const resolveSubtitlePreferenceValue = (
  selectedValue: string,
  customValue: string,
) => {
  if (selectedValue === AUTO_SUBTITLE_VALUE) {
    return null
  }

  if (selectedValue === OFF_SUBTITLE_VALUE) {
    return "sid:no"
  }

  if (selectedValue === CUSTOM_SUBTITLE_VALUE) {
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

const formatEpisodeSize = (bytes?: number | null): string | null => {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null

  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

const formatFps = (fps?: number | null): string | null => {
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return null
  const rounded = fps >= 100 ? fps.toFixed(0) : fps >= 10 ? fps.toFixed(3) : fps.toFixed(2)
  return `${rounded.replace(/\.?0+$/, "")} fps`
}

const parseMediaHints = (value?: string | null): Partial<MediaTechnicalDetails> => {
  if (!value) return {}

  const text = value.toLowerCase()
  const resolutionMatch = text.match(/(?:^|[^0-9])(2160p|1440p|1080p|720p|480p)(?:[^0-9]|$)/i)
  const fpsMatch = text.match(/(\d{2,3}(?:\.\d+)?)\s*fps/i)
  const extensionMatch = value.match(/\.([a-z0-9]{2,5})(?:$|\s)/i)

  return {
    resolutionLabel: resolutionMatch?.[1]?.toLowerCase() ?? undefined,
    fps: fpsMatch ? Number.parseFloat(fpsMatch[1]) : undefined,
    extension: extensionMatch?.[1]?.toUpperCase() ?? undefined,
    container: extensionMatch?.[1]?.toUpperCase() ?? undefined,
  }
}

const getExtensionLabel = (path?: string | null): string | null => {
  if (!path) return null
  const lastDot = path.lastIndexOf(".")
  if (lastDot < 0 || lastDot === path.length - 1) return null
  return path.slice(lastDot + 1).toUpperCase()
}

const buildDisplayMediaParts = (
  item: Pick<MediaItem, "title" | "file_path" | "zip_entry_path" | "file_size_bytes" | "zip_uncompressed_size" | "zip_compressed_size" | "parent_zip_id">,
  details?: MediaTechnicalDetails | null,
  includeSize: boolean = true,
): string[] => {
  const hinted = parseMediaHints(item.title || item.file_path || item.zip_entry_path)
  const size = details?.fileSizeBytes ?? (
    item.parent_zip_id
      ? item.zip_uncompressed_size ?? item.zip_compressed_size ?? item.file_size_bytes ?? null
      : item.file_size_bytes ?? item.zip_uncompressed_size ?? item.zip_compressed_size ?? null
  )

  return [
    details?.resolutionLabel ?? hinted.resolutionLabel ?? null,
    formatFps(details?.fps ?? hinted.fps),
    details?.container ?? hinted.container ?? getExtensionLabel(item.zip_entry_path || item.file_path),
    includeSize ? formatEpisodeSize(size) : null,
  ].filter(Boolean) as string[]
}

const getPreferredEpisodeSize = (episode: MediaItem): number | null => {
  if (episode.parent_zip_id) {
    return episode.zip_uncompressed_size ?? episode.zip_compressed_size ?? episode.file_size_bytes ?? null
  }

  return episode.file_size_bytes ?? episode.zip_uncompressed_size ?? episode.zip_compressed_size ?? null
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
  onSecondaryAction,
  onDownloadAction,
  downloadActionLabel,
  secondaryActionLabel,
  onEpisodeSecondaryAction,
  episodeSecondaryActionLabel,
  onMetadataRefresh,
}: ContentDetailsModalProps) {
  const { toast } = useToast()
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null)
  const [posterImageUrl, setPosterImageUrl] = useState<string | null>(null)
  const [runtimeMinutesOverride, setRuntimeMinutesOverride] = useState<number | null>(null)
  const [director, setDirector] = useState<string | null>(null)
  const [creator, setCreator] = useState<string | null>(null)
  const [technicalDetails, setTechnicalDetails] = useState<MediaTechnicalDetails | null>(null)

  const [episodes, setEpisodes] = useState<MediaItem[]>([])
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  const [selectedSeason, setSelectedSeason] = useState<number>(1)
  const [tmdbEpisodesBySeason, setTmdbEpisodesBySeason] = useState<Map<number, Map<number, TmdbEpisodeInfo>>>(new Map())
  const [selectedAudioPreference, setSelectedAudioPreference] = useState<string>(AUTO_AUDIO_VALUE)
  const [customAudioPreference, setCustomAudioPreference] = useState("")
  const [detectedAudioTracks, setDetectedAudioTracks] = useState<AudioTrackOption[]>([])
  const [audioTracksLoading, setAudioTracksLoading] = useState(false)
  const [audioTracksStatus, setAudioTracksStatus] = useState<string>("")
  const [detectedSubtitleTracks, setDetectedSubtitleTracks] = useState<SubtitleTrackOption[]>([])
  const [subtitleTracksLoading, setSubtitleTracksLoading] = useState(false)
  const [subtitleTracksStatus, setSubtitleTracksStatus] = useState<string>("")
  const [selectedSubtitlePreference, setSelectedSubtitlePreference] = useState<string>(AUTO_SUBTITLE_VALUE)
  const [customSubtitlePreference, setCustomSubtitlePreference] = useState("")
  const [playbackSettingsOpen, setPlaybackSettingsOpen] = useState(false)
  const [isRefreshingMetadata, setIsRefreshingMetadata] = useState(false)

  const [activeItem, setActiveItem] = useState<MediaItem | null>(null)

  const handleEpisodeMarkWatched = async (episode: MediaItem) => {
    if (!onEpisodeSecondaryAction) return

    await onEpisodeSecondaryAction(episode)

    const markedAt = new Date().toISOString()
    setEpisodes((currentEpisodes) =>
      currentEpisodes.map((currentEpisode) =>
        currentEpisode.id === episode.id
          ? {
              ...currentEpisode,
              progress_percent: 100,
              resume_position_seconds: 0,
              duration_seconds: currentEpisode.duration_seconds ?? episode.duration_seconds,
              last_watched: markedAt,
            }
          : currentEpisode,
      ),
    )

    setActiveItem((currentActiveItem) =>
      currentActiveItem?.id === episode.id
        ? {
            ...currentActiveItem,
            progress_percent: 100,
            resume_position_seconds: 0,
            duration_seconds: currentActiveItem.duration_seconds ?? episode.duration_seconds,
            last_watched: markedAt,
          }
        : currentActiveItem,
    )
  }

  useEffect(() => {
    if (item) {
      setActiveItem(item)
    }
  }, [item])

  const handleRefreshMetadata = useCallback(async () => {
    if (!item || item.media_type !== "tvshow" || !item.tmdb_id || isRefreshingMetadata) return

    const tmdbId = Number.parseInt(item.tmdb_id, 10)
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      toast({
        title: "Refresh unavailable",
        description: "This series does not have a valid TMDB match yet.",
        variant: "destructive",
      })
      return
    }

    setIsRefreshingMetadata(true)
    heroArtworkCache.delete(item.id)
    tvDetailsCache.delete(tmdbId)

    try {
      const result = await refreshSeriesMetadata(tmdbId, item.title)
      const refreshedItem =
        (await Promise.resolve(onMetadataRefresh?.(item.id))) ||
        (await getMediaInfo(item.id))

      const refreshedEpisodes = await getEpisodes(item.id)
      setActiveItem(refreshedItem)
      setEpisodes(refreshedEpisodes)
      setTmdbEpisodesBySeason(new Map())

      toast({
        title: "Metadata refreshed",
        description: result,
      })
    } catch (error) {
      console.error("Failed to refresh metadata in content details modal:", error)
      toast({
        title: "Error",
        description: "Failed to refresh metadata",
        variant: "destructive",
      })
    } finally {
      setIsRefreshingMetadata(false)
    }
  }, [isRefreshingMetadata, item, onMetadataRefresh, toast])

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

  useEffect(() => {
    if (!seriesPreferenceId) {
      setSelectedSubtitlePreference(AUTO_SUBTITLE_VALUE)
      setCustomSubtitlePreference("")
      return
    }

    const storedPreference = getSeriesSubtitlePreference(seriesPreferenceId)
    const normalizedStored = storedPreference?.trim().toLowerCase()

    if (normalizedStored === "sid:no" || normalizedStored === "no") {
      setSelectedSubtitlePreference(OFF_SUBTITLE_VALUE)
      setCustomSubtitlePreference("")
      return
    }

    const presetMatch = detectedSubtitleTracks.find((option) => {
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
    })

    if (presetMatch) {
      setSelectedSubtitlePreference(presetMatch.mpv_value || AUTO_SUBTITLE_VALUE)
      setCustomSubtitlePreference("")
      return
    }

    if (storedPreference) {
      setSelectedSubtitlePreference(CUSTOM_SUBTITLE_VALUE)
      setCustomSubtitlePreference(storedPreference)
      return
    }

    setSelectedSubtitlePreference(AUTO_SUBTITLE_VALUE)
    setCustomSubtitlePreference("")
  }, [detectedSubtitleTracks, seriesPreferenceId])

  // Reset and load episodes
  useEffect(() => {
    if (!open) {
      setEpisodes([])
      setLoadingEpisodes(false)
      setTmdbEpisodesBySeason(new Map())
      setPlaybackSettingsOpen(false)
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

    const tmdbId = parseInt(item.tmdb_id!)
    const cachedShowSeasons = tvSeasonEpisodesCache.get(tmdbId)
    const cachedSeason = cachedShowSeasons?.get(selectedSeason)
    if (cachedSeason) {
      setTmdbEpisodesBySeason(prev => {
        if (prev.get(selectedSeason) === cachedSeason) return prev
        const next = new Map(prev)
        next.set(selectedSeason, cachedSeason)
        return next
      })
      return
    }

    if (tmdbEpisodesBySeason.get(selectedSeason)) return

    const loadTmdbMetadata = async () => {
      try {
        const data = await getTvSeasonEpisodes(tmdbId, selectedSeason)
        if (data) {
          const episodeMap = new Map<number, TmdbEpisodeInfo>()
          data.episodes.forEach(ep => {
            episodeMap.set(ep.episode_number, ep)
          })
          const nextShowSeasons = new Map(tvSeasonEpisodesCache.get(tmdbId) ?? new Map())
          nextShowSeasons.set(selectedSeason, episodeMap)
          tvSeasonEpisodesCache.set(tmdbId, nextShowSeasons)
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
    const target = activeItem ?? item
    if (!target) return;

    // Reset immediately
    setHeroImageUrl(null)
    setPosterImageUrl(null)
    setRuntimeMinutesOverride(null)
    setDirector(null)
    setCreator(null)
    setTechnicalDetails(null)

    const cachedHero = heroArtworkCache.get(target.id)
    if (cachedHero !== undefined) {
      setHeroImageUrl(cachedHero)
    }

    const cachedRuntime = runtimeMinutesCache.get(target.id)
    if (cachedRuntime !== undefined) {
      setRuntimeMinutesOverride(cachedRuntime)
    }

    let cancelled = false

    const loadArtworkAndDetails = async () => {
      if (!open || !target) return

      const expectedType = target.media_type === "movie" ? "movie" : "tv"
      const itemTmdbId = Number.parseInt(target.tmdb_id || "", 10)
      const hasItemTmdbId = Number.isFinite(itemTmdbId) && itemTmdbId > 0
      let nextHero = cachedHero ?? null

      const posterPromise = resolveLocalImage(target.poster_path)
      const detailsPromise = hasItemTmdbId
        ? target.media_type === "movie"
          ? (movieDetailsCache.has(itemTmdbId)
              ? Promise.resolve(movieDetailsCache.get(itemTmdbId) ?? null)
              : getMovieDetails(itemTmdbId).then((details) => {
                  movieDetailsCache.set(itemTmdbId, details)
                  return details
                }))
          : (tvDetailsCache.has(itemTmdbId)
              ? Promise.resolve(tvDetailsCache.get(itemTmdbId) ?? null)
              : getTvDetails(itemTmdbId).then((details) => {
                  tvDetailsCache.set(itemTmdbId, details)
                  return details
                }))
        : Promise.resolve(null)

      const [poster, details] = await Promise.all([posterPromise, detailsPromise])
      if (!cancelled) setPosterImageUrl(poster)

      if (!cancelled && details) {
        if (target.media_type === "movie") {
          const movieDetails = details as TmdbMovieDetails
          if (movieDetails.runtime) {
            runtimeMinutesCache.set(target.id, movieDetails.runtime)
            setRuntimeMinutesOverride(movieDetails.runtime)
          }
          if (movieDetails.director) {
            setDirector(movieDetails.director)
          }
          if (!nextHero && movieDetails.backdrop_path) {
            nextHero = await resolveLocalImage(movieDetails.backdrop_path)
          }
        } else if (target.media_type === "tvshow") {
          const showDetails = details as TmdbShowDetails
          if (showDetails.creator) {
            setCreator(showDetails.creator)
          }
          if (!nextHero && showDetails.backdrop_path) {
            nextHero = await resolveLocalImage(showDetails.backdrop_path)
          }
        }
      }

      if (!nextHero) {
        try {
          if (target.media_type === "tvepisode" && target.still_path) {
            nextHero = await resolveLocalImage(target.still_path)
          }
          if (!nextHero && !hasItemTmdbId) {
            const response = await searchTmdb(target.title)
            const results = Array.isArray(response?.results) ? response.results : []
            const exactMatch = results.find(r => String(r.id) === target.tmdb_id && r.media_type === expectedType)
            const chosen = exactMatch ?? results.find(r => r.media_type === expectedType && !!r.backdrop_path)
            nextHero = getTmdbImageUrl(chosen?.backdrop_path, "original")
          }
        } catch { /* ignore */ }
      }

      if (!nextHero) nextHero = poster
      heroArtworkCache.set(target.id, nextHero)
      if (!cancelled) setHeroImageUrl(nextHero)
    }

    void loadArtworkAndDetails()
    return () => { cancelled = true }
  }, [activeItem, item, open])

  const castList = useMemo(() => {
    const target = activeItem ?? item
    if (!target?.cast_names || typeof target.cast_names !== "string") return []
    return target.cast_names.split(",").map(s => s.trim()).filter(Boolean).slice(0, 8)
  }, [activeItem, item])

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
    const targetItem = activeItem ?? item

    if (!open || !targetItem) {
      setTechnicalDetails(null)
      return
    }

    const technicalMediaId =
      targetItem.media_type === "tvshow"
        ? filteredEpisodes[0]?.id ?? null
        : targetItem.id

    if (!technicalMediaId) {
      setTechnicalDetails(null)
      return
    }

    const probeTarget =
      targetItem.media_type === "tvshow"
        ? filteredEpisodes[0] ?? null
        : targetItem

    const hinted = parseMediaHints(
      probeTarget?.title || probeTarget?.file_path || probeTarget?.zip_entry_path,
    )
    if (Object.keys(hinted).length > 0) {
      setTechnicalDetails((current) => ({
        ...(current ?? {}),
        ...hinted,
        sampleFromEpisode: targetItem.media_type === "tvshow" ? true : current?.sampleFromEpisode,
      }))
    }

    const cached = technicalDetailsCache.get(technicalMediaId)
    if (cached !== undefined) {
      setTechnicalDetails(
        targetItem.media_type === "tvshow" && cached
          ? { ...cached, sampleFromEpisode: true }
          : cached,
      )
      return
    }

    let cancelled = false

    const loadTechnicalDetails = async () => {
      const details = await getMediaTechnicalDetails(technicalMediaId)
      technicalDetailsCache.set(technicalMediaId, details)

      if (!cancelled) {
        setTechnicalDetails(
          targetItem.media_type === "tvshow" && details
            ? { ...details, sampleFromEpisode: true }
            : details,
        )
      }
    }

    void loadTechnicalDetails()

    return () => {
      cancelled = true
    }
  }, [activeItem, filteredEpisodes, item, open])

  useEffect(() => {
    if (!open || !item || item.media_type !== "tvshow") {
      setDetectedAudioTracks([])
      setAudioTracksLoading(false)
      setAudioTracksStatus("")
      setDetectedSubtitleTracks([])
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus("")
      return
    }

    if (filteredEpisodes.length === 0) {
      setDetectedAudioTracks([])
      setAudioTracksLoading(false)
      setAudioTracksStatus("")
      setDetectedSubtitleTracks([])
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus("")
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

  useEffect(() => {
    if (!open || !item || item.media_type !== "tvshow") {
      setDetectedSubtitleTracks([])
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus("")
      return
    }

    if (filteredEpisodes.length === 0) {
      setDetectedSubtitleTracks([])
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus("")
      return
    }

    const cachedTracks = getCachedSeriesSubtitleTracks(item.id)
    if (cachedTracks) {
      setDetectedSubtitleTracks(cachedTracks)
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus(
        selectedSeasonHasZipEpisodes
          ? "Learned from playback and updates as you watch."
          : "Detected earlier for this series.",
      )
      return
    }

    if (selectedSeasonHasZipEpisodes) {
      setDetectedSubtitleTracks([])
      setSubtitleTracksLoading(false)
      setSubtitleTracksStatus("Play one ZIP episode once. Later episodes can expand this list.")
      return
    }

    let cancelled = false

    const loadSubtitleTracks = async () => {
      setSubtitleTracksLoading(true)
      setSubtitleTracksStatus("Detecting subtitle tracks...")

      const sampleEpisode = filteredEpisodes[0]
      const tracks = await getSubtitleTracks(sampleEpisode.id)
      if (cancelled) return

      const nextTracks = [...tracks].sort((left, right) =>
        left.label.localeCompare(right.label),
      )

      setDetectedSubtitleTracks(nextTracks)
      setCachedSeriesSubtitleTracks(item.id, nextTracks)
      setSubtitleTracksStatus(
        nextTracks.length > 0
          ? `Detected once from episode ${sampleEpisode.episode_number || 1}.`
          : "No labeled subtitle tracks were found in the sampled episode.",
      )
      setSubtitleTracksLoading(false)
    }

    void loadSubtitleTracks()

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
  const showSampleMediaItem = isShow
    ? filteredEpisodes[0] ?? episodes[0] ?? null
    : null
  const mediaFormatParts = buildDisplayMediaParts(
    showSampleMediaItem ?? displayItem,
    technicalDetails,
  )

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

  const handleSubtitlePreferenceSelect = (value: string) => {
    setSelectedSubtitlePreference(value)
    if (!seriesPreferenceId) return

    setSeriesSubtitlePreference(
      seriesPreferenceId,
      resolveSubtitlePreferenceValue(
        value,
        value === CUSTOM_SUBTITLE_VALUE ? customSubtitlePreference : "",
      ),
    )
  }

  const handleCustomSubtitlePreferenceChange = (value: string) => {
    setCustomSubtitlePreference(value)
    if (!seriesPreferenceId || selectedSubtitlePreference !== CUSTOM_SUBTITLE_VALUE) return

    setSeriesSubtitlePreference(
      seriesPreferenceId,
      resolveSubtitlePreferenceValue(CUSTOM_SUBTITLE_VALUE, value),
    )
  }

  const selectedDetectedAudioTrack = detectedAudioTracks.find(
    (track) => track.mpv_value === selectedAudioPreference,
  )
  const selectedAudioSummary = selectedAudioPreference === CUSTOM_AUDIO_VALUE
    ? (customAudioPreference.trim() || "Manual")
    : selectedDetectedAudioTrack?.label || (selectedAudioPreference === AUTO_AUDIO_VALUE ? "Auto" : null)
  const selectedDetectedSubtitleTrack = detectedSubtitleTracks.find(
    (track) => track.mpv_value === selectedSubtitlePreference,
  )
  const selectedSubtitleSummary = selectedSubtitlePreference === CUSTOM_SUBTITLE_VALUE
    ? (customSubtitlePreference.trim() || "Manual")
    : selectedSubtitlePreference === OFF_SUBTITLE_VALUE
      ? "Off"
      : selectedDetectedSubtitleTrack?.label || (selectedSubtitlePreference === AUTO_SUBTITLE_VALUE ? "Auto" : null)
  const playbackControlStatus = audioTracksLoading || subtitleTracksLoading
    ? "Reading tracks..."
    : selectedSeasonHasZipEpisodes
      ? "Learns more tracks as ZIP episodes are played."
      : (audioTracksStatus || subtitleTracksStatus || "Ready for this season.")

  const audioControls = isShow ? (
    <div className="w-full overflow-hidden rounded-lg border border-white/12 bg-black/38 shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-white/48">Playback</p>
          <p className="mt-1 max-w-[260px] truncate text-[11px] font-medium text-white/36">
            {playbackControlStatus}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-semibold text-white/54">
            Season {selectedSeason}
          </span>
          <button
            type="button"
            onClick={() => setPlaybackSettingsOpen(false)}
            className="grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/8 text-white/58 transition-colors hover:bg-white/14 hover:text-white"
            aria-label="Close playback settings"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="divide-y divide-white/10">
        <div className="grid gap-2.5 px-3.5 py-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-white/58">
            <AudioLines className="h-4 w-4 text-white/58" />
            Audio
          </div>
          <div className="min-w-0 space-y-2">
            <div className="relative">
              <select
                value={selectedAudioPreference}
                onChange={(event) => handleAudioPreferenceSelect(event.target.value)}
                aria-label="Audio track"
                title={selectedAudioSummary || "Auto"}
                className="h-10 w-full appearance-none rounded-md border border-white/12 bg-white/[0.07] px-3 pr-9 text-sm font-semibold text-white outline-none transition-colors hover:border-white/24 focus:border-white/45"
              >
                <option value={AUTO_AUDIO_VALUE} className="bg-[#101114] text-white">Auto</option>
                {detectedAudioTracks.map((track) => (
                  <option
                    key={`${track.stream_index}-${track.mpv_value || track.label}`}
                    value={track.mpv_value || ""}
                    disabled={!track.mpv_value}
                    className="bg-[#101114] text-white"
                  >
                    {track.label}
                  </option>
                ))}
                <option value={MANUAL_AUDIO_OPTION.value} className="bg-[#101114] text-white">Manual</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
            </div>

            {selectedAudioPreference === CUSTOM_AUDIO_VALUE && (
              <Input
                value={customAudioPreference}
                onChange={(e) => handleCustomAudioPreferenceChange(e.target.value)}
                placeholder="Language code, e.g. hi, hin, hindi"
                className="h-9 rounded-md border-white/12 bg-white/[0.07] px-3 text-sm text-white placeholder:text-white/32"
              />
            )}
          </div>
        </div>

        <div className="grid gap-2.5 px-3.5 py-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-white/58">
            <Captions className="h-4 w-4 text-white/58" />
            Subtitles
          </div>
          <div className="min-w-0 space-y-2">
            <div className="relative">
              <select
                value={selectedSubtitlePreference}
                onChange={(event) => handleSubtitlePreferenceSelect(event.target.value)}
                aria-label="Subtitle track"
                title={selectedSubtitleSummary || "Auto"}
                className="h-10 w-full appearance-none rounded-md border border-white/12 bg-white/[0.07] px-3 pr-9 text-sm font-semibold text-white outline-none transition-colors hover:border-white/24 focus:border-white/45"
              >
                <option value={AUTO_SUBTITLE_VALUE} className="bg-[#101114] text-white">Auto</option>
                <option value={OFF_SUBTITLE_VALUE} className="bg-[#101114] text-white">Off</option>
                {detectedSubtitleTracks.map((track) => (
                  <option
                    key={`${track.stream_index}-${track.mpv_value || track.label}`}
                    value={track.mpv_value || ""}
                    disabled={!track.mpv_value}
                    className="bg-[#101114] text-white"
                  >
                    {track.label}
                  </option>
                ))}
                <option value={CUSTOM_SUBTITLE_VALUE} className="bg-[#101114] text-white">Manual</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
            </div>

            {selectedSubtitlePreference === CUSTOM_SUBTITLE_VALUE && (
              <Input
                value={customSubtitlePreference}
                onChange={(e) => handleCustomSubtitlePreferenceChange(e.target.value)}
                placeholder="Language code, e.g. eng or sid:2"
                className="h-9 rounded-md border-white/12 bg-white/[0.07] px-3 text-sm text-white placeholder:text-white/32"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  ) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPortal>
        <div
          className="fixed inset-x-0 bottom-0 top-9 z-40 bg-black/52 backdrop-blur-md"
          onClick={() => onOpenChange(false)}
        />
      </DialogPortal>
      <DialogContent
        className="max-w-[1080px] w-[96vw] max-h-[92vh] h-auto bg-[#090a0d] border-white/10 text-white p-0 overflow-hidden flex flex-col shadow-2xl [&>button]:z-[100] [&>button]:bg-black/50 [&>button]:rounded-full [&>button]:p-1.5 [&>button]:hover:bg-black/80"
      >
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
                    {mediaFormatParts.length > 0 && !isShow && (
                      <span className="flex items-center gap-2 px-3 py-1 rounded-lg bg-white/10 border border-white/10 text-white/90">
                        {technicalDetails?.sampleFromEpisode ? "Sample:" : "Media:"} {mediaFormatParts.join(" · ")}
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

                {!isShow && (
                  <div className="shrink-0 mb-2 flex flex-wrap gap-3">
                    {onSecondaryAction && secondaryActionLabel && (
                      <Button
                        onClick={() => onSecondaryAction(displayItem)}
                        variant="outline"
                        className="h-16 px-8 rounded-2xl text-base font-bold border-white/15 text-white/85 bg-white/8 hover:bg-white/14 hover:text-white"
                      >
                        <Check className="w-5 h-5 mr-3" /> {secondaryActionLabel}
                      </Button>
                    )}
                    {onDownloadAction && downloadActionLabel && displayItem.is_cloud && (
                      <Button
                        onClick={() => onDownloadAction(displayItem)}
                        variant="outline"
                        className="h-16 px-8 rounded-2xl text-base font-bold border-cyan-300/20 text-cyan-100 bg-cyan-400/10 hover:bg-cyan-400/16 hover:text-white"
                      >
                        <Download className="w-5 h-5 mr-3" /> {downloadActionLabel}
                      </Button>
                    )}
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
                <div className="flex items-center gap-3 mb-2 shrink-0">
                  <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto no-scrollbar">
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
                  
                  <div className="ml-auto flex max-w-[420px] shrink-0 flex-col items-end gap-1.5">
                    <p className="max-w-[360px] text-right text-[10px] font-medium leading-4 text-white/42">
                      Changing audio or subtitles inside MPV can cause issues. Change them here only. If tracks are missing, play 2 seconds of the first episode and quit; this list will update automatically.
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRefreshMetadata()}
                        disabled={isRefreshingMetadata || !item?.tmdb_id}
                        className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.22em] text-white/88 transition-colors hover:bg-white/15 hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <RefreshCw className={cn("w-2.5 h-2.5", isRefreshingMetadata && "animate-spin")} />
                        <span>{isRefreshingMetadata ? "Refreshing" : "Refresh Metadata"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlaybackSettingsOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-xl border border-white/10 text-[9px] font-bold uppercase tracking-[0.22em] text-white/88 transition-colors hover:bg-white/15 hover:border-white/20"
                      >
                        <span>Audio & Subtitles</span>
                        <SlidersHorizontal className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
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
                          const isWatched = isMediaMarkedWatched(ep)
                          const episodeSizeLabel = formatEpisodeSize(getPreferredEpisodeSize(ep))
                          const episodeZipCompressionLabel = ep.parent_zip_id
                            ? getZipCompressionLabel(ep.zip_compression_method)
                            : null
                          const episodeMediaParts = buildDisplayMediaParts(
                            ep,
                            selectedSeasonHasZipEpisodes ? technicalDetails : null,
                            false,
                          )
                          
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
                                {isWatched ? (
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
                                    {isWatched ? (
                                      <div className="inline-flex items-center gap-1.5 rounded-full border border-green-500/35 bg-green-500/18 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-green-300">
                                        <Check className="w-3.5 h-3.5" />
                                        Watched
                                      </div>
                                    ) : onEpisodeSecondaryAction && episodeSecondaryActionLabel ? (
                                      <button
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          void handleEpisodeMarkWatched(ep)
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-white/78 transition-colors hover:bg-white/12 hover:text-white"
                                      >
                                        <Check className="w-3.5 h-3.5" />
                                        {episodeSecondaryActionLabel}
                                      </button>
                                    ) : null}
                                    {onDownloadAction && ep.is_cloud ? (
                                      <button
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          void onDownloadAction(ep)
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/18 bg-amber-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-100 transition-colors hover:bg-amber-400/16 hover:border-amber-300/35"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                        Download
                                      </button>
                                    ) : null}
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
                                
                                {(airDate || episodeSizeLabel || episodeMediaParts.length > 0) && (
                                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-[0.15em] text-white/30">
                                    {airDate && (
                                      <span className="inline-flex items-center gap-2">
                                        <Calendar className="w-3 h-3 opacity-50" />
                                        {new Date(airDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                      </span>
                                    )}
                                    {episodeMediaParts.length > 0 && (
                                      <span className="inline-flex items-center gap-2 font-extrabold text-white/72">
                                        {airDate && <span className="text-white/18">•</span>}
                                        <span>{episodeMediaParts.join(" · ")}</span>
                                      </span>
                                    )}
                                    {episodeSizeLabel && (
                                      <span className="inline-flex items-center gap-2 font-extrabold text-white">
                                        {(airDate || episodeMediaParts.length > 0) && <span className="text-white/18">•</span>}
                                        <span>{episodeSizeLabel}</span>
                                      </span>
                                    )}
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

          {audioControls && playbackSettingsOpen && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 px-4 backdrop-blur-[3px]"
              onClick={() => setPlaybackSettingsOpen(false)}
            >
              <div
                className="w-full max-w-[430px]"
                onClick={(event) => event.stopPropagation()}
              >
                {audioControls}
              </div>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
