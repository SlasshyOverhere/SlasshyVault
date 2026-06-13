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
import { ResumeDialog } from '@/components/ResumeDialog'
import { Film, Play, X } from 'lucide-react'
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

interface ResumeDialogState {
  open: boolean
  mediaId: number
  title: string
  position: number
  duration: number
}

type PageState = 'library' | 'search' | 'detail'

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
  return {
    id: Number.isFinite(tmdbId) ? tmdbId : item.id,
    title: item.media_type === 'movie' ? item.title : undefined,
    name: item.media_type === 'tv' ? item.title : undefined,
    media_type: item.media_type as 'movie' | 'tv',
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

  const [pageState, setPageState] = useState<PageState>('library')
  const [selectedItem, setSelectedItem] = useState<TmdbSearchResult | null>(null)

  // Stream fetching
  const [fetching, setFetching] = useState(false)
  const [groupedStreams, setGroupedStreams] = useState<GroupedStreams[]>([])
  const [streamError, setStreamError] = useState<string | null>(null)
  const [qualityOpen, setQualityOpen] = useState(false)

  // Current episode context (for TV)
  const [currentSeason, setCurrentSeason] = useState<number>(1)
  const [currentEpisode, setCurrentEpisode] = useState<number>(1)
  const [currentEpisodeTitle, setCurrentEpisodeTitle] = useState('')

  // Resume dialog
  const [resumeDialog, setResumeDialog] = useState<ResumeDialogState>({ open: false, mediaId: 0, title: '', position: 0, duration: 0 })
  const pendingStreamRef = useRef<{ stream: RemoteStreamData; identifier: string; startPosition: number; mediaId?: number } | null>(null)
  const pendingFetchedStreamsRef = useRef<RemoteStreamData[] | null>(null)

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

  useEffect(() => {
    loadRemoteLibrary()
  }, [loadRemoteLibrary])

  // Check if addon URL is configured
  useEffect(() => {
    invoke<string | null>('get_config')
      .then((config: any) => {
        setAddonUrlConfigured(!!config?.addon_url)
      })
      .catch(() => setAddonUrlConfigured(false))
  }, [])

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
  }, [loadRemoteLibrary])

  const handleDismissNextEpisode = useCallback(() => {
    setNextEpisodePrompt((prev) => ({ ...prev, show: false }))
  }, [])

  const handleSelectResult = useCallback(async (item: TmdbSearchResult) => {
    setSelectedItem(item)
    setPageState('detail')
    // Check for existing resume progress when selecting from search results
    try {
      const resumeInfo = await invoke<any>('remote_get_resume_info', {
        tmdbId: item.id,
        mediaType: item.media_type,
        seasonNumber: item.media_type === 'tv' ? currentSeason : null,
        episodeNumber: item.media_type === 'tv' ? currentEpisode : null,
      })
      if (resumeInfo.has_resume) {
        const identifier = getMediaIdentifier(item, currentSeason, currentEpisode)
        setResumeDialog({
          open: true,
          mediaId: resumeInfo.media_id,
          title: item.title || item.name || 'Unknown',
          position: resumeInfo.position,
          duration: resumeInfo.duration,
        })
        pendingStreamRef.current = { stream: null as any, identifier, startPosition: resumeInfo.position, mediaId: resumeInfo.media_id }
        // Fetch streams in background
        const imdbId = item.imdb_id
        if (imdbId) {
          try {
            const isTv = item.media_type === 'tv'
            const streams = isTv
              ? await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season: currentSeason, episode: currentEpisode, forceRefresh: false })
              : await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId, forceRefresh: false })
            const flat = streams.flatMap((g) => g.streams)
            if (flat.length > 0) {
              pendingFetchedStreamsRef.current = flat
              if (pendingStreamRef.current) {
                pendingStreamRef.current.stream = flat[0]
              }
            }
          } catch (e) { console.warn('[RemoteSourceView] handleSelectResult fetch streams:', e) }
        }
      }
    } catch (e) { console.warn('[RemoteSourceView] handleSelectResult resume check:', e) }
  }, [currentSeason, currentEpisode])

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
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season, episode, forceRefresh })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
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
  const handleQualitySelect = useCallback(async (stream: RemoteStreamData) => {
    if (!selectedItem) return
    const identifier = getMediaIdentifier(selectedItem, currentSeason, currentEpisode)
    setQualityOpen(false)

    // Check if there's existing resume progress for this content
    try {
      const resumeInfo = await invoke<any>('remote_get_resume_info', {
        tmdbId: selectedItem.id,
        mediaType: selectedItem.media_type,
        seasonNumber: selectedItem.media_type === 'tv' ? currentSeason : null,
        episodeNumber: selectedItem.media_type === 'tv' ? currentEpisode : null,
      })
      if (resumeInfo.has_resume) {
        setResumeDialog({
          open: true,
          mediaId: resumeInfo.media_id,
          title: selectedItem.title || selectedItem.name || 'Unknown',
          position: resumeInfo.position,
          duration: resumeInfo.duration,
        })
        pendingStreamRef.current = { stream, identifier, startPosition: resumeInfo.position, mediaId: resumeInfo.media_id }
        return
      }
    } catch (e) {
      console.warn('[RemoteSourceView] handleQualitySelect resume check:', e)
    }

    launchPlayback(stream, identifier, 0, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback, toast])

  // Helper to get a stream for resume — uses cached streams or fetches on demand
  const getStreamForResume = useCallback(async (item: TmdbSearchResult): Promise<RemoteStreamData | null> => {
    // Check already-fetched streams first
    if (pendingFetchedStreamsRef.current && pendingFetchedStreamsRef.current.length > 0) {
      return pendingFetchedStreamsRef.current[0]
    }
    // Fetch streams on demand
    try {
      const imdbId = item.imdb_id
      if (!imdbId) return null
      const isTv = item.media_type === 'tv'
      const streams = isTv
        ? await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season: currentSeason, episode: currentEpisode, forceRefresh: false })
        : await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId, forceRefresh: false })
      const flat = streams.flatMap((g) => g.streams)
      return flat.length > 0 ? flat[0] : null
    } catch (e) { console.warn('[RemoteSourceView] getStreamForResume:', e); return null }
  }, [currentSeason, currentEpisode])

  // Resume dialog handlers
  const handleResume = useCallback(async () => {
    const pending = pendingStreamRef.current
    if (!pending || !selectedItem) return
    setResumeDialog((prev) => ({ ...prev, open: false }))

    let stream: RemoteStreamData | null = pending.stream
    if (!stream) {
      stream = await getStreamForResume(selectedItem)
      if (!stream) {
        toast({ title: 'No streams found', description: 'Could not find streams to resume playback.', variant: 'destructive' })
        pendingStreamRef.current = null
        return
      }
    }
    launchPlayback(stream, pending.identifier, pending.startPosition, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
    pendingStreamRef.current = null
    pendingFetchedStreamsRef.current = null
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback, getStreamForResume, toast])

  const handleStartOver = useCallback(async () => {
    const pending = pendingStreamRef.current
    if (!pending || !selectedItem) return
    setResumeDialog((prev) => ({ ...prev, open: false }))

    try {
      if (pending.mediaId) {
        await invoke('remote_clear_progress', { mediaId: pending.mediaId })
      }
    } catch (e) { console.warn('[RemoteSourceView] handleStartOver clear_progress:', e) }

    let stream: RemoteStreamData | null = pending.stream
    if (!stream) {
      stream = await getStreamForResume(selectedItem)
      if (!stream) {
        toast({ title: 'No streams found', description: 'Could not find streams to start playback.', variant: 'destructive' })
        pendingStreamRef.current = null
        pendingFetchedStreamsRef.current = null
        return
      }
    }
    launchPlayback(stream, pending.identifier, 0, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
    pendingStreamRef.current = null
    pendingFetchedStreamsRef.current = null
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback, getStreamForResume, toast])

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
    const reqId = ++detailReqId.current
    const searchItem = toSearchResult(item)
    // Navigate immediately so the user sees feedback right away
    setSelectedItem(searchItem)
    setPageState('detail')
    setShowCleanup(false) // Dismiss cleanup dialog if open

    // If item has resume progress, show resume dialog immediately
    const hasProgress = item.resume_position_seconds > 0 && item.duration_seconds > 0
    if (hasProgress) {
      const identifier = getMediaIdentifier(searchItem, item.season_number ?? undefined, item.episode_number ?? undefined)
      // Set episode context so title formatting works
      if (item.season_number != null) setCurrentSeason(item.season_number)
      if (item.episode_number != null) setCurrentEpisode(item.episode_number)
      if (item.episode_title) setCurrentEpisodeTitle(item.episode_title)
      setResumeDialog({
        open: true,
        mediaId: item.id,
        title: item.title || 'Unknown',
        position: item.resume_position_seconds,
        duration: item.duration_seconds,
      })
      pendingStreamRef.current = { stream: null as any, identifier, startPosition: item.resume_position_seconds, mediaId: item.id }
      // Fetch streams in background so handleResume can use them
      const imdbId = searchItem.imdb_id
      if (imdbId) {
        try {
          const isTv = item.media_type === 'tvshow' || item.media_type === 'tv'
          const streams = isTv
            ? await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season: item.season_number ?? 1, episode: item.episode_number ?? 1, forceRefresh: false })
            : await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId, forceRefresh: false })
          const flat = streams.flatMap((g) => g.streams)
          if (flat.length > 0) {
            pendingFetchedStreamsRef.current = flat
            // Update the pending ref with the best stream
            if (pendingStreamRef.current) {
              pendingStreamRef.current.stream = flat[0]
            }
          }
        } catch (e) { console.warn('[RemoteSourceView] handleLibraryCardClick fetch streams:', e) }
      }
    }

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

  const handleBackToLibrary = useCallback(() => {
    setSelectedItem(null)
    setGroupedStreams([])
    setStreamError(null)
    setQualityOpen(false)
    setResumeDialog((prev) => ({ ...prev, open: false }))
    pendingStreamRef.current = null
    pendingFetchedStreamsRef.current = null
    setPageState(searchQuery ? 'search' : 'library')
  }, [searchQuery])

  // Save addon URL from setup wizard
  const handleSaveAddonUrl = useCallback(async () => {
    const url = setupAddonUrl.trim()
    if (!url) return
    try {
      const config = await invoke<any>('get_config')
      config.addon_url = url
      await invoke('save_config', { newConfig: config, confirmed: true })
      setAddonUrlConfigured(true)
      loadRemoteLibrary()
      toast({ title: 'Addon URL saved', description: 'You can now stream content from the External tab.' })
    } catch (e: any) {
      toast({ title: 'Failed to save', description: e?.message || 'Could not save addon URL.', variant: 'destructive' })
    }
  }, [setupAddonUrl, loadRemoteLibrary, toast])

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

      {pageState === 'detail' ? (
        /* ── Detail view ── */
        <ScrollArea className="flex-1 px-8 pb-8 pt-10 relative z-10">
          <div className="max-w-4xl mx-auto">
            <RemoteMediaDetail
              item={selectedItem!}
              imdbId={(selectedItem as any).imdb_id}
              onBack={handleBackToLibrary}
              onFetchMovieStreams={handleFetchMovieStreams}
              onFetchEpisodeStreams={handleFetchEpisodeStreams}
              fetching={fetching}
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
                        {item.media_type === 'movie' ? 'Movie' : 'TV'}
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
                      {/* Play overlay on hover */}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-300 flex items-center justify-center">
                        <div className="size-8 rounded-full bg-amber-600/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
                          <Play className="size-3.5 fill-white ml-0.5" />
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
        loading={fetching}
        error={streamError}
        verifying={false}
        streamStatus={{}}
      />

      {/* Resume Dialog */}
      <ResumeDialog
        open={resumeDialog.open}
        onOpenChange={(open) => setResumeDialog((prev) => ({ ...prev, open }))}
        title={resumeDialog.title}
        mediaType={selectedItem?.media_type === 'tv' ? 'tvepisode' : 'movie'}
        seasonEpisode={selectedItem?.media_type === 'tv' ? `S${currentSeason}E${currentEpisode}` : undefined}
        currentPosition={resumeDialog.position}
        duration={resumeDialog.duration}
        posterUrl={selectedItem?.poster_path ? `https://image.tmdb.org/t/p/w154${selectedItem.poster_path}` : undefined}
        onResume={handleResume}
        onStartOver={handleStartOver}
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
