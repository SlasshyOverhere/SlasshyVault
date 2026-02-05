import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Eye, EyeOff, Shield, Users, Activity, Film, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  getProfile,
  updatePrivacySettings,
  PrivacySettings as PrivacySettingsType
} from '@/services/social';

interface PrivacySettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PrivacySettings({ isOpen, onClose }: PrivacySettingsProps) {
  const [settings, setSettings] = useState<PrivacySettingsType>({
    showStatsToFriends: true,
    showActivityToFriends: true,
    showCurrentlyWatching: true,
    allowFriendRequests: true
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const profile = await getProfile();
      if (profile?.privacySettings) {
        setSettings(profile.privacySettings);
      }
    } catch (error) {
      console.error('Failed to load privacy settings:', error);
      setError('Failed to load privacy settings. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (key: keyof PrivacySettingsType) => {
    const newSettings = { ...settings, [key]: !settings[key] };
    setSettings(newSettings);

    try {
      setSaving(true);
      await updatePrivacySettings({ [key]: newSettings[key] });
    } catch (error) {
      console.error('Failed to update privacy settings:', error);
      // Revert on error
      setSettings(settings);
      alert('Failed to update privacy setting. Please try again later.');
    } finally {
      setSaving(false);
    }
  };

  const retryLoad = () => {
    loadSettings();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-zinc-900 rounded-xl border border-zinc-800 w-full max-w-md"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-purple-500" />
            <h2 className="font-semibold">Privacy Settings</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4">
          {error ? (
            <div className="flex flex-col items-center justify-center py-8 text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-500 mb-4" />
              <p className="text-red-400 font-medium mb-2">Failed to load settings</p>
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
            <div className="flex items-center justify-center py-8 text-zinc-500">
              Loading...
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400 mb-4">
                Control what your friends can see about your activity.
              </p>

              {/* Show Stats */}
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                    <Activity className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <p className="font-medium">Watch Stats</p>
                    <p className="text-xs text-zinc-500">Movies watched, episodes, watch time</p>
                  </div>
                </div>
                <Switch
                  checked={settings.showStatsToFriends}
                  onCheckedChange={() => handleToggle('showStatsToFriends')}
                  disabled={saving}
                />
              </div>

              {/* Show Activity */}
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                    <Film className="w-5 h-5 text-purple-400" />
                  </div>
                  <div>
                    <p className="font-medium">Activity Feed</p>
                    <p className="text-xs text-zinc-500">What you've been watching</p>
                  </div>
                </div>
                <Switch
                  checked={settings.showActivityToFriends}
                  onCheckedChange={() => handleToggle('showActivityToFriends')}
                  disabled={saving}
                />
              </div>

              {/* Show Currently Watching */}
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                    {settings.showCurrentlyWatching ? (
                      <Eye className="w-5 h-5 text-green-400" />
                    ) : (
                      <EyeOff className="w-5 h-5 text-green-400" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium">Currently Watching</p>
                    <p className="text-xs text-zinc-500">Show what you're watching live</p>
                  </div>
                </div>
                <Switch
                  checked={settings.showCurrentlyWatching}
                  onCheckedChange={() => handleToggle('showCurrentlyWatching')}
                  disabled={saving}
                />
              </div>

              {/* Allow Friend Requests */}
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center">
                    <Users className="w-5 h-5 text-orange-400" />
                  </div>
                  <div>
                    <p className="font-medium">Friend Requests</p>
                    <p className="text-xs text-zinc-500">Allow others to send you requests</p>
                  </div>
                </div>
                <Switch
                  checked={settings.allowFriendRequests}
                  onCheckedChange={() => handleToggle('allowFriendRequests')}
                  disabled={saving}
                />
              </div>

              {saving && (
                <p className="text-xs text-center text-zinc-500">Saving...</p>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
