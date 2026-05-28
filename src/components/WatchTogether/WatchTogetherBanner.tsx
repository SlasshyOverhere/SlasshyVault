import { WatchRoom, wtLeaveRoom } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Users, X, Play } from 'lucide-react';

type BannerSyncPhase = 'lobby' | 'loading' | 'playing' | 'paused';

interface WatchTogetherBannerProps {
    room: WatchRoom;
    isPlaying: boolean;
    syncPhase?: BannerSyncPhase;
    onOpenModal: () => void;
    onLeave: () => void;
}

export function WatchTogetherBanner({
    room,
    isPlaying,
    syncPhase = 'lobby',
    onOpenModal,
    onLeave,
}: WatchTogetherBannerProps) {
    const handleLeave = async () => {
        try {
            await wtLeaveRoom();
        } catch (error) {
            console.error('Failed to leave room:', error);
        } finally {
            onLeave();
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 bg-purple-600/95 backdrop-blur-sm rounded-lg shadow-lg px-3 py-2 flex items-center gap-3">
            <Users className="size-4 text-white" />
            <span className="text-sm font-mono font-bold text-white">{room.code}</span>
            <span className="text-xs text-purple-200">{room.participants.length}p</span>
            {isPlaying && (
                <div className="flex items-center gap-1 text-green-300">
                    <Play className="size-3 fill-current" />
                </div>
            )}
            {syncPhase === 'paused' && (
                <div className="flex items-center gap-2 text-amber-400 text-sm">
                    <span className="animate-pulse">●</span>
                    Syncing, waiting for all participants…
                </div>
            )}
            {syncPhase === 'loading' && (
                <div className="flex items-center gap-2 text-emerald-400 text-sm">
                    <span className="animate-spin">⟳</span>
                    Pre-buffering for smooth playback…
                </div>
            )}
                <Button
                size="sm"
                variant="ghost"
                onClick={onOpenModal}
                className="text-white hover:bg-purple-500/50 h-6 px-2 text-xs"
                aria-label="Open watch together modal"
            >
                Open
            </Button>
            <Button
                size="sm"
                variant="ghost"
                onClick={handleLeave}
                className="text-white hover:bg-red-500/50 size-6 p-0"
                aria-label="Leave watch together room"
            >
                <X className="size-3" />
            </Button>
        </div>
    );
}
