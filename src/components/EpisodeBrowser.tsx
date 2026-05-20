import { useEffect, useState, useMemo, useCallback, memo, useRef } from "react"
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Play, ChevronLeft, Clock, Check, Loader2, Star, Timer, ChevronDown, ChevronUp, RefreshCw, Users, FileText, Copy } from "lucide-react"
import {
    MediaItem, getEpisodes, playMedia, getResumeInfo,
    getCachedImageUrl, ResumeInfo, getTvSeasonEpisodes, TmdbEpisodeInfo,
    getTmdbImageUrl, markAsComplete, refreshSeriesMetadata, resolveSeriesAudioPreferenceForPlayback, resolveSeriesSubtitlePreferenceForPlayback
} from "@/services/api"
import { useToast } from "@/components/ui/use-toast"
import { PlayerModal } from "@/components/PlayerModal"
import { ResumeDialog } from "@/components/ResumeDialog"
import { ContentDetailsModal } from "@/components/ContentDetailsModal"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ZipPlaybackLoadingOverlay } from "@/components/ZipPlaybackLoadingOverlay"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import {
    buildZipPlaybackLoadingState,
    type ZipPlaybackLoadingState,
    waitForMinimumZipOverlayVisibility,
    waitForMpvPlaybackStart,
    waitForZipLoadingOverlayPaint,
} from "@/utils/zipPlayback"
import {
    getMediaProgressPercent,
    isMediaMarkedWatched,
    isProgressPastAutoCompleteThreshold,
} from "@/utils/playbackProgress"

interface EpisodeBrowserProps {
    show: MediaItem
    onBack: () => void
    onWatchTogether?: (episode: MediaItem) => void
    onDownload?: (episode: MediaItem) => void | Promise<void>
}

// TODO: Extract this to a shared component (duplicated in ContentDetailsModal.tsx)
const EpisodeThumbnailImage = memo(function EpisodeThumbnailImage({
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
                // Load from local cache - handle paths with or without 'image_cache/' prefix
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
                    console.error(`[EpisodeThumbnail] Failed to load local image for E${episodeNumber}:`, error);
                }
            }

            // Fall back to TMDB URL
            if (tmdbStillUrl) {
                setImageUrl(tmdbStillUrl);
            }
            setLoading(false);
        };
        loadImage();
    }, [localStillPath, tmdbStillUrl, episodeNumber]);

    if (loading) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/50">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/50" />
            </div>
        );
    }

    if (imageUrl) {
        return (
            <img
                src={imageUrl}
                alt={episodeTitle}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
        );
    }

    return (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/50">
            <span className="text-2xl font-bold text-muted-foreground/50">
                {episodeNumber > 0 ? episodeNumber : '?'}
            </span>
        </div>
    );
});


/**
 * ⚡ Bolt: Performance Optimization
 *
 * What: Extracted `EpisodeItem` and `EpisodeThumbnailImage` into separate `React.memo` components.
 *       Memoized callback functions (`handleEpisodeClick`, `handleToggleExpand`) using `useCallback`.
 * Why:  Previously, the entire list of episodes re-rendered every time the parent component's state changed
 *       (e.g., toggling `expandedEpisode`, opening the player modal).
 * Impact: Prevents O(N) re-renders when interacting with a single episode in a season.
 *         Reduces rendering time for large seasons significantly.
 */
interface EpisodeItemProps {
    episode: MediaItem;
    index: number;
    tmdbData?: TmdbEpisodeInfo;
    isExpanded: boolean;
    onEpisodeClick: (episode: MediaItem) => void;
    onToggleExpand: (episodeId: number) => void;
    onMarkWatched: (episode: MediaItem) => void;
    onWatchTogether?: (episode: MediaItem) => void;
}

const getZipCompressionLabel = (method?: number): string | null => {
    switch (method) {
        case 0:
            return "Store";
        case 8:
            return "Deflate";
        default:
            return null;
    }
};

const EpisodeItemBase = ({
    episode,
    index,
    tmdbData,
    isExpanded,
    onEpisodeClick,
    onToggleExpand,
    onMarkWatched,
    onWatchTogether
}: EpisodeItemProps) => {
    const progress = getMediaProgressPercent(episode);
    const isFinished = isMediaMarkedWatched(episode);
    const hasProgress = progress > 0 && !isFinished;

    // Prefer local still_path over TMDB
    const localStillPath = episode.still_path;
    const stillUrl = localStillPath
        ? null // Will be loaded from cache below
        : getTmdbImageUrl(tmdbData?.still_path, 'w300');
    // Use local episode title first, then TMDB, then fallback
    const episodeTitle = episode.episode_title || tmdbData?.name || episode.title || `Episode ${episode.episode_number}`;
    const localRuntimeMinutes = episode.duration_seconds && episode.duration_seconds >= 60
        ? Math.round(episode.duration_seconds / 60)
        : null;
    const tmdbRuntimeMinutes = tmdbData?.runtime && tmdbData.runtime > 0
        ? tmdbData.runtime
        : null;
    const runtimeMinutes = localRuntimeMinutes ?? tmdbRuntimeMinutes;
    const zipCompressionLabel = episode.parent_zip_id
        ? getZipCompressionLabel(episode.zip_compression_method)
        : null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.02 }}
            className="hover:bg-muted/30 transition-colors"
        >
            <div
                onClick={() => onEpisodeClick(episode)}
                className="p-3 lg:p-4 cursor-pointer group"
            >
                <div className="flex gap-3 lg:gap-4">
                    {/* Episode Thumbnail */}
                    <div className="relative flex-shrink-0 w-28 md:w-36 lg:w-40 aspect-video rounded-lg overflow-hidden bg-muted">
                        <EpisodeThumbnailImage
                            localStillPath={localStillPath}
                            tmdbStillUrl={stillUrl}
                            episodeTitle={episodeTitle}
                            episodeNumber={episode.episode_number || 0}
                        />

                        {/* Play overlay */}
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-full bg-white flex items-center justify-center">
                                <Play className="w-4 h-4 lg:w-5 lg:h-5 text-black fill-black ml-0.5" />
                            </div>
                        </div>

                        {/* Progress bar on thumbnail */}
                        {hasProgress && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                                <div
                                    className="h-full bg-white"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        )}

                        {/* Watched badge */}
                        {isFinished && (
                            <div className="absolute top-1.5 right-1.5 lg:top-2 lg:right-2 px-1.5 py-0.5 rounded bg-gray-500 text-white text-[10px] lg:text-xs font-medium flex items-center gap-1">
                                <Check className="w-2.5 h-2.5 lg:w-3 lg:h-3" />
                            </div>
                        )}
                    </div>

                    {/* Episode Info */}
                    <div className="flex-1 min-w-0 py-0.5 lg:py-1">
                        {/* Header row */}
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5 lg:mb-1">
                                    <span className="text-[10px] lg:text-xs font-medium text-white">
                                        Episode {episode.episode_number}
                                    </span>
                                    {zipCompressionLabel && (
                                        <span className="text-[10px] lg:text-xs px-1.5 py-0.5 rounded bg-white/10 text-white border border-white/15">
                                            ZIP: {zipCompressionLabel}
                                        </span>
                                    )}
                                    {isFinished && (
                                        <span className="flex items-center gap-1 text-[10px] lg:text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30">
                                            <Check className="w-2.5 h-2.5 lg:w-3 lg:h-3" />
                                            Watched
                                        </span>
                                    )}
                                    {hasProgress && (
                                        <span className="flex items-center gap-1 text-[10px] lg:text-xs px-1.5 py-0.5 rounded bg-white/15 text-white border border-white/20">
                                            <Clock className="w-2.5 h-2.5 lg:w-3 lg:h-3" />
                                            {Math.round(progress)}%
                                        </span>
                                    )}
                                </div>
                                <h4 className="font-semibold text-foreground line-clamp-1 text-sm lg:text-base">
                                    {episodeTitle}
                                </h4>
                            </div>

                            {/* Episode actions */}
                            <div className="hidden md:flex items-center gap-2 flex-shrink-0">
                                {!isFinished && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-white/15 text-white/80 bg-white/5 hover:bg-white/12 hover:text-white"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onMarkWatched(episode);
                                        }}
                                    >
                                        <Check className="w-4 h-4 mr-1" />
                                        Mark as watched
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEpisodeClick(episode);
                                    }}
                                >
                                    <Play className="w-4 h-4 fill-current mr-1" />
                                    Play
                                </Button>
                                {onWatchTogether && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-purple-500/50 text-purple-400 hover:bg-purple-500/20"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onWatchTogether(episode);
                                        }}
                                    >
                                        <Users className="w-4 h-4 mr-1" />
                                        Together
                                    </Button>
                                )}
                            </div>
                        </div>

                        {/* Metadata row - local duration first, fallback to TMDB runtime */}
                        <div className="mt-1 lg:mt-1.5 flex flex-wrap items-center gap-2 lg:gap-3 text-[10px] lg:text-xs text-muted-foreground">
                            {runtimeMinutes || (tmdbData?.vote_average && tmdbData.vote_average > 0) ? (
                                <>
                                {runtimeMinutes && (
                                    <span className="flex items-center gap-1">
                                        <Timer className="w-2.5 h-2.5 lg:w-3 lg:h-3" />
                                        {runtimeMinutes} min
                                    </span>
                                )}
                                {tmdbData?.vote_average && tmdbData.vote_average > 0 && (
                                    <span className="flex items-center gap-1">
                                        <Star className="w-2.5 h-2.5 lg:w-3 lg:h-3 text-gray-400 fill-gray-400" />
                                        {tmdbData.vote_average.toFixed(1)}
                                    </span>
                                )}
                                </>
                            ) : null}
                            {isFinished ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/8 px-2.5 py-1 text-[10px] lg:text-xs font-semibold text-white/72">
                                    <Check className="w-3 h-3" />
                                    Watched
                                </span>
                            ) : (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMarkWatched(episode);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/6 px-2.5 py-1 text-[10px] lg:text-xs font-semibold text-white/78 transition-colors hover:bg-white/12 hover:text-white"
                                >
                                    <Check className="w-3 h-3" />
                                    Mark as watched
                                </button>
                            )}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2 md:hidden">
                            <Button
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onEpisodeClick(episode);
                                }}
                            >
                                <Play className="w-4 h-4 fill-current mr-1" />
                                Play
                            </Button>
                            {onWatchTogether && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-purple-500/50 text-purple-400 hover:bg-purple-500/20"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onWatchTogether(episode);
                                    }}
                                >
                                    <Users className="w-4 h-4 mr-1" />
                                    Together
                                </Button>
                            )}
                        </div>

                        {/* Overview/Description - hidden on small screens */}
                        {(episode.overview || tmdbData?.overview) && (
                            <div className="mt-1.5 lg:mt-2 hidden md:block">
                                <p className={cn(
                                    "text-xs lg:text-sm text-muted-foreground",
                                    isExpanded ? "" : "line-clamp-2"
                                )}>
                                    {episode.overview || tmdbData?.overview}
                                </p>
                                {((episode.overview || tmdbData?.overview) || '').length > 150 && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleExpand(episode.id);
                                        }}
                                        className="text-[10px] lg:text-xs text-white hover:underline mt-1 flex items-center gap-0.5"
                                    >
                                        {isExpanded ? (
                                            <>Show less <ChevronUp className="w-2.5 h-2.5 lg:w-3 lg:h-3" /></>
                                        ) : (
                                            <>Show more <ChevronDown className="w-2.5 h-2.5 lg:w-3 lg:h-3" /></>
                                        )}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

const areEpisodeItemPropsEqual = (prevProps: EpisodeItemProps, nextProps: EpisodeItemProps) => {
    // ⚡ Bolt: Custom equality check for memoization to prevent brittle property comparisons.
    // Shallow compares the episode object itself (reference should be stable from API),
    // and scalar/function props to avoid unnecessary re-renders.
    return (
        prevProps.episode === nextProps.episode &&
        prevProps.isExpanded === nextProps.isExpanded &&
        prevProps.index === nextProps.index &&
        prevProps.tmdbData === nextProps.tmdbData &&
        prevProps.onEpisodeClick === nextProps.onEpisodeClick &&
        prevProps.onToggleExpand === nextProps.onToggleExpand &&
        prevProps.onMarkWatched === nextProps.onMarkWatched &&
        prevProps.onWatchTogether === nextProps.onWatchTogether
    );
};

const EpisodeItem = memo(EpisodeItemBase, areEpisodeItemPropsEqual);

export function EpisodeBrowser({ show, onBack, onWatchTogether, onDownload }: EpisodeBrowserProps) {
    const [episodes, setEpisodes] = useState<MediaItem[]>([])
    const [loading, setLoading] = useState(true)
    const [posterUrl, setPosterUrl] = useState<string | null>(null)
    const [selectedSeason, setSelectedSeason] = useState<number>(1)

    // ⚡ Bolt: Chunked rendering state to prevent rendering bottlenecks with large seasons
    const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(20)
    const loadMoreRef = useRef<HTMLDivElement>(null)
    const { toast } = useToast()

    // TMDB episode metadata
    const [tmdbEpisodesBySeason, setTmdbEpisodesBySeason] = useState<Map<number, Map<number, TmdbEpisodeInfo>>>(new Map())
    const [expandedEpisode, setExpandedEpisode] = useState<number | null>(null)

    // Player selection state
    const [playerModalOpen, setPlayerModalOpen] = useState(false)
    const [pendingPlayEpisode, setPendingPlayEpisode] = useState<MediaItem | null>(null)
    const [_pendingResumeTime, _setPendingResumeTime] = useState(0)

    // Details modal state
    const [contentDetailsOpen, setContentDetailsOpen] = useState(false)
    const [contentDetailsItem, setContentDetailsItem] = useState<MediaItem | null>(null)

    // Resume dialog state
    const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
    const [resumeDialogData, setResumeDialogData] = useState<{
        episode: MediaItem;
        resumeInfo: ResumeInfo;
    } | null>(null)
    const [zipPlaybackLoading, setZipPlaybackLoading] = useState<ZipPlaybackLoadingState | null>(null)

    // Metadata refresh state
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [showEpisodeUrls, setShowEpisodeUrls] = useState(false)

    useEffect(() => {
        loadEpisodes()
        setTmdbEpisodesBySeason(new Map())

        let unlistenMpvEnded: UnlistenFn | undefined;
        let unlistenMarkedComplete: UnlistenFn | undefined;
        let unlistenLibraryUpdated: UnlistenFn | undefined;

        const setupListener = async () => {
            unlistenMpvEnded = await listen('mpv-playback-ended', () => {
                loadEpisodes();
            });
            // Listen for mark complete events from the dialog
            unlistenMarkedComplete = await listen('media-marked-complete', () => {
                loadEpisodes();
            });
            // Listen for metadata updates (Fix Match / file watcher) and refresh in-place.
            unlistenLibraryUpdated = await listen('library-updated', () => {
                loadEpisodes();
                loadPoster();
            });
        };

        setupListener();

        return () => {
            unlistenMpvEnded?.();
            unlistenMarkedComplete?.();
            unlistenLibraryUpdated?.();
        };
    }, [show.id])

    useEffect(() => {
        loadPoster()
    }, [show.id, show.poster_path])

    // Load TMDB episode metadata when season changes if local runtime is missing
    useEffect(() => {
        const seasonEpisodes = episodes.filter(ep => (ep.season_number || 1) === selectedSeason);
        if (!show.tmdb_id || selectedSeason <= 0 || seasonEpisodes.length === 0) return;

        // If all episodes already have valid local duration, no need to fetch TMDB runtime.
        const allLocalDurationsAvailable = seasonEpisodes.every(ep => (ep.duration_seconds || 0) >= 60);
        if (allLocalDurationsAvailable) return;

        // Avoid re-fetching for the same season.
        if (tmdbEpisodesBySeason.has(selectedSeason)) return;

        loadTmdbEpisodes(selectedSeason)
    }, [show.tmdb_id, selectedSeason, episodes, tmdbEpisodesBySeason])

    const loadTmdbEpisodes = async (season: number) => {
        if (!show.tmdb_id) return

        try {
            const tmdbId = parseInt(show.tmdb_id)
            const seasonDetails = await getTvSeasonEpisodes(tmdbId, season)

            if (seasonDetails) {
                const episodeMap = new Map<number, TmdbEpisodeInfo>()
                seasonDetails.episodes.forEach(ep => {
                    episodeMap.set(ep.episode_number, ep)
                })
                setTmdbEpisodesBySeason(prev => {
                    const next = new Map(prev)
                    next.set(season, episodeMap)
                    return next
                })
            }
        } catch (error) {
            console.error("Failed to load TMDB episode metadata", error)
        }
    }

    const loadEpisodes = async () => {
        try {
            const data = await getEpisodes(show.id)
            setEpisodes(data)
            // Set initial season ONLY on first load (when episodes is empty)
            if (data.length > 0 && episodes.length === 0) {
                const firstSeason = data.reduce((min, ep) =>
                    ep.season_number && ep.season_number < min ? ep.season_number : min,
                    data[0].season_number || 1
                )
                setSelectedSeason(firstSeason)
            }
        } catch (error) {
            console.error("Failed to load episodes", error)
            toast({ title: "Error", description: "Failed to load episodes", variant: "destructive" })
        } finally {
            setLoading(false)
        }
    }

    const loadPoster = async () => {
        setPosterUrl(null);
        if (show.poster_path) {
            const filename = show.poster_path.replace('image_cache/', '');
            const url = await getCachedImageUrl(filename);
            if (url) {
                setPosterUrl(url);
            }
        }
    }

    const handleRefreshMetadata = async () => {
        if (!show.tmdb_id || isRefreshing) return;

        setIsRefreshing(true);
        try {
            const tmdbId = parseInt(show.tmdb_id);
            const result = await refreshSeriesMetadata(tmdbId, show.title);
            toast({ title: "Metadata Refreshed", description: result });
            // Reload episodes to get updated metadata
            await loadEpisodes();
        } catch (error) {
            console.warn("Failed to refresh metadata:", error);
            toast({ title: "Error", description: "Failed to refresh metadata", variant: "destructive" });
        } finally {
            setIsRefreshing(false);
        }
    }

    // Get unique seasons (memoized to prevent recalculation on every render)
    const seasons = useMemo(() => {
        return [...new Set(episodes.map(ep => ep.season_number || 1))].sort((a, b) => a - b)
    }, [episodes])

    // Filter episodes by selected season (memoized to prevent sorting on every render)
    const filteredEpisodes = useMemo(() => {
        return episodes
            .filter(ep => (ep.season_number || 1) === selectedSeason)
            .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    }, [episodes, selectedSeason])

    // ⚡ Bolt: Reset visible count when switching seasons to prevent sudden layout jumps
    useEffect(() => {
        setVisibleEpisodeCount(20)
    }, [selectedSeason])

    // ⚡ Bolt: IntersectionObserver to load more episodes as user scrolls
    useEffect(() => {
        const sentinel = loadMoreRef.current
        if (!sentinel || filteredEpisodes.length <= visibleEpisodeCount) return

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setVisibleEpisodeCount((prev) =>
                            Math.min(prev + 20, filteredEpisodes.length)
                        )
                    }
                }
            },
            { root: null, rootMargin: '200px 0px', threshold: 0.01 }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [filteredEpisodes.length, visibleEpisodeCount])

    // ⚡ Bolt: Slice episodes to only render what's visible
    const episodesToRender = useMemo(() => {
        return filteredEpisodes.slice(0, visibleEpisodeCount)
    }, [filteredEpisodes, visibleEpisodeCount])

    const handleEpisodeClick = useCallback((episode: MediaItem) => {
        setContentDetailsItem(episode);
        setContentDetailsOpen(true);
    }, []);

    const handleToggleExpand = useCallback((id: number) => {
        setExpandedEpisode(prev => prev === id ? null : id);
    }, []);

    const handleMarkWatched = useCallback(async (episode: MediaItem) => {
        try {
            await markAsComplete(episode.id);
            await emit('media-marked-complete', { media_id: episode.id });
            setEpisodes((currentEpisodes) =>
                currentEpisodes.map((currentEpisode) =>
                    currentEpisode.id === episode.id
                        ? {
                            ...currentEpisode,
                            progress_percent: 100,
                            resume_position_seconds: 0,
                            duration_seconds: currentEpisode.duration_seconds ?? episode.duration_seconds,
                            last_watched: new Date().toISOString(),
                        }
                        : currentEpisode,
                ),
            );
            await loadEpisodes();
            toast({
                title: "Marked as watched",
                description: `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')} saved to history.`,
            });
        } catch (error) {
            console.warn("Failed to mark episode as watched:", error);
            toast({ title: "Error", description: "Failed to mark episode as watched", variant: "destructive" });
        }
    }, [toast]);

    const handleDetailsPrimaryAction = async (episode: MediaItem) => {
        setContentDetailsOpen(false);
        setContentDetailsItem(null);
        await handlePlay(episode);
    }

    const launchPlaybackWithZipLoading = useCallback(
        async (
            episode: MediaItem,
            resume: boolean,
            audioPreference: string | null,
            subtitlePreference: string | null,
        ) => {
            const loadingState = episode.parent_zip_id
                ? buildZipPlaybackLoadingState(episode, resume)
                : null;
            let overlayVisibleSince = 0;

            if (loadingState) {
                setZipPlaybackLoading(loadingState);
                await waitForZipLoadingOverlayPaint();
                overlayVisibleSince = Date.now();
            }

            try {
                await playMedia(episode.id, resume, audioPreference, subtitlePreference);
                if (loadingState) {
                    await waitForMpvPlaybackStart(episode.id);
                    await waitForMinimumZipOverlayVisibility(
                        overlayVisibleSince,
                    );
                }
            } finally {
                if (loadingState) {
                    setZipPlaybackLoading(null);
                }
            }
        },
        [],
    );

    const handlePlay = async (episode: MediaItem) => {
        try {
            const resumeInfo = await getResumeInfo(episode.id);

            if (resumeInfo.has_progress && !isProgressPastAutoCompleteThreshold(resumeInfo.progress_percent)) {
                setResumeDialogData({ episode, resumeInfo });
                setResumeDialogOpen(true);
            } else {
                await startPlayback(episode, 0);
            }
        } catch (error) {
            console.warn("Failed to start playback (handlePlay):", error);
            toast({ title: "Error", description: "Failed to start playback", variant: "destructive" })
        }
    }

    const handleResumeChoice = async (resume: boolean) => {
        if (!resumeDialogData) return;
        const { episode, resumeInfo } = resumeDialogData;
        const resumeTime = resume ? resumeInfo.position : 0;
        await startPlayback(episode, resumeTime);
    }

    const startPlayback = async (episode: MediaItem, resumeTime: number) => {
        try {
            await launchPlaybackWithZipLoading(
                episode,
                resumeTime > 0,
                resolveSeriesAudioPreferenceForPlayback(
                    show.id,
                    episode.season_number,
                ),
                resolveSeriesSubtitlePreferenceForPlayback(
                    show.id,
                    episode.season_number,
                ),
            );
            toast({
                title: "Playing",
                description: `Now playing S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
            });
        } catch (error) {
            console.warn("Failed to start playback:", error);
            toast({ title: "Error", description: "Failed to start playback", variant: "destructive" })
        }

        setPendingPlayEpisode(null);
    }

    const handlePlayerSelect = useCallback((_player: 'mpv' | 'vlc' | 'builtin') => {
        if (pendingPlayEpisode) {
            void startPlayback(pendingPlayEpisode, 0);
        }
    }, [pendingPlayEpisode]);

    const imageSrc = posterUrl || `https://placehold.co/400x600/1a1a2e/3a3a4e?text=${encodeURIComponent(show.title.slice(0, 2))}`;

    return (
        <>
            <ZipPlaybackLoadingOverlay loadingState={zipPlaybackLoading} zIndexClassName="z-[200]" />

            <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="h-full flex flex-col overflow-hidden"
            >
                {/* Back Button - Fixed at top */}
                <button
                    onClick={onBack}
                    className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-4 w-fit flex-shrink-0"
                >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="text-sm font-medium">
                        {show.is_cloud ? 'Back to Cloud TV Shows' : 'Back to TV Shows'}
                    </span>
                </button>

                {/* Main Content - Two column layout */}
                <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
                    {/* Left: Show Info - Fixed/Sticky sidebar */}
                    <div className="w-full lg:w-48 xl:w-56 flex-shrink-0 lg:h-full lg:overflow-y-auto">
                        {/* Poster - smaller on lg screens */}
                        <div className="rounded-xl overflow-hidden shadow-elevation-2 mb-3 lg:mb-4">
                            <img
                                src={imageSrc}
                                alt={show.title}
                                className="w-full aspect-[2/3] object-cover max-h-[200px] lg:max-h-none"
                            />
                        </div>

                        {/* Title & Info */}
                        <h1 className="text-base lg:text-lg xl:text-xl font-bold text-foreground mb-1 lg:mb-2 line-clamp-2">{show.title}</h1>
                        {show.year && (
                            <p className="text-sm text-muted-foreground mb-2 lg:mb-3">{show.year}</p>
                        )}

                        {/* Stats */}
                        <div className="flex gap-1.5 lg:gap-2 mb-2 lg:mb-3 flex-wrap">
                            <div className="px-2 py-0.5 lg:px-2.5 lg:py-1 rounded-lg bg-muted text-xs">
                                {seasons.length} Season{seasons.length !== 1 ? 's' : ''}
                            </div>
                            <div className="px-2 py-0.5 lg:px-2.5 lg:py-1 rounded-lg bg-muted text-xs">
                                {episodes.length} Ep{episodes.length !== 1 ? 's' : ''}
                            </div>
                            {show.tmdb_id && (
                                <button
                                    onClick={handleRefreshMetadata}
                                    disabled={isRefreshing}
                                    className="px-2 py-0.5 lg:px-2.5 lg:py-1 rounded-lg bg-muted hover:bg-muted/80 text-xs flex items-center gap-1 transition-colors disabled:opacity-50"
                                    title="Refresh metadata and images from TMDB"
                                >
                                    <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
                                    {isRefreshing ? "..." : "↻"}
                                </button>
                            )}
                            {filteredEpisodes.some(ep => ep.file_path) && (
                                <button
                                    onClick={() => setShowEpisodeUrls(true)}
                                    className="px-2 py-0.5 lg:px-2.5 lg:py-1 rounded-lg bg-muted hover:bg-muted/80 text-xs flex items-center gap-1 transition-colors"
                                    title="Show file names for all episodes in this season"
                                >
                                    <FileText className="w-3 h-3" />
                                    Files
                                </button>
                            )}
                        </div>

                        {/* Overview - hidden on smaller screens */}
                        {show.overview && (
                            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 hidden xl:block">
                                {show.overview}
                            </p>
                        )}
                    </div>

                    {/* Right: Episodes Panel - This is the scrolling area */}
                    <div className="flex-1 flex flex-col min-h-0 h-full">
                        {/* Season Tabs - Fixed at top of episode panel */}
                        {seasons.length > 1 && (
                            <div className="flex gap-2 mb-3 flex-wrap flex-shrink-0">
                                {seasons.map((season) => (
                                    <button
                                        key={season}
                                        onClick={() => setSelectedSeason(season)}
                                        className={cn(
                                            "px-3 py-1.5 rounded-lg text-xs lg:text-sm font-medium transition-all duration-200",
                                            selectedSeason === season
                                                ? "bg-white text-black"
                                                : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80"
                                        )}
                                    >
                                        Season {season}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Episode List */}
                        <div className="flex-1 rounded-xl border border-border bg-card overflow-hidden min-h-0">
                            <ScrollArea className="h-full">
                                {loading ? (
                                    <div className="p-8 flex items-center justify-center text-muted-foreground">
                                        <Loader2 className="w-6 h-6 animate-spin mr-2" />
                                        Loading episodes...
                                    </div>
                                ) : filteredEpisodes.length === 0 ? (
                                    <div className="p-8 text-center text-muted-foreground">
                                        No episodes found for Season {selectedSeason}
                                    </div>
                                ) : (
                                    <div className="divide-y divide-border pb-4">
                                        {episodesToRender.map((episode, index) => {
                                            const tmdbData = tmdbEpisodesBySeason
                                                .get(selectedSeason)
                                                ?.get(episode.episode_number || 0);

                                            return (
                                                <EpisodeItem
                                                    key={episode.id}
                                                    episode={episode}
                                                    index={index}
                                                    tmdbData={tmdbData}
                                                    isExpanded={expandedEpisode === episode.id}
                                                    onEpisodeClick={handleEpisodeClick}
                                                    onToggleExpand={handleToggleExpand}
                                                    onMarkWatched={handleMarkWatched}
                                                    onWatchTogether={onWatchTogether}
                                                />
                                            );
                                        })}
                                        {filteredEpisodes.length > visibleEpisodeCount && (
                                            <div
                                                ref={loadMoreRef}
                                                className="h-16 flex items-center justify-center text-xs text-muted-foreground/70"
                                            >
                                                Loading more episodes...
                                            </div>
                                        )}
                                    </div>
                                )}
                            </ScrollArea>
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Player Selection Modal */}
            <PlayerModal
                open={playerModalOpen}
                onOpenChange={setPlayerModalOpen}
                onSelectPlayer={handlePlayerSelect}
                title={pendingPlayEpisode ? `S${String(pendingPlayEpisode.season_number).padStart(2, '0')}E${String(pendingPlayEpisode.episode_number).padStart(2, '0')} - ${pendingPlayEpisode.title}` : ''}
            />

            {/* Resume Dialog */}
            {resumeDialogData && (
                <ResumeDialog
                    open={resumeDialogOpen}
                    onOpenChange={setResumeDialogOpen}
                    title={show.title}
                    mediaType={resumeDialogData.episode.media_type}
                    seasonEpisode={`S${String(resumeDialogData.episode.season_number).padStart(2, '0')}E${String(resumeDialogData.episode.episode_number).padStart(2, '0')}`}
                    currentPosition={resumeDialogData.resumeInfo.position}
                    duration={resumeDialogData.resumeInfo.duration}
                    posterUrl={posterUrl || undefined}
                    onResume={() => handleResumeChoice(true)}
                    onStartOver={() => handleResumeChoice(false)}
                />
            )}

            {/* Content Details Modal */}
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
                <DialogContent className="sm:max-w-2xl max-h-[80vh] !h-[80vh] flex flex-col">
                    <DialogTitle className="text-lg font-bold text-white px-1 shrink-0">
                        Episode Files — {show.title} (Season {selectedSeason})
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
                                    const episodeLabel = `S${String(ep.season_number || selectedSeason).padStart(2, '0')}E${String(ep.episode_number || 0).padStart(2, '0')} — ${ep.episode_title || ep.title}`
                                    const fileName = (() => {
                                        const p = ep.file_path || ep.zip_entry_path
                                        if (!p) return ''
                                        const norm = p.replace(/\\/g, '/')
                                        const idx = norm.lastIndexOf('/')
                                        return idx >= 0 ? norm.slice(idx + 1) : norm
                                    })()
                                    return (
                                        <div key={ep.id} className="flex items-start gap-2 p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-colors">
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-semibold text-white/90 truncate">{episodeLabel}</p>
                                                <p className="text-xs text-white/50 break-all mt-0.5 select-all">{fileName}</p>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    navigator.clipboard.writeText(fileName)
                                                }}
                                                className="flex items-center gap-1 shrink-0 h-8 px-2.5 rounded-md bg-white/10 hover:bg-white/15 text-white/70 hover:text-white text-xs font-medium transition-colors"
                                                title="Copy file name"
                                            >
                                                <Copy className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    )
                                })}
                            {filteredEpisodes.filter(ep => ep.file_path || ep.zip_entry_path).length === 0 && (
                                <p className="text-sm text-white/40 text-center py-8">No file path info available for episodes in this season.</p>
                            )}
                        </div>
                    </ScrollArea>
                </DialogContent>
            </Dialog>
        </>
    )
}
