import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Users, Shield, User, LogIn, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActivityFeed } from './ActivityFeed';
import { FriendsPanel } from './FriendsPanel';
import { ChatWindow } from './ChatWindow';
import { UserProfileModal } from './UserProfileModal';
import { PrivacySettings } from './PrivacySettings';
import { ProfileEditor } from './ProfileEditor';
import { invoke } from '@tauri-apps/api/tauri';
import {
  isSocialInitialized,
  restoreSocialConnection,
  getCachedProfile,
  initSocial,
  onSocialEvent,
  Friend,
  UserProfile,
  disconnectSocial,
  syncLocalWatchDataToSocial
} from '@/services/social';

interface SocialViewProps {
  onShowSettings?: () => void;
}

export function SocialView({ onShowSettings }: SocialViewProps) {
  const [isInitialized, setIsInitialized] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFriendsPanel, setShowFriendsPanel] = useState(false);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [activeChat, setActiveChat] = useState<Friend | null>(null);
  const [viewingProfileId, setViewingProfileId] = useState<string | null>(null);
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const [activityFeedKey, setActivityFeedKey] = useState(0);
  const autoSyncInProgressRef = useRef(false);

  useEffect(() => {
    checkInitialization();
    
    // Cleanup function to disconnect social when component unmounts
    return () => {
      if (isInitialized) {
        disconnectSocial();
      }
    };
  }, []);

  useEffect(() => {
    const unsubRequest = onSocialEvent('friend_request', () => {
      setPendingRequestsCount(prev => prev + 1);
    });

    return () => {
      unsubRequest();
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || autoSyncInProgressRef.current) return;

    autoSyncInProgressRef.current = true;
    syncLocalWatchDataToSocial()
      .then((syncResult) => {
        console.log('[SocialView] Auto-sync complete:', syncResult);
      })
      .catch((syncError) => {
        console.warn('[SocialView] Auto-sync failed:', syncError);
      })
      .finally(() => {
        autoSyncInProgressRef.current = false;
      });
  }, [isInitialized]);

  const checkInitialization = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isSocialInitialized()) {
        // Show cached profile immediately for instant UI
        const cached = getCachedProfile();
        if (cached) {
          setProfile(cached);
          setIsInitialized(true);
        }

        const restored = await restoreSocialConnection();
        if (restored) {
          setIsInitialized(true);
          // restoreSocialConnection already calls syncProfile() which updates the cache.
          // Use getCachedProfile() instead of a redundant getProfile() API call.
          const freshProfile = getCachedProfile();
          if (freshProfile) {
            setProfile(freshProfile);
          }
        } else if (!cached) {
          // Only mark as not initialized if we also don't have a cached profile
          setIsInitialized(false);
        }
      }
    } catch (err) {
      console.error('[SocialView] Check init error:', err);
      setError('Failed to initialize social features. Please try connecting again.');
    }
    setLoading(false);
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      // Check if Google Drive is connected
      const hasTokens = await invoke<boolean>('gdrive_is_connected');
      console.log('[SocialView] Google Drive connected:', hasTokens);

      if (!hasTokens) {
        setError('Please connect Google Drive first in Settings → Cloud Storage');
        onShowSettings?.();
        setConnecting(false);
        return;
      }

      // Get access token
      const accessToken = await invoke<string>('gdrive_get_access_token');
      console.log('[SocialView] Got access token:', accessToken ? 'yes' : 'no');

      if (!accessToken) {
        setError('Failed to get access token. Try reconnecting Google Drive.');
        setConnecting(false);
        return;
      }

      // Initialize social features
      console.log('[SocialView] Initializing social...');
      const profileData = await initSocial(accessToken);
      console.log('[SocialView] Init result:', profileData);

      if (profileData) {
        setProfile(profileData);
        setIsInitialized(true);
      } else {
        setError('Failed to initialize. Make sure the backend server is running.');
      }
    } catch (err) {
      console.error('[SocialView] Connect error:', err);
      setError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    setConnecting(false);
  };

  const handleDisconnect = () => {
    disconnectSocial();
    setIsInitialized(false);
    setProfile(null);
    setError(null);
  };

  const handleReconnect = async () => {
    // Disconnect first, then reconnect with a fresh token
    disconnectSocial();
    setProfile(null);
    setError(null);
    await handleConnect();
    // Bump key to force ActivityFeed to fully remount and re-fetch data
    setActivityFeedKey(prev => prev + 1);
  };

  const handleOpenChat = (friend: Friend) => {
    setActiveChat(friend);
    setShowFriendsPanel(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <span className="text-sm text-zinc-400">Loading social features...</span>
        </div>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-full">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center max-w-md p-8"
        >
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-purple-500/20 flex items-center justify-center">
            <Users className="w-10 h-10 text-purple-500" />
          </div>
          <h2 className="text-2xl font-bold mb-3">Social Features</h2>
          <p className="text-zinc-400 mb-6">
            Connect with friends, share what you're watching, and discover new content together.
            Your social data is securely stored in your Google Drive.
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <Button
            onClick={handleConnect}
            disabled={connecting}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {connecting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4 mr-2" />
                Connect with Google
              </>
            )}
          </Button>

          <p className="mt-4 text-xs text-zinc-500">
            Make sure the backend server is running on localhost:3000
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Social</h1>
          {profile && (
            <button
              onClick={() => setShowProfileEditor(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors cursor-pointer"
            >
              <div className="w-6 h-6 rounded-full bg-zinc-700 overflow-hidden">
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-full h-full p-1 text-zinc-500" />
                )}
              </div>
              <span className="text-sm font-medium">{profile.displayName}</span>
              <span className="text-xs text-zinc-500">
                @{profile.username || profile.email?.split('@')[0] || ''}
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPrivacySettings(true)}
            className="border-zinc-700"
          >
            <Shield className="w-4 h-4 mr-2" />
            Privacy
          </Button>
          <Button
            onClick={() => setShowFriendsPanel(true)}
            className="bg-purple-600 hover:bg-purple-700 relative"
          >
            <Users className="w-4 h-4 mr-2" />
            Friends
            {pendingRequestsCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-xs flex items-center justify-center">
                {pendingRequestsCount}
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            className="border-red-500/50 text-red-500 hover:bg-red-500/10"
          >
            <LogIn className="w-4 h-4 mr-2 rotate-180" />
            Disconnect
          </Button>
        </div>
      </div>

      {/* Activity Feed */}
      <ActivityFeed key={activityFeedKey} onViewProfile={setViewingProfileId} onReconnect={handleReconnect} />

      {/* Friends Panel */}
      <FriendsPanel
        isOpen={showFriendsPanel}
        onClose={() => setShowFriendsPanel(false)}
        onOpenChat={handleOpenChat}
        onViewProfile={(id) => {
          setViewingProfileId(id);
          setShowFriendsPanel(false);
        }}
      />

      {/* Chat Window */}
      {activeChat && (
        <ChatWindow
          friend={activeChat}
          onClose={() => setActiveChat(null)}
        />
      )}

      {/* Profile Modal */}
      {viewingProfileId && (
        <UserProfileModal
          userId={viewingProfileId}
          onClose={() => setViewingProfileId(null)}
          onChat={(_userId) => {
            // Find friend and open chat
            setViewingProfileId(null);
          }}
        />
      )}

      {/* Privacy Settings */}
      <PrivacySettings
        isOpen={showPrivacySettings}
        onClose={() => setShowPrivacySettings(false)}
      />

      {/* Profile Editor */}
      <ProfileEditor
        isOpen={showProfileEditor}
        onClose={() => setShowProfileEditor(false)}
        onProfileUpdated={(updatedProfile) => setProfile(updatedProfile)}
      />
    </div>
  );
}
