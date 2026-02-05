import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, UserPlus, Zap, Clock, X, Search as SearchIcon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { 
  getFriends, 
  getPendingRequests, 
  getFriendsWatching,
  acceptFriendRequest,
  rejectFriendRequest,
  onSocialEvent,
  Friend,
  FriendRequest,
  CurrentlyWatching
} from '@/services/social';
import { FriendsList } from './FriendsList';
import { FriendSearch } from './FriendSearch';
import { FriendRequests } from './FriendRequests';
import { FriendActivity } from './FriendActivity';

interface SocialSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenChat: (friend: Friend) => void;
  onViewProfile: (userId: string) => void;
  onJoinWatch: (item: CurrentlyWatching & { userId: string }) => void;
}

type Tab = 'friends' | 'activity' | 'requests' | 'search';

export function SocialSidebar({ isOpen, onClose, onOpenChat, onViewProfile, onJoinWatch }: SocialSidebarProps) {
  const [activeTab, setActiveTab] = useState<Tab>('friends');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [watching, setWatching] = useState<(CurrentlyWatching & { userId: string; userName: string; userAvatar?: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadAllData();
    }
  }, [isOpen]);

  useEffect(() => {
    const unsubOnline = onSocialEvent('friend_online', (data) => {
      setOnlineIds(prev => [...new Set([...prev, data.userId as string])]);
    });

    const unsubOffline = onSocialEvent('friend_offline', (data) => {
      setOnlineIds(prev => prev.filter(id => id !== data.userId));
    });

    const unsubRequest = onSocialEvent('friend_request', () => {
      loadRequests();
    });

    const unsubAccepted = onSocialEvent('friend_accepted', () => {
      loadFriends();
    });

    const unsubWatching = onSocialEvent('currently_watching', () => {
      loadWatching();
    });

    return () => {
      unsubOnline();
      unsubOffline();
      unsubRequest();
      unsubAccepted();
      unsubWatching();
    };
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadFriends(),
        loadRequests(),
        loadWatching()
      ]);
    } catch (error) {
      console.error('Failed to load social data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadFriends = async () => {
    const data = await getFriends();
    setFriends(data.friends);
    setOnlineIds(data.online.map(f => f.id));
  };

  const loadRequests = async () => {
    const data = await getPendingRequests();
    setRequests(data);
  };

  const loadWatching = async () => {
    const data = await getFriendsWatching();
    setWatching(data);
  };

  const handleAccept = async (id: string) => {
    await acceptFriendRequest(id);
    loadRequests();
    loadFriends();
  };

  const handleReject = async (id: string) => {
    await rejectFriendRequest(id);
    loadRequests();
  };

  if (!isOpen) return null;

  const tabs: { id: Tab; icon: any; label: string; count?: number }[] = [
    { id: 'friends', icon: Users, label: 'Friends' },
    { id: 'activity', icon: Zap, label: 'Activity', count: watching.length },
    { id: 'requests', icon: Clock, label: 'Requests', count: requests.length },
    { id: 'search', icon: SearchIcon, label: 'Search' },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed right-0 top-0 h-full w-80 bg-zinc-950/95 backdrop-blur-2xl border-l border-white/[0.08] z-[100] flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-purple-500/20 flex items-center justify-center border border-purple-500/20">
              <Users className="w-4 h-4 text-purple-400" />
            </div>
            <h2 className="font-bold text-lg text-white tracking-tight">Social</h2>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={onClose}
            className="rounded-xl hover:bg-white/5 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex p-2 gap-1 bg-white/[0.01] border-b border-white/5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex-1 flex flex-col items-center justify-center py-2.5 rounded-xl transition-all duration-300 ${
                  isActive 
                    ? 'bg-white/10 text-white shadow-inner ring-1 ring-white/10' 
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                }`}
              >
                <Icon className={`w-4 h-4 mb-1 transition-transform duration-300 ${isActive ? 'scale-110' : ''}`} />
                <span className="text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="absolute top-1.5 right-2 flex h-4 w-4 items-center justify-center">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-20"></span>
                    <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-purple-500 text-[8px] font-black text-white items-center justify-center shadow-sm">
                      {tab.count}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content Area */}
        <ScrollArea className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              {activeTab === 'friends' && (
                <FriendsList 
                  friends={friends} 
                  onlineFriends={onlineIds} 
                  onOpenChat={onOpenChat}
                  onViewProfile={onViewProfile}
                  loading={loading}
                />
              )}
              {activeTab === 'activity' && (
                <FriendActivity 
                  watching={watching}
                  onJoinWatch={onJoinWatch}
                  onViewProfile={onViewProfile}
                />
              )}
              {activeTab === 'requests' && (
                <FriendRequests 
                  requests={requests}
                  onAccept={handleAccept}
                  onReject={handleReject}
                />
              )}
              {activeTab === 'search' && (
                <FriendSearch 
                  excludeIds={[...friends.map(f => f.id)]} 
                />
              )}
            </motion.div>
          </AnimatePresence>
        </ScrollArea>

        {/* Footer Info */}
        <div className="p-4 border-t border-white/5 bg-white/[0.01]">
          <div className="flex items-center justify-between text-[10px] font-bold text-zinc-600 uppercase tracking-[0.15em]">
            <span>{onlineIds.length} Friends Online</span>
            <span>{friends.length} Total</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
