import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  User, Camera, X, MapPin, Film, Clock,
  BarChart3, Edit3, Check, AtSign, AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  getProfile,
  updateProfile,
  UserProfile,
  formatWatchTime
} from '@/services/social';

interface ProfileEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileUpdated?: (profile: UserProfile) => void;
}

const GENRE_OPTIONS = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi',
  'Thriller', 'Western'
];

export function ProfileEditor({ isOpen, onClose, onProfileUpdated }: ProfileEditorProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Editable fields
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [favoriteGenre, setFavoriteGenre] = useState('');
  const [location, setLocation] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadProfile();
    }
  }, [isOpen]);

  const loadProfile = async () => {
    try {
      setLoading(true);
      setError(null);
      const profileData = await getProfile();
      if (profileData) {
        setProfile(profileData);
        setDisplayName(profileData.displayName || '');
        setBio(profileData.bio || '');
        setFavoriteGenre(profileData.favoriteGenre || '');
        setLocation(profileData.location || '');
      } else {
        setError('Failed to load profile data');
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
      setError('Failed to load profile. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!profile) return;

    setSaving(true);
    try {
      const updatedProfile = await updateProfile({
        displayName: displayName.trim() || profile.username,
        bio: bio.trim(),
        favoriteGenre,
        location: location.trim()
      });
      setProfile(updatedProfile);
      onProfileUpdated?.(updatedProfile);
      setEditMode(false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      alert('Failed to save profile. Please try again later.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (profile) {
      setDisplayName(profile.displayName || '');
      setBio(profile.bio || '');
      setFavoriteGenre(profile.favoriteGenre || '');
      setLocation(profile.location || '');
    }
    setEditMode(false);
  };

  const retryLoad = () => {
    loadProfile();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-zinc-900 rounded-xl border border-zinc-800 w-full max-w-lg max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold">My Profile</h2>
          <div className="flex items-center gap-2">
            {!editMode ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditMode(true)}
                className="border-zinc-700"
                disabled={loading || !!error}
              >
                <Edit3 className="w-4 h-4 mr-2" />
                Edit
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  disabled={saving}
                >
                  <X className="w-4 h-4 mr-1" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-purple-600 hover:bg-purple-700"
                >
                  {saving ? (
                    'Saving...'
                  ) : (
                    <>
                      <Check className="w-4 h-4 mr-1" />
                      Save
                    </>
                  )}
                </Button>
              </>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
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
              >
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              Loading profile...
            </div>
          ) : profile ? (
            <div className="p-6 space-y-6">
              {/* Avatar & Basic Info */}
              <div className="flex items-start gap-4">
                <div className="relative group">
                  <div className="w-24 h-24 rounded-full bg-zinc-800 overflow-hidden border-4 border-zinc-700">
                    {profile.avatarUrl ? (
                      <img
                        src={profile.avatarUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-4xl text-zinc-500">
                        {profile.displayName?.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity cursor-pointer">
                    <Camera className="w-6 h-6 text-white" />
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  {editMode ? (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-xs text-zinc-500">Display Name</Label>
                        <Input
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Your display name"
                          className="mt-1 bg-zinc-800 border-zinc-700"
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <h3 className="text-xl font-bold truncate">{profile.displayName}</h3>
                      <p className="text-zinc-500 flex items-center gap-1">
                        <AtSign className="w-4 h-4" />
                        {profile.username}
                      </p>
                    </>
                  )}
                </div>
              </div>

              {/* Username (read-only) */}
              <div className="p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <AtSign className="w-4 h-4" />
                  <span>Username:</span>
                  <span className="text-white font-medium">
                    @{profile.username || profile.email?.split('@')[0] || 'loading...'}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mt-1">
                  Username is based on your Google account and cannot be changed
                </p>
              </div>

              {/* Bio */}
              <div>
                <Label className="text-sm text-zinc-400 flex items-center gap-2">
                  <User className="w-4 h-4" />
                  Bio
                </Label>
                {editMode ? (
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Tell others about yourself..."
                    maxLength={200}
                    className="mt-2 w-full h-24 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                ) : (
                  <p className="mt-2 text-sm text-zinc-300">
                    {profile.bio || <span className="text-zinc-500 italic">No bio yet</span>}
                  </p>
                )}
                {editMode && (
                  <p className="text-xs text-zinc-500 mt-1">{bio.length}/200 characters</p>
                )}
              </div>

              {/* Favorite Genre */}
              <div>
                <Label className="text-sm text-zinc-400 flex items-center gap-2">
                  <Film className="w-4 h-4" />
                  Favorite Genre
                </Label>
                {editMode ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {GENRE_OPTIONS.map((genre) => (
                      <button
                        key={genre}
                        onClick={() => setFavoriteGenre(genre === favoriteGenre ? '' : genre)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          favoriteGenre === genre
                            ? 'bg-purple-600 text-white'
                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                        }`}
                      >
                        {genre}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm">
                    {profile.favoriteGenre ? (
                      <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-400">
                        {profile.favoriteGenre}
                      </span>
                    ) : (
                      <span className="text-zinc-500 italic">Not set</span>
                    )}
                  </p>
                )}
              </div>

              {/* Location */}
              <div>
                <Label className="text-sm text-zinc-400 flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  Location
                </Label>
                {editMode ? (
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="City, Country"
                    maxLength={50}
                    className="mt-2 bg-zinc-800 border-zinc-700"
                  />
                ) : (
                  <p className="mt-2 text-sm text-zinc-300">
                    {profile.location || <span className="text-zinc-500 italic">Not set</span>}
                  </p>
                )}
              </div>

              {/* Stats */}
              <div className="pt-4 border-t border-zinc-800">
                <Label className="text-sm text-zinc-400 flex items-center gap-2 mb-3">
                  <BarChart3 className="w-4 h-4" />
                  Watch Statistics
                </Label>
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-zinc-800/50 text-center">
                    <p className="text-2xl font-bold text-blue-400">
                      {profile.stats?.moviesWatched || 0}
                    </p>
                    <p className="text-xs text-zinc-500">Movies</p>
                  </div>
                  <div className="p-3 rounded-lg bg-zinc-800/50 text-center">
                    <p className="text-2xl font-bold text-purple-400">
                      {profile.stats?.tvEpisodesWatched || 0}
                    </p>
                    <p className="text-xs text-zinc-500">Episodes</p>
                  </div>
                  <div className="p-3 rounded-lg bg-zinc-800/50 text-center">
                    <p className="text-2xl font-bold text-green-400">
                      {formatWatchTime(profile.stats?.totalWatchTime || 0)}
                    </p>
                    <p className="text-xs text-zinc-500">Watch Time</p>
                  </div>
                </div>
              </div>

              {/* Member Since */}
              <div className="pt-4 border-t border-zinc-800 flex items-center gap-2 text-sm text-zinc-500">
                <Clock className="w-4 h-4" />
                <span>
                  Member since {new Date(profile.joinedAt || profile.createdAt || Date.now()).toLocaleDateString('en-US', {
                    month: 'long',
                    year: 'numeric'
                  })}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              Failed to load profile
            </div>
          )}
        </ScrollArea>
      </motion.div>
    </div>
  );
}
