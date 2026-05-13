import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Play, ChevronDown, ChevronUp, Calendar, Clock, Star, Tv } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/tauri';

interface TvSeasonInfo {
    season_number: number;
    name: string;
    episode_count: number;
    overview?: string;
    poster_path?: string;
    air_date?: string;
}

interface TvEpisodeInfo {
    episode_number: number;
    name: string;
    overview?: string;
    still_path?: string;
    air_date?: string;
    runtime?: number;
    vote_average?: number;
}

interface TvShowDetails {
    id: number;
    name: string;
    poster_path?: string;
    backdrop_path?: string;
    overview?: string;
    number_of_seasons: number;
    seasons: TvSeasonInfo[];
}

interface TvSeasonDetails {
    season_number: number;
    name: string;
    episodes: TvEpisodeInfo[];
}

interface EpisodeSelectorProps {
    tvId: number;
    title: string;
    posterPath?: string;
    backdropPath?: string;
    onSelect: (season: number, episode: number) => void;
    onClose: () => void;
}

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export function EpisodeSelector({
    tvId,
    title,
    posterPath,
    backdropPath,
    onSelect,
    onClose,
}: EpisodeSelectorProps) {
    const [isLoading, setIsLoading] = useState(true);
    const [tvDetails, setTvDetails] = useState<TvShowDetails | null>(null);
    const [selectedSeason, setSelectedSeason] = useState<number>(1);
    const [episodes, setEpisodes] = useState<TvEpisodeInfo[]>([]);
    const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expandedEpisode, setExpandedEpisode] = useState<number | null>(null);

    // Fetch TV show details
    useEffect(() => {
        const fetchDetails = async () => {
            setIsLoading(true);
            setError(null);
            try {
                const details = await invoke<TvShowDetails>('get_tv_details', { tvId });
                setTvDetails(details);
                if (details.seasons.length > 0) {
                    setSelectedSeason(details.seasons[0].season_number);
                }
            } catch (err: unknown) {
                console.error('Failed to fetch TV details:', err);
                setError(typeof err === 'string' ? err : 'Failed to load TV show details');
            } finally {
                setIsLoading(false);
            }
        };
        fetchDetails();
    }, [tvId]);

    // Fetch episodes when season changes
    useEffect(() => {
        if (!selectedSeason || !tvDetails) return;

        const fetchEpisodes = async () => {
            setIsLoadingEpisodes(true);
            try {
                const seasonDetails = await invoke<TvSeasonDetails>('get_tv_season_episodes', {
                    tvId,
                    seasonNumber: selectedSeason,
                });
                setEpisodes(seasonDetails.episodes);
            } catch (err: unknown) {
                console.error('Failed to fetch episodes:', err);
                setEpisodes([]);
            } finally {
                setIsLoadingEpisodes(false);
            }
        };
        fetchEpisodes();
    }, [tvId, selectedSeason, tvDetails]);

    const handleEpisodeClick = useCallback((episodeNumber: number) => {
        onSelect(selectedSeason, episodeNumber);
    }, [selectedSeason, onSelect]);

    const toggleEpisodeExpand = useCallback((episodeNumber: number) => {
        setExpandedEpisode(prev => prev === episodeNumber ? null : episodeNumber);
    }, []);

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const modalContent = (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[9998] flex items-center justify-center p-4"
                onClick={onClose}
            >
                {/* Backdrop with blur */}
                <div
                    className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                    style={{
                        backgroundImage: backdropPath
                            ? `linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.95)), url(${TMDB_IMAGE_BASE}/w1280${backdropPath})`
                            : undefined,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                    }}
                />

                {/* Modal Content */}
                <motion.div
                    initial={{ scale: 0.9, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.9, opacity: 0, y: 20 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="relative w-full max-w-4xl max-h-[85vh] bg-gradient-to-br from-slate-900/95 via-slate-800/95 to-slate-900/95 rounded-2xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Close Button */}
                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 hover:bg-white/10 transition-colors"
                    >
                        <X className="h-5 w-5 text-white" />
                    </button>

                    {/* Header */}
                    <div className="p-6 border-b border-white/10 bg-gradient-to-r from-white/10 to-transparent">
                        <div className="flex items-center gap-4">
                            {posterPath && (
                                <img
                                    src={`${TMDB_IMAGE_BASE}/w92${posterPath}`}
                                    alt={title}
                                    className="w-16 h-24 object-cover rounded-lg shadow-lg"
                                />
                            )}
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <Tv className="h-5 w-5 text-gray-400" />
                                    <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">TV Series</span>
                                </div>
                                <h2 className="text-2xl font-bold text-white">{title}</h2>
                                {tvDetails && (
                                    <p className="text-sm text-white/60 mt-1">
                                        {tvDetails.number_of_seasons} Season{tvDetails.number_of_seasons !== 1 ? 's' : ''} • Select an episode to stream
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Loading State */}
                    {isLoading && (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Loader2 className="h-12 w-12 animate-spin text-white" />
                            <p className="mt-4 text-white/60">Loading episodes...</p>
                        </div>
                    )}

                    {/* Error State */}
                    {error && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <p className="text-red-400 mb-4">{error}</p>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 bg-white text-black rounded-lg hover:bg-gray-200 transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    )}

                    {/* Content */}
                    {!isLoading && !error && tvDetails && (
                        <div className="flex flex-col md:flex-row h-[calc(85vh-120px)]">
                            {/* Season List */}
                            <div className="w-full md:w-56 border-b md:border-b-0 md:border-r border-white/10 p-4 overflow-x-auto md:overflow-y-auto bg-black/20">
                                <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3 px-2">Seasons</h3>
                                <div className="flex md:flex-col gap-2">
                                    {tvDetails.seasons.map((season) => (
                                        <button
                                            key={season.season_number}
                                            onClick={() => setSelectedSeason(season.season_number)}
                                            className={`flex-shrink-0 md:flex-shrink flex items-center gap-3 p-3 rounded-xl transition-all ${selectedSeason === season.season_number
                                                ? 'bg-white/20 border border-white/40 text-white'
                                                : 'bg-white/5 border border-transparent hover:bg-white/10 text-white/80 hover:text-white'
                                                }`}
                                        >
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${selectedSeason === season.season_number
                                                ? 'bg-white text-black'
                                                : 'bg-white/10 text-white/60'
                                                }`}>
                                                {season.season_number}
                                            </div>
                                            <div className="text-left hidden md:block">
                                                <div className="text-sm font-medium truncate max-w-[120px]">
                                                    {season.name}
                                                </div>
                                                <div className="text-xs text-white/50">
                                                    {season.episode_count} Episodes
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Episodes List */}
                            <div className="flex-1 overflow-y-auto p-4">
                                {isLoadingEpisodes ? (
                                    <div className="flex items-center justify-center py-12">
                                        <Loader2 className="h-8 w-8 animate-spin text-white" />
                                    </div>
                                ) : episodes.length === 0 ? (
                                    <div className="text-center py-12 text-white/50">
                                        No episodes available
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {episodes.map((episode) => (
                                            <motion.div
                                                key={episode.episode_number}
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: episode.episode_number * 0.02 }}
                                                className="group"
                                            >
                                                <div
                                                    className="relative flex items-start gap-4 p-3 rounded-xl bg-white/5 border border-transparent hover:border-white/30 hover:bg-white/10 transition-all cursor-pointer"
                                                    onClick={() => handleEpisodeClick(episode.episode_number)}
                                                >
                                                    {/* Episode Thumbnail */}
                                                    <div className="relative w-32 h-20 rounded-lg overflow-hidden bg-black/50 flex-shrink-0">
                                                        {episode.still_path ? (
                                                            <img
                                                                src={`${TMDB_IMAGE_BASE}/w300${episode.still_path}`}
                                                                alt={episode.name}
                                                                className="w-full h-full object-cover"
                                                                loading="lazy"
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-white/20 to-gray-600/20">
                                                                <Tv className="h-8 w-8 text-white/30" />
                                                            </div>
                                                        )}
                                                        {/* Play overlay */}
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/50 transition-colors">
                                                            <div className="p-2 rounded-full bg-white/90 scale-0 group-hover:scale-100 transition-transform shadow-lg">
                                                                <Play className="h-4 w-4 text-black fill-black" />
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Episode Info */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <span className="text-xs font-bold text-white bg-white/20 px-2 py-0.5 rounded">
                                                                E{String(episode.episode_number).padStart(2, '0')}
                                                            </span>
                                                            {episode.vote_average && episode.vote_average > 0 && (
                                                                <span className="flex items-center gap-1 text-xs text-gray-400">
                                                                    <Star className="h-3 w-3 fill-gray-400" />
                                                                    {episode.vote_average.toFixed(1)}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <h4 className="text-sm font-semibold text-white truncate pr-6">
                                                            {episode.name}
                                                        </h4>
                                                        <div className="flex items-center gap-3 mt-1 text-xs text-white/50">
                                                            {episode.air_date && (
                                                                <span className="flex items-center gap-1">
                                                                    <Calendar className="h-3 w-3" />
                                                                    {new Date(episode.air_date).toLocaleDateString()}
                                                                </span>
                                                            )}
                                                            {episode.runtime && (
                                                                <span className="flex items-center gap-1">
                                                                    <Clock className="h-3 w-3" />
                                                                    {episode.runtime}m
                                                                </span>
                                                            )}
                                                        </div>

                                                        {/* Expandable overview */}
                                                        {episode.overview && (
                                                            <>
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        toggleEpisodeExpand(episode.episode_number);
                                                                    }}
                                                                    className="flex items-center gap-1 mt-2 text-xs text-white hover:text-white/80 transition-colors"
                                                                >
                                                                    {expandedEpisode === episode.episode_number ? (
                                                                        <>
                                                                            <ChevronUp className="h-3 w-3" />
                                                                            Hide Details
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <ChevronDown className="h-3 w-3" />
                                                                            Show Details
                                                                        </>
                                                                    )}
                                                                </button>
                                                                <AnimatePresence>
                                                                    {expandedEpisode === episode.episode_number && (
                                                                        <motion.p
                                                                            initial={{ height: 0, opacity: 0 }}
                                                                            animate={{ height: 'auto', opacity: 1 }}
                                                                            exit={{ height: 0, opacity: 0 }}
                                                                            className="text-xs text-white/60 mt-2 line-clamp-3"
                                                                        >
                                                                            {episode.overview}
                                                                        </motion.p>
                                                                    )}
                                                                </AnimatePresence>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );

    // Render as portal to document.body to cover the sidebar
    return createPortal(modalContent, document.body);
}
