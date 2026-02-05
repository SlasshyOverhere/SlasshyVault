import { CurrentlyWatching } from '@/services/social';
import { Film, Tv, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';

interface FriendActivityProps {
  watching: (CurrentlyWatching & { userId: string; userName: string; userAvatar?: string })[];
  onJoinWatch: (item: CurrentlyWatching & { userId: string }) => void;
  onViewProfile: (userId: string) => void;
}

export function FriendActivity({ watching, onJoinWatch, onViewProfile }: FriendActivityProps) {
  if (watching.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mb-3 text-zinc-600">
          <Film className="w-6 h-6" />
        </div>
        <p className="text-zinc-500 text-sm font-medium">No one is watching anything right now</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {watching.map((item) => (
        <motion.div
          key={item.userId}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative overflow-hidden bg-zinc-800/40 border border-white/[0.03] rounded-2xl p-4 hover:border-white/10 transition-all duration-300 group"
        >
          {/* Background Poster Blur */}
          {item.posterPath && (
            <div 
              className="absolute inset-0 opacity-10 blur-2xl scale-150 pointer-events-none transition-transform duration-700 group-hover:scale-[1.75]"
              style={{ backgroundImage: `url(${item.posterPath})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
            />
          )}

          <div className="relative z-10 space-y-3">
            <div 
              className="flex items-center gap-2 cursor-pointer group/user"
              onClick={() => onViewProfile(item.userId)}
            >
              <div className="w-6 h-6 rounded-full bg-zinc-700 overflow-hidden ring-1 ring-white/10">
                {item.userAvatar ? (
                  <img src={item.userAvatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-400 font-bold">
                    {item.userName.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <span className="text-xs font-semibold text-zinc-300 group-hover/user:text-white transition-colors">
                {item.userName}
              </span>
              <span className="text-[10px] text-zinc-500 font-medium ml-auto uppercase tracking-tighter">Watching Now</span>
            </div>

            <div className="flex gap-3">
              <div className="w-14 h-20 bg-zinc-900 rounded-lg overflow-hidden shrink-0 shadow-lg ring-1 ring-white/5">
                {item.posterPath ? (
                  <img src={item.posterPath} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-700">
                    {item.contentType === 'movie' ? <Film className="w-6 h-6" /> : <Tv className="w-6 h-6" />}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <h4 className="text-sm font-bold text-white truncate leading-tight mb-1">{item.title}</h4>
                <div className="flex items-center gap-1.5 text-xs text-purple-400 font-medium">
                  {item.contentType === 'movie' ? (
                    <Film className="w-3 h-3 shrink-0 opacity-70" />
                  ) : (
                    <Tv className="w-3 h-3 shrink-0 opacity-70" />
                  )}
                  <span className="truncate">
                    {item.contentType === 'movie' ? 'Movie' : `S${item.season} E${item.episode}`}
                  </span>
                </div>
              </div>
            </div>

            <Button
              className="w-full h-9 bg-white text-black hover:bg-zinc-200 font-bold rounded-xl gap-2 shadow-lg shadow-black/20"
              onClick={() => onJoinWatch(item)}
            >
              <Users className="w-4 h-4" />
              <span>Join Together</span>
            </Button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
