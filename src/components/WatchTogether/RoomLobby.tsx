import { useState } from 'react';
import { WatchRoom, wtSetReady, wtStartPlayback } from '@/services/api';
import { ParticipantList } from './ParticipantList';
import { Button } from '@/components/ui/button';
import { Copy, Check, Play, LogOut, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

type LobbySyncPhase = 'lobby' | 'loading' | 'playing' | 'paused';

interface RoomLobbyProps {
    room: WatchRoom;
    isHost: boolean;
    currentUserId: string;
    mediaDuration?: number;
    onPlaybackStart: () => void;
    onLaunchMpv: (startPosition?: number) => Promise<void>;
    onLeave: () => Promise<void>;
    syncPhase?: LobbySyncPhase;
    participantStatus?: Map<string, {state: string; loadProgress: number}>;
    onSyncPhaseChange?: (phase: LobbySyncPhase) => void;
}

export function RoomLobby({
    room,
    isHost,
    currentUserId,
    mediaDuration,
    onLeave,
    syncPhase = 'lobby',
    participantStatus,
    onSyncPhaseChange,
}: RoomLobbyProps) {
    const [copied, setCopied] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [isLeaving, setIsLeaving] = useState(false);
    const { toast } = useToast();

    const allReady = room.participants.every((p) => p.is_ready);
    const readyCount = room.participants.filter((p) => p.is_ready).length;

    const handleCopyCode = async () => {
        try {
            await navigator.clipboard.writeText(room.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast({
                title: "Error",
                description: "Failed to copy room code",
                variant: "destructive",
            });
        }
    };

    const handleSetReady = async () => {
        try {
            const durationFromParticipant = room.participants.find((p) => p.id === currentUserId)?.duration;
            const duration = mediaDuration ?? durationFromParticipant ?? 0;
            await wtSetReady(duration);
            setIsReady(true);
        } catch (error) {
            console.error('Failed to set ready:', error);
            toast({
                title: "Error",
                description: "Failed to set ready status",
                variant: "destructive",
            });
        }
    };

    const handleStartPlayback = async () => {
        if (!isHost || !allReady) return;
        setIsStarting(true);
        try {
            await wtStartPlayback();
            onSyncPhaseChange?.('loading');
        } catch (error) {
            console.error('Failed to start playback:', error);
        } finally {
            setIsStarting(false);
        }
    };

    const handleLeave = async () => {
        setIsLeaving(true);
        try {
            await onLeave();
        } catch (error) {
            console.error('Failed to leave room:', error);
        } finally {
            setIsLeaving(false);
        }
    };

    return (
        <div className="relative">
            <div className={`space-y-6 ${syncPhase === 'loading' ? 'opacity-30 pointer-events-none select-none' : ''}`}>
            {/* Room Code */}
            <div className="text-center">
                <p className="text-sm text-zinc-400 mb-2">Room Code</p>
                <div className="flex items-center justify-center gap-2">
                    <div className="bg-zinc-800 px-6 py-3 rounded-lg">
                        <span className="text-3xl font-mono font-bold tracking-widest text-white">
                            {room.code}
                        </span>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCopyCode}
                        className="text-zinc-400 hover:text-white"
                        aria-label="Copy room code"
                    >
                        {copied ? (
                            <Check className="w-5 h-5 text-green-500" />
                        ) : (
                            <Copy className="w-5 h-5" />
                        )}
                    </Button>
                </div>
                <p className="text-xs text-zinc-500 mt-2">
                    Share this code with friends to watch together
                </p>
            </div>

            {/* Media Info */}
            <div className="bg-zinc-800/50 rounded-lg p-4">
                <p className="text-sm text-zinc-400">Now watching</p>
                <p className="text-lg font-medium text-white">{room.media_title}</p>
            </div>

            {/* Participants */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <p className="text-sm text-zinc-400">
                        Participants ({room.participants.length})
                    </p>
                    <p className="text-xs text-zinc-500">
                        {readyCount}/{room.participants.length} ready
                    </p>
                </div>
                <ParticipantList
                    participants={room.participants}
                    currentUserId={currentUserId}
                />
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
                {!isReady && (
                <Button
                    onClick={handleSetReady}
                    className="w-full bg-green-600 hover:bg-green-700"
                    aria-label="Mark yourself as ready"
                >
                    <Check className="w-4 h-4 mr-2" />
                    I'm Ready
                </Button>
                )}

                {isHost && (
                <Button
                    onClick={handleStartPlayback}
                    disabled={!allReady || isStarting}
                    className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50"
                    aria-label="Start playback for all"
                >
                    {isStarting ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                        <Play className="w-4 h-4 mr-2" />
                    )}
                    {allReady ? 'Start Watching' : 'Waiting for everyone...'}
                </Button>
                )}

                {!isHost && isReady && (
                    <p className="text-center text-sm text-zinc-400">
                        Waiting for host to start playback...
                    </p>
                )}

                <Button
                    variant="outline"
                    onClick={handleLeave}
                    disabled={isLeaving}
                    className="w-full border-zinc-700 text-zinc-400 hover:text-white"
                    aria-label="Leave watch together room"
                >
                    {isLeaving ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                        <LogOut className="w-4 h-4 mr-2" />
                    )}
                    Leave Room
                </Button>
            </div>
        </div>

            {syncPhase === 'loading' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center py-8 space-y-4">
                    <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
                    <h3 className="text-lg font-semibold text-white">Preparing Watch Together</h3>
                    <p className="text-sm text-zinc-400 text-center max-w-md">
                        Pre-buffering 30 seconds of content for a smooth synchronized experience.
                        This ensures everyone starts at the same moment regardless of connection speed.
                    </p>
                    <div className="w-full max-w-sm space-y-2 mt-2">
                        {participantStatus && Array.from(participantStatus.entries()).map(([id, status]) => {
                            const nickname = room.participants.find(p => p.id === id)?.nickname || id;
                            return (
                                <div key={id} className="flex items-center justify-between text-sm">
                                    <span className="text-zinc-300">{nickname}</span>
                                    <span className="text-zinc-500">
                                        {status.state === 'loading' ? 'Buffering...' : status.state === 'ready' ? 'Ready' : status.state}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
