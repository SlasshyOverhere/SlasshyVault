import { useState, useEffect, useCallback, useRef, memo, Component, type ReactNode, type ErrorInfo } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { listen } from '@tauri-apps/api/event'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { RemoteSearchBar } from './RemoteSearchBar'
import { RemoteSearchResults } from './RemoteSearchResults'
import { RemoteMediaDetail } from './RemoteMediaDetail'
import { RemoteQualitySelector } from './RemoteQualitySelector'
import { RemoteCacheStatusBar } from './RemoteCacheStatusBar'
import { RemoteCleanupDialog } from './RemoteCleanupDialog'
import { Film, Play, X, Loader2, ArrowLeft, Check, Clock } from 'lucide-react'
import type { TmdbSearchResult, GroupedStreams, RemoteStreamData, CacheStatus } from './remote.types'
import { getYear } from './remote.types'
import { getCachedImageUrl } from '@/services/api'

interface TmdbSearchResponse { results: TmdbSearchResult[]; total_results: number }

interface PlaybackEndedEvent {
  media_id: number
  completed: boolean
  final_position: number | null
  final_duration: number | null
  media_type: 'movie' | 'tv'
  tmdb_id: number
  season_number: number | null
  episode_number: number | null
  title: string
}

type PageState = 'library' | 'search' | 'detail' | 'episodes'

function getMediaIdentifier(item: TmdbSearchResult, season?: number, episode?: number): string {
  const base = `remote-${item.id}`
  if (item.media_type === 'tv' && season != null && episode != null) {
    return `${base}-S${season}E${episode}`
  }
  return base
}

interface RemoteLibraryItem {
  id: number
  title: string
  year: number | null
  overview: string | null
  poster_path: string | null
  media_type: string
  tmdb_id: string | null
  last_watched: string | null
  resume_position_seconds: number
  duration_seconds: number
  season_number: number | null
  episode_number: number | null
  episode_title: string | null
}

function toSearchResult(item: RemoteLibraryItem): TmdbSearchResult {
  const tmdbId = item.tmdb_id ? parseInt(item.tmdb_id) : item.id
  // DB stores "tvshow"/"tvepisode"/"movie" — normalize to what the app expects
  const normalType: 'movie' | 'tv' = item.media_type === 'tvshow' || item.media_type === 'tvepisode'
    ? 'tv'
    : 'movie'
  return {
    id: Number.isFinite(tmdbId) ? tmdbId : item.id,
    title: normalType === 'movie' ? item.title : undefined,
    name: normalType === 'tv' ? item.title : undefined,
    media_type: normalType,
    poster_path: item.poster_path ?? undefined,
    overview: item.overview ?? undefined,
    release_date: item.year ? String(item.year) : undefined,
    first_air_date: item.year ? String(item.year) : undefined,
    vote_average: undefined,
  }
}

const LibraryPoster = memo(function LibraryPoster({ posterPath, alt }: { posterPath: string | null; alt: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!posterPath) { if (!cancelled) setImgUrl(null); return }
      if (posterPath.startsWith('http://') || posterPath.startsWith('https://') || posterPath.startsWith('asset://')) {
        if (!cancelled) setImgUrl(posterPath)
        return
      }
      if (posterPath.startsWith('/')) {
        if (!cancelled) setImgUrl(`https://image.tmdb.org/t/p/w185${posterPath}`)
        return
      }
      let filename = posterPath
      if (filename.startsWith('image_cache/')) filename = filename.replace('image_cache/', '')
      try {
        const url = await getCachedImageUrl(filename)
        if (!cancelled) setImgUrl(url)
      } catch (e) {
        console.warn('[RemoteSourceView] getCachedImageUrl:', e)
        if (!cancelled) setImgUrl(null)
      }
    }
    load()
    return () => { cancelled = true }
  }, [posterPath])

  const url = imgUrl && !failed ? imgUrl : null
  return url ? (
    <img src={url} alt={alt} className="w-full h-full object-cover" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-neutral-900">
      <Film className="size-5 text-neutral-700" />
    </div>
  )
})

interface ErrorBoundaryState { hasError: boolean; error: Error | null }

class RemoteSourceErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RemoteSourceView] Uncaught error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center space-y-4 p-8">
            <div className="size-16 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center mx-auto">
              <Film className="size-7 text-red-500/60" />
            </div>
            <div>
              <p className="text-sm font-semibold text-neutral-300">Something went wrong</p>
              <p className="text-[13px] text-neutral-600 mt-1 max-w-xs">
                {this.state.error?.message || 'An unexpected error occurred in the remote library.'}
              </p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-4 px-4 py-2 rounded-xl bg-neutral-900 border border-neutral-800 text-xs font-semibold text-neutral-400 hover:text-neutral-200 hover:border-neutral-700 transition-all"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function RemoteSourceViewInner() {
  const { toast } = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [remoteLibrary, setRemoteLibrary] = useState<RemoteLibraryItem[]>([])
  const [libraryLimit, setLibraryLimit] = useState(50)
  const [addonUrlConfigured, setAddonUrlConfigured] = useState<boolean | null>(null)
  const [setupAddonUrl, setSetupAddonUrl] = useState('')
  const [activeSource, setActiveSource] = useState<{ name: string; url: string } | null>(null)

  const [pageState, setPageState] = useState<PageState>('library')
  const [selectedItem, setSelectedItem] = useState<TmdbSearchResult | null>(null)
  const [selectedShow, setSelectedShow] = useState<RemoteLibraryItem | null>(null)
  const [showEpisodes, setShowEpisodes] = useState<RemoteLibraryItem[]>([])
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)

  // Stream fetching
  const [fetching, setFetching] = useState(false)
  const [groupedStreams, setGroupedStreams] = useState<GroupedStreams[]>([])
  const [streamError, setStreamError] = useState<string | null>(null)
  const [qualityOpen, setQualityOpen] = useState(false)
  // ponytail: season stream cache, keyed by "imdbId:season"
  const seasonStreamsCache = useRef<Map<string, Map<number, GroupedStreams[]>>>(new Map())

  // Current episode context (for TV)
  const [currentSeason, setCurrentSeason] = useState<number>(1)
  const [currentEpisode, setCurrentEpisode] = useState<number>(1)
  const [currentEpisodeTitle, setCurrentEpisodeTitle] = useState('')

  // Resume dialog

  // Cache
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null)
  const [showCleanup, setShowCleanup] = useState(false)
  const [lastPlayedTitle, setLastPlayedTitle] = useState('')
  const [lastCacheKey, setLastCacheKey] = useState('')


  const imdbIdRef = useRef<string>('')
  const detailReqId = useRef(0)
  const searchReqIdRef = useRef(0)

  // Next episode prompt
  const [nextEpisodePrompt, setNextEpisodePrompt] = useState<{ show: boolean; imdbId: string; season: number; episode: number; title: string }>({ show: false, imdbId: '', season: 0, episode: 0, title: '' })

  const HISTORY_KEY = 'remote-search-history'
  const MAX_HISTORY = 20

  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    } catch (e) { console.warn('[RemoteSourceView] load search history:', e); return [] }
  })

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(searchHistory))
  }, [searchHistory])

  const lastSavedRef = useRef<string>('')

  const addToHistory = useCallback((query: string) => {
    const q = query.trim()
    if (!q || q.length < 2 || q.toLowerCase() === lastSavedRef.current) return
    lastSavedRef.current = q.toLowerCase()
    setSearchHistory((prev) => {
      const filtered = prev.filter((s) => s.toLowerCase() !== q.toLowerCase())
      return [q, ...filtered].slice(0, MAX_HISTORY)
    })
  }, [])

  const clearHistory = useCallback(() => {
    setSearchHistory([])
  }, [])

  const removeFromHistory = useCallback((q: string) => {
    setSearchHistory((prev) => prev.filter((s) => s !== q))
  }, [])

  // Load remote library on mount
  const loadRemoteLibrary = useCallback(async () => {
    try {
      const items = await invoke<RemoteLibraryItem[]>('remote_get_library')
      setRemoteLibrary(items)
    } catch (e) { console.warn('[RemoteSourceView] loadRemoteLibrary:', e) }
  }, [])

  // Pre-fetch all streams for a season (tt{imdb}:{season}:full)
  const handleFetchSeasonStreams = useCallback(async (imdbId: string, season: number) => {
    const cacheKey = `${imdbId}:${season}`
    if (seasonStreamsCache.current.has(cacheKey)) return
    try {
      type SeasonEpisodeResponse = { episode: number; groupedStreams: GroupedStreams[] }
      const result = await invoke<SeasonEpisodeResponse[]>('remote_get_season_streams', { imdbId, season })
      const epMap = new Map<number, GroupedStreams[]>()
      for (const ep of result) {
        epMap.set(ep.episode, ep.groupedStreams)
      }
      seasonStreamsCache.current.set(cacheKey, epMap)
    } catch (e) {
      console.warn('[RemoteSourceView] season streams fetch failed:', e)
    }
  }, [])

  const loadShowEpisodes = useCallback(async (showId: number, tmdbId?: number) => {
    setLoadingEpisodes(true)
    try {
      // Fetch all episodes from TMDB and merge with DB progress
      if (tmdbId) {
        const dbEpisodes = await invoke<RemoteLibraryItem[]>('remote_get_episodes', { showId })
        const dbMap = new Map<string, RemoteLibraryItem>()
        for (const ep of dbEpisodes) {
          dbMap.set(`${ep.season_number}x${ep.episode_number}`, ep)
        }
        const details = await invoke<any>('get_tv_details', { tvId: tmdbId })
        const tvSeasons = (details.seasons || []).filter((s: any) => s.season_number > 0)
        const allEpisodes: RemoteLibraryItem[] = []
        for (const season of tvSeasons) {
          try {
            const seasonData = await invoke<any>('get_tv_season_episodes', { tvId: tmdbId, seasonNumber: season.season_number })
            for (const ep of (seasonData.episodes || [])) {
              const key = `${season.season_number}x${ep.episode_number}`
              const dbEp = dbMap.get(key)
              allEpisodes.push({
                id: dbEp?.id ?? 0,
                title: ep.name || '',
                year: null,
                overview: ep.overview ?? null,
                poster_path: ep.still_path ?? null,
                media_type: 'tvepisode',
                tmdb_id: String(tmdbId),
                last_watched: dbEp?.last_watched ?? null,
                resume_position_seconds: dbEp?.resume_position_seconds ?? 0,
                duration_seconds: dbEp?.duration_seconds ?? (ep.runtime ? ep.runtime * 60 : 0),
                season_number: season.season_number,
                episode_number: ep.episode_number,
                episode_title: ep.name ?? null,
              })
            }
          } catch (e) { console.warn(`[RemoteSourceView] Failed to fetch season ${season.season_number}:`, e) }
        }
        setShowEpisodes(allEpisodes)
        // Pre-fetch season streams in background for instant episode playback
        if (tmdbId) {
          const imdbId = await invoke<string | null>('resolve_imdb_id', { tmdbId, mediaType: 'tv' }).catch(() => null)
          if (imdbId) {
            for (const season of tvSeasons) {
              handleFetchSeasonStreams(imdbId, season.season_number).catch(() => {})
            }
          }
        }
      } else {
        const episodes = await invoke<RemoteLibraryItem[]>('remote_get_episodes', { showId })
        setShowEpisodes(episodes)
      }
    } catch (e) { console.warn('[RemoteSourceView] loadShowEpisodes:', e) }
    finally { setLoadingEpisodes(false) }
  }, [handleFetchSeasonStreams])

  useEffect(() => {
    loadRemoteLibrary()
  }, [loadRemoteLibrary])

  // Check if addon URL is configured AND addon server is actually running
  const checkAddonConfig = useCallback(async () => {
    try {
      const config = await invoke<any>('get_config')
      const hasSources = config?.addon_sources?.length > 0
      const hasLegacyUrl = !!config?.addon_url
      if (!hasSources && !hasLegacyUrl) {
        setAddonUrlConfigured(false)
        setActiveSource(null)
        return
      }
      if (hasSources) {
        // Sources are validated at install time — trust them
        const defaultSrc = config.addon_sources.find((s: any) => s.is_default)
        const src = defaultSrc || config.addon_sources[0]
        setActiveSource({ name: src.name, url: src.url })
        setAddonUrlConfigured(true)
      } else {
        // Manual URL — validate server is actually responding
        setActiveSource({ name: 'Addon', url: config.addon_url })
        try {
          const ok = await invoke<boolean>('check_addon_server', { url: config.addon_url })
          setAddonUrlConfigured(ok)
        } catch {
          setAddonUrlConfigured(false)
        }
      }
    } catch {
      setAddonUrlConfigured(false)
    }
  }, [])

  useEffect(() => { checkAddonConfig() }, [checkAddonConfig])

  // Re-check when config changes (e.g. source removed in Settings)
  useEffect(() => {
    const handler = () => checkAddonConfig()
    window.addEventListener('config-saved', handler)
    return () => window.removeEventListener('config-saved', handler)
  }, [checkAddonConfig])

  // Search (with race condition guard via searchReqIdRef)
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    const reqId = ++searchReqIdRef.current
    setIsSearching(true)
    setPageState('search')
    invoke<TmdbSearchResponse>('search_tmdb', { query: searchQuery })
      .then((res) => {
        if (reqId !== searchReqIdRef.current) return
        const results = res.results || []
        if (results.length > 0) addToHistory(searchQuery)
        setSearchResults(results)
      })
      .catch((e) => {
        if (reqId !== searchReqIdRef.current) return
        console.warn('[RemoteSourceView] search_tmdb:', e)
        setSearchResults([])
      })
      .finally(() => {
        if (reqId !== searchReqIdRef.current) return
        setIsSearching(false)
      })
  }, [searchQuery, addToHistory])

  // Cache progress events
  useEffect(() => {
    const unsub = listen<CacheStatus>('remote-cache-progress', (event) => {
      setCacheStatus(event.payload)
    })
    return () => { unsub.then((fn) => fn()) }
  }, [])

  // Playback complete => cleanup dialog
  useEffect(() => {
    const unsub = listen<any>('remote-cache-complete', (event) => {
      const s = event.payload as CacheStatus
      setLastCacheKey(s.cacheKey)
      setLastPlayedTitle(s.cacheKey.replace(/_.*$/, ''))
      setShowCleanup(true)
    })
    return () => { unsub.then((fn) => fn()) }
  }, [])

  // Netflix-style: listen for mpv-playback-ended for next-episode flow
  useEffect(() => {
    const unsub = listen<PlaybackEndedEvent>('mpv-playback-ended', (event) => {
      const data = event.payload
      // Refresh library to reflect updated progress
      loadRemoteLibrary()
      // Also refresh episode list if viewing episodes
      if (selectedShow) loadShowEpisodes(selectedShow.id, selectedShow.tmdb_id ? parseInt(selectedShow.tmdb_id) : undefined)
      if (data.completed && data.media_type === 'tv' && data.season_number != null && data.episode_number != null) {
        const nextEp = data.episode_number + 1
        setNextEpisodePrompt({
          show: true,
          imdbId: imdbIdRef.current,
          season: data.season_number,
          episode: nextEp,
          title: data.title,
        })
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [loadRemoteLibrary, selectedShow, loadShowEpisodes])

  const handleDismissNextEpisode = useCallback(() => {
    setNextEpisodePrompt((prev) => ({ ...prev, show: false }))
  }, [])

  const handleSelectResult = useCallback(async (item: TmdbSearchResult) => {
    setSelectedItem(item)
    setPageState('detail')
  }, [])

  // Stream verification removed — causes rate limiting against addon servers.
  // All streams are shown as available without probing.

  // Movie: fetch streams and open quality selector
  const handleFetchMovieStreams = useCallback(async (imdbId: string, forceRefresh = false) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    setCurrentSeason(1)
    setCurrentEpisode(1)
    setCurrentEpisodeTitle('')
    imdbIdRef.current = imdbId
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId, forceRefresh })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
    }
    setFetching(false)
  }, [])

  // Series episode: fetch streams and open quality selector
  const handleFetchEpisodeStreams = useCallback(async (imdbId: string, season: number, episode: number, episodeTitle: string, forceRefresh = false) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    setCurrentSeason(season)
    setCurrentEpisode(episode)
    setCurrentEpisodeTitle(episodeTitle)
    imdbIdRef.current = imdbId

    // Check season cache first
    const cacheKey = `${imdbId}:${season}`
    const cached = seasonStreamsCache.current.get(cacheKey)
    if (cached && !forceRefresh) {
      const epStreams = cached.get(episode) || []
      setGroupedStreams(epStreams)
      setFetching(false)
      return
    }

    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season, episode, forceRefresh })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
    }
    setFetching(false)
  }, [])

  // Season pack: fetch all episode streams for a season and show in quality selector
  const handleFetchSeasonPack = useCallback(async (imdbId: string, season: number) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    setCurrentSeason(season)
    imdbIdRef.current = imdbId
    try {
      type SeasonEpisodeResponse = { episode: number; groupedStreams: GroupedStreams[] }
      const result = await invoke<SeasonEpisodeResponse[]>('remote_get_season_streams', { imdbId, season })
      // Merge all episode streams into a single flat list grouped by quality
      const allStreams: GroupedStreams[] = []
      for (const ep of result) {
        for (const group of ep.groupedStreams) {
          const existing = allStreams.find(g => g.quality === group.quality)
          if (existing) {
            existing.streams.push(...group.streams)
          } else {
            allStreams.push({ ...group, streams: [...group.streams] })
          }
        }
      }
      setGroupedStreams(allStreams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load season pack')
    }
    setFetching(false)
  }, [])

  const handlePlayNextEpisode = useCallback(() => {
    const prompt = nextEpisodePrompt
    setNextEpisodePrompt({ show: false, imdbId: '', season: 0, episode: 0, title: '' })
    if (!prompt.imdbId) return
    handleFetchEpisodeStreams(prompt.imdbId, prompt.season, prompt.episode, '')
  }, [nextEpisodePrompt, handleFetchEpisodeStreams])

  const launchPlayback = useCallback(async (
    stream: RemoteStreamData,
    identifier: string,
    startPosition: number,
    item: TmdbSearchResult,
    season: number,
    episode: number,
    episodeTitle: string,
  ) => {
    try {
      const year = item.release_date || item.first_air_date || ''
      const showName = item.title || item.name || stream.name || 'Unknown'
      const displayTitle = item.media_type === 'tv' && episodeTitle
        ? `${showName} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${episodeTitle}`
        : showName
      
      await invoke<any>('remote_play_with_mpv', {
        url: stream.url,
        title: displayTitle,
        videoSize: stream.videoSize,
        mediaIdentifier: identifier,
        qualityLabel: stream.parsedQuality,
        mediaType: item.media_type,
        tmdbId: item.id,
        seasonNumber: item.media_type === 'tv' ? season : null,
        episodeNumber: item.media_type === 'tv' ? episode : null,
        episodeTitle: item.media_type === 'tv' ? episodeTitle : null,
        posterPath: item.poster_path || null,
        stillPath: null,
        overview: item.overview || null,
        year: getYear(year) ? parseInt(getYear(year)) : null,
        startPosition,
      })

      // Refresh library to pick up the new record
      loadRemoteLibrary()

      toast({ title: 'Playback started', description: `${episodeTitle || item.title || item.name} -- ${stream.parsedQuality}` })
    } catch (e: any) {
      toast({
        title: 'Playback failed',
        description: typeof e === 'string' ? e : 'Failed to launch player',
        variant: 'destructive',
      })
    }
  }, [toast, loadRemoteLibrary])

  // User selects a quality => check resume, maybe show dialog, then play
  const isInLibrary = useCallback((item: TmdbSearchResult) => {
    const tmdbId = String(item.id)
    return remoteLibrary.some(lib => lib.tmdb_id === tmdbId && lib.media_type === (item.media_type === 'tv' ? 'tvshow' : 'movie'))
  }, [remoteLibrary])

  const handleQualitySelect = useCallback(async (stream: RemoteStreamData) => {
    if (!selectedItem) return
    const identifier = getMediaIdentifier(selectedItem, currentSeason, currentEpisode)
    setQualityOpen(false)
    // Auto-add to library if not already there
    if (!isInLibrary(selectedItem)) {
      try {
        await invoke('remote_add_to_library', {
          tmdbId: String(selectedItem.id),
          title: selectedItem.title || selectedItem.name || '',
          mediaType: selectedItem.media_type === 'tv' ? 'tv' : 'movie',
          year: getYear(selectedItem.release_date || selectedItem.first_air_date) ? parseInt(getYear(selectedItem.release_date || selectedItem.first_air_date)) : null,
          posterPath: selectedItem.poster_path || null,
          overview: selectedItem.overview || null,
        })
        await loadRemoteLibrary()
      } catch (e) { console.warn('[RemoteSourceView] auto-add to library:', e) }
    }
    launchPlayback(stream, identifier, 0, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback, isInLibrary, loadRemoteLibrary])

  const handleCleanup = useCallback(async () => {
    try {
      await invoke('remote_cleanup_cache', { cacheKey: lastCacheKey })
      setCacheStatus(null)
      toast({ title: 'Cache cleaned', description: 'Cached file has been removed.' })
    } catch (e: any) {
      toast({ title: 'Cleanup failed', description: typeof e === 'string' ? e : 'Failed to clean cache', variant: 'destructive' })
    }
  }, [lastCacheKey, toast])

  const handleKeep = useCallback(() => {
    setCacheStatus(null)
    toast({ title: 'Kept', description: 'File will be auto-cleaned based on cache settings.' })
  }, [toast])

  const handleRemoveFromLibrary = useCallback(async (item: RemoteLibraryItem, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await invoke('remote_remove_from_library', { mediaId: item.id })
      setRemoteLibrary((prev) => prev.filter((i) => i.id !== item.id))
      toast({ title: 'Removed', description: `${item.title} removed from library.` })
    } catch (err: any) {
      toast({ title: 'Remove failed', description: typeof err === 'string' ? err : 'Failed to remove', variant: 'destructive' })
    }
  }, [toast])

  const handleLibraryCardClick = useCallback(async (item: RemoteLibraryItem) => {
    // For TV shows, open episode browser instead of detail view
    if (item.media_type === 'tvshow') {
      setSelectedShow(item)
      setShowEpisodes([])
      setPageState('episodes')
      setShowCleanup(false)
      loadShowEpisodes(item.id, item.tmdb_id ? parseInt(item.tmdb_id) : undefined)
      return
    }

    const reqId = ++detailReqId.current
    const searchItem = toSearchResult(item)

    // Navigate immediately so the user sees feedback right away
    setSelectedItem(searchItem)
    setPageState('detail')
    setShowCleanup(false) // Dismiss cleanup dialog if open

    // Fetch fresh TMDB details in the background to enrich poster/backdrop
    try {
      if (item.media_type === 'movie') {
        const details = await invoke<any>('get_movie_details', { movieId: searchItem.id })
        if (reqId !== detailReqId.current) return
        if (details.poster_path) {
          setSelectedItem((prev) => prev ? { ...prev, poster_path: details.poster_path } : prev)
          invoke('remote_update_poster', { tmdbId: searchItem.id, posterPath: details.poster_path }).catch((e) => console.warn('[RemoteSourceView] remote_update_poster:', e))
        }
        if (details.backdrop_path) {
          setSelectedItem((prev) => prev ? { ...prev, backdrop_path: details.backdrop_path } as TmdbSearchResult : prev)
        }
        if (details.imdb_id) {
          setSelectedItem((prev) => prev ? { ...prev, imdb_id: details.imdb_id } as TmdbSearchResult : prev)
        }
      } else {
        const [details, extIds] = await Promise.all([
          invoke<any>('get_tv_details', { tvId: searchItem.id }),
          invoke<any>('get_imdb_details', { imdbId: null, tmdbId: searchItem.id, mediaType: 'tv' }).catch((e) => { console.warn('[RemoteSourceView] get_imdb_details:', e); return null }),
        ])
        if (reqId !== detailReqId.current) return
        if (details.poster_path) {
          setSelectedItem((prev) => prev ? { ...prev, poster_path: details.poster_path } : prev)
          invoke('remote_update_poster', { tmdbId: searchItem.id, posterPath: details.poster_path }).catch((e) => console.warn('[RemoteSourceView] remote_update_poster:', e))
        }
        if (details.backdrop_path) {
          setSelectedItem((prev) => prev ? { ...prev, backdrop_path: details.backdrop_path } : prev)
        }
        if (extIds?.imdb_id) {
          setSelectedItem((prev) => prev ? { ...prev, imdb_id: extIds.imdb_id } : prev)
        }
      }
    } catch (e) { console.warn('[RemoteSourceView] handleLibraryCardClick TMDB details:', e) }
    if (reqId !== detailReqId.current) return
    loadRemoteLibrary()
  }, [loadRemoteLibrary])

  const handleBackFromEpisodes = useCallback(() => {
    setSelectedShow(null)
    setShowEpisodes([])
    setPageState('library')
  }, [])

  const handleEpisodeClick = useCallback(async (episode: RemoteLibraryItem) => {
    if (!selectedShow) return
    const showSearchItem = toSearchResult(selectedShow)
    // Set episode context
    if (episode.season_number != null) setCurrentSeason(episode.season_number)
    if (episode.episode_number != null) setCurrentEpisode(episode.episode_number)
    if (episode.episode_title) setCurrentEpisodeTitle(episode.episode_title)
    setSelectedItem(showSearchItem)
    setPageState('detail')
    // Fetch streams in background
    const imdbId = showSearchItem.imdb_id
    if (imdbId) {
      try {
        const streams = await invoke<GroupedStreams[]>('remote_get_series_streams', {
          imdbId,
          season: episode.season_number ?? 1,
          episode: episode.episode_number ?? 1,
          forceRefresh: false,
        })
        const flat = streams.flatMap((g) => g.streams)
        if (flat.length > 0) {
        }
      } catch (e) { console.warn('[RemoteSourceView] handleEpisodeClick fetch streams:', e) }
    }
  }, [selectedShow])

  const handleBackToLibrary = useCallback(() => {
    setSelectedItem(null)
    setSelectedShow(null)
    setShowEpisodes([])
    setGroupedStreams([])
    setStreamError(null)
    setQualityOpen(false)
    setPageState(searchQuery ? 'search' : 'library')
  }, [searchQuery])

  // Check if a TMDB item is already in the library

  // Add content to library without playing
  const [addingToLibrary, setAddingToLibrary] = useState(false)
  const handleAddToLibrary = useCallback(async () => {
    if (!selectedItem || addingToLibrary) return
    setAddingToLibrary(true)
    try {
      await invoke('remote_add_to_library', {
        tmdbId: String(selectedItem.id),
        title: selectedItem.title || selectedItem.name || '',
        mediaType: selectedItem.media_type === 'tv' ? 'tv' : 'movie',
        year: getYear(selectedItem.release_date || selectedItem.first_air_date) ? parseInt(getYear(selectedItem.release_date || selectedItem.first_air_date)) : null,
        posterPath: selectedItem.poster_path || null,
        overview: selectedItem.overview || null,
      })
      await loadRemoteLibrary()
      toast({ title: 'Added to library' })
    } catch (e: any) {
      toast({ title: 'Failed to add', description: typeof e === 'string' ? e : 'Could not add to library', variant: 'destructive' })
    } finally {
      setAddingToLibrary(false)
    }
  }, [selectedItem, addingToLibrary, loadRemoteLibrary, toast])

  // Save addon URL from setup wizard (uses new add_addon_source command)
  const handleSaveAddonUrl = useCallback(async () => {
    const url = setupAddonUrl.trim()
    if (!url) return
    try {
      await invoke('add_addon_source', { name: 'Default', url })
      setAddonUrlConfigured(true)
      loadRemoteLibrary()
      window.dispatchEvent(new CustomEvent('config-saved'))
      toast({ title: 'Source added', description: 'You can now stream content from the External tab.' })
    } catch (e: any) {
      toast({ title: 'Failed to save', description: e?.message || 'Could not save addon URL.', variant: 'destructive' })
    }
  }, [setupAddonUrl, loadRemoteLibrary, toast])

  // npm install handler
  const [npmPackage, setNpmPackage] = useState('')
  const [npmArgs, setNpmArgs] = useState('--yes')
  const [npmInstalling, setNpmInstalling] = useState(false)
  const [binaryInstalling, setBinaryInstalling] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Binary install handler (Go binary drag-and-drop)
  const handleBinaryInstall = useCallback(async (filePath: string) => {
    setBinaryInstalling(true)
    try {
      const result = await invoke<any>('install_addon_binary', { filePath, name: 'Custom Addon Binary' })
      setAddonUrlConfigured(true)
      loadRemoteLibrary()
      window.dispatchEvent(new CustomEvent('config-saved'))
      toast({ title: 'Binary installed', description: `Addon binary installed and running at ${result.url}` })
    } catch (e: any) {
      toast({ title: 'Installation failed', description: e?.message || String(e), variant: 'destructive' })
    } finally {
      setBinaryInstalling(false)
    }
  }, [loadRemoteLibrary, toast])

  // npm package install handler
  const handleNpmInstall = useCallback(async () => {
    if (!npmPackage.trim()) return
    setNpmInstalling(true)
    try {
      const args = npmArgs.trim() ? npmArgs.trim().split(/\s+/) : []
      const result = await invoke<any>('install_npm_addon', { package: npmPackage.trim(), args })
      setAddonUrlConfigured(true)
      loadRemoteLibrary()
      window.dispatchEvent(new CustomEvent('config-saved'))
      toast({ title: 'Addon installed & running', description: `Connected to ${result.url}` })
    } catch (e: any) {
      toast({ title: 'Installation failed', description: e?.message || String(e), variant: 'destructive' })
    } finally {
      setNpmInstalling(false)
    }
  }, [npmPackage, npmArgs, loadRemoteLibrary, toast])

  // Show setup wizard if addon URL is not configured
  if (addonUrlConfigured === false) {
    return (
      <div className="h-full flex flex-col relative">
        <div className="pointer-events-none absolute -top-40 -right-40 size-[600px] rounded-full bg-amber-500/3 blur-[120px]" />
        <div className="pointer-events-none absolute -bottom-40 -left-40 size-[500px] rounded-full bg-sky-500/2 blur-[120px]" />
        <div className="flex-1 flex items-center justify-center relative z-10">
          <div className="max-w-md w-full space-y-6 p-8">
            <div className="space-y-2 text-center">
              <div className="mx-auto size-16 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center">
                <Film className="size-8 text-neutral-500" />
              </div>
              <h2 className="text-2xl font-bold text-neutral-100">No addon configured</h2>
              <p className="text-sm text-neutral-500">
                To stream content, you need to add your SlasshyVault addon URL.
              </p>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={npmPackage}
                onChange={(e) => setNpmPackage(e.target.value)}
                placeholder="npm package name"
                className="w-full h-12 px-4 text-sm bg-[#0A0A0A] border border-neutral-800 rounded-xl text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-amber-700/50 focus:ring-1 focus:ring-amber-700/30"
              />
              <input
                type="text"
                value={npmArgs}
                onChange={(e) => setNpmArgs(e.target.value)}
                placeholder="arguments (e.g. --yes)"
                className="w-full h-12 px-4 text-sm bg-[#0A0A0A] border border-neutral-800 rounded-xl text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-amber-700/50 focus:ring-1 focus:ring-amber-700/30"
                onKeyDown={(e) => { if (e.key === 'Enter') handleNpmInstall() }}
              />
              <button
                onClick={handleNpmInstall}
                disabled={!npmPackage.trim() || npmInstalling}
                className="w-full h-11 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2"
              >
                {npmInstalling ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Installing & starting...
                  </>
                ) : (
                  "Install & Run"
                )}
              </button>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-neutral-800" />
                <span className="text-xs text-neutral-600">or use a binary</span>
                <div className="flex-1 h-px bg-neutral-800" />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".exe"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    // Tauri file input gives us the full path via webkitRelativePath or tauri://file-drop
                    // Use the file name to construct path — Tauri's file dialog returns full paths
                    const path = (file as any).path || file.name
                    handleBinaryInstall(path)
                  }
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={binaryInstalling}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const file = e.dataTransfer.files[0]
                  if (file) {
                    const path = (file as any).path || file.name
                    handleBinaryInstall(path)
                  }
                }}
                className="w-full h-16 rounded-xl border-2 border-dashed border-neutral-700 hover:border-neutral-500 disabled:opacity-40 disabled:cursor-not-allowed bg-white/[0.02] hover:bg-white/[0.04] text-neutral-400 hover:text-neutral-200 text-sm transition-all duration-200 flex flex-col items-center justify-center gap-1"
              >
                {binaryInstalling ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Installing binary...
                  </>
                ) : (
                  <>
                    <span className="text-xs">Drop addon binary here or click to browse</span>
                    <span className="text-[10px] text-neutral-600">.exe file — no console window</span>
                  </>
                )}
              </button>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-neutral-800" />
                <span className="text-xs text-neutral-600">or add URL manually</span>
                <div className="flex-1 h-px bg-neutral-800" />
              </div>
              <input
                type="url"
                value={setupAddonUrl}
                onChange={(e) => setSetupAddonUrl(e.target.value)}
                placeholder="https://your-addon-url.com"
                className="w-full h-12 px-4 text-sm bg-[#0A0A0A] border border-neutral-800 rounded-xl text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-amber-700/50 focus:ring-1 focus:ring-amber-700/30"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAddonUrl() }}
              />
              <button
                onClick={handleSaveAddonUrl}
                disabled={!setupAddonUrl.trim()}
                className="w-full h-11 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm transition-all duration-200"
              >
                Save & Start Streaming
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Loading state while checking config
  if (addonUrlConfigured === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="size-10 rounded-full border-2 border-neutral-800 border-t-amber-700/40 animate-spin" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute -top-40 -right-40 size-[600px] rounded-full bg-amber-500/3 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -left-40 size-[500px] rounded-full bg-sky-500/2 blur-[120px]" />

      {pageState === 'episodes' && selectedShow ? (
        /* ── Episode browser ── */
        <ScrollArea className="flex-1 px-8 pb-8 pt-10 relative z-10">
          <div className="max-w-4xl mx-auto">
            <button
              onClick={handleBackFromEpisodes}
              className="flex items-center gap-2 text-xs text-neutral-500 hover:text-neutral-200 transition-colors mb-6"
            >
              <ArrowLeft className="size-3.5" />
              Back to Library
            </button>
            <div className="flex gap-6 mb-8">
              <div className="w-32 shrink-0">
                <div className="aspect-[2/3] rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800/60">
                  <LibraryPoster posterPath={selectedShow.poster_path} alt={selectedShow.title} />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-black text-white tracking-tight">{selectedShow.title}</h2>
                {selectedShow.year && <p className="text-sm text-neutral-500 mt-1">{selectedShow.year}</p>}
                <p className="text-xs text-neutral-600 mt-2">{loadingEpisodes ? 'Loading episodes...' : `${showEpisodes.length} episode${showEpisodes.length !== 1 ? 's' : ''}`}</p>
              </div>
            </div>
            {showEpisodes.length === 0 ? (
              <p className="text-sm text-neutral-600 text-center py-12">No episodes yet</p>
            ) : loadingEpisodes ? (
              <div className="flex items-center justify-center py-12">
                <div className="size-8 rounded-full border-2 border-neutral-800 border-t-amber-700/40 animate-spin" />
              </div>
            ) : (
              (() => {
                const grouped: Record<number, RemoteLibraryItem[]> = {}
                for (const ep of showEpisodes) {
                  const s = ep.season_number ?? 0
                  if (!grouped[s]) grouped[s] = []
                  grouped[s].push(ep)
                }
                const seasons = Object.keys(grouped).map(Number).sort((a, b) => a - b)
                return seasons.map((seasonNum) => (
                  <div key={seasonNum} className="mb-6">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-neutral-500 mb-3">
                      Season {seasonNum}
                    </h3>
                    <div className="space-y-2">
                      {grouped[seasonNum].map((ep) => {
                        const progress = ep.duration_seconds > 0 ? Math.min(100, (ep.resume_position_seconds / ep.duration_seconds) * 100) : 0
                        const isCompleted = progress >= 90
                        const inProgress = ep.resume_position_seconds > 0 && !isCompleted
                        const stillUrl = ep.poster_path
                          ? ep.poster_path.startsWith('http') ? ep.poster_path
                          : ep.poster_path.startsWith('/') ? `https://image.tmdb.org/t/p/w185${ep.poster_path}`
                          : null : null
                        return (
                          <button
                            key={ep.id}
                            onClick={() => handleEpisodeClick(ep)}
                            className="w-full flex flex-col sm:flex-row gap-4 p-4 rounded-2xl bg-[#0A0A0A] border border-neutral-800/80 hover:bg-[#0D0D0D] hover:border-neutral-700/50 transition-all text-left group"
                          >
                            <div className="shrink-0 w-full sm:w-44 aspect-video rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800">
                              {stillUrl ? (
                                <img src={stillUrl} alt={ep.episode_title || ''} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center"><Film className="size-5 text-neutral-400" /></div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-bold text-neutral-400 tabular-nums shrink-0">
                                  S{String(seasonNum).padStart(2, '0')} &middot; E{String(ep.episode_number ?? 0).padStart(2, '0')}
                                </span>
                                <h3 className={`text-sm font-semibold truncate ${isCompleted ? 'text-neutral-500' : 'text-neutral-200'}`}>
                                  {ep.episode_title || `Episode ${ep.episode_number}`}
                                </h3>
                                {isCompleted && <Check className="size-3.5 text-emerald-500 shrink-0" />}
                                {inProgress && <Clock className="size-3.5 text-amber-500 shrink-0" />}
                              </div>
                              {ep.overview && (
                                <p className="text-xs text-neutral-300 leading-relaxed line-clamp-2">{ep.overview}</p>
                              )}
                              <div className="flex items-center gap-3 mt-0.5">
                                {ep.duration_seconds > 0 && (
                                  <span className="text-[10px] text-neutral-600">{Math.floor(ep.duration_seconds / 60)}m</span>
                                )}
                                {inProgress && (
                                  <div className="flex-1 max-w-32 h-1 rounded-full bg-neutral-800 overflow-hidden">
                                    <div className="h-full bg-amber-500/70 rounded-full" style={{ width: `${progress}%` }} />
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center">
                              <div className="size-10 flex items-center justify-center rounded-xl bg-white/10 border border-white/15 text-neutral-200 hover:bg-white/20 hover:text-white hover:border-white/25 transition-all opacity-0 group-hover:opacity-100">
                                <Play className="size-4 fill-current" />
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))
              })()
            )}
          </div>
        </ScrollArea>
      ) : pageState === 'detail' ? (
        /* ── Detail view ── */
        <ScrollArea className="flex-1 px-8 pb-8 pt-10 relative z-10">
          <div className="max-w-4xl mx-auto">
            <RemoteMediaDetail
              item={selectedItem!}
              imdbId={(selectedItem as any).imdb_id}
              onBack={handleBackToLibrary}
              onFetchMovieStreams={handleFetchMovieStreams}
              onFetchEpisodeStreams={handleFetchEpisodeStreams}
              onFetchSeasonStreams={handleFetchSeasonStreams}
              onFetchSeasonPack={handleFetchSeasonPack}
              fetching={fetching}
              isInLibrary={isInLibrary(selectedItem!)}
              onAddToLibrary={handleAddToLibrary}
              addingToLibrary={addingToLibrary}
            />
          </div>
        </ScrollArea>
      ) : (
        /* ── Library + Search view ── */
        <div className="flex-1 flex flex-col relative z-10">
          {/* Header */}
          <div className="shrink-0 pt-16 pb-6 px-8 text-center">
            <div className="max-w-lg mx-auto space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-center gap-3 text-[10px] font-semibold text-neutral-600 uppercase tracking-[0.15em]">
                  <span className="h-px w-6 bg-neutral-800" />
                  <span>External Sources</span>
                  <span className="h-px w-6 bg-neutral-800" />
                </div>
                {activeSource && (
                  <div className="flex items-center justify-center gap-2">
                    <div className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs text-neutral-400">{activeSource.name}</span>
                    <span className="text-[10px] text-neutral-600 truncate max-w-[200px]">{activeSource.url}</span>
                  </div>
                )}
                <h1 className="text-3xl font-black tracking-tight text-white leading-none">Stream fuckin anything.</h1>
                <p className="text-[10px] text-neutral-700 leading-relaxed max-w-md mx-auto">
                  All media sources are third-party. We do not host, store, or control any content.
                </p>
              </div>
              <RemoteSearchBar value={searchQuery} onChange={setSearchQuery} />
              {!searchQuery && searchHistory.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {searchHistory.slice(0, 10).map((q) => (
                    <span
                      key={q}
                      className="group/chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-neutral-900/80 border border-neutral-800/60 text-[11px] text-neutral-500"
                    >
                      <button onClick={() => setSearchQuery(q)} className="hover:text-neutral-200 transition-colors">
                        {q}
                      </button>
                      <button
                        onClick={() => removeFromHistory(q)}
                        className="text-neutral-700 hover:text-red-400 transition-colors leading-none"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    onClick={clearHistory}
                    className="px-2 py-0.5 rounded-md text-[11px] text-neutral-600 hover:text-red-400 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Library cards - shown when no search query */}
          {!searchQuery && remoteLibrary.length > 0 && (
            <div className="px-8 pb-4">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-neutral-600 mb-4">My Library</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-2.5">
                {remoteLibrary.slice(0, libraryLimit).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleLibraryCardClick(item)}
                    className="group text-left focus:outline-none"
                  >
                    <div className="aspect-[2/3] rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800/60 group-hover:border-amber-700/40 transition-all duration-300 relative">
                      <LibraryPoster posterPath={item.poster_path} alt={item.title} />
                      {/* Media type badge */}
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider bg-black/60 text-neutral-400">
                        {item.media_type === 'movie' ? 'Movie' : 'Series'}
                      </div>
                      {/* Resume progress bar */}
                      {item.resume_position_seconds > 0 && item.duration_seconds > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-neutral-800">
                          <div
                            className="h-full bg-amber-500/70 transition-all"
                            style={{ width: `${Math.min(100, (item.resume_position_seconds / item.duration_seconds) * 100)}%` }}
                          />
                        </div>
                      )}
                      {/* Delete button on hover */}
                      <button
                        onClick={(e) => handleRemoveFromLibrary(item, e)}
                        className="absolute top-1 right-1 size-5 rounded-full bg-black/70 text-neutral-400 hover:text-red-400 hover:bg-black/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-10"
                        title="Remove from library"
                      >
                        <X className="size-3" />
                      </button>
                      {/* Play/Browse overlay on hover */}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-300 flex items-center justify-center">
                        <div className="size-8 rounded-full bg-amber-600/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
                          {item.media_type === 'tvshow' ? (
                            <Film className="size-3.5" />
                          ) : (
                            <Play className="size-3.5 fill-white ml-0.5" />
                          )}
                        </div>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] font-semibold text-neutral-300 truncate leading-tight">
                      {item.title}
                    </p>
                    {item.year && (
                      <p className="text-[10px] text-neutral-600">{item.year}</p>
                    )}
                  </button>
                ))}
              </div>
              {remoteLibrary.length > libraryLimit && (
                <div className="flex justify-center mt-4">
                  <button
                    onClick={() => setLibraryLimit((prev) => prev + 50)}
                    className="px-4 py-2 rounded-xl bg-neutral-900 border border-neutral-800 text-xs font-semibold text-neutral-400 hover:text-neutral-200 hover:border-neutral-700 transition-all"
                  >
                    Load More ({remoteLibrary.length - libraryLimit} remaining)
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Empty library */}
          {!searchQuery && remoteLibrary.length === 0 && (
            <div className="flex-1 flex items-center justify-center px-8">
              <div className="text-center space-y-4">
                <div className="size-16 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center mx-auto">
                  <Film className="size-7 text-neutral-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-neutral-300">No content yet</p>
                  <p className="text-[13px] text-neutral-600 mt-1 max-w-xs">
                    Search for a movie or TV show above to start streaming
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Search results */}
          {searchQuery && (
            <ScrollArea className="flex-1 min-h-0 px-8 pb-8">
              <div className="max-w-lg mx-auto">
                {/* Merge library items that match search into results */}
                <RemoteSearchResults results={searchResults} isLoading={isSearching} onSelect={handleSelectResult} />
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      <RemoteQualitySelector
        open={qualityOpen}
        onOpenChange={setQualityOpen}
        title={selectedItem?.title || selectedItem?.name || 'Unknown'}
        groupedStreams={groupedStreams}
        onSelect={handleQualitySelect}
        onOpenUrl={(url) => window.open(url, '_blank')}
        loading={fetching}
        error={streamError}
        verifying={false}
        streamStatus={{}}
        addonContext={imdbIdRef.current && currentSeason ? { imdbId: imdbIdRef.current, season: currentSeason } : null}
      />


      {/* Next Episode Prompt */}
      {nextEpisodePrompt.show && selectedItem && (
        <div className="fixed bottom-8 right-8 z-50 bg-[#0A0A0A] border border-neutral-800 rounded-2xl p-5 shadow-2xl max-w-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-500 mb-1">Up Next</p>
          <p className="text-sm font-semibold text-neutral-200 mb-3">
            {selectedItem.title || selectedItem.name}
            {' '}
            <span className="text-amber-400">S{nextEpisodePrompt.season}E{nextEpisodePrompt.episode}</span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={handlePlayNextEpisode}
              className="px-4 py-2 rounded-xl bg-amber-600/15 text-amber-400 border border-amber-700/30 text-xs font-semibold uppercase tracking-wider hover:bg-amber-600/25 transition-all"
            >
              Play Next Episode
            </button>
            <button
              onClick={handleDismissNextEpisode}
              className="px-4 py-2 rounded-xl bg-[#0D0D0D] text-neutral-500 border border-neutral-800 text-xs font-semibold uppercase tracking-wider hover:bg-neutral-900 hover:text-neutral-300 transition-all"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <RemoteCacheStatusBar status={cacheStatus} />
      <RemoteCleanupDialog open={showCleanup} onOpenChange={setShowCleanup} title={lastPlayedTitle} onCleanup={handleCleanup} onKeep={handleKeep} />
    </div>
  )
}

export default function RemoteSourceViewExport() {
  return (
    <RemoteSourceErrorBoundary>
      <RemoteSourceViewInner />
    </RemoteSourceErrorBoundary>
  )
}

export { RemoteSourceViewExport as RemoteSourceView }
