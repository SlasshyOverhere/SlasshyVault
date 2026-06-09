import { useState, useEffect, useCallback } from 'react'
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
import type { TmdbSearchResult, GroupedStreams, RemoteStreamData, CacheStatus } from './remote.types'

interface TmdbSearchResponse { results: TmdbSearchResult[]; total_results: number }

type PageState = 'search' | 'detail'

export function RemoteSourceView() {
  const { toast } = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)

  const [pageState, setPageState] = useState<PageState>('search')
  const [selectedItem, setSelectedItem] = useState<TmdbSearchResult | null>(null)

  // Stream fetching
  const [fetching, setFetching] = useState(false)
  const [groupedStreams, setGroupedStreams] = useState<GroupedStreams[]>([])
  const [streamError, setStreamError] = useState<string | null>(null)
  const [qualityOpen, setQualityOpen] = useState(false)

  // Cache
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null)
  const [showCleanup, setShowCleanup] = useState(false)
  const [lastPlayedTitle, setLastPlayedTitle] = useState('')
  const [lastCacheKey, setLastCacheKey] = useState('')

  // Search
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    setIsSearching(true)
    invoke<TmdbSearchResponse>('search_tmdb', { query: searchQuery })
      .then((res) => setSearchResults(res.results || []))
      .catch(() => setSearchResults([]))
      .finally(() => setIsSearching(false))
  }, [searchQuery])

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
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_movie_streams', { imdbId })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
    }
    setFetching(false)
  }, [])

  // Series episode: fetch streams and open quality selector
  const handleFetchEpisodeStreams = useCallback(async (imdbId: string, season: number, episode: number, _episodeTitle: string) => {
    setFetching(true)
    setStreamError(null)
    setGroupedStreams([])
    setQualityOpen(true)
    try {
      const streams = await invoke<GroupedStreams[]>('remote_get_series_streams', { imdbId, season, episode })
      setGroupedStreams(streams)
    } catch (e: any) {
      setStreamError(typeof e === 'string' ? e : 'Failed to load streams')
    }
    setFetching(false)
  }, [])

  // User selects a quality => launch MPV (cache starts automatically)
  const handleQualitySelect = useCallback(async (stream: RemoteStreamData) => {
    const title = selectedItem?.title || selectedItem?.name || 'Unknown'
    const cacheKey = `stream_${Date.now()}`
    setQualityOpen(false)

    try {
      await invoke('remote_play_with_mpv', {
        url: stream.url,
        title,
        videoSize: stream.videoSize,
        mediaIdentifier: cacheKey,
        qualityLabel: stream.parsedQuality,
      })

      toast({ title: 'Playback started', description: `${title} -- ${stream.parsedQuality}` })
    } catch (e: any) {
      toast({
        title: 'Playback failed',
        description: typeof e === 'string' ? e : 'Failed to launch player',
        variant: 'destructive',
      })
    }
  }, [selectedItem, toast])

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

  return (
    <div className="h-full flex flex-col relative">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute -top-40 -right-40 size-[600px] rounded-full bg-amber-500/3 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -left-40 size-[500px] rounded-full bg-sky-500/2 blur-[120px]" />

      {pageState === 'search' ? (
        <div className="flex-1 flex flex-col relative z-10">
          {/* Header + Search - always visible, centered */}
          <div className="shrink-0 pt-24 pb-8 px-8 text-center">
            <div className="max-w-lg mx-auto space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-3 text-[10px] font-semibold text-neutral-600 uppercase tracking-[0.15em]">
                  <span className="h-px w-6 bg-neutral-800" />
                  <span>External Sources</span>
                  <span className="h-px w-6 bg-neutral-800" />
                </div>
                <h1 className="text-4xl font-black tracking-tight text-white leading-none">Stream<br/>anything.</h1>
                <p className="text-sm text-neutral-500">Search and stream from external sources</p>
              </div>
              <RemoteSearchBar value={searchQuery} onChange={setSearchQuery} />
            </div>
          </div>

          {/* Results area - only when searching */}
          {searchQuery && (
            <ScrollArea className="flex-1 min-h-0 px-8 pb-8">
              <div className="max-w-lg mx-auto">
                <RemoteSearchResults results={searchResults} isLoading={isSearching} onSelect={handleSelectResult} />
              </div>
            </ScrollArea>
          )}
        </div>
      ) : (
        <ScrollArea className="flex-1 px-8 pb-8 pt-10 relative z-10">
          <div className="max-w-4xl mx-auto">
            <RemoteMediaDetail
              item={selectedItem!}
              onBack={() => { setPageState('search'); setSelectedItem(null); setGroupedStreams([]); setStreamError(null) }}
              onFetchMovieStreams={handleFetchMovieStreams}
              onFetchEpisodeStreams={handleFetchEpisodeStreams}
              fetching={fetching}
            />
          </div>
        </ScrollArea>
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

      <RemoteCacheStatusBar status={cacheStatus} />
      <RemoteCleanupDialog open={showCleanup} onOpenChange={setShowCleanup} title={lastPlayedTitle} onCleanup={handleCleanup} onKeep={handleKeep} />
    </div>
  )
}
