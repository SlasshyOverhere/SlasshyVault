import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Film, Tv, Filter, User, X, AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  getFriendsActivity,
  getFriendsWatching,
  onSocialEvent,
  Activity,
  CurrentlyWatching,
  formatRelativeTime
} from '@/services/social';

interface ActivityFeedProps {
  onViewProfile?: (userId: string) => void;
}

export function ActivityFeed({ onViewProfile }: ActivityFeedProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [watching, setWatching] = useState<(CurrentlyWatching & { userId: string; userName: string; userAvatar?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contentTypeFilter, setContentTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [genreFilter, setGenreFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Collect unique genres from activities
  const genres = [...new Set(activities.flatMap(a => a.genres || []))].sort();

  useEffect(() => {
    loadData();

    const unsubActivity = onSocialEvent('friend_activity', (data) => {
      setActivities(prev => [data.activity as Activity, ...prev].slice(0, 50));
    });

    const unsubWatching = onSocialEvent('currently_watching', () => {
      loadWatching();
    });

    return () => {
      unsubActivity();
      unsubWatching();
    };
  }, []);

  useEffect(() => {
    // Reset pagination when filters change
    setPage(1);
    setHasMore(true);
    loadActivities(true);
  }, [contentTypeFilter, genreFilter]);

  // Set up intersection observer for infinite scrolling
  useEffect(() => {
    if (!sentinelRef.current) return;

    // Clean up previous observer if exists
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          loadMore();
        }
      },
      { threshold: 1.0 }
    );

    observer.observe(sentinelRef.current);
    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, isLoadingMore]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      await Promise.all([loadActivities(true), loadWatching()]);
    } catch (err) {
      setError('Failed to load activity data. Please try again later.');
      console.error('Failed to load activity data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadActivities = async (reset = false) => {
    try {
      if (reset) {
        setLoading(true);
      } else {
        setIsLoadingMore(true);
      }

      const filters: { contentType?: 'movie' | 'tv'; genre?: string; page?: number } = {
        page: reset ? 1 : page
      };
      if (contentTypeFilter !== 'all') filters.contentType = contentTypeFilter;
      if (genreFilter !== 'all') filters.genre = genreFilter;

      const data = await getFriendsActivity(filters);
      
      if (reset) {
        setActivities(data);
      } else {
        setActivities(prev => [...prev, ...data]);
      }
      
      // Check if there are more items to load (assuming API returns less than page size when no more items)
      setHasMore(data.length > 0); // Simplified check - adjust based on actual API response
    } catch (error) {
      console.error('Failed to load activities:', error);
      if (reset) {
        setError('Failed to load activities. Please try again later.');
      }
    } finally {
      if (reset) {
        setLoading(false);
      } else {
        setIsLoadingMore(false);
      }
    }
  };

  const loadWatching = async () => {
    try {
      const data = await getFriendsWatching();
      setWatching(data);
    } catch (error) {
      console.error('Failed to load watching status:', error);
    }
  };

  const loadMore = () => {
    if (hasMore && !isLoadingMore) {
      setPage(prev => prev + 1);
      loadActivities();
    }
  };

  const retryLoad = () => {
    loadData();
  };

  return (
    <div className="h-full flex flex-col">
      {/* Currently Watching Section */}
      {watching.length > 0 && (
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            Friends Watching Now
          </h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {watching.map((item) => (
              <motion.div
                key={item.userId}
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="flex-shrink-0 w-40 bg-zinc-800/50 rounded-lg p-3 cursor-pointer hover:bg-zinc-800 transition-colors"
                onClick={() => onViewProfile?.(item.userId)}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-zinc-700 overflow-hidden">
                    {item.userAvatar ? (
                      <img src={item.userAvatar} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-full h-full p-1 text-zinc-500" />
                    )}
                  </div>
                  <span className="text-xs font-medium truncate">{item.userName}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-purple-400 mb-1">
                  {item.contentType === 'movie' ? (
                    <Film className="w-3 h-3" />
                  ) : (
                    <Tv className="w-3 h-3" />
                  )}
                  <span>Watching</span>
                </div>
                <p className="text-sm font-medium truncate">{item.title}</p>
                {item.season && item.episode && (
                  <p className="text-xs text-zinc-500">S{item.season} E{item.episode}</p>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 p-4 border-b border-zinc-800 flex-wrap">
        <Filter className="w-4 h-4 text-zinc-500" />

        {/* Content Type Filter */}
        <div className="flex rounded-lg bg-zinc-800 p-1">
          <button
            onClick={() => setContentTypeFilter('all')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              contentTypeFilter === 'all'
                ? 'bg-purple-600 text-white'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setContentTypeFilter('movie')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1 ${
              contentTypeFilter === 'movie'
                ? 'bg-purple-600 text-white'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Film className="w-3 h-3" />
            Movies
          </button>
          <button
            onClick={() => setContentTypeFilter('tv')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1 ${
              contentTypeFilter === 'tv'
                ? 'bg-purple-600 text-white'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Tv className="w-3 h-3" />
            TV Shows
          </button>
        </div>

        {/* Genre Filter - Simple dropdown alternative */}
        {genres.length > 0 && (
          <div className="relative group">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-zinc-700 bg-zinc-800"
            >
              {genreFilter === 'all' ? 'All Genres' : genreFilter}
            </Button>
            <div className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl hidden group-hover:block z-10 min-w-[140px] max-h-48 overflow-y-auto">
              <button
                onClick={() => setGenreFilter('all')}
                className={`w-full px-3 py-2 text-left text-xs hover:bg-zinc-700 ${
                  genreFilter === 'all' ? 'text-purple-400' : 'text-zinc-300'
                }`}
              >
                All Genres
              </button>
              {genres.map(genre => (
                <button
                  key={genre}
                  onClick={() => setGenreFilter(genre)}
                  className={`w-full px-3 py-2 text-left text-xs hover:bg-zinc-700 ${
                    genreFilter === genre ? 'text-purple-400' : 'text-zinc-300'
                  }`}
                >
                  {genre}
                </button>
              ))}
            </div>
          </div>
        )}

        {(contentTypeFilter !== 'all' || genreFilter !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setContentTypeFilter('all');
              setGenreFilter('all');
            }}
            className="h-8 text-xs text-zinc-500 hover:text-white"
          >
            <X className="w-3 h-3 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Activity List */}
      <ScrollArea ref={scrollAreaRef} className="flex-1">
        {error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center p-4">
            <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
            <p className="text-red-400 font-medium mb-2">Failed to load activity</p>
            <p className="text-zinc-500 text-sm mb-4">{error}</p>
            <Button 
              variant="outline" 
              onClick={retryLoad}
              className="border-zinc-700"
            >
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-12 text-zinc-500">
            Loading activity...
          </div>
        ) : activities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <Film className="w-12 h-12 mb-3 opacity-50" />
            <p>No activity yet</p>
            <p className="text-sm">Your friends' watch activity will appear here</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {activities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                onViewProfile={onViewProfile}
              />
            ))}
            
            {/* Sentinel element for infinite scroll detection */}
            <div 
              ref={sentinelRef} 
              className="h-1 w-full"
            />
            
            {isLoadingMore && (
              <div className="flex justify-center py-4">
                <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
            
            {!hasMore && activities.length > 0 && (
              <div className="text-center py-4 text-zinc-500 text-sm">
                You've reached the end of the activity feed
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ActivityItemProps {
  activity: Activity;
  onViewProfile?: (userId: string) => void;
}

function ActivityItem({ activity, onViewProfile }: ActivityItemProps) {
  const isMovie = activity.contentType === 'movie';

  return (
    <motion.div
      initial={{ y: 10, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="flex gap-3 p-3 bg-zinc-800/30 rounded-lg hover:bg-zinc-800/50 transition-colors"
    >
      {/* Poster */}
      <div className="w-16 h-24 bg-zinc-800 rounded overflow-hidden flex-shrink-0">
        {activity.posterPath ? (
          <img
            src={`https://image.tmdb.org/t/p/w92${activity.posterPath}`}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {isMovie ? <Film className="w-6 h-6 text-zinc-600" /> : <Tv className="w-6 h-6 text-zinc-600" />}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <div
            className="flex items-center gap-1.5 cursor-pointer hover:text-purple-400 transition-colors"
            onClick={() => activity.userId && onViewProfile?.(activity.userId)}
          >
            <div className="w-5 h-5 rounded-full bg-zinc-700 overflow-hidden">
              {activity.userAvatar ? (
                <img src={activity.userAvatar} alt="" className="w-full h-full object-cover" />
              ) : (
                <User className="w-full h-full p-0.5 text-zinc-500" />
              )}
            </div>
            <span className="text-sm font-medium">{activity.userName}</span>
          </div>
          <span className="text-xs text-zinc-500">watched</span>
        </div>

        <p className="font-medium truncate">{activity.title}</p>

        {activity.season && activity.episode && (
          <p className="text-sm text-zinc-400">
            Season {activity.season}, Episode {activity.episode}
          </p>
        )}

        <div className="flex items-center gap-2 mt-2">
          <span className={`text-xs px-2 py-0.5 rounded ${isMovie ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
            {isMovie ? 'Movie' : 'TV Show'}
          </span>
          {activity.genres?.slice(0, 2).map(genre => (
            <span key={genre} className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-400">
              {genre}
            </span>
          ))}
          <span className="text-xs text-zinc-500 ml-auto">
            {formatRelativeTime(activity.timestamp)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
