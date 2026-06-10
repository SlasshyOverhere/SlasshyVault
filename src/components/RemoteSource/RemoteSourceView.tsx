import { useState, useEffect, useCallback, useRef, memo } from 'react'
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
import { Film, Play } from 'lucide-react'
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
      } catch {
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

export function RemoteSourceView() {
  const { toast } = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [remoteLibrary, setRemoteLibrary] = useState<RemoteLibraryItem[]>([])

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
  const pendingStreamRef = useRef<{ stream: RemoteStreamData; identifier: string; startPosition: number } | null>(null)

  // Cache
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null)
  const [showCleanup, setShowCleanup] = useState(false)
  const [lastPlayedTitle, setLastPlayedTitle] = useState('')
  const [lastCacheKey, setLastCacheKey] = useState('')

  const imdbIdRef = useRef<string>('')

  // Next episode prompt
  const [nextEpisodePrompt, setNextEpisodePrompt] = useState<{ show: boolean; imdbId: string; season: number; episode: number; title: string }>({ show: false, imdbId: '', season: 0, episode: 0, title: '' })

  const HISTORY_KEY = 'remote-search-history'
  const MAX_HISTORY = 20

  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    } catch { return [] }
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
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadRemoteLibrary()
  }, [loadRemoteLibrary])

  // Search
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    setIsSearching(true)
    setPageState('search')
    invoke<TmdbSearchResponse>('search_tmdb', { query: searchQuery })
      .then((res) => {
        const results = res.results || []
        if (results.length > 0) addToHistory(searchQuery)
        setSearchResults(results)
      })
      .catch(() => setSearchResults([]))
      .finally(() => setIsSearching(false))
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

  const handleSelectResult = useCallback((item: TmdbSearchResult) => {
    setSelectedItem(item)
    setPageState('detail')
  }, [])

  // Movie: fetch streams and open quality selector
  const handleFetchMovieStreams = useCallback(async (imdbId: string) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    setCurrentSeason(1)
    setCurrentEpisode(1)
    setCurrentEpisodeTitle('')
    imdbIdRef.current = imdbId
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
    }
    setFetching(false)
  }, [])

  // Series episode: fetch streams and open quality selector
  const handleFetchEpisodeStreams = useCallback(async (imdbId: string, season: number, episode: number, episodeTitle: string) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    setCurrentSeason(season)
    setCurrentEpisode(episode)
    setCurrentEpisodeTitle(episodeTitle)
    imdbIdRef.current = imdbId
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season, episode })
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
      const response = await invoke<any>('remote_play_with_mpv', {
        url: stream.url,
        title: item.title || item.name || 'Unknown',
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

      // Cache media_id for future resume checks
      const storageKey = `remote-media-id-${identifier}`
      localStorage.setItem(storageKey, String(response.media_id))

      // Refresh library to pick up the new record
      loadRemoteLibrary()

      // If there's resume info and we started at 0, show resume dialog
      if (response.has_resume && startPosition === 0) {
        setResumeDialog({
          open: true,
          mediaId: response.media_id,
          title: item.title || item.name || 'Unknown',
          position: response.position,
          duration: response.duration,
        })
        pendingStreamRef.current = { stream, identifier, startPosition: response.position }
      }

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

    // Check if we have a cached media_id for this content
    const storageKey = `remote-media-id-${identifier}`
    const cachedMediaId = localStorage.getItem(storageKey)

    if (cachedMediaId) {
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
          pendingStreamRef.current = { stream, identifier, startPosition: resumeInfo.position }
          return
        }
      } catch {
        // No record found, proceed with fresh play
      }
    }

    launchPlayback(stream, identifier, 0, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback, toast])

  // Resume dialog handlers
  const handleResume = useCallback(async () => {
    const pending = pendingStreamRef.current
    if (!pending || !selectedItem) return
    setResumeDialog((prev) => ({ ...prev, open: false }))
    launchPlayback(pending.stream, pending.identifier, pending.startPosition, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
    pendingStreamRef.current = null
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback])

  const handleStartOver = useCallback(async () => {
    const pending = pendingStreamRef.current
    if (!pending || !selectedItem) return
    setResumeDialog((prev) => ({ ...prev, open: false }))

    try {
      const storageKey = `remote-media-id-${pending.identifier}`
      const mediaId = localStorage.getItem(storageKey)
      if (mediaId) {
        await invoke('remote_clear_progress', { mediaId: parseInt(mediaId) })
      }
    } catch { /* ignore */ }

    launchPlayback(pending.stream, pending.identifier, 0, selectedItem, currentSeason, currentEpisode, currentEpisodeTitle)
    pendingStreamRef.current = null
  }, [selectedItem, currentSeason, currentEpisode, currentEpisodeTitle, launchPlayback])

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

  const handleLibraryCardClick = useCallback(async (item: RemoteLibraryItem) => {
    const searchItem = toSearchResult(item)
    // Fetch fresh TMDB details to get poster_path and backdrop_path (DB may have null)
    try {
      if (item.media_type === 'movie') {
        const details = await invoke<any>('get_movie_details', { movieId: searchItem.id })
        if (details.poster_path) {
          searchItem.poster_path = details.poster_path
          invoke('remote_update_poster', { tmdbId: searchItem.id, posterPath: details.poster_path }).catch(() => {})
        }
        if (details.backdrop_path) (searchItem as any).backdrop_path = details.backdrop_path
        if (details.imdb_id) (searchItem as any).imdb_id = details.imdb_id
      } else {
        const details = await invoke<any>('get_tv_details', { tvId: searchItem.id })
        if (details.poster_path) {
          searchItem.poster_path = details.poster_path
          invoke('remote_update_poster', { tmdbId: searchItem.id, posterPath: details.poster_path }).catch(() => {})
        }
        if (details.backdrop_path) (searchItem as any).backdrop_path = details.backdrop_path
      }
    } catch { /* use whatever we have */ }
    setSelectedItem(searchItem)
    setPageState('detail')
    // Refresh library to pick up the updated poster
    loadRemoteLibrary()
  }, [loadRemoteLibrary])

  const handleBackToLibrary = useCallback(() => {
    setSelectedItem(null)
    setGroupedStreams([])
    setStreamError(null)
    setPageState(searchQuery ? 'search' : 'library')
  }, [searchQuery])

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
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5">
                {remoteLibrary.map((item) => (
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
