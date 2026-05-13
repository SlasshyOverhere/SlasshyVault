import { FriendRequest, formatRelativeTime } from '@/services/social';
import { Check, X, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FriendRequestsProps {
  requests: FriendRequest[];
  onAccept: (fromId: string) => void;
  onReject: (fromId: string) => void;
}

export function FriendRequests({ requests, onAccept, onReject }: FriendRequestsProps) {
  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mb-3">
          <Clock className="w-6 h-6 text-zinc-600" />
        </div>
        <p className="text-zinc-500 text-sm font-medium">No pending requests</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      {requests.map((request) => (
        <div
          key={request.fromId}
          className="flex items-center gap-3 p-3 rounded-xl bg-zinc-800/30 border border-white/[0.03] animate-in slide-in-from-right-2 duration-300"
        >
          <div className="w-10 h-10 rounded-full bg-zinc-800 border border-white/5 overflow-hidden">
            {request.fromAvatar ? (
              <img src={request.fromAvatar} alt={`${request.fromName}'s avatar`} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-zinc-500 bg-gradient-to-br from-zinc-800 to-zinc-900 font-semibold text-sm">
                {request.fromName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-zinc-200 truncate">{request.fromName}</p>
            <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider mt-0.5">
              {formatRelativeTime(request.sentAt)}
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-lg bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-white transition-all duration-200 shadow-sm"
              onClick={() => onAccept(request.fromId)}
              aria-label={`Accept friend request from ${request.fromName}`}
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all duration-200 shadow-sm"
              onClick={() => onReject(request.fromId)}
              aria-label={`Reject friend request from ${request.fromName}`}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
