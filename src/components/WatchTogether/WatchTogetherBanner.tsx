import { WatchRoom, wtLeaveRoom } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Users, X, Play } from 'lucide-react';

interface WatchTogetherBannerProps {
    room: WatchRoom;
    isPlaying: boolean;
    onOpenModal: () => void;
    onLeave: () => void;
}

export function WatchTogetherBanner({
    room,
    isPlaying,
    onOpenModal,
    onLeave,
}: WatchTogetherBannerProps) {
    const handleLeave = async () => {
        try {
            await wtLeaveRoom();
            onLeave();
        } catch (error) {
            console.error('Failed to leave room:', error);
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 bg-purple-600/95 backdrop-blur-sm rounded-lg shadow-lg px-3 py-2 flex items-center gap-3">
            <Users className="w-4 h-4 text-white" />
            <span className="text-sm font-mono font-bold text-white">{room.code}</span>
            <span className="text-xs text-purple-200">{room.participants.length}p</span>
            {isPlaying && (
                <div className="flex items-center gap-1 text-green-300">
                    <Play className="w-3 h-3 fill-current" />
                </div>
            )}
            <Button
                size="sm"
                variant="ghost"
                onClick={onOpenModal}
                className="text-white hover:bg-purple-500/50 h-6 px-2 text-xs"
            >
                Open
            </Button>
            <Button
                size="sm"
                variant="ghost"
                onClick={handleLeave}
                className="text-white hover:bg-red-500/50 h-6 w-6 p-0"
            >
                <X className="w-3 h-3" />
            </Button>
        </div>
    );
}
