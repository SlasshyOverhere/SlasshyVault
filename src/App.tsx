import { useState, useEffect, useRef, lazy, Suspense, useMemo, useCallback } from 'react'
import { listen, emit, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import { appWindow } from '@tauri-apps/api/window'
import {
  Sidebar,
  MovieCard,
  ContinueCard,
  ResumeDialog,
  DeleteEpisodesModal,
  OnboardingModal,
  MainAppTour,
  MarkCompleteDialog,
  WatchTogetherBanner,
  LoginScreen,
  ContentDetailsModal,
  ZipPlaybackLoadingOverlay,
} from '@/components'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Toaster } from '@/components/ui/toaster'
import {
  getLibraryFiltered,
  getLibraryStats,
  getWatchHistory,
  getWatchHistoryEvents,
  removeFromWatchHistory,
  removeWatchHistoryEntry,
  clearAllWatchHistory,
  deleteMediaFiles,
  MediaItem,
  WatchHistoryEvent,
  WatchRoom,
  playMedia,
  getResumeInfo,
  getMediaInfo,
  ResumeInfo,
  getCachedImageUrl,
  hasCompletedOnboarding,
  completeOnboarding,
  getTabVisibility,
  setTabVisibility,
  TabVisibility,
  markAsComplete,
  isBetaEnabled,
  setBetaEnabled,
  isUnstableEnabled,
  setUnstableEnabled,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  syncWatchHistory,
  UpdateInfo,
  MpvAudioTracksDetectedPayload,
  MpvSubtitleTracksDetectedPayload,
  mergeCachedSeriesAudioTracks,
  mergeCachedSeriesSubtitleTracks,
  resolveSeriesAudioPreferenceForPlayback,
  resolveSeriesSubtitlePreferenceForPlayback,
} from '@/services/api'
import {
  Search, Loader2, Play, Film, Tv, Clock,
  ChevronRight, LayoutGrid, List,
  TrendingUp, BarChart3, Calendar, Sparkles, PlayCircle, X, Cloud, RefreshCw, Minus, Bot, Download,
  Maximize2, Minimize2, Archive
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { sortMediaItems } from '@/utils/sorting'
import {
  getMediaProgressPercent,
  isProgressPastAutoCompleteThreshold,
  shouldPromptToMarkComplete,
} from '@/utils/playbackProgress'
import {
  buildZipPlaybackLoadingState,
  type ZipPlaybackLoadingState,
  waitForMinimumZipOverlayVisibility,
  waitForMpvPlaybackStart,
  waitForZipLoadingOverlayPaint,
} from '@/utils/zipPlayback'
import streamvaultIcon from '@/assets/streamvault-icon-ui.png'
import { HistoryEventCard } from '@/components/HistoryEventCard'

// Lazy load heavy components
const loadSettingsModal = () => import('@/components/SettingsModal')
const loadEpisodeBrowser = () => import('@/components/EpisodeBrowser')
const loadSocialView = () => import('@/components/Social')
const loadAIChatView = () => import('@/components/AI/AIChatView')
const loadWatchTogetherModal = () => import('@/components/WatchTogether/WatchTogetherModal')
const loadFixMatchModal = () => import('@/components/FixMatchModal')

const SettingsModal = lazy(() => loadSettingsModal().then(module => ({ default: module.SettingsModal })))
const EpisodeBrowser = lazy(() => loadEpisodeBrowser().then(module => ({ default: module.EpisodeBrowser })))
const SocialView = lazy(() => loadSocialView().then(module => ({ default: module.SocialView })))
const AIChatView = lazy(() => loadAIChatView().then(module => ({ default: module.AIChatView })))
const WatchTogetherModal = lazy(() => loadWatchTogetherModal().then(module => ({ default: module.WatchTogetherModal })))
const FixMatchModal = lazy(() => loadFixMatchModal().then(module => ({ default: module.FixMatchModal })))

const AI_CHAT_PAUSED = true


interface ScanProgressPayload {
  title: string
  media_type: string
  current: number
  total: number
}

interface ScanCompletePayload {
  movies_count: number
  tv_count: number
}

interface MpvPlaybackEndedPayload {
  media_id: number
  title: string
  season_number?: number
  episode_number?: number
  media_type?: string
  final_position?: number
  final_duration?: number
  completed: boolean
}

const AUTO_MARK_WATCHED_THRESHOLD_PERCENT = 93

interface ZipProcessingStatusPayload {
  phase: 'detected' | 'complete' | 'error'
  archiveCount: number
  archiveName?: string | null
  episodesIndexed?: number | null
  message: string
}

interface ZipProcessingPopupState {
  phase: 'detected' | 'complete' | 'error'
  archiveCount: number
  archiveName?: string | null
  episodesIndexed?: number | null
  message: string
}

type ViewMode = 'grid' | 'list'
type SortOption = 'title' | 'year' | 'recent' | 'progress'
type MediaSubTab = 'movies' | 'tv'
const LARGE_LIBRARY_THRESHOLD = 120
const CLOUD_INITIAL_RENDER_COUNT = 48
const CLOUD_CHUNK_RENDER_COUNT = 96
const VIEW_MODE_STORAGE_KEY = 'streamvault.view_mode'

const LoadingFallback = () => (
  <div className="flex h-full w-full items-center justify-center min-h-[50vh]">
    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
  </div>
)

function App() {
  const [view, setView] = useState<string>('home')
  const [items, setItems] = useState<MediaItem[]>([])
  const [historyEvents, setHistoryEvents] = useState<WatchHistoryEvent[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedShow, setSelectedShow] = useState<MediaItem | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isClearingHistory, setIsClearingHistory] = useState(false)
  const [isHistorySyncing, setIsHistorySyncing] = useState(false)

  // Sub-tabs for Cloud view
  const [cloudSubTab, setCloudSubTab] = useState<MediaSubTab>('movies')

  // View mode and sort
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
      return saved === 'list' || saved === 'grid' ? saved : 'grid'
    } catch {
      return 'grid'
    }
  })
  const [sortBy] = useState<SortOption>('title')

  // Memoized sorted items to prevent re-sorting on every render
  const sortedItems = useMemo(() => {
    return sortMediaItems(items, sortBy)
  }, [items, sortBy])

  const refreshWindowState = useCallback(async () => {
    setIsMaximized(await appWindow.isMaximized())
  }, [])

  // Incremental rendering for very large cloud libraries to avoid view-switch stutter
  const [visibleCloudItemsCount, setVisibleCloudItemsCount] = useState(CLOUD_INITIAL_RENDER_COUNT)
  const cloudLoadMoreRef = useRef<HTMLDivElement | null>(null)
  const isChunkedCloudRender = view === 'cloud' && !searchQuery.trim() && sortedItems.length > LARGE_LIBRARY_THRESHOLD
  const cloudItemsToRender = useMemo(() => {
    if (!isChunkedCloudRender) return sortedItems
    return sortedItems.slice(0, visibleCloudItemsCount)
  }, [sortedItems, isChunkedCloudRender, visibleCloudItemsCount])
  const disableCloudEntryAnimation = false

  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    const setup = async () => {
      await refreshWindowState()
      unlisten = await appWindow.onResized(async () => {
        await refreshWindowState()
      })
    }
    setup()
    return () => {
      unlisten?.()
    }
  }, [refreshWindowState])

  useEffect(() => {
    document.body.classList.toggle('app-window-maximized', isMaximized)

    return () => {
      document.body.classList.remove('app-window-maximized')
    }
  }, [isMaximized])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode)
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [viewMode])

  useEffect(() => {
    return () => {
      if (zipProcessingPopupTimeoutRef.current) {
        window.clearTimeout(zipProcessingPopupTimeoutRef.current)
      }
    }
  }, [])

  // Home search state
  const [homeSearchQuery, setHomeSearchQuery] = useState('')
  const [homeSearchResults, setHomeSearchResults] = useState<MediaItem[]>([])
  const [isHomeSearching, setIsHomeSearching] = useState(false)

  // Continue watching
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>([])

  // Library stats
  const [libraryStats, setLibraryStats] = useState({ movies: 0, shows: 0, episodes: 0 })

  // Scanning state
  const [isScanning, setIsScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number; title: string } | null>(null)

  // Cloud indexing state
  const [isCloudIndexing, setIsCloudIndexing] = useState(false)
  const [cloudIndexingStatus, setCloudIndexingStatus] = useState<string>('')
  const [cloudIndexingProgress, setCloudIndexingProgress] = useState<{
    currentFolder: number
    totalFolders: number
    currentFolderName: string
    filesFound: number
    moviesFound: number
    tvFound: number
  } | null>(null)
  const [zipPlaybackLoading, setZipPlaybackLoading] = useState<ZipPlaybackLoadingState | null>(null)
  const [zipProcessingPopup, setZipProcessingPopup] = useState<ZipProcessingPopupState | null>(null)
  const zipProcessingPopupTimeoutRef = useRef<number | null>(null)

  // Modals
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'beta' | 'updates' | 'cloud' | 'api' | 'danger' | 'dev'>('general')
  const [fixMatchOpen, setFixMatchOpen] = useState(false)
  const [itemToFix, setItemToFix] = useState<MediaItem | null>(null)
  const [aiLaunchRequest, setAiLaunchRequest] = useState<{ item: MediaItem; nonce: number } | null>(null)

  const [theme] = useState<'dark' | 'light'>('dark')
  const { toast } = useToast()

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void loadSettingsModal()
      void loadEpisodeBrowser()
      void loadSocialView()
      void loadWatchTogetherModal()
      void loadFixMatchModal()
    }, 1500)

    return () => window.clearTimeout(preloadTimer)
  }, [])

  // Resume dialog state
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const [resumeDialogData, setResumeDialogData] = useState<{
    item: MediaItem
    resumeInfo: ResumeInfo
    posterUrl?: string
  } | null>(null)
  const [contentDetailsOpen, setContentDetailsOpen] = useState(false)
  const [contentDetailsItem, setContentDetailsItem] = useState<MediaItem | null>(null)

  // Delete modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteModalData, setDeleteModalData] = useState<{
    seriesId: number
    seriesTitle: string
  } | null>(null)

  // Watch Together state
  const [watchTogetherOpen, setWatchTogetherOpen] = useState(false)
  const [watchTogetherMedia, setWatchTogetherMedia] = useState<MediaItem | null>(null)

  // Watch Together session state (persists across modal open/close)
  const [wtActiveRoom, setWtActiveRoom] = useState<WatchRoom | null>(null)
  const [wtSessionId, setWtSessionId] = useState('')
  const [wtIsPlaying, setWtIsPlaying] = useState(false)
  const [wtSessionMedia, setWtSessionMedia] = useState<MediaItem | null>(null) // Media for the session

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showMainAppTour, setShowMainAppTour] = useState(false)

  // Update notes state
  // Tab visibility state - cloud-only mode
  const [tabVisibility, setTabVisibilityState] = useState<TabVisibility>({ showLocal: false, showCloud: true })

  // Cloud connection state for contextual empty states
  const [isGDriveConnected, setIsGDriveConnected] = useState(false)

  // Mark complete dialog state
  const [markCompleteDialogOpen, setMarkCompleteDialogOpen] = useState(false)
  const [markCompleteData, setMarkCompleteData] = useState<{
    mediaId: number
    title: string
    seasonEpisode?: string
    progressPercent: number
    isCompletionConfirmation?: boolean // True when MPV detected end chapter
  } | null>(null)

  // Authentication state
  const { isAuthenticated, isAuthLoading, isLoggingIn, login: handleLogin, logout: handleLogout } = useAuth()

  // Beta features state
  const [betaEnabled, setBetaEnabledState] = useState(false)
  const [unstableEnabled, setUnstableEnabledState] = useState(false)

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateGateStatus, setUpdateGateStatus] = useState<'checking' | 'downloading' | 'installing' | 'error' | 'idle'>('idle')
  const [updateGateMessage, setUpdateGateMessage] = useState('Checking for updates...')
  const [updateGateError, setUpdateGateError] = useState<string | null>(null)
  const [updateProgress, setUpdateProgress] = useState(0)

  // Check onboarding status and load tab visibility on mount
  useEffect(() => {
    if (!hasCompletedOnboarding()) {
      setShowOnboarding(true)
    }
    // Load tab visibility settings
    setTabVisibilityState(getTabVisibility())
  }, [])

  // Initialize beta features
  useEffect(() => {
    setBetaEnabledState(isBetaEnabled())
    setUnstableEnabledState(isUnstableEnabled())
  }, [])

  const runMandatoryUpdate = useCallback(async (showCheckErrors = false) => {
    let updateDetected = false

    setUpdateGateStatus('idle')
    setUpdateGateMessage('Checking for updates...')
    setUpdateGateError(null)
    setUpdateProgress(0)

    let unlistenProgress: UnlistenFn | null = null

    try {
      const info = await checkForUpdates()
      if (!info.available) {
        setUpdateInfo(null)
        setUpdateGateStatus('idle')
        return
      }

      updateDetected = true
      setUpdateInfo(info)

      if (!info.download_url) {
        throw new Error('Missing update download URL.')
      }

      setUpdateGateStatus('downloading')
      setUpdateGateMessage(`Downloading update v${info.latest_version}...`)

      unlistenProgress = await listen<{ progress: number }>('update-download-progress', (event) => {
        const value = Math.max(0, Math.min(100, Math.round(event.payload.progress)))
        setUpdateProgress(value)
      })

      await invoke('plugin:autostart|enable')

      const installerPath = await downloadUpdate(info.download_url)

      setUpdateGateStatus('installing')
      setUpdateGateMessage('Installing update and restarting...')
      await installUpdate(installerPath)
    } catch (error) {
      console.error('[Update] Mandatory update failed:', error)
      if (!updateDetected && !showCheckErrors) {
        setUpdateInfo(null)
        setUpdateGateStatus('idle')
        return
      }

      setUpdateGateStatus('error')
      setUpdateGateMessage(updateDetected ? 'Update required to continue.' : 'Unable to check for updates.')
      setUpdateGateError(error instanceof Error ? error.message : 'Unknown update error.')
    } finally {
      if (unlistenProgress) {
        unlistenProgress()
      }
    }
  }, [])

  // Mandatory update check on app start
  useEffect(() => {
    void runMandatoryUpdate()
  }, [runMandatoryUpdate])

  // Handle beta toggle
  const handleBetaToggle = (enabled: boolean) => {
    setBetaEnabled(enabled)
    setBetaEnabledState(enabled)
    if (!enabled && view === 'social') {
      setView('home')
    }
    toast({
      title: enabled ? "Beta Features Enabled" : "Beta Features Disabled",
      description: enabled
        ? "Watch Together and Social features are now available"
        : "Watch Together and Social features are now hidden"
    })
  }

  const handleUnstableToggle = (enabled: boolean) => {
    setUnstableEnabled(enabled)
    setUnstableEnabledState(enabled)
    if (!enabled && view === 'ai') {
      setView('home')
    }
    toast({
      title: enabled ? "Unstable Features Enabled" : "Unstable Features Disabled",
      description: enabled
        ? "Paused AI Chat entry points are now visible"
        : "AI Chat is now hidden again"
    })
  }

  const handleAiChatPaused = useCallback(() => {
    toast({
      title: "AI Chat Paused",
      description: "AI Chat is temporarily disabled and will return shortly in a future update.",
    })
  }, [toast])

  const handleOnboardingComplete = () => {
    completeOnboarding()
    setShowOnboarding(false)
    // Start the main app tour after onboarding modal
    setTimeout(() => {
      setShowMainAppTour(true)
    }, 300)
  }

  const handleMainAppTourComplete = () => {
    setShowMainAppTour(false)
  }

  const handleMainAppTourSkip = () => {
    setShowMainAppTour(false)
  }

  const handleRestartOnboarding = () => {
    // Small delay to let Settings modal close first
    setTimeout(() => {
      setShowOnboarding(true)
    }, 300)
  }

  // Check GDrive connection status for contextual empty states
  const checkGDriveStatus = async () => {
    try {
      const { isGDriveConnected: checkConnected } = await import('@/services/gdrive')
      const connected = await checkConnected()
      setIsGDriveConnected(connected)
    } catch (error) {
      console.log('[GDrive] Status check failed:', error)
      setIsGDriveConnected(false)
    }
  }

  // Check GDrive status when switching to cloud view or on mount
  useEffect(() => {
    if (view === 'cloud') {
      checkGDriveStatus()
    }
  }, [view])

  // Handler for tab visibility changes from settings
  const handleTabVisibilityChange = (visibility: TabVisibility) => {
    setTabVisibility(visibility)
    setTabVisibilityState(visibility)
    // If user hides the cloud view, navigate to home
    if (view === 'cloud' && !visibility.showCloud) {
      setView('home')
    }
  }

  // Listen for Tauri events - depends on view to properly refresh data
  useEffect(() => {
    document.documentElement.classList.add('dark')

    // Disable right-click context menu in production
    if (import.meta.env.PROD) {
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault()
      }
      document.addEventListener('contextmenu', handleContextMenu)
      return () => document.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [])

  // Cloud change detection is now handled by the Rust backend
  // The backend polls every 60 seconds and emits 'library-updated' events
  // which are already handled elsewhere in the app

  // Load library stats - cloud only
  const loadLibraryStats = useCallback(async () => {
    try {
      const stats = await getLibraryStats(true)
      setLibraryStats(stats)
    } catch (error) {
      console.error('Failed to load stats', error)
    }
  }, [])

  // Load continue watching
  const loadContinueWatching = useCallback(async () => {
    try {
      const history = await getWatchHistory()
      // Filter to items that are still meaningfully in progress.
      const inProgress = history
        .filter(item => {
          const progress = getMediaProgressPercent(item)
          return progress > 0 && !isProgressPastAutoCompleteThreshold(progress)
        })
        .slice(0, 10)
      setContinueWatching(inProgress)
    } catch (error) {
      console.error('Failed to load continue watching', error)
    }
  }, [])

  const loadHistoryEvents = useCallback(async () => {
    try {
      const events = await getWatchHistoryEvents()
      setHistoryEvents(events)
    } catch (error) {
      console.error('Failed to load history events', error)
    }
  }, [])

  const runWatchHistorySync = useCallback(async () => {
    setIsHistorySyncing(true)
    try {
      await syncWatchHistory()
    } catch (error) {
      console.warn('[History] Sync failed:', error)
    } finally {
      setIsHistorySyncing(false)
    }
  }, [])

  const handleHomeSearch = useCallback(async () => {
    if (!homeSearchQuery.trim()) {
      setHomeSearchResults([])
      return
    }

    setIsHomeSearching(true)
    try {
      // Search across all 4 entities: Local Movies, Local TV, Cloud Movies, Cloud TV
      const [localMovies, localTv, cloudMovies, cloudTv] = await Promise.all([
        getLibraryFiltered('movie', homeSearchQuery, false),
        getLibraryFiltered('tv', homeSearchQuery, false),
        getLibraryFiltered('movie', homeSearchQuery, true),
        getLibraryFiltered('tv', homeSearchQuery, true)
      ])

      const combined = [...localMovies, ...localTv, ...cloudMovies, ...cloudTv]
      const query = homeSearchQuery.toLowerCase()

      // Use Schwartzian transform to pre-calculate lowercase titles for faster sorting
      const sorted = combined
        .map(item => ({ item, titleLower: item.title.toLowerCase() }))
        .sort((a, b) => {
          const aTitle = a.titleLower
          const bTitle = b.titleLower
          if (aTitle === query && bTitle !== query) return -1
          if (bTitle === query && aTitle !== query) return 1
          if (aTitle.startsWith(query) && !bTitle.startsWith(query)) return -1
          if (bTitle.startsWith(query) && !aTitle.startsWith(query)) return 1
          return aTitle.localeCompare(bTitle)
        })
        .map(({ item }) => item)

      setHomeSearchResults(sorted)
    } catch (error) {
      console.error("Failed to search", error)
    } finally {
      setIsHomeSearching(false)
    }
  }, [homeSearchQuery])

  const fetchData = useCallback(async () => {
    try {
      let data: MediaItem[] = []
      if (view === 'cloud') {
        // Cloud view - filter by is_cloud = true
        const mediaType = cloudSubTab === 'movies' ? 'movie' : 'tv'
        data = await getLibraryFiltered(mediaType, searchQuery, true)
      }

      // Sorting is now handled by useMemo (sortedItems)
      setItems(data)
    } catch (error) {
      console.error("Failed to fetch data", error)
    }
  }, [view, cloudSubTab, searchQuery])

  // Stable ref for fetchData to avoid callback identity churn in downstream handlers.
  const fetchDataRef = useRef(fetchData)
  fetchDataRef.current = fetchData

  // Load initial data
  useEffect(() => {
    loadContinueWatching()
    loadLibraryStats()
  }, [tabVisibility, loadContinueWatching, loadLibraryStats])

  useEffect(() => {
    if (!isAuthenticated) {
      setHistoryEvents([])
      return
    }

    let cancelled = false

    const syncAndRefresh = async () => {
      await runWatchHistorySync()
      if (cancelled) return
      await loadContinueWatching()
      if (cancelled) return
      await loadHistoryEvents()
    }

    void syncAndRefresh()

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, loadContinueWatching, loadHistoryEvents, runWatchHistorySync])

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined
    let unlistenComplete: UnlistenFn | undefined
    let unlistenMpvEnded: UnlistenFn | undefined
    let unlistenMpvAudioTracks: UnlistenFn | undefined
    let unlistenMpvSubtitleTracks: UnlistenFn | undefined
    let unlistenLibraryUpdated: UnlistenFn | undefined
    let unlistenNotification: UnlistenFn | undefined
    let unlistenCloudIndexingStarted: UnlistenFn | undefined
    let unlistenZipProcessing: UnlistenFn | undefined

    const setupListeners = async () => {
      unlistenProgress = await listen<ScanProgressPayload>('scan-progress', (event) => {
        const payload = event.payload
        setScanProgress({
          current: payload.current,
          total: payload.total,
          title: payload.title
        })
      })

      unlistenCloudIndexingStarted = await listen<{ count: number }>('cloud-indexing-started', (event) => {
        setIsCloudIndexing(true)
        console.log(`[Cloud] Indexing started: ${event.payload.count} files`)
      })

      unlistenZipProcessing = await listen<ZipProcessingStatusPayload>('zip-processing-status', (event) => {
        const payload = event.payload

        if (zipProcessingPopupTimeoutRef.current) {
          window.clearTimeout(zipProcessingPopupTimeoutRef.current)
          zipProcessingPopupTimeoutRef.current = null
        }

        setZipProcessingPopup({
          phase: payload.phase,
          archiveCount: payload.archiveCount,
          archiveName: payload.archiveName ?? null,
          episodesIndexed: payload.episodesIndexed ?? null,
          message: payload.message,
        })

        if (payload.phase === 'detected') {
          setIsCloudIndexing(true)
          toast({
            title: payload.archiveCount > 1 ? 'ZIP archives detected' : 'ZIP archive detected',
            description: payload.message,
          })
          return
        }

        toast({
          title: payload.phase === 'complete' ? 'ZIP processing complete' : 'ZIP processing failed',
          description: payload.message,
          variant: payload.phase === 'error' ? 'destructive' : 'default',
        })

        zipProcessingPopupTimeoutRef.current = window.setTimeout(() => {
          setZipProcessingPopup(null)
          zipProcessingPopupTimeoutRef.current = null
        }, payload.phase === 'error' ? 6500 : 5000)
      })

      unlistenComplete = await listen<ScanCompletePayload>('scan-complete', async () => {
        setIsScanning(false)
        setScanProgress(null)
        if (view === 'cloud') {
          await fetchData()
        } else if (view === 'history') {
          await loadHistoryEvents()
        }
        await loadLibraryStats()
        await loadContinueWatching()

        toast({ title: "Scan Complete", description: "Library has been updated." })
      })

      unlistenMpvEnded = await listen<MpvPlaybackEndedPayload>('mpv-playback-ended', async (event) => {
        const { media_id, title, season_number, episode_number, media_type, completed, final_position, final_duration } = event.payload

        const seasonEpisode = media_type === 'tvepisode' && season_number && episode_number
          ? `S${String(season_number).padStart(2, '0')}E${String(episode_number).padStart(2, '0')}`
          : undefined
        const displayTitle = seasonEpisode ? `${title} (${seasonEpisode})` : title
        const autoMarkAsWatched = async () => {
          await markAsComplete(media_id)
          await emit('media-marked-complete', { media_id })
          toast({ title: "Marked Complete", description: `${displayTitle} marked as watched` })
        }

        if (completed) {
          try {
            await autoMarkAsWatched()
          } catch {
            toast({ title: "Progress Saved", description: `${displayTitle} - 100% watched` })
          }
        } else if (final_position && final_duration && final_position > 30) {
          const progressPercent = (final_position / final_duration) * 100

          if (isProgressPastAutoCompleteThreshold(progressPercent)) {
            try {
              await autoMarkAsWatched()
            } catch {
              toast({ title: "Progress Saved", description: `${displayTitle} - ${progressPercent.toFixed(0)}% watched` })
            }
          } else if (shouldPromptToMarkComplete(progressPercent)) {
            setMarkCompleteData({
              mediaId: media_id,
              title,
              seasonEpisode,
              progressPercent,
              isCompletionConfirmation: false
            })
            setMarkCompleteDialogOpen(true)
          } else {
            const displayTitle = seasonEpisode ? `${title} (${seasonEpisode})` : title
            toast({ title: "Progress Saved", description: `${displayTitle} - ${progressPercent.toFixed(0)}% watched` })
          }
        }

        if (view === 'cloud') {
          await fetchData()
        } else if (view === 'history') {
          await loadHistoryEvents()
        }
        await loadContinueWatching()
        await runWatchHistorySync()
      })

      unlistenMpvAudioTracks = await listen<MpvAudioTracksDetectedPayload>('mpv-audio-tracks-detected', (event) => {
        const { series_id, tracks } = event.payload
        if (!series_id || !Array.isArray(tracks)) {
          return
        }

        const nextTracks = [...tracks].sort((left, right) =>
          left.label.localeCompare(right.label),
        )
        mergeCachedSeriesAudioTracks(series_id, nextTracks)
      })

      unlistenMpvSubtitleTracks = await listen<MpvSubtitleTracksDetectedPayload>('mpv-subtitle-tracks-detected', (event) => {
        const { series_id, tracks } = event.payload
        if (!series_id || !Array.isArray(tracks)) {
          return
        }

        const nextTracks = [...tracks].sort((left, right) =>
          left.label.localeCompare(right.label),
        )
        mergeCachedSeriesSubtitleTracks(series_id, nextTracks)
      })

      unlistenLibraryUpdated = await listen<{ type?: string; title?: string; media_id?: number; parent_id?: number }>('library-updated', async (event) => {
        const payload = event.payload || {}
        const type = payload.type || 'updated'
        const title = payload.title || 'Library'
        console.log(`[WATCHER] Library updated: ${type} - ${title}`)

        setIsCloudIndexing(false)

        if (view === 'cloud') {
          await fetchData()
        } else if (view === 'history') {
          await loadHistoryEvents()
        } else if (view === 'episodes' && selectedShow) {
          try {
            const selectedId = selectedShow.id
            const changedMediaId = typeof payload.media_id === 'number' ? payload.media_id : null
            const changedParentId = typeof payload.parent_id === 'number' ? payload.parent_id : null

            if (
              changedMediaId === null
              || changedParentId === selectedId
              || changedMediaId === selectedId
            ) {
              const refreshedShow = await getMediaInfo(selectedId)
              setSelectedShow(refreshedShow)
            }
          } catch (error) {
            console.warn('[App] Failed to refresh selected show after library update:', error)
          }
        }
        await loadLibraryStats()
        await loadContinueWatching()
      })

      unlistenNotification = await listen<{ type: string; title: string; message: string }>('notification', (event) => {
        const { type, title, message } = event.payload
        toast({
          title,
          description: message,
          variant: type === 'success' ? 'default' : type === 'info' ? 'info' : 'destructive'
        })
      })
    }

    void setupListeners()
    return () => {
      unlistenProgress?.()
      unlistenComplete?.()
      unlistenMpvEnded?.()
      unlistenMpvAudioTracks?.()
      unlistenMpvSubtitleTracks?.()
      unlistenLibraryUpdated?.()
      unlistenNotification?.()
      unlistenCloudIndexingStarted?.()
      unlistenZipProcessing?.()
    }
  }, [view, selectedShow, fetchData, loadContinueWatching, loadHistoryEvents, loadLibraryStats, runWatchHistorySync, toast])

  useEffect(() => {
    if (view !== 'episodes' && view !== 'home' && view !== 'stats' && view !== 'social' && view !== 'ai') {
      // Fetch immediately on tab switch; only debounce active typing.
      const delayMs = searchQuery.trim() ? 180 : 0
      const timer = window.setTimeout(() => {
        if (view === 'history') {
          loadHistoryEvents()
          return
        }
        fetchData()
      }, delayMs)
      return () => window.clearTimeout(timer)
    }
  }, [view, searchQuery, cloudSubTab, fetchData, loadHistoryEvents])

  useEffect(() => {
    if (view !== 'cloud') return

    if (!isChunkedCloudRender) {
      setVisibleCloudItemsCount(sortedItems.length)
      return
    }

    setVisibleCloudItemsCount(Math.min(CLOUD_INITIAL_RENDER_COUNT, sortedItems.length))
  }, [view, cloudSubTab, searchQuery, sortedItems.length, isChunkedCloudRender])

  useEffect(() => {
    if (view !== 'cloud' || !isChunkedCloudRender) return

    const sentinel = cloudLoadMoreRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          setVisibleCloudItemsCount((prev) => {
            if (prev >= sortedItems.length) return prev
            return Math.min(prev + CLOUD_CHUNK_RENDER_COUNT, sortedItems.length)
          })
        }
      },
      {
        root: null,
        rootMargin: '260px 0px',
        threshold: 0.01,
      }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [view, isChunkedCloudRender, sortedItems.length])

  useEffect(() => {
    if (view !== 'home') return
    if (!homeSearchQuery.trim()) {
      setHomeSearchResults([])
      return
    }

    const delayDebounceFn = setTimeout(() => {
      handleHomeSearch()
    }, 300)
    return () => clearTimeout(delayDebounceFn)
  }, [homeSearchQuery, view, handleHomeSearch])


  // Handle cloud-only indexing - scans the entire Google Drive for NEW files only
  const handleCloudScan = async () => {
    if (isScanning || isCloudIndexing) {
      toast({ title: "Update In Progress", description: "Library update is already running." })
      return
    }

    try {
      const { isGDriveConnected: checkConnected, scanCloudFolder } = await import('@/services/gdrive')
      const connected = await checkConnected()

      if (!connected) {
        toast({
          title: "Not Connected",
          description: "Connect to Google Drive in Settings first"
        })
        return
      }

      setIsCloudIndexing(true)
      setCloudIndexingStatus('Checking for new files...')

      // Scan the root folder which will recursively scan all subfolders
      // The backend automatically skips files that are already indexed
      const result = await scanCloudFolder('root', 'My Drive')

      if (result.indexed_count > 0) {
        setCloudIndexingStatus(`✓ Added ${result.indexed_count} new files!`)
        toast({
          title: "Library Updated",
          description: `Added ${result.movies_count} movies and ${result.tv_count} TV shows`
        })
        // Refresh the view and stats
        await fetchData()
        await loadLibraryStats()
      } else {
        setCloudIndexingStatus('✓ Library is up to date')
        toast({
          title: "Library Up to Date",
          description: "No new movies or TV shows found in your Drive"
        })
      }

      // Keep the success state visible briefly
      setTimeout(() => {
        setIsCloudIndexing(false)
        setCloudIndexingStatus('')
        setCloudIndexingProgress(null)
      }, 2500)

    } catch (error) {
      console.error('[CloudScan] Failed:', error)
      setIsCloudIndexing(false)
      setCloudIndexingStatus('')
      setCloudIndexingProgress(null)
      toast({
        title: "Update Failed",
        description: String(error) || "Failed to update library",
        variant: "destructive"
      })
    }
  }

  const handleContentDetailsOpenChange = useCallback((open: boolean) => {
    setContentDetailsOpen(open)
    if (!open) {
      setContentDetailsItem(null)
    }
  }, [])

  const launchPlaybackWithZipLoading = useCallback(async (
    item: MediaItem,
    resume: boolean,
    audioPreference?: string | null,
    subtitlePreference?: string | null,
  ) => {
    const loadingState = item.parent_zip_id ? buildZipPlaybackLoadingState(item, resume) : null
    let overlayVisibleSince = 0
    if (loadingState) {
      setZipPlaybackLoading(loadingState)
      await waitForZipLoadingOverlayPaint()
      overlayVisibleSince = Date.now()
    }

    try {
      await playMedia(item.id, resume, audioPreference, subtitlePreference)
      if (loadingState) {
        await waitForMpvPlaybackStart(item.id)
        await waitForMinimumZipOverlayVisibility(overlayVisibleSince)
      }
    } finally {
      if (loadingState) {
        setZipPlaybackLoading(null)
      }
    }
  }, [])

  const startPlaybackFlow = useCallback(async (item: MediaItem) => {
    try {
      const resumeInfo = await getResumeInfo(item.id)

      if (resumeInfo.has_progress && resumeInfo.progress_percent <= AUTO_MARK_WATCHED_THRESHOLD_PERCENT) {
        let posterUrl: string | undefined
        if (item.poster_path) {
          try {
            posterUrl = await getCachedImageUrl(item.poster_path.replace('image_cache/', '')) || undefined
          } catch {
            // Ignore cache lookup failures and continue playback.
          }
        }

        setResumeDialogData({ item, resumeInfo, posterUrl })
        setResumeDialogOpen(true)
      } else {
        await launchPlaybackWithZipLoading(
          item,
          false,
          resolveSeriesAudioPreferenceForPlayback(item.parent_id, item.season_number),
          resolveSeriesSubtitlePreferenceForPlayback(item.parent_id, item.season_number),
        )
        toast({ title: "Playing", description: `Now playing: ${item.title}` })
      }
    } catch {
      toast({ title: "Error", description: "Failed to start playback", variant: "destructive" })
    }
  }, [launchPlaybackWithZipLoading, toast])

  const handleItemClick = useCallback((item: MediaItem) => {
    setContentDetailsItem(item)
    setContentDetailsOpen(true)
  }, [])

  const handleDetailsPrimaryAction = useCallback(async (item: MediaItem) => {
    setContentDetailsOpen(false)
    setContentDetailsItem(null)

    if (item.media_type === 'tvshow') {
      setSelectedShow(item)
      setView('episodes')
      return
    }

    await startPlaybackFlow(item)
  }, [startPlaybackFlow])

  const handleDetailsMarkWatched = useCallback(async (item: MediaItem) => {
    try {
      await markAsComplete(item.id)
      await emit('media-marked-complete', { media_id: item.id })
      toast({
        title: "Marked as watched",
        description: item.media_type === 'tvepisode'
          ? `${item.title} saved as watched.`
          : `${item.title} marked as watched.`,
      })
      await Promise.all([
        loadContinueWatching(),
        loadHistoryEvents(),
        runWatchHistorySync(),
        fetchData(),
      ])
    } catch {
      toast({ title: "Error", description: "Failed to mark as watched", variant: "destructive" })
    }
  }, [fetchData, loadContinueWatching, loadHistoryEvents, runWatchHistorySync, toast])

  const handleResumeChoice = async (resume: boolean) => {
    if (!resumeDialogData) return
    const { item, resumeInfo } = resumeDialogData
    const resumeTime = resume ? resumeInfo.position : 0
    try {
      await launchPlaybackWithZipLoading(
        item,
        resumeTime > 0,
        resolveSeriesAudioPreferenceForPlayback(item.parent_id, item.season_number),
        resolveSeriesSubtitlePreferenceForPlayback(item.parent_id, item.season_number),
      )
      toast({ title: "Playing", description: `Now playing: ${item.title}` })
      setResumeDialogOpen(false)
      setResumeDialogData(null)
    } catch (e) {
      toast({ title: "Error", description: String(e) || "Failed to start playback", variant: "destructive" })
    }
  }

  const handleFixMatch = useCallback((item: MediaItem) => {
    setItemToFix(item)
    setFixMatchOpen(true)
  }, [])

  const handleAskAiFromContent = useCallback((item: MediaItem) => {
    if (!unstableEnabled || AI_CHAT_PAUSED) {
      handleAiChatPaused()
      return
    }
    setAiLaunchRequest({
      item,
      nonce: Date.now(),
    })
    setView('ai')
    toast({
      title: "Opening AI Chat",
      description: `Fetching insights for "${item.title}"...`,
    })
  }, [unstableEnabled, handleAiChatPaused, toast])

  useEffect(() => {
    if (view === 'ai' && (!unstableEnabled || AI_CHAT_PAUSED)) {
      setView('home')
    }
  }, [view, unstableEnabled])

  const handleFixMatchSuccess = useCallback(async () => {
    const fixedItem = itemToFix

    await Promise.all([
      fetchData(),
      loadLibraryStats(),
      loadContinueWatching(),
    ])

    // Emit update event so current view can hot-refresh in-place without manual reload.
    try {
      await emit('library-updated', {
        type: 'metadata-updated',
        title: fixedItem?.title || 'Metadata updated',
        media_id: fixedItem?.id || null,
        parent_id: fixedItem?.parent_id || null,
      })
    } catch (error) {
      console.warn('[FixMatch] Failed to emit library-updated event:', error)
    }

    if (!selectedShow) return

    const shouldRefreshSelectedShow =
      view === 'episodes'
      || !fixedItem
      || selectedShow.id === fixedItem.id
      || selectedShow.id === (fixedItem.parent_id || -1)

    if (!shouldRefreshSelectedShow) return

    try {
      const refreshedShow = await getMediaInfo(selectedShow.id)
      setSelectedShow(refreshedShow)
    } catch (error) {
      console.warn('[FixMatch] Failed to refresh selected show metadata:', error)
    }
  }, [itemToFix, fetchData, loadLibraryStats, loadContinueWatching, selectedShow, view])

  const handleHistoryEntryOpen = useCallback(async (event: WatchHistoryEvent) => {
    if (!event.media_id) return
    try {
      const media = await getMediaInfo(event.media_id)
      await handleItemClick(media)
    } catch (error) {
      console.warn('[History] Failed to open history item:', error)
      toast({
        title: 'Unavailable',
        description: 'This watch entry is still saved, but the media item is no longer in your library.',
        variant: 'destructive',
      })
    }
  }, [handleItemClick, toast])

  const handleRemoveHistoryEntry = useCallback(async (event: WatchHistoryEvent) => {
    try {
      await removeWatchHistoryEntry(event.event_id)
      if (event.media_id) {
        await removeFromWatchHistory(event.media_id)
      }
      toast({
        title: "Removed",
        description: `"${event.parent_title || event.title}" removed from watch history.`,
      })
      await loadHistoryEvents()
      await loadContinueWatching()
      await runWatchHistorySync()
    } catch {
      toast({ title: "Error", description: "Failed to remove from history", variant: "destructive" })
    }
  }, [toast, loadContinueWatching, loadHistoryEvents, runWatchHistorySync])

  const handleClearHistory = useCallback(async () => {
    if (historyEvents.length === 0 || isClearingHistory) return

    setIsClearingHistory(true)
    try {
      await clearAllWatchHistory()
      toast({
        title: "History cleared",
        description: `Removed ${historyEvents.length} watch history ${historyEvents.length === 1 ? 'entry' : 'entries'}.`,
      })
      await loadHistoryEvents()
      await loadContinueWatching()
      await runWatchHistorySync()
    } catch {
      toast({ title: "Error", description: "Failed to clear watch history", variant: "destructive" })
    } finally {
      setIsClearingHistory(false)
    }
  }, [historyEvents.length, isClearingHistory, loadContinueWatching, toast, loadHistoryEvents, runWatchHistorySync])

  const handleDelete = useCallback(async (item: MediaItem) => {
    if (item.media_type === 'tvshow') {
      setDeleteModalData({ seriesId: item.id, seriesTitle: item.title })
      setDeleteModalOpen(true)
    } else {
      const deletePrompt = item.parent_zip_id
        ? `"${item.title}" comes from a ZIP archive. Deleting it will remove the ZIP archive from Google Drive and all indexed episodes from that archive. Continue?`
        : `Are you sure you want to permanently delete "${item.title}"?`
      const confirmed = confirm(deletePrompt)
      if (confirmed) {
        try {
          const result = await deleteMediaFiles([item.id])
          if (result.success) {
            toast({ title: "Deleted", description: result.message })
            await fetchDataRef.current()
          } else {
            toast({ title: "Partial Delete", description: result.message, variant: "destructive" })
            await fetchDataRef.current()
          }
        } catch {
          toast({ title: "Error", description: "Failed to delete file", variant: "destructive" })
        }
      }
    }
  }, [toast])

  const handleDeleteComplete = useCallback(async (message?: string) => {
    await fetchDataRef.current()
    toast({ title: "Deleted", description: message || "Selected content has been permanently deleted." })
  }, [toast])

  const handleMarkComplete = async () => {
    if (!markCompleteData) return
    try {
      await markAsComplete(markCompleteData.mediaId)
      toast({ title: "Marked Complete", description: `${markCompleteData.title} marked as watched` })
      // Emit event so EpisodeBrowser and other components can refresh
      await emit('media-marked-complete', { media_id: markCompleteData.mediaId })
      await loadContinueWatching()
      await loadHistoryEvents()
      await runWatchHistorySync()
      // Refresh library items to update progress display on cards
      await fetchData()
    } catch {
      toast({ title: "Error", description: "Failed to mark as complete", variant: "destructive" })
    }
  }

  // Watch Together handler
  const handleWatchTogether = useCallback((item: MediaItem) => {
    // Only allow if beta is enabled
    if (!betaEnabled) return
    setWatchTogetherMedia(item)
    setWatchTogetherOpen(true)
  }, [betaEnabled])

  // Watch Together session change handler
  const handleWtSessionChange = (room: WatchRoom | null, sessionId: string, isPlaying: boolean, media?: MediaItem) => {
    setWtActiveRoom(room)
    setWtSessionId(sessionId)
    setWtIsPlaying(isPlaying)
    if (media) {
      setWtSessionMedia(media)
    }
    if (!room) {
      setWtSessionMedia(null)
    }
  }

  const handleWtLeave = () => {
    setWtActiveRoom(null)
    setWtSessionId('')
    setWtIsPlaying(false)
    setWtSessionMedia(null)
  }

  const toggleTheme = () => {
    toast({ title: "Theme Locked", description: "Dark mode is optimized for this interface." })
  }

  const isUpdateGateActive = updateGateStatus === 'downloading' || updateGateStatus === 'installing' || updateGateStatus === 'error'

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden bg-gradient-mesh">
      {isUpdateGateActive && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg mx-4 rounded-2xl border border-white/10 bg-[#121212]/95 shadow-2xl shadow-black/50 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-xl bg-white/10">
                <Download className="w-5 h-5 text-neutral-200" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Updating StreamVault</h2>
                <p className="text-sm text-neutral-400">
                  {updateInfo?.latest_version ? `v${updateInfo.latest_version}` : 'Checking version...'}
                </p>
              </div>
            </div>

            <p className="text-sm text-neutral-300 mb-4">
              {updateGateMessage}
            </p>

            {updateGateStatus === 'downloading' && (
              <div className="space-y-2">
                <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-white/60 transition-all"
                    style={{ width: `${updateProgress}%` }}
                  />
                </div>
                <div className="text-xs text-neutral-500">{updateProgress}%</div>
              </div>
            )}

            {updateGateStatus === 'installing' && (
              <div className="flex items-center gap-2 text-xs text-neutral-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Installing and restarting...
              </div>
            )}

            {updateGateStatus === 'error' && (
              <div className="mt-4 space-y-3">
                {updateGateError && (
                  <div className="text-xs text-red-300/90 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {updateGateError}
                  </div>
                )}
                <button
                  onClick={() => void runMandatoryUpdate()}
                  className="w-full py-2.5 px-4 rounded-lg bg-white/10 hover:bg-white/15 text-neutral-200 text-sm font-medium transition-colors border border-white/10"
                >
                  Retry Update
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Show login screen if not authenticated */}
      {!isAuthenticated && !isAuthLoading && (
        <LoginScreen onLogin={handleLogin} isLoading={isLoggingIn} />
      )}

      {/* Show loading state while checking auth */}
      {isAuthLoading && (
        <div className="fixed inset-0 bg-[#0a0a0a] flex items-center justify-center z-[300]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
            <span className="text-neutral-400 text-sm">Loading...</span>
          </div>
        </div>
      )}

      {/* Main app content - only show when authenticated */}
      {isAuthenticated && (
        <>
          <ZipPlaybackLoadingOverlay loadingState={zipPlaybackLoading} />

          {/* Custom Title Bar */}
          <header className="fixed top-0 left-0 right-0 h-9 z-[220] border-b border-white/10 bg-black/45 backdrop-blur-2xl">
            <div className="relative h-full w-full flex items-center justify-between">
              <div className="absolute top-0 left-0 right-0 h-1.5" />
              <div
                data-tauri-drag-region
                onDoubleClick={async () => {
                  await appWindow.toggleMaximize()
                  await refreshWindowState()
                }}
                className="absolute left-0 top-1.5 bottom-0 right-[120px]"
              />
              <div className="flex items-center gap-2 pl-3 select-none">
                <img
                  data-tauri-drag-region
                  src={streamvaultIcon}
                  alt=""
                  draggable={false}
                  className="pointer-events-none h-4 w-4 object-contain"
                />
                <span data-tauri-drag-region className="pointer-events-none text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-400">
                  StreamVault
                </span>
              </div>
              <div className="flex items-center gap-1 pr-1.5">
                <button
                  onClick={() => appWindow.minimize()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="h-7 w-8 rounded-md border border-transparent text-neutral-400 transition-colors hover:border-white/10 hover:bg-white/10 hover:text-white"
                  title="Minimize"
                  aria-label="Minimize window"
                >
                  <Minus className="mx-auto h-3.5 w-3.5" />
                </button>
                <button
                  onClick={async () => {
                    await appWindow.toggleMaximize()
                    await refreshWindowState()
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="h-7 w-8 rounded-md border border-transparent text-neutral-400 transition-colors hover:border-white/10 hover:bg-white/10 hover:text-white"
                  title={isMaximized ? "Restore" : "Maximize"}
                  aria-label={isMaximized ? "Restore window" : "Maximize window"}
                >
                  {isMaximized ? <Minimize2 className="mx-auto h-3.5 w-3.5" /> : <Maximize2 className="mx-auto h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={async () => {
                    await appWindow.hide()
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="h-7 w-8 rounded-md border border-transparent text-neutral-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/20 hover:text-rose-300"
                  title="Close"
                  aria-label="Hide window"
                >
                  <X className="mx-auto h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </header>
          {/* Background decorative orbs */}
          <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
            <div className="bg-orb bg-orb-1" />
            <div className="bg-orb bg-orb-2" />
            <div className="bg-orb bg-orb-3" />
          </div>

          <AnimatePresence>
            {zipProcessingPopup && (
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.98 }}
                className="fixed right-5 top-14 z-[230] w-[min(92vw,390px)] rounded-[24px] border border-white/10 bg-[#11141b]/94 p-4 shadow-2xl shadow-black/45 backdrop-blur-xl"
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
                    zipProcessingPopup.phase === 'complete'
                      ? 'border-emerald-400/25 bg-emerald-400/10'
                      : zipProcessingPopup.phase === 'error'
                        ? 'border-red-400/25 bg-red-400/10'
                        : 'border-white/10 bg-white/5'
                  }`}>
                    {zipProcessingPopup.phase === 'complete' ? (
                      <span className="text-lg text-emerald-300">✓</span>
                    ) : zipProcessingPopup.phase === 'error' ? (
                      <span className="text-lg text-red-300">!</span>
                    ) : (
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}
                      >
                        <Archive className="h-5 w-5 text-white/80" />
                      </motion.div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">
                        {zipProcessingPopup.phase === 'complete'
                          ? 'ZIP Ready'
                          : zipProcessingPopup.phase === 'error'
                            ? 'ZIP Error'
                            : 'ZIP Detected'}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/60">
                        {zipProcessingPopup.archiveCount} archive{zipProcessingPopup.archiveCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-sm font-medium leading-relaxed text-white/85">
                      {zipProcessingPopup.message}
                    </p>
                    {zipProcessingPopup.archiveName && (
                      <p className="mt-2 line-clamp-1 text-xs text-white/45">
                        {zipProcessingPopup.archiveName}
                      </p>
                    )}
                    {typeof zipProcessingPopup.episodesIndexed === 'number' && zipProcessingPopup.phase === 'complete' && (
                      <p className="mt-2 text-xs text-emerald-200/80">
                        Indexed {zipProcessingPopup.episodesIndexed} episode{zipProcessingPopup.episodesIndexed === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <Sidebar
            currentView={view === 'episodes' ? 'cloud' : view}
            setView={(v) => {
              setView(v)
              setSelectedShow(null)
              setSearchQuery('')
              setHomeSearchQuery('')
              setHomeSearchResults([])
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onCloudScan={handleCloudScan}
            theme={theme}
            toggleTheme={toggleTheme}
            isScanning={isScanning}
            isCloudIndexing={isCloudIndexing}
            scanProgress={scanProgress}
            showCloudTab={tabVisibility.showCloud}
            betaEnabled={betaEnabled}
            unstableEnabled={unstableEnabled}
            aiChatPaused={AI_CHAT_PAUSED}
            onAiChatClick={handleAiChatPaused}
            className="flex-shrink-0 z-50 h-screen sticky top-0"
          />

          <main className="flex-1 flex flex-col min-w-0 relative z-10 overflow-hidden">
            {/* Floating Scan Progress Indicator */}
            <AnimatePresence>
              {isScanning && scanProgress && (
                <motion.div
                  initial={{ opacity: 0, y: -20, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -20, scale: 0.9 }}
                  className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-2.5 rounded-full bg-card/90 backdrop-blur-xl border border-white/30 shadow-lg"
                >
                  <div className="relative">
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                    <div className="absolute inset-0 rounded-full bg-white/40 blur-md animate-pulse" />
                  </div>
                  <span className="text-white text-sm font-semibold">
                    Scanning {scanProgress.current}/{scanProgress.total}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Floating Cloud Indexing Indicator */}
            <AnimatePresence>
              {isCloudIndexing && !isScanning && view !== 'cloud' && (
                <motion.div
                  initial={{ opacity: 0, y: -20, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -20, scale: 0.9 }}
                  className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-card/95 backdrop-blur-xl border border-gray-500/30 shadow-glow"
                >
                  <div className="relative">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    >
                      <Cloud className="h-4 w-4 text-gray-400" />
                    </motion.div>
                    <div className="absolute inset-0 rounded-full bg-gray-400/40 blur-md animate-pulse" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-gray-400 text-sm font-semibold">
                      {cloudIndexingProgress
                        ? `Scanning folder ${cloudIndexingProgress.currentFolder}/${cloudIndexingProgress.totalFolders}`
                        : 'Indexing cloud files...'
                      }
                    </span>
                    {cloudIndexingProgress && cloudIndexingProgress.filesFound > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Found {cloudIndexingProgress.filesFound} files ({cloudIndexingProgress.moviesFound} movies, {cloudIndexingProgress.tvFound} TV)
                      </span>
                    )}
                  </div>
                  {cloudIndexingProgress && (
                    <div className="w-16 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-gray-500 to-gray-400 rounded-full"
                        animate={{ width: `${(cloudIndexingProgress.currentFolder / cloudIndexingProgress.totalFolders) * 100}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Floating Controls for Cloud View */}
            <AnimatePresence>
              {view === 'cloud' && (
                <motion.div
                  initial={{ opacity: 0, y: -15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4"
                >
                  {/* Sub-tabs for Movies/TV */}
                  <div className="flex p-0.5 rounded-full bg-card/90 backdrop-blur-xl border border-white/10 shadow-md">
                    <motion.button
                      onClick={() => setCloudSubTab('movies')}
                      whileTap={{ scale: 0.95 }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${cloudSubTab === 'movies'
                        ? 'bg-white text-black shadow-md'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      <Film className="w-3.5 h-3.5" />
                      <span>Movies</span>
                    </motion.button>
                    <motion.button
                      onClick={() => setCloudSubTab('tv')}
                      whileTap={{ scale: 0.95 }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${cloudSubTab === 'tv'
                        ? 'bg-white text-black shadow-md'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      <Tv className="w-3.5 h-3.5" />
                      <span>TV Shows</span>
                    </motion.button>
                  </div>

                  {/* Search Input */}
                  <div className="relative flex items-center bg-card/90 backdrop-blur-xl border border-white/10 rounded-lg shadow-md overflow-hidden">
                    <Search className="w-3.5 h-3.5 text-muted-foreground ml-2.5" />
                    <input
                      type="text"
                      placeholder={`Search ${cloudSubTab === 'movies' ? 'movies' : 'TV shows'}...`}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-32 bg-transparent border-none text-xs px-2 py-1.5 focus:outline-none text-white placeholder:text-muted-foreground/60 font-medium"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="p-1 hover:bg-white/10 rounded-full transition-colors mr-1.5"
                      >
                        <X className="w-3 h-3 text-muted-foreground" />
                      </button>
                    )}
                  </div>

                  {/* View Mode Toggle */}
                  <div className="relative flex p-[3px] rounded-xl bg-card/90 backdrop-blur-xl border border-white/10 shadow-md">
                    {/* Sliding indicator */}
                    <motion.div
                      className="absolute top-[3px] bottom-[3px] rounded-[9px] bg-white/15 border border-white/20 shadow-sm"
                      animate={{
                        left: viewMode === 'grid' ? '3px' : '50%',
                        width: 'calc(50% - 3px)',
                      }}
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                    <motion.button
                      onClick={() => setViewMode('grid')}
                      whileTap={{ scale: 0.95 }}
                      className={`relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] text-xs font-medium transition-colors duration-200 ${viewMode === 'grid'
                        ? 'text-white'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      <span>Grid</span>
                    </motion.button>
                    <motion.button
                      onClick={() => setViewMode('list')}
                      whileTap={{ scale: 0.95 }}
                      className={`relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] text-xs font-medium transition-colors duration-200 ${viewMode === 'list'
                        ? 'text-white'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      <List className="w-3.5 h-3.5" />
                      <span>List</span>
                    </motion.button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Content - Episodes and AI chat have their own fixed layout/scroll behavior */}
            {view === 'episodes' && selectedShow ? (
              <div className="flex-1 overflow-hidden px-3 pb-3 pt-12">
                <AnimatePresence mode="wait">
                  <motion.div
                    key="episodes"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="h-full"
                  >
                    <Suspense fallback={<LoadingFallback />}>
                      <EpisodeBrowser
                        show={selectedShow}
                        onBack={() => {
                          // Navigate back to cloud view (all shows are cloud-based now)
                          setView('cloud')
                          setCloudSubTab('tv')
                          setSelectedShow(null)
                        }}
                        onWatchTogether={betaEnabled ? handleWatchTogether : undefined}
                      />
                    </Suspense>
                  </motion.div>
                </AnimatePresence>
              </div>
) : view === 'ai' && unstableEnabled && !AI_CHAT_PAUSED ? (
              <div className="flex-1 overflow-hidden">
                <div className="h-full min-h-0">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key="ai"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-full"
                    >
                      <Suspense fallback={<LoadingFallback />}>
                        <AIChatView
                          launchItem={aiLaunchRequest?.item || null}
                          launchNonce={aiLaunchRequest?.nonce || 0}
                          onLaunchHandled={() => setAiLaunchRequest(null)}
                        />
                      </Suspense>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            ) : (
              <ScrollArea className="flex-1">
                <div className={`content-container ${view === 'social' ? 'h-full min-h-0' : ''}`}>
                  <AnimatePresence mode="wait">
                    {/* Home View */}
                    {view === 'home' && (
                      <motion.div
                        key="home"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="min-h-[calc(100vh-80px)] flex flex-col"
                      >
                        {/* Logo at Top Center */}


                        {/* Hero Search Section - Stays visible */}
                        <div className="flex-1 flex items-center justify-center py-6">
                          <div className="w-full max-w-xl text-center">
                            <motion.div
                              animate={{
                                opacity: homeSearchQuery ? 0.7 : 1,
                                scale: homeSearchQuery ? 0.95 : 1,
                                y: homeSearchQuery ? -10 : 0
                              }}
                            >
                              <h2 className="text-3xl font-bold tracking-tight text-white mb-2">
                                <span className="bg-clip-text text-transparent bg-gradient-to-r from-white via-white to-white/70">
                                  Discover your next
                                </span>
                                {' '}
                                <span className="bg-clip-text text-transparent bg-gradient-to-r from-white via-gray-300 to-gray-400">
                                  favorite story
                                </span>
                              </h2>

                              <p className="text-sm text-muted-foreground mb-4">
                                Search across your library
                              </p>
                            </motion.div>

                            <div className="relative max-w-md mx-auto group">
                              <div className="relative flex items-center bg-card/80 backdrop-blur-xl border border-white/10 rounded-xl shadow-lg p-1.5 transition-all group-focus-within:border-white/50 group-focus-within:bg-card">
                                <Search className="w-5 h-5 text-muted-foreground ml-3" />
                                <input
                                  type="text"
                                  className="w-full bg-transparent border-none text-base px-3 py-2.5 focus:outline-none text-white placeholder:text-muted-foreground font-medium"
                                  placeholder="Search movies, TV shows..."
                                  value={homeSearchQuery}
                                  onChange={(e) => setHomeSearchQuery(e.target.value)}
                                  autoFocus
                                />
                                {homeSearchQuery && (
                                  <button
                                    onClick={() => setHomeSearchQuery('')}
                                    className="p-1.5 hover:bg-white/10 rounded-full transition-colors mr-2"
                                  >
                                    <X className="w-4 h-4 text-muted-foreground" />
                                  </button>
                                )}
                                {isHomeSearching && (
                                  <div className="mr-3">
                                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Quick Actions */}
                            <motion.div
                              animate={{ opacity: homeSearchQuery ? 0 : 1, height: homeSearchQuery ? 0 : 'auto' }}
                              className="flex items-center justify-center gap-3 mt-5 overflow-hidden"
                            >
                              {tabVisibility.showCloud && (
                                <button
                                  onClick={() => setView('cloud')}
                                  className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-sm font-medium transition-all hover:scale-105"
                                >
                                  <Cloud className="w-4 h-4 text-gray-400" />
                                  <span>Google Drive</span>
                                </button>
                              )}
                              {unstableEnabled && (
                                <button
                                  onClick={handleAiChatPaused}
                                  className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-sm font-medium transition-all hover:scale-105"
                                >
                                  <Bot className="w-4 h-4 text-amber-300" />
                                  <span>AI Chat</span>
                                  <span className="rounded-full border border-amber-400/35 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300">
                                    Paused
                                  </span>
                                </button>
                              )}
                            </motion.div>
                          </div>
                        </div>

                        {/* Bottom Sections - Continue Watching and Library Stats */}
                        <div className="space-y-4 pb-4 mt-auto">
                          {homeSearchQuery ? (
                            <section className="pt-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                              <div className="section-header-compact">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 rounded-lg bg-white/10">
                                    <Search className="w-4 h-4 text-white" />
                                  </div>
                                  <div>
                                    <h3 className="text-sm font-semibold text-foreground">
                                      {isHomeSearching ? 'Searching Library...' : `Search Results (${homeSearchResults.length})`}
                                    </h3>
                                  </div>
                                </div>
                              </div>

                              {homeSearchResults.length > 0 ? (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                  {homeSearchResults.slice(0, 10).map((item, index) => (
                                    <MovieCard
                                      key={item.id}
                                      item={item}
                                      index={index}
                                      onClick={handleItemClick}
                                      onFixMatch={handleFixMatch}
                                      onDelete={handleDelete}
                                      onWatchTogether={betaEnabled ? handleWatchTogether : undefined}
                                    />
                                  ))}
                                </div>
                              ) : !isHomeSearching && (
                                <div className="text-center py-10 bg-white/5 rounded-2xl border border-white/5">
                                  <p className="text-sm text-muted-foreground">No matches found in your library</p>
                                </div>
                              )}
                            </section>
                          ) : (
                            <>
                              {/* Continue Watching - Middle Bottom */}
                              {continueWatching.length > 0 && (
                                <motion.section
                                  initial={{ opacity: 0, y: 15 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ delay: 0.1 }}
                                >
                                  <div className="section-header-compact">
                                    <div className="flex items-center gap-2">
                                      <div className="p-1.5 rounded-lg bg-white/10">
                                        <PlayCircle className="w-4 h-4 text-white" />
                                      </div>
                                      <div>
                                        <h3 className="text-sm font-semibold text-foreground">Continue Watching</h3>
                                        <p className="text-[10px] text-muted-foreground">Pick up where you left off</p>
                                      </div>
                                    </div>
                                    <button
                                      onClick={() => setView('history')}
                                      className="btn-ghost text-xs flex items-center gap-1 group py-1 px-2"
                                    >
                                      View All
                                      <ChevronRight className="w-3 h-3 transition-transform group-hover:translate-x-1" />
                                    </button>
                                  </div>
                                  <div className="flex gap-3 pb-3">
                                    {continueWatching.slice(0, 3).map((item, index) => (
                                      <ContinueCard
                                        key={item.id}
                                        item={item}
                                        index={index}
                                        onClick={handleItemClick}
                                      />
                                    ))}
                                  </div>
                                </motion.section>
                              )}

                              {/* Library Stats - Bottom */}
                              {tabVisibility.showCloud && (
                                <motion.section
                                  initial={{ opacity: 0, y: 15 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ delay: 0.2 }}
                                >
                                  <div className="section-header-compact">
                                    <div className="flex items-center gap-2">
                                      <div className="p-1.5 rounded-lg bg-white/10">
                                        <BarChart3 className="w-4 h-4 text-white" />
                                      </div>
                                      <div>
                                        <h3 className="text-sm font-semibold text-foreground">Your Library</h3>
                                        <p className="text-[10px] text-muted-foreground">At a glance</p>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-3 gap-3">
                                    {/* Movies Card */}
                                    <motion.div
                                      onClick={() => {
                                        setView('cloud'); setCloudSubTab('movies');
                                      }}
                                      className="stat-card-compact group cursor-pointer"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                    >
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="p-1.5 rounded-lg bg-white/10">
                                          <Film className="w-4 h-4 text-white" />
                                        </div>
                                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                      </div>
                                      <div className="text-2xl font-bold text-foreground">{libraryStats.movies}</div>
                                      <div className="text-[10px] text-muted-foreground">Movies</div>
                                    </motion.div>

                                    {/* TV Shows Card */}
                                    <motion.div
                                      onClick={() => {
                                        setView('cloud'); setCloudSubTab('tv');
                                      }}
                                      className="stat-card-compact group cursor-pointer"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                    >
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="p-1.5 rounded-lg bg-white/10">
                                          <Tv className="w-4 h-4 text-white" />
                                        </div>
                                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                      </div>
                                      <div className="text-2xl font-bold text-foreground">{libraryStats.shows}</div>
                                      <div className="text-[10px] text-muted-foreground">TV Shows</div>
                                    </motion.div>

                                    {/* In Progress Card */}
                                    <motion.div
                                      onClick={() => setView('history')}
                                      className="stat-card-compact group cursor-pointer"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                    >
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="p-1.5 rounded-lg bg-white/10">
                                          <Clock className="w-4 h-4 text-gray-400" />
                                        </div>
                                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                      </div>
                                      <div className="text-2xl font-bold text-foreground">{continueWatching.length}</div>
                                      <div className="text-[10px] text-muted-foreground">Watching</div>
                                    </motion.div>
                                  </div>
                                </motion.section>
                              )}

                              {/* Empty state - only when nothing to show */}
                              {continueWatching.length === 0 && libraryStats.movies === 0 && libraryStats.shows === 0 && (
                                <motion.div
                                  className="flex flex-col items-center text-center py-6"
                                  initial={{ opacity: 0, scale: 0.9 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                >
                                  <div className="p-3 rounded-xl bg-white/5 mb-3">
                                    <Film className="w-8 h-8 text-muted-foreground" />
                                  </div>
                                  <h3 className="text-base font-semibold text-foreground mb-1">Your library is empty</h3>
                                  <p className="text-xs text-muted-foreground max-w-xs mb-4">
                                    Connect Google Drive to discover your movies and TV shows
                                  </p>
                                  <button
                                    onClick={() => setSettingsOpen(true)}
                                    className="btn-primary-compact inline-flex items-center gap-1.5"
                                  >
                                    <Sparkles className="w-3.5 h-3.5" />
                                    Get Started
                                  </button>
                                </motion.div>
                              )}
                            </>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {/* Statistics View */}
                    {view === 'stats' && (
                      <motion.div
                        key="stats"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="space-y-8"
                      >
                        {/* Stats Header */}
                        <motion.div
                          className="text-center mb-8"
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                        >
                          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-white text-sm font-medium mb-3">
                            <TrendingUp className="w-4 h-4" />
                            <span>Your Activity</span>
                          </div>
                          <h2 className="text-2xl font-bold text-foreground">Library Overview</h2>
                          <p className="text-muted-foreground mt-1">Track your watching progress</p>
                        </motion.div>

                        {/* Main Stats Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                          {/* Movies */}
                          <motion.div
                            className="stat-card-enhanced"
                            style={{ '--stat-color': 'hsl(0 0% 70%)' } as React.CSSProperties}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 }}
                            whileHover={{ scale: 1.02 }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div
                                className="stat-icon-wrapper"
                                style={{ '--icon-color': 'hsl(0 0% 70%)' } as React.CSSProperties}
                              >
                                <Film className="w-6 h-6 text-white" />
                              </div>
                            </div>
                            <div className="text-4xl font-bold text-foreground mb-1">{libraryStats.movies}</div>
                            <div className="text-sm text-muted-foreground">Total Movies</div>
                          </motion.div>

                          {/* TV Shows */}
                          <motion.div
                            className="stat-card-enhanced"
                            style={{ '--stat-color': 'hsl(0 0% 60%)' } as React.CSSProperties}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.15 }}
                            whileHover={{ scale: 1.02 }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div
                                className="stat-icon-wrapper"
                                style={{ '--icon-color': 'hsl(0 0% 60%)' } as React.CSSProperties}
                              >
                                <Tv className="w-6 h-6 text-white" />
                              </div>
                            </div>
                            <div className="text-4xl font-bold text-foreground mb-1">{libraryStats.shows}</div>
                            <div className="text-sm text-muted-foreground">Total TV Shows</div>
                          </motion.div>

                          {/* In Progress */}
                          <motion.div
                            className="stat-card-enhanced"
                            style={{ '--stat-color': 'hsl(0 0% 50%)' } as React.CSSProperties}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            whileHover={{ scale: 1.02 }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div
                                className="stat-icon-wrapper"
                                style={{ '--icon-color': 'hsl(0 0% 50%)' } as React.CSSProperties}
                              >
                                <Clock className="w-6 h-6 text-gray-400" />
                              </div>
                            </div>
                            <div className="text-4xl font-bold text-foreground mb-1">{continueWatching.length}</div>
                            <div className="text-sm text-muted-foreground">In Progress</div>
                          </motion.div>

                          {/* Items Watched */}
                          <motion.div
                            className="stat-card-enhanced"
                            style={{ '--stat-color': 'hsl(0 0% 55%)' } as React.CSSProperties}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.25 }}
                            whileHover={{ scale: 1.02 }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div
                                className="stat-icon-wrapper"
                                style={{ '--icon-color': 'hsl(0 0% 55%)' } as React.CSSProperties}
                              >
                                <TrendingUp className="w-6 h-6 text-gray-400" />
                              </div>
                            </div>
                            <div className="text-4xl font-bold text-foreground mb-1">{items.length}</div>
                            <div className="text-sm text-muted-foreground">Items Watched</div>
                          </motion.div>
                        </div>

                        {/* Recent Activity */}
                        {continueWatching.length > 0 && (
                          <motion.section
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                          >
                            <div className="section-header">
                              <div className="flex items-center gap-3">
                                <div className="p-2 rounded-xl bg-white/10">
                                  <Calendar className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                  <h3 className="text-lg font-semibold text-foreground">Recent Activity</h3>
                                  <p className="text-xs text-muted-foreground">Your recent watches</p>
                                </div>
                              </div>
                            </div>
                            <div className="space-y-3">
                              {continueWatching.slice(0, 5).map((item, index) => (
                                <motion.div
                                  key={item.id}
                                  initial={{ opacity: 0, x: -20 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: 0.3 + index * 0.05 }}
                                  onClick={() => handleItemClick(item)}
                                  className="list-item-interactive group"
                                >
                                  <div className="w-14 h-20 rounded-lg bg-muted overflow-hidden flex-shrink-0">
                                    {item.poster_path && (
                                      <img
                                        src={item.poster_path}
                                        alt={item.title}
                                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                                      />
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <h4 className="font-semibold text-foreground truncate group-hover:text-white transition-colors">
                                      {item.title}
                                    </h4>
                                    <div className="flex items-center gap-3 mt-1">
                                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-32">
                                        <div
                                          className="h-full bg-white rounded-full"
                                          style={{ width: `${item.progress_percent || 0}%` }}
                                        />
                                      </div>
                                      <span className="text-sm text-muted-foreground">
                                        {Math.round(item.progress_percent || 0)}%
                                      </span>
                                    </div>
                                  </div>
                                  <div className="p-2 rounded-full bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Play className="w-5 h-5 text-white" />
                                  </div>
                                </motion.div>
                              ))}
                            </div>
                          </motion.section>
                        )}

                        {/* Empty state for stats */}
                        {continueWatching.length === 0 && libraryStats.movies === 0 && libraryStats.shows === 0 && (
                          <motion.div
                            className="empty-state-enhanced flex flex-col items-center text-center min-h-[40vh] justify-center"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                          >
                            <div className="icon-wrapper mb-4">
                              <div className="icon-bg">
                                <BarChart3 className="w-10 h-10 text-muted-foreground" />
                              </div>
                            </div>
                            <h3 className="text-xl font-semibold text-foreground mb-2 text-center">No activity yet</h3>
                            <p className="text-muted-foreground max-w-sm text-center mx-auto">
                              Start watching content to see your statistics here
                            </p>
                          </motion.div>
                        )}
                      </motion.div>
                    )}

                    {/* AI Chat View */}
                {view === 'ai' && unstableEnabled && !AI_CHAT_PAUSED && (
                      <motion.div
                        key="ai"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full"
                      >
                        <Suspense fallback={<LoadingFallback />}>
                          <AIChatView
                            launchItem={aiLaunchRequest?.item || null}
                            launchNonce={aiLaunchRequest?.nonce || 0}
                            onLaunchHandled={() => setAiLaunchRequest(null)}
                          />
                        </Suspense>
                      </motion.div>
                    )}

                    {/* Social View - Only visible when beta is enabled */}
                    {view === 'social' && betaEnabled && (
                      <motion.div
                        key="social"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full"
                      >
                        <Suspense fallback={<LoadingFallback />}>
                          <SocialView />
                        </Suspense>
                      </motion.div>
                    )}

                    {/* History View */}
                    {view === 'history' && (
                      <motion.div
                        key="history"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="pt-24"
                      >
                        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                          <div className="space-y-1">
                            <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-white/45">
                              Watch History
                            </p>
                            <h2 className="text-2xl font-semibold tracking-tight text-white">
                              Your Watch Timeline
                            </h2>
                            <p className="text-sm text-white/55">
                              {historyEvents.length === 0
                                ? 'Every movie and episode session will be saved here with the exact date and time.'
                                : `${historyEvents.length} saved ${historyEvents.length === 1 ? 'session' : 'sessions'} across your local library and Google Drive sync.`}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-3">
                            <div className="inline-flex h-10 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 px-4 text-sm font-semibold text-emerald-100">
                              {isHistorySyncing ? 'Syncing to Google Drive...' : 'Google Drive history sync ready'}
                            </div>
                            <button
                              type="button"
                              onClick={handleClearHistory}
                              disabled={historyEvents.length === 0 || isClearingHistory}
                              className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.08] px-4 text-sm font-semibold text-white/80 transition-all duration-200 hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {isClearingHistory ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <X className="h-4 w-4" />
                              )}
                              Clear History
                            </button>
                          </div>
                        </div>

                        <div className="space-y-2.5">
                          {historyEvents.map((event) => (
                            <HistoryEventCard
                              key={event.event_id}
                              event={event}
                              onOpen={event.media_id ? handleHistoryEntryOpen : undefined}
                              onRemove={handleRemoveHistoryEntry}
                            />
                          ))}
                          {historyEvents.length === 0 && (
                            <div className="col-span-full flex items-center justify-center min-h-[60vh]">
                              <motion.div
                                className="empty-state-enhanced flex flex-col items-center text-center"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                              >
                                <div className="icon-wrapper mb-4">
                                  <div className="icon-bg">
                                    <Film className="w-10 h-10 text-muted-foreground" />
                                  </div>
                                </div>
                                <h3 className="text-xl font-semibold text-foreground mb-2 text-center">No watch sessions yet</h3>
                                <p className="text-muted-foreground max-w-sm text-center mx-auto">
                                  Start watching a movie or episode and StreamVault will save the exact session time here and sync it to your Google Drive account.
                                </p>
                              </motion.div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {/* Cloud Media Grid */}
                    {view === 'cloud' && (
                      <motion.div
                        key={`cloud-${cloudSubTab}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="pt-24"
                      >
                        <div className={viewMode === 'grid' ? 'grid-media' : 'list-media'}>
                          {cloudItemsToRender.map((item, index) => (
                            <MovieCard
                              key={item.id}
                              item={item}
                              index={index}
                              layout={viewMode}
                              disableEntryAnimation={disableCloudEntryAnimation}
                              onClick={handleItemClick}
                              onFixMatch={handleFixMatch}
                          onAskAI={unstableEnabled ? handleAskAiFromContent : undefined}
                              onDelete={handleDelete}
                              onWatchTogether={betaEnabled ? handleWatchTogether : undefined}
                            />
                          ))}
                          {isChunkedCloudRender && cloudItemsToRender.length < sortedItems.length && (
                            <div
                              ref={cloudLoadMoreRef}
                              className={viewMode === 'grid'
                                ? 'col-span-full h-16 flex items-center justify-center text-xs text-muted-foreground/70'
                                : 'h-16 flex items-center justify-center text-xs text-muted-foreground/70'}
                            >
                              Loading more...
                            </div>
                          )}
                          {sortedItems.length === 0 && (
                            <div className="col-span-full flex items-center justify-center min-h-[60vh]">
                              <motion.div
                                className="empty-state-enhanced flex flex-col items-center text-center"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                              >
                                {/* Cloud Indexing Progress - Shows when indexing */}
                                {view === 'cloud' && isCloudIndexing ? (
                                  <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="flex flex-col items-center w-full max-w-md"
                                  >
                                    <div className="relative mb-6">
                                      {/* Animated rings */}
                                      <motion.div
                                        className="absolute inset-0 rounded-full border-2 border-gray-500/30"
                                        animate={{ scale: [1, 1.5, 1.5], opacity: [0.5, 0, 0] }}
                                        transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
                                        style={{ width: 80, height: 80 }}
                                      />
                                      <motion.div
                                        className="absolute inset-0 rounded-full border-2 border-gray-500/30"
                                        animate={{ scale: [1, 1.5, 1.5], opacity: [0.5, 0, 0] }}
                                        transition={{ duration: 2, repeat: Infinity, ease: "easeOut", delay: 0.5 }}
                                        style={{ width: 80, height: 80 }}
                                      />
                                      {/* Center icon */}
                                      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-gray-500/20 to-gray-400/20 border border-gray-500/30 flex items-center justify-center">
                                        <motion.div
                                          animate={cloudIndexingStatus.includes('complete') ? {} : { rotate: 360 }}
                                          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                        >
                                          <Cloud className={`w-8 h-8 ${cloudIndexingStatus.includes('complete') ? 'text-white' : 'text-gray-400'}`} />
                                        </motion.div>
                                      </div>
                                    </div>

                                    {/* Status Title */}
                                    <h3 className="text-xl font-semibold text-foreground mb-1">
                                      {cloudIndexingStatus.includes('complete') ? '✓ Indexing Complete!' : cloudIndexingStatus || 'Indexing your cloud files...'}
                                    </h3>

                                    {/* Current Folder */}
                                    {cloudIndexingProgress && cloudIndexingProgress.currentFolderName && !cloudIndexingStatus.includes('complete') && (
                                      <p className="text-gray-400 text-sm font-medium mb-3">
                                        📁 {cloudIndexingProgress.currentFolderName}
                                      </p>
                                    )}

                                    {/* Stats Cards */}
                                    {cloudIndexingProgress && (
                                      <div className="flex items-center gap-4 mb-4">
                                        <div className="flex flex-col items-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                                          <span className="text-2xl font-bold text-foreground">{cloudIndexingProgress.filesFound}</span>
                                          <span className="text-xs text-muted-foreground">Files Found</span>
                                        </div>
                                        <div className="flex flex-col items-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                                          <span className="text-2xl font-bold text-white">{cloudIndexingProgress.moviesFound}</span>
                                          <span className="text-xs text-muted-foreground">Movies</span>
                                        </div>
                                        <div className="flex flex-col items-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                                          <span className="text-2xl font-bold text-white">{cloudIndexingProgress.tvFound}</span>
                                          <span className="text-xs text-muted-foreground">TV Shows</span>
                                        </div>
                                      </div>
                                    )}

                                    {/* Progress bar with folder count */}
                                    {cloudIndexingProgress && (
                                      <div className="w-full max-w-xs">
                                        <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                                          <span>Folder {cloudIndexingProgress.currentFolder} of {cloudIndexingProgress.totalFolders}</span>
                                          <span>{Math.round((cloudIndexingProgress.currentFolder / cloudIndexingProgress.totalFolders) * 100)}%</span>
                                        </div>
                                        <div className="w-full h-2 bg-muted/30 rounded-full overflow-hidden">
                                          <motion.div
                                            className={`h-full rounded-full ${cloudIndexingStatus.includes('complete') ? 'bg-gradient-to-r from-gray-500 to-gray-400' : 'bg-gradient-to-r from-gray-500 to-gray-400'}`}
                                            initial={{ width: "0%" }}
                                            animate={{ width: `${(cloudIndexingProgress.currentFolder / cloudIndexingProgress.totalFolders) * 100}%` }}
                                            transition={{ duration: 0.3 }}
                                          />
                                        </div>
                                      </div>
                                    )}
                                  </motion.div>
                                ) : (
                                  <>
                                    <div className="icon-wrapper mb-4">
                                      <div className="icon-bg">
                                        <Cloud className="w-10 h-10 text-muted-foreground" />
                                      </div>
                                    </div>
                                    <h3 className="text-xl font-semibold text-foreground mb-2 text-center">
                                      {`No cloud ${(cloudSubTab === 'movies' ? 'movies' : 'TV shows')} found`}
                                    </h3>
                                    <p className="text-muted-foreground max-w-sm mb-6 text-center mx-auto">
                                      {isGDriveConnected
                                        ? 'Click Update Library to scan your Google Drive for movies and TV shows'
                                        : 'Connect your Google Drive account to stream your cloud media'
                                      }
                                    </p>
                                    <div className="flex items-center gap-3">
                                      {isGDriveConnected ? (
                                        <button
                                          onClick={handleCloudScan}
                                          disabled={isScanning || isCloudIndexing}
                                          className="btn-primary inline-flex items-center gap-2"
                                        >
                                          <RefreshCw className={`w-4 h-4 ${isCloudIndexing ? 'animate-spin' : ''}`} />
                                          {isCloudIndexing ? 'Updating...' : 'Update Library'}
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => {
                                            setSettingsInitialTab('cloud')
                                            setSettingsOpen(true)
                                          }}
                                          className="btn-primary inline-flex items-center gap-2"
                                        >
                                          <Sparkles className="w-4 h-4" />
                                          {view === 'cloud' ? 'Setup Google Drive' : 'Add Media Folders'}
                                        </button>
                                      )}
                                    </div>
                                  </>
                                )}
                              </motion.div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </ScrollArea>
            )}
          </main>

          {/* Modals */}
          <OnboardingModal
            open={showOnboarding}
            onComplete={handleOnboardingComplete}
          />

          {/* Main App Tour - shows after onboarding */}
          <MainAppTour
            isActive={showMainAppTour}
            onComplete={handleMainAppTourComplete}
            onSkip={handleMainAppTourSkip}
            setView={(v) => {
              setView(v)
              setSelectedShow(null)
              setSearchQuery('')
              setHomeSearchQuery('')
              setHomeSearchResults([])
            }}
          />

          <Suspense fallback={null}>
            <SettingsModal
              open={settingsOpen}
              onOpenChange={(open) => {
                setSettingsOpen(open)
                if (!open) {
                  setSettingsInitialTab('general')
                }
              }}
              onRestartOnboarding={handleRestartOnboarding}
              initialTab={settingsInitialTab}
              tabVisibility={tabVisibility}
              onTabVisibilityChange={handleTabVisibilityChange}
              onLogout={handleLogout}
            betaEnabled={betaEnabled}
            onBetaToggle={handleBetaToggle}
            unstableEnabled={unstableEnabled}
            onUnstableToggle={handleUnstableToggle}
          />
          </Suspense>

          <Suspense fallback={null}>
            <FixMatchModal
              open={fixMatchOpen}
              onOpenChange={setFixMatchOpen}
              item={itemToFix}
              onSuccess={handleFixMatchSuccess}
            />
          </Suspense>

          <ContentDetailsModal
            open={contentDetailsOpen}
            onOpenChange={handleContentDetailsOpenChange}
            item={contentDetailsItem}
            onPrimaryAction={handleDetailsPrimaryAction}
            onEpisodeSecondaryAction={handleDetailsMarkWatched}
            episodeSecondaryActionLabel="Mark as watched"
          />

          {resumeDialogData && (
            <ResumeDialog
              open={resumeDialogOpen}
              onOpenChange={setResumeDialogOpen}
              title={resumeDialogData.item.title}
              mediaType={resumeDialogData.item.media_type}
              seasonEpisode={
                resumeDialogData.item.season_number !== undefined && resumeDialogData.item.episode_number !== undefined
                  ? `S${String(resumeDialogData.item.season_number).padStart(2, '0')}E${String(resumeDialogData.item.episode_number).padStart(2, '0')}`
                  : undefined
              }
              currentPosition={resumeDialogData.resumeInfo.position}
              duration={resumeDialogData.resumeInfo.duration}
              posterUrl={resumeDialogData.posterUrl}
              onResume={() => handleResumeChoice(true)}
              onStartOver={() => handleResumeChoice(false)}
            />
          )}

          {deleteModalData && (
            <DeleteEpisodesModal
              isOpen={deleteModalOpen}
              onClose={() => { setDeleteModalOpen(false); setDeleteModalData(null) }}
              seriesId={deleteModalData.seriesId}
              seriesTitle={deleteModalData.seriesTitle}
              onDeleteComplete={handleDeleteComplete}
            />
          )}

          {/* Mark Complete Dialog */}
          {markCompleteData && (
            <MarkCompleteDialog
              open={markCompleteDialogOpen}
              onOpenChange={setMarkCompleteDialogOpen}
              title={markCompleteData.title}
              seasonEpisode={markCompleteData.seasonEpisode}
              progressPercent={markCompleteData.progressPercent}
              onMarkComplete={handleMarkComplete}
              onKeepProgress={() => {
                toast({ title: "Progress Saved", description: `${markCompleteData.title} - ${markCompleteData.progressPercent.toFixed(0)}% watched` })
              }}
            />
          )}

          {/* Watch Together Modal */}
          <Suspense fallback={null}>
            <WatchTogetherModal
              isOpen={watchTogetherOpen}
              onClose={() => {
                setWatchTogetherOpen(false)
                // Don't clear watchTogetherMedia if still in a room
                if (!wtActiveRoom) {
                  setWatchTogetherMedia(null)
                }
              }}
              selectedMedia={wtSessionMedia || watchTogetherMedia || undefined}
              activeRoom={wtActiveRoom}
              sessionId={wtSessionId}
              isPlaying={wtIsPlaying}
              onSessionChange={handleWtSessionChange}
            />
          </Suspense>

          {/* Watch Together Banner - shows when in a room but modal is closed */}
          {wtActiveRoom && !watchTogetherOpen && (
            <WatchTogetherBanner
              room={wtActiveRoom}
              isPlaying={wtIsPlaying}
              onOpenModal={() => setWatchTogetherOpen(true)}
              onLeave={handleWtLeave}
            />
          )}

          <Toaster />
        </>
      )}
    </div>
  )
}

export default App
