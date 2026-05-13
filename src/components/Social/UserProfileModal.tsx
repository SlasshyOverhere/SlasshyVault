import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Film, Tv, Clock, BarChart3, Eye, EyeOff, MessageCircle, UserMinus, AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  getFriendProfile,
  getMyActivity,
  removeFriend,
  UserProfile,
  Activity,
  formatWatchTime,
  formatRelativeTime
} from '@/services/social';

interface UserProfileModalProps {
  userId: string | null;
  isOwnProfile?: boolean;
  onClose: () => void;
  onChat?: (userId: string) => void;
}

export function UserProfileModal({ userId, isOwnProfile, onClose, onChat }: UserProfileModalProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (userId) {
      loadProfile();
    }
  }, [userId]);

  const loadProfile = async () => {
    if (!userId) return;

    try {
      setLoading(true);
      setError(null);
      const profileData = await getFriendProfile(userId);
      
      if (!profileData) {
        setError('Profile not found');
        return;
      }
      
      setProfile(profileData);

      if (isOwnProfile) {
        const activityData = await getMyActivity();
        setActivities(activityData.slice(0, 10));
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
      setError('Failed to load profile. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveFriend = async () => {
    if (!userId) return;
    if (!confirm('Are you sure you want to remove this friend?')) return;

    try {
      await removeFriend(userId);
      onClose();
    } catch (error) {
      console.error('Failed to remove friend:', error);
      alert('Failed to remove friend. Please try again later.');
    }
  };

  const retryLoad = () => {
    loadProfile();
  };

  if (!userId) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-zinc-900 rounded-xl border border-zinc-800 w-full max-w-md max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="font-semibold">Profile</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close profile">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center p-4">
              <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
              <p className="text-red-400 font-medium mb-2">Failed to load profile</p>
              <p className="text-zinc-500 text-sm mb-4">{error}</p>
              <Button 
                variant="outline" 
                onClick={retryLoad}
                className="border-zinc-700"
                aria-label="Retry loading profile"
              >
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              Loading profile...
            </div>
          ) : profile ? (
            <div className="p-4">
              {/* Profile Header */}
              <div className="flex items-center gap-4 mb-6">
                <div className="w-20 h-20 rounded-full bg-zinc-800 overflow-hidden">
                  {profile.avatarUrl ? (
                    <img src={profile.avatarUrl} alt={profile.displayName} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl text-zinc-500">
                      {profile.displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold">{profile.displayName}</h3>
                  <p className="text-sm text-zinc-500">
                    Member since {new Date(profile.createdAt || Date.now()).toLocaleDateString()}
                  </p>
                </div>
              </div>

              {/* Actions */}
              {!isOwnProfile && (
                <div className="flex gap-2 mb-6">
                    <Button
                    className="flex-1 bg-purple-600 hover:bg-purple-700"
                    onClick={() => onChat?.(userId)}
                    aria-label="Send message to user"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Message
                  </Button>
                  <Button
                    variant="outline"
                    className="border-red-500/50 text-red-500 hover:bg-red-500/10"
                    onClick={handleRemoveFriend}
                    aria-label="Remove friend"
                  >
                    <UserMinus className="w-4 h-4" />
                  </Button>
                </div>
              )}

              {/* Stats */}
              {profile.stats && (
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-zinc-400 mb-3 flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" />
                    Watch Stats
                  </h4>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="flex items-center justify-center gap-1 text-blue-400 mb-1">
                        <Film className="w-4 h-4" />
                      </div>
                      <p className="text-2xl font-bold">{profile.stats.moviesWatched}</p>
                      <p className="text-xs text-zinc-500">Movies</p>
                    </div>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="flex items-center justify-center gap-1 text-purple-400 mb-1">
                        <Tv className="w-4 h-4" />
                      </div>
                      <p className="text-2xl font-bold">{profile.stats.tvEpisodesWatched}</p>
                      <p className="text-xs text-zinc-500">Episodes</p>
                    </div>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="flex items-center justify-center gap-1 text-green-400 mb-1">
                        <Clock className="w-4 h-4" />
                      </div>
                      <p className="text-2xl font-bold">{formatWatchTime(profile.stats.totalWatchTime)}</p>
                      <p className="text-xs text-zinc-500">Watch Time</p>
                    </div>
                  </div>

                  {profile.stats.favoriteGenres.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-zinc-500 mb-2">Favorite Genres</p>
                      <div className="flex flex-wrap gap-2">
                        {profile.stats.favoriteGenres.map(genre => (
                          <span key={genre} className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-300">
                            {genre}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Privacy Indicators */}
              {!isOwnProfile && (
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-zinc-400 mb-3">Sharing</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-zinc-400">
                      {profile.privacySettings?.showStatsToFriends ? (
                        <Eye className="w-4 h-4 text-green-500" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-zinc-600" />
                      )}
                      <span>Stats {profile.privacySettings?.showStatsToFriends ? 'visible' : 'hidden'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-400">
                      {profile.privacySettings?.showActivityToFriends ? (
                        <Eye className="w-4 h-4 text-green-500" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-zinc-600" />
                      )}
                      <span>Activity {profile.privacySettings?.showActivityToFriends ? 'visible' : 'hidden'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-400">
                      {profile.privacySettings?.showCurrentlyWatching ? (
                        <Eye className="w-4 h-4 text-green-500" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-zinc-600" />
                      )}
                      <span>Currently watching {profile.privacySettings?.showCurrentlyWatching ? 'visible' : 'hidden'}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent Activity (own profile only) */}
              {isOwnProfile && activities.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-zinc-400 mb-3">Recent Activity</h4>
                  <div className="space-y-2">
                    {activities.map(activity => (
                      <div key={activity.id} className="flex items-center gap-3 p-2 bg-zinc-800/30 rounded">
                        <div className="w-8 h-12 bg-zinc-800 rounded overflow-hidden flex-shrink-0">
                          {activity.posterPath ? (
                              <img
                              src={`https://image.tmdb.org/t/p/w92${activity.posterPath}`}
                              alt={activity.title}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              {activity.contentType === 'movie' ? (
                                <Film className="w-4 h-4 text-zinc-600" />
                              ) : (
                                <Tv className="w-4 h-4 text-zinc-600" />
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{activity.title}</p>
                          <p className="text-xs text-zinc-500">{formatRelativeTime(activity.timestamp)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              User not found
            </div>
          )}
        </ScrollArea>
      </motion.div>
    </div>
  );
}
