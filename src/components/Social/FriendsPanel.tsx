import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, UserPlus, MessageCircle, Search, X, Check, Clock, Film, Tv, AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getFriends,
  getPendingRequests,
  searchUsers,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  onSocialEvent,
  Friend,
  FriendRequest,
  formatRelativeTime
} from '@/services/social';

interface FriendsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenChat: (friend: Friend) => void;
  onViewProfile: (friendId: string) => void;
}

export function FriendsPanel({ isOpen, onClose, onOpenChat, onViewProfile }: FriendsPanelProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [onlineFriends, setOnlineFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ id: string; displayName: string; avatarUrl: string | null }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<'friends' | 'requests' | 'add'>('friends');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadFriendsAndRequests();
    }
  }, [isOpen]);

  useEffect(() => {
    const unsubOnline = onSocialEvent('friend_online', (data) => {
      setOnlineFriends(prev => {
        const friend = friends.find(f => f.id === data.userId);
        if (friend && !prev.some(f => f.id === data.userId)) {
          return [...prev, friend];
        }
        return prev;
      });
    });

    const unsubOffline = onSocialEvent('friend_offline', (data) => {
      setOnlineFriends(prev => prev.filter(f => f.id !== data.userId));
    });

    const unsubRequest = onSocialEvent('friend_request', () => {
      loadRequests();
    });

    const unsubAccepted = onSocialEvent('friend_accepted', () => {
      loadFriends();
    });

    return () => {
      unsubOnline();
      unsubOffline();
      unsubRequest();
      unsubAccepted();
    };
  }, [friends]);

  const loadFriendsAndRequests = async () => {
    try {
      setLoading(true);
      setError(null);
      await Promise.all([loadFriends(), loadRequests()]);
    } catch (err) {
      setError('Failed to load friends data. Please try again later.');
      console.error('Failed to load friends data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFriends = async () => {
    try {
      const data = await getFriends();
      setFriends(data.friends);
      setOnlineFriends(data.online);
    } catch (error) {
      console.error('Failed to load friends:', error);
      throw error;
    }
  };

  const loadRequests = async () => {
    try {
      const data = await getPendingRequests();
      setRequests(data);
    } catch (error) {
      console.error('Failed to load requests:', error);
      throw error;
    }
  };

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const results = await searchUsers(query);
      setSearchResults(results.filter(r => !friends.some(f => f.id === r.id)));
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSendRequest = async (userId: string) => {
    try {
      await sendFriendRequest(userId);
      setSearchResults(prev => prev.filter(r => r.id !== userId));
      // Reload requests to show the new pending request
      loadRequests();
    } catch (error) {
      console.error('Failed to send request:', error);
    }
  };

  const handleAcceptRequest = async (fromId: string) => {
    try {
      await acceptFriendRequest(fromId);
      setRequests(prev => prev.filter(r => r.fromId !== fromId));
      loadFriends();
    } catch (error) {
      console.error('Failed to accept request:', error);
    }
  };

  const handleRejectRequest = async (fromId: string) => {
    try {
      await rejectFriendRequest(fromId);
      setRequests(prev => prev.filter(r => r.fromId !== fromId));
    } catch (error) {
      console.error('Failed to reject request:', error);
    }
  };

  const retryLoad = () => {
    loadFriendsAndRequests();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 300, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 300, opacity: 0 }}
        className="fixed right-0 top-0 h-full w-80 bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-500" />
            <h2 className="font-semibold">Friends</h2>
            {requests.length > 0 && (
              <span className="bg-purple-500 text-white text-xs px-2 py-0.5 rounded-full">
                {requests.length}
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800">
          <button
            onClick={() => setActiveTab('friends')}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              activeTab === 'friends' ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Friends ({friends.length})
          </button>
          <button
            onClick={() => setActiveTab('requests')}
            className={`flex-1 py-2 text-sm font-medium transition-colors relative ${
              activeTab === 'requests' ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Requests
            {requests.length > 0 && (
              <span className="absolute -top-1 right-4 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                {requests.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('add')}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              activeTab === 'add' ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <UserPlus className="w-4 h-4 mx-auto" />
          </button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1">
          {error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center p-4">
              <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
              <p className="text-red-400 font-medium mb-2">Failed to load friends</p>
              <p className="text-zinc-500 text-sm mb-4">{error}</p>
              <Button 
                variant="outline" 
                onClick={retryLoad}
                className="border-zinc-700"
              >
                Retry
              </Button>
            </div>
          ) : activeTab === 'friends' && (
            <div className="p-2">
              {/* Online Friends */}
              {onlineFriends.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase px-2 mb-2">
                    Online ({onlineFriends.length})
                  </h3>
                  {onlineFriends.map(friend => (
                    <FriendItem
                      key={friend.id}
                      friend={friend}
                      isOnline={true}
                      onChat={() => onOpenChat(friend)}
                      onViewProfile={() => onViewProfile(friend.id)}
                    />
                  ))}
                </div>
              )}

              {/* All Friends */}
              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase px-2 mb-2">
                  All Friends
                </h3>
                {loading ? (
                  <div className="text-center py-8 text-zinc-500">Loading...</div>
                ) : friends.length === 0 ? (
                  <div className="text-center py-8 text-zinc-500">
                    <Users className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No friends yet</p>
                    <p className="text-sm">Search and add friends to get started</p>
                  </div>
                ) : (
                  friends.map(friend => (
                    <FriendItem
                      key={friend.id}
                      friend={friend}
                      isOnline={onlineFriends.some(f => f.id === friend.id)}
                      onChat={() => onOpenChat(friend)}
                      onViewProfile={() => onViewProfile(friend.id)}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'requests' && (
            <div className="p-2">
              {loading ? (
                <div className="text-center py-8 text-zinc-500">Loading...</div>
              ) : requests.length === 0 ? (
                <div className="text-center py-8 text-zinc-500">
                  <Clock className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No pending requests</p>
                </div>
              ) : (
                requests.map(request => (
                  <div
                    key={request.fromId}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-800/50"
                  >
                    <div className="w-10 h-10 rounded-full bg-zinc-700 overflow-hidden">
                      {request.fromAvatar ? (
                        <img src={request.fromAvatar} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-400">
                          {request.fromName.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{request.fromName}</p>
                      <p className="text-xs text-zinc-500">{formatRelativeTime(request.sentAt)}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-green-500 hover:text-green-400 hover:bg-green-500/10"
                        onClick={() => handleAcceptRequest(request.fromId)}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-red-500 hover:text-red-400 hover:bg-red-500/10"
                        onClick={() => handleRejectRequest(request.fromId)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'add' && (
            <div className="p-4">
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <Input
                  placeholder="Search by name or email..."
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="pl-10 bg-zinc-800 border-zinc-700"
                />
              </div>

              {isSearching ? (
                <div className="text-center py-8 text-zinc-500">Searching...</div>
              ) : searchResults.length > 0 ? (
                <div className="space-y-2">
                  {searchResults.map(user => (
                    <div
                      key={user.id}
                      className="flex items-center gap-3 p-3 rounded-lg bg-zinc-800/50"
                    >
                      <div className="w-10 h-10 rounded-full bg-zinc-700 overflow-hidden">
                        {user.avatarUrl ? (
                          <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-400">
                            {user.displayName.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{user.displayName}</p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleSendRequest(user.id)}
                        className="bg-purple-600 hover:bg-purple-700"
                      >
                        <UserPlus className="w-4 h-4 mr-1" />
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              ) : searchQuery.length >= 2 ? (
                <div className="text-center py-8 text-zinc-500">
                  <Search className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No users found</p>
                </div>
              ) : (
                <div className="text-center py-8 text-zinc-500">
                  <UserPlus className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Search for users to add</p>
                  <p className="text-sm">Enter at least 2 characters</p>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </motion.div>
    </AnimatePresence>
  );
}

interface FriendItemProps {
  friend: Friend;
  isOnline: boolean;
  onChat: () => void;
  onViewProfile: () => void;
}

function FriendItem({ friend, isOnline, onChat, onViewProfile }: FriendItemProps) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/50 group">
      <div className="relative cursor-pointer" onClick={onViewProfile}>
        <div className="w-10 h-10 rounded-full bg-zinc-700 overflow-hidden">
          {friend.avatar ? (
            <img src={friend.avatar} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-400">
              {friend.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        {isOnline && (
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-zinc-900" />
        )}
      </div>

      <div className="flex-1 min-w-0 cursor-pointer" onClick={onViewProfile}>
        <p className="font-medium truncate">{friend.name}</p>
        {friend.currentlyWatching ? (
          <div className="flex items-center gap-1 text-xs text-purple-400">
            {friend.currentlyWatching.contentType === 'movie' ? (
              <Film className="w-3 h-3" />
            ) : (
              <Tv className="w-3 h-3" />
            )}
            <span className="truncate">Watching {friend.currentlyWatching.title}</span>
          </div>
        ) : isOnline ? (
          <p className="text-xs text-green-500">Online</p>
        ) : (
          <p className="text-xs text-zinc-500">Offline</p>
        )}
      </div>

      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onChat}
      >
        <MessageCircle className="w-4 h-4" />
      </Button>
    </div>
  );
}
