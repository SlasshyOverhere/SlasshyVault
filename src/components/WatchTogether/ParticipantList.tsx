import { WatchParticipant } from '@/services/api';
import { User, Crown, Check, Clock } from 'lucide-react';

interface ParticipantListProps {
    participants: WatchParticipant[];
    currentUserId?: string;
    syncStates?: Map<string, string>;
}

export function ParticipantList({ participants, currentUserId, syncStates }: ParticipantListProps) {
    if (!participants || participants.length === 0) {
        return (
            <div className="text-center py-6 text-zinc-500 text-sm">
                No participants
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {participants.map((participant) => (
                <div
                    key={participant.id}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                        participant.id === currentUserId
                            ? 'bg-purple-500/20 border border-purple-500/30'
                            : 'bg-zinc-800/50'
                    }`}
                >
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center">
                            {participant.is_host ? (
                                <Crown className="w-4 h-4 text-yellow-500" />
                            ) : (
                                <User className="w-4 h-4 text-zinc-400" />
                            )}
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-white">
                                    {participant.nickname}
                                </span>
                                {participant.id === currentUserId && (
                                    <span className="text-xs text-zinc-500">(you)</span>
                                )}
                            </div>
                            {participant.is_host && (
                                <span className="text-xs text-yellow-500">Host</span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {participant.is_ready ? (
                            <div className="flex items-center gap-1 text-green-500">
                                <Check className="w-4 h-4" />
                                <span className="text-xs">Ready</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1 text-zinc-500">
                                <Clock className="w-4 h-4" />
                                <span className="text-xs">Waiting</span>
                            </div>
                        )}
                        {syncStates?.get(participant.id) === 'loading' && (
                            <span className="text-xs text-amber-400">buffering...</span>
                        )}
                        {syncStates?.get(participant.id) === 'ready' && (
                            <span className="text-xs text-emerald-400">ready</span>
                        )}
                        {syncStates?.get(participant.id) === 'paused' && (
                            <span className="text-xs text-amber-400">syncing</span>
                        )}
                        {(!syncStates?.get(participant.id) || syncStates.get(participant.id) === 'playing') && (
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
