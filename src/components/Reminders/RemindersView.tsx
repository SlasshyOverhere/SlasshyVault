import { useEffect, useState } from 'react'
import {
  Search, Film, Tv, Bell,
  Loader2, TrendingUp, Globe, Clapperboard, Bookmark
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  searchTmdb,
  getMovieReminders,
  createMovieReminder,
  updateMovieReminder,
  getTmdbTrending,
  getTmdbImageUrl,
  getConfig,
  saveConfig,
  createOrUpdateWatchlistItem,
  getWatchlistItems,
  syncWatchlist,
  updateWatchlistItem,
  MovieReminder,
  TmdbSearchResult,
  TmdbTrendingItem,
  Config,
  MovieReminderInput,
  WatchlistItem,
  WatchlistItemInput,
} from '@/services/api'
import { ReminderEditor } from './ReminderEditor'
import { RemindersList } from './RemindersList'
import { TmdbDetailsModal } from './TmdbDetailsModal'
import { WatchlistEditor } from './WatchlistEditor'
import { WatchlistList } from './WatchlistList'
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export function RemindersView() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<'discover' | 'reminders' | 'watchlist'>('discover')
  const [searchQuery, setSearchQuery] = useState('')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'tv'>('all')
  const [isSearching, setIsSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [trendingSuggestions, setTrendingSuggestions] = useState<TmdbTrendingItem[]>([])
  const [reminders, setReminders] = useState<MovieReminder[]>([])
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
  const [config, setConfig] = useState<Config | null>(null)

  const [detailsModalOpen, setDetailsModalOpen] = useState(false)
  const [selectedResult, setSelectedResult] = useState<{ id: number, type: 'movie' | 'tv' } | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingReminder, setEditingReminder] = useState<Partial<MovieReminderInput> | MovieReminder | null>(null)

  const [watchlistEditorOpen, setWatchlistEditorOpen] = useState(false)
  const [editingWatchlistItem, setEditingWatchlistItem] = useState<Partial<WatchlistItemInput> | WatchlistItem | null>(null)

  useEffect(() => {
    loadReminders()
    loadConfig()
    loadTrendingSuggestions()
    loadWatchlist(true)

    let unlistenReminderRefresh: (() => void) | undefined
    let unlistenWatchlistRefresh: (() => void) | undefined

    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenReminderRefresh = await listen('refresh-reminders', () => {
        loadReminders()
      })
      unlistenWatchlistRefresh = await listen('refresh-watchlist', () => {
        loadWatchlist()
      })
    }
    setup()

    return () => {
      unlistenReminderRefresh?.()
      unlistenWatchlistRefresh?.()
    }
  }, [])

  const loadReminders = async () => {
    try {
      const data = await getMovieReminders(true)
      setReminders(data)
    } catch (error) {
      console.error('Failed to load reminders:', error)
    }
  }

  const loadWatchlist = async (shouldSync = false) => {
    if (shouldSync) {
      try {
        await syncWatchlist()
      } catch (error) {
        console.error('Watchlist sync failed, falling back to local data:', error)
      }
    }

    try {
      const data = await getWatchlistItems(true)
      setWatchlistItems(data)
    } catch (error) {
      console.error('Failed to load watchlist:', error)
    }
  }

  useEffect(() => {
    if (activeTab === 'watchlist') {
      loadWatchlist()
    }
  }, [activeTab])

  const loadConfig = async () => {
    try {
      const data = await getConfig()
      setConfig(data)
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  const loadTrendingSuggestions = async () => {
    try {
      const response = await getTmdbTrending()
      setTrendingSuggestions(response.results.slice(0, 6))
    } catch (error) {
      console.error('Failed to load TMDB trending suggestions:', error)
      setTrendingSuggestions([])
    }
  }

  const handleSearch = async (queryOverride?: string) => {
    const query = (queryOverride ?? searchQuery).trim()
    if (!query) return
    setSearchQuery(query)
    setIsSearching(true)
    try {
      const response = await searchTmdb(query)
      setSearchResults(response.results)
    } catch (error) {
      console.error('TMDB search failed:', error)
      toast({
        title: "Search failed",
        description: "Could not connect to TMDB. Please check your internet connection.",
        variant: "destructive"
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleSearchInputChange = (value: string) => {
    setSearchQuery(value)
    if (!value.trim()) {
      setSearchResults([])
      setMediaFilter('all')
    }
  }

  const openTrendingDetails = (item: TmdbTrendingItem) => {
    setSelectedResult({ id: item.id, type: item.media_type })
    setDetailsModalOpen(true)
  }

  const handleDetailsOpenChange = (open: boolean) => {
    setDetailsModalOpen(open)
    if (!open) {
      setSelectedResult(null)
    }
  }

  const handleToggleNotifications = async (enabled: boolean) => {
    if (!config) return
    const newConfig = { ...config, notifications_enabled: enabled }
    try {
      await saveConfig(newConfig)
      setConfig(newConfig)
      toast({
        title: enabled ? "Notifications enabled" : "Notifications disabled",
        description: enabled
          ? "You will receive native alerts for your reminders and watchlist."
          : "Schedules stay saved, but alerts are silenced."
      })
    } catch (error) {
      console.error('Failed to save config:', error)
    }
  }

  const filteredResults = searchResults.filter(result => {
    if (mediaFilter === 'all') return true
    return result.media_type === mediaFilter
  })

  const handleSetReminderFromSearch = (data: Partial<MovieReminderInput>) => {
    setEditingReminder(data)
    setEditorOpen(true)
  }

  const handleAddToWatchlist = (data: Partial<WatchlistItemInput>) => {
    setEditingWatchlistItem(data)
    setWatchlistEditorOpen(true)
  }

  const handleSaveReminder = async (input: MovieReminderInput) => {
    try {
      if (editingReminder && 'id' in editingReminder) {
        await updateMovieReminder(editingReminder.id as number, input)
        toast({ title: "Reminder updated" })
      } else {
        await createMovieReminder(input)
        toast({ title: "Reminder set successfully" })
      }
      loadReminders()
      setActiveTab('reminders')
    } catch (error) {
      console.error('Failed to save reminder:', error)
      toast({
        title: "Failed to save reminder",
        description: "There was an error communicating with the backend.",
        variant: "destructive"
      })
    }
  }

  const handleSaveWatchlist = async (input: WatchlistItemInput) => {
    try {
      if (editingWatchlistItem && 'id' in editingWatchlistItem) {
        await updateWatchlistItem(editingWatchlistItem.id as number, input)
        toast({ title: "Watchlist updated" })
      } else {
        await createOrUpdateWatchlistItem(input)
        toast({ title: "Added to watchlist" })
      }
      loadWatchlist()
      setActiveTab('watchlist')
    } catch (error) {
      console.error('Failed to save watchlist item:', error)
      toast({
        title: "Failed to update watchlist",
        description: "There was an error saving your watchlist item.",
        variant: "destructive"
      })
    }
  }

  return (
    <LazyMotion features={domAnimation}>
    <div className="h-full min-h-0 flex flex-col bg-transparent text-white relative overflow-hidden font-sans items-center">
      <div className="absolute inset-0 bg-gradient-mesh opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-sheen opacity-20 pointer-events-none" />
      <div className="absolute inset-0 noise-overlay opacity-[0.03] pointer-events-none" />

      <header className="w-full max-w-5xl shrink-0 pt-12 pb-8 px-6 flex flex-col lg:flex-row lg:items-center justify-between gap-8 relative z-10 mt-8">
        <div className="flex items-center gap-8">
          <div className="relative group">
            <m.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="flex items-center gap-4">
              <div className="relative">
                <div className="absolute -inset-2 bg-white/10 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                <div className="size-12 rounded-[1.25rem] bg-white/5 border border-white/10 flex items-center justify-center shadow-elevation-1">
                  <Clapperboard className="size-6 text-white/70" />
                </div>
              </div>
              <div className="space-y-0.5">
                <h1 className="text-4xl font-black tracking-tighter leading-none text-white/80">
                  Watchlist
                </h1>
                <div className="flex items-center gap-2">
                  <div className="size-1 rounded-full bg-emerald-500/50 animate-pulse" />
                  <p className="text-white/20 text-[9px] font-black uppercase tracking-[0.3em]">
                    Discover, queue, remind
                  </p>
                </div>
              </div>
            </m.div>
          </div>

          <div className="h-10 w-px bg-white/5 hidden lg:block" />

          <div className="flex p-0.5 rounded-full bg-card/90 backdrop-blur-xl border border-white/10 shadow-md">
            {[
              { id: 'discover', label: 'Discover', icon: Globe },
              { id: 'reminders', label: 'Reminders', icon: Bell },
              { id: 'watchlist', label: 'Watchlist', icon: Bookmark },
            ].map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id as 'discover' | 'reminders' | 'watchlist')}
                className={cn(
                  'relative flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200',
                  activeTab === tab.id ? 'text-black' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {activeTab === tab.id && (
                  <m.div layoutId="RemindersTab" className="absolute inset-0 bg-white rounded-full shadow-md" />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  <tab.icon className="size-3.5" />
                  {tab.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <m.div initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="flex items-center gap-4">
          <div className="flex items-center gap-4 px-4 py-2 bg-white/[0.02] border border-white/[0.05] rounded-xl backdrop-blur-sm">
            <div className="flex flex-col items-end">
              <span className="text-[8px] font-black uppercase tracking-[0.2em] text-white/20 leading-none mb-1">Engine</span>
              <div className="flex items-center gap-1.5">
                <div className={cn('size-1 rounded-full transition-all duration-500', config?.notifications_enabled ? 'bg-white shadow-glow-sm animate-pulse' : 'bg-white/10')} />
                <span className={cn('text-[9px] font-black uppercase tracking-widest leading-none transition-colors duration-500', config?.notifications_enabled ? 'text-white/80' : 'text-white/30')}>
                  {config?.notifications_enabled ? 'Active' : 'Muted'}
                </span>
              </div>
            </div>
            <Switch checked={config?.notifications_enabled || false} onCheckedChange={handleToggleNotifications} className="scale-75 data-[state=checked]:bg-white transition-colors" />
          </div>
        </m.div>
      </header>

      <main className="flex-1 w-full min-h-0 relative z-10 overflow-hidden flex justify-center">
        <div className="w-full max-w-5xl h-full min-h-0 overflow-hidden">
          <AnimatePresence mode="wait">
            {activeTab === 'discover' ? (
              <m.div key="discover" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="h-full flex flex-col items-center">
                <ScrollArea className="w-full flex-1 px-6 pb-12 [&>div]:scrollbar-none">
                  <div className="w-full gap-y-12 pt-4 flex flex-col items-center">
                    <div className={cn('w-full relative group/search pt-4 max-w-3xl transition-all duration-700', searchResults.length > 0 ? 'mt-0' : 'mt-32')}>
                      <div className="absolute -inset-10 bg-white/[0.02] rounded-[3rem] blur-3xl group-focus-within/search:bg-white/[0.05] transition-all duration-1000 pointer-events-none" />
                      <div className="space-y-6">
                        <div className="flex flex-col gap-4">
                          <div className="relative group/input">
                            <Search className="absolute left-6 top-1/2 -translate-y-1/2 size-5 text-white/20 group-focus-within/search:text-white/60 group-hover/input:text-white/40 transition-all duration-500" />
                            <Input
                              value={searchQuery}
                              onChange={e => handleSearchInputChange(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && handleSearch()}
                              placeholder="Search global motion picture database..."
                              className="h-16 pl-16 pr-8 rounded-[1.5rem] bg-white/[0.02] border-white/[0.05] focus:bg-white/[0.04] focus:border-white/20 text-lg font-bold placeholder:text-white/10 transition-all duration-500 shadow-elevation-1 focus:shadow-glow-sm"
                            />
                            {isSearching && <div className="absolute right-6 top-1/2 -translate-y-1/2"><Loader2 className="size-6 animate-spin text-white/40" /></div>}
                          </div>
                          <Button onClick={() => handleSearch()} disabled={isSearching || !searchQuery.trim()} className="h-16 px-12 rounded-[1.5rem] bg-white text-black hover:bg-white/90 font-black uppercase tracking-[0.25em] text-[11px] shadow-glow-sm active:scale-95 transition-all duration-500 w-full">
                            Search
                          </Button>
                        </div>

                        {!searchResults.length && trendingSuggestions.length > 0 && (
                          <div className="flex items-center justify-center gap-4 px-6 opacity-40 animate-fade-in-up">
                            <span className="text-[10px] font-black uppercase tracking-widest">Trending:</span>
                            <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
                              {trendingSuggestions.map(item => (
                                <button type="button" key={`${item.media_type}-${item.id}`} onClick={() => openTrendingDetails(item)} className="text-[10px] font-bold hover:text-white transition-colors hover:underline underline-offset-4 decoration-white/20">
                                  {item.title}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {searchResults.length > 0 ? (
                      <div className="w-full space-y-10 animate-fade-in-up">
                        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between px-2">
                          <div className="flex items-center gap-4">
                            <div className="size-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shadow-inner">
                              <TrendingUp className="size-5 text-white/60" />
                            </div>
                            <div className="flex flex-col">
                              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white/80 leading-none">Discovery System</h2>
                              <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest mt-1.5">{filteredResults.length} records identified</span>
                            </div>
                          </div>

                          <div className="flex w-fit items-center gap-1.5 rounded-2xl p-1.5 bg-white/[0.03] border border-white/[0.05] backdrop-blur-md">
                            {[
                              { id: 'all', label: 'All' },
                              { id: 'movie', label: 'Movies' },
                              { id: 'tv', label: 'Series' }
                            ].map(tab => (
                              <button type="button" key={tab.id} onClick={() => setMediaFilter(tab.id as 'all' | 'movie' | 'tv')} className={cn('px-5 py-2 rounded-xl text-[9px] font-black uppercase tracking-[0.2em] transition-all duration-500', mediaFilter === tab.id ? 'bg-white text-black shadow-glow-sm' : 'text-white/30 hover:text-white/60 hover:bg-white/5')}>
                                {tab.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-8 gap-y-12">
                          {filteredResults.map((result, idx) => (
                            <m.div key={`${result.media_type}-${result.id}`} initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ delay: idx * 0.05, duration: 0.5 }} className="group">
                              <button type="button" className="relative isolate cursor-pointer text-left w-full" onClick={() => {
                                setSelectedResult({ id: result.id, type: result.media_type as 'movie' | 'tv' })
                                setDetailsModalOpen(true)
                              }} aria-label={`View details for ${result.title || result.name}`}>
                                <div className="relative overflow-hidden rounded-[2rem] border border-white/[0.06] bg-white/[0.02] shadow-elevation-1 transition-all duration-500 group-hover:border-white/15 group-hover:shadow-elevation-2">
                                  {result.poster_path ? (
                                    <img src={getTmdbImageUrl(result.poster_path, 'w500') || ''} alt={result.title || result.name} className="aspect-[2/3] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
                                  ) : (
                                    <div className="aspect-[2/3] w-full flex items-center justify-center bg-white/[0.02] text-white/5">
                                      {result.media_type === 'movie' ? <Film className="size-16" /> : <Tv className="size-16" />}
                                    </div>
                                  )}
                                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-80 transition-opacity duration-500 group-hover:opacity-100" />

                                  <div className="absolute top-4 left-4 z-20">
                                    <div className="h-7 px-3 flex items-center gap-2 rounded-full border border-white/10 bg-black/35 backdrop-blur-xl">
                                      {result.media_type === 'movie' ? <Film className="size-3 opacity-60" /> : <Tv className="size-3 opacity-60" />}
                                      <span className="text-[8px] font-black uppercase tracking-widest">{result.media_type}</span>
                                    </div>
                                  </div>

                                </div>
                              </button>

                              <div className="mt-5 px-1 space-y-1.5 text-center">
                                <h3 className="font-black text-white text-sm line-clamp-1 tracking-tight">
                                  {result.title || result.name}
                                </h3>
                                <div className="flex items-center justify-center gap-3 text-[9px] text-white/20 font-black uppercase tracking-[0.15em]">
                                  <span>
                                    {result.release_date ? new Date(result.release_date).getFullYear() :
                                      result.first_air_date ? new Date(result.first_air_date).getFullYear() : 'TBA'}
                                  </span>
                                  {(result.vote_average ?? 0) > 0 && (
                                    <>
                                      <div className="size-1 rounded-full bg-white/10" />
                                      <span className="text-white/40">{(result.vote_average ?? 0).toFixed(1)} Score</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </m.div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      !isSearching && !searchQuery && (
                        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center gap-y-8 w-full">
                          <p className="text-white/20 font-bold uppercase tracking-[0.2em] text-sm">
                            Search the TMDB catalog or open a trending title
                          </p>
                        </div>
                      )
                    )}
                  </div>
                </ScrollArea>
              </m.div>
            ) : activeTab === 'reminders' ? (
              <m.div key="reminders" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="flex flex-col h-full min-h-0 overflow-hidden px-6 pb-8 items-center">
                <div className="w-full max-w-4xl flex-1 min-h-0">
                  <RemindersList reminders={reminders} onEdit={(r) => {
                    setEditingReminder(r)
                    setEditorOpen(true)
                  }} onRefresh={loadReminders} />
                </div>
              </m.div>
            ) : (
              <m.div key="watchlist" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="flex flex-col h-full min-h-0 overflow-hidden px-6 pb-8 items-center">
                <div className="w-full max-w-4xl flex-1 min-h-0">
                  <WatchlistList items={watchlistItems} onEdit={(item) => {
                    setEditingWatchlistItem(item)
                    setWatchlistEditorOpen(true)
                  }} onRefresh={loadWatchlist} />
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {selectedResult && (
        <TmdbDetailsModal
          key={`${selectedResult.type}-${selectedResult.id}`}
          open={detailsModalOpen}
          onOpenChange={handleDetailsOpenChange}
          tmdbId={selectedResult.id}
          mediaType={selectedResult.type}
          onSetReminder={(data) => {
            handleDetailsOpenChange(false)
            handleSetReminderFromSearch(data)
          }}
          onAddToWatchlist={(data) => {
            handleDetailsOpenChange(false)
            handleAddToWatchlist(data)
          }}
        />
      )}

      <ReminderEditor open={editorOpen} onOpenChange={setEditorOpen} initialData={editingReminder || undefined} onSave={handleSaveReminder} />
      <WatchlistEditor open={watchlistEditorOpen} onOpenChange={setWatchlistEditorOpen} initialData={editingWatchlistItem || undefined} onSave={handleSaveWatchlist} />
    </div>
    </LazyMotion>
  )
}
