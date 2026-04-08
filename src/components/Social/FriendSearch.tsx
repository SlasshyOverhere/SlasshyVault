import { useState, useMemo } from 'react';
import { Search, UserPlus, Loader2, User } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { searchUsers, sendFriendRequest } from '@/services/social';
import { useToast } from '@/components/ui/use-toast';

interface FriendSearchProps {
  excludeIds: string[];
}

export function FriendSearch({ excludeIds }: FriendSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setSearchResults] = useState<{ id: string; displayName: string; avatarUrl: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<string[]>([]);
  const { toast } = useToast();

  // ⚡ Bolt: Performance Optimization - Use Sets for O(1) lookups
  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const pendingSet = useMemo(() => new Set(pendingRequests), [pendingRequests]);

  const handleSearch = async (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setLoading(true);
    try {
      const data = await searchUsers(value);
      setSearchResults(data.filter(u => !excludeSet.has(u.id)));
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddFriend = async (userId: string, name: string) => {
    try {
      await sendFriendRequest(userId);
      setPendingRequests(prev => [...prev, userId]);
      toast({
        title: "Request Sent",
        description: `Friend request sent to ${name}`,
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to send friend request",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="relative group">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center">
          {loading ? (
            <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />
          ) : (
            <Search className="w-4 h-4 text-zinc-500 group-focus-within:text-purple-500 transition-colors" />
          )}
        </div>
        <Input
          placeholder="Search for friends..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-10 bg-zinc-800/50 border-zinc-700/50 focus:border-purple-500/50 focus:ring-purple-500/20 transition-all rounded-xl"
        />
      </div>

      <div className="space-y-2">
<<<<<<< HEAD
        {results.map((user) => {
          // ⚡ Bolt: Cache pending status calculation to avoid multiple Array.includes calls in render
          const isPending = pendingRequests.includes(user.id);
          return (
            <div
              key={user.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-zinc-800/30 border border-white/[0.03] hover:border-white/10 transition-all duration-200"
            >
=======
<<<<<<< HEAD
        {results.map((user) => (
          <div
            key={user.id}
            className="flex items-center gap-3 p-3 rounded-xl bg-zinc-800/30 border border-white/[0.03] hover:border-white/10 transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-full bg-zinc-800 border border-white/5 overflow-hidden">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-500 bg-gradient-to-br from-zinc-800 to-zinc-900">
                  <User className="w-5 h-5 opacity-50" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-zinc-200 truncate">{user.displayName}</p>
            </div>
            <Button
              size="sm"
              disabled={pendingRequestsSet.has(user.id)}
              onClick={() => handleAddFriend(user.id, user.displayName)}
              className="bg-purple-600 hover:bg-purple-700 text-white rounded-lg h-8 text-xs font-bold"
            >
              {pendingRequestsSet.has(user.id) ? (
                "Sent"
              ) : (
                <>
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                  Add
                </>
              )}
            </Button>
          </div>
        ))}
=======
        {results.map((user) => {
          const isPending = pendingSet.has(user.id);
          return (
            <div
              key={user.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-zinc-800/30 border border-white/[0.03] hover:border-white/10 transition-all duration-200"
            >
>>>>>>> ccc24b0e040b432eed94c364b868ef4a0a6d6bf5
              <div className="w-10 h-10 rounded-full bg-zinc-800 border border-white/5 overflow-hidden">
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-500 bg-gradient-to-br from-zinc-800 to-zinc-900">
                    <User className="w-5 h-5 opacity-50" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-zinc-200 truncate">{user.displayName}</p>
              </div>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() => handleAddFriend(user.id, user.displayName)}
                className="bg-purple-600 hover:bg-purple-700 text-white rounded-lg h-8 text-xs font-bold"
              >
                {isPending ? (
                  "Sent"
                ) : (
                  <>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                    Add
                  </>
                )}
              </Button>
            </div>
          );
        })}
<<<<<<< HEAD
=======
>>>>>>> 0cea0afb4e8ebd9471cf847d9b4ec3e924a4b8ea
>>>>>>> ccc24b0e040b432eed94c364b868ef4a0a6d6bf5

        {query.length >= 2 && !loading && results.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-sm italic">
            No users found matching "{query}"
          </div>
        )}
      </div>
    </div>
  );
}
