import { useMemo } from 'react';
import { Friend } from '@/services/social';
import { MessageCircle, Film, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FriendsListProps {
  friends: Friend[];
  onlineFriends: string[]; // Array of user IDs
  onOpenChat: (friend: Friend) => void;
  onViewProfile: (friendId: string) => void;
  loading?: boolean;
}

export function FriendsList({ friends, onlineFriends, onOpenChat, onViewProfile, loading }: FriendsListProps) {
  const onlineSet = useMemo(() => new Set(onlineFriends), [onlineFriends]);

  if (loading && friends.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 p-2 rounded-lg animate-pulse bg-zinc-800/20">
            <div className="w-10 h-10 rounded-full bg-zinc-800" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-zinc-800 rounded w-24" />
              <div className="h-2 bg-zinc-800 rounded w-16" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (friends.length === 0) {
    return (
      <div className="text-center py-12 px-4">
        <p className="text-zinc-500 text-sm">No friends yet. Add some to get started!</p>
      </div>
    );
  }

  // Sort: Online first, then by name
  const sortedFriends = useMemo(() => {
    return [...friends].sort((a, b) => {
      const aOnline = onlineSet.has(a.id);
      const bOnline = onlineSet.has(b.id);
      if (aOnline && !bOnline) return -1;
      if (!aOnline && bOnline) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [friends, onlineSet]);

  return (
    <div className="flex flex-col gap-1 p-2">
      {sortedFriends.map((friend) => {
        const isOnline = onlineSet.has(friend.id);
        return (
          <div
            key={friend.id}
            className="flex items-center gap-3 p-2 rounded-xl hover:bg-zinc-800/50 group transition-all duration-200"
          >
            <div className="relative cursor-pointer" onClick={() => onViewProfile(friend.id)}>
              <div className="w-10 h-10 rounded-full bg-zinc-800 border border-white/5 overflow-hidden shadow-inner">
                {friend.avatar ? (
                  <img src={friend.avatar} alt={friend.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-500 font-semibold bg-gradient-to-br from-zinc-800 to-zinc-900">
                    {friend.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className={cn(
                "absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full border-2 border-zinc-900 transition-colors duration-300",
                isOnline ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" : "bg-zinc-600"
              )} />
            </div>

            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onViewProfile(friend.id)}>
              <div className="flex items-center gap-1.5">
                <p className="font-semibold text-sm text-zinc-200 truncate">{friend.name}</p>
              </div>
              {friend.currentlyWatching ? (
                <div className="flex items-center gap-1.5 text-[11px] text-purple-400 font-medium">
                  {friend.currentlyWatching.contentType === 'movie' ? (
                    <Film className="w-3 h-3 shrink-0" />
                  ) : (
                    <Tv className="w-3 h-3 shrink-0" />
                  )}
                  <span className="truncate">Watching {friend.currentlyWatching.title}</span>
                </div>
              ) : (
                <p className={cn(
                  "text-[11px] font-medium transition-colors",
                  isOnline ? "text-green-500/80" : "text-zinc-500"
                )}>
                  {isOnline ? 'Online' : 'Offline'}
                </p>
              )}
            </div>

            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-white transition-all duration-200"
              onClick={() => onOpenChat(friend)}
            >
              <MessageCircle className="w-4 h-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
