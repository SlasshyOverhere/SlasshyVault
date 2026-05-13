import { useEffect, useState } from 'react';
import { WatchRoom, wtSetReady, wtStartPlayback } from '@/services/api';
import { ParticipantList } from './ParticipantList';
import { Button } from '@/components/ui/button';
import { Copy, Check, Play, LogOut, Loader2, UserPlus, RefreshCw } from 'lucide-react';
import { Friend, getFriends, sendChatMessage } from '@/services/social';

interface RoomLobbyProps {
    room: WatchRoom;
    isHost: boolean;
    currentUserId: string;
    mediaDuration?: number;
    onPlaybackStart: () => void;
    onLaunchMpv: (startPosition?: number) => Promise<void>;
    onLeave: () => Promise<void>;
}

export function RoomLobby({
    room,
    isHost,
    currentUserId,
    mediaDuration,
    onPlaybackStart,
    onLaunchMpv,
    onLeave,
}: RoomLobbyProps) {
    const [copied, setCopied] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [isLeaving, setIsLeaving] = useState(false);
    const [inviteCandidates, setInviteCandidates] = useState<Friend[]>([]);
    const [invitesLoading, setInvitesLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [invitingFriendId, setInvitingFriendId] = useState<string | null>(null);
    const [invitedFriendIds, setInvitedFriendIds] = useState<Record<string, boolean>>({});

    const allReady = room.participants.every((p) => p.is_ready);
    const readyCount = room.participants.filter((p) => p.is_ready).length;

    useEffect(() => {
        void loadInviteCandidates();
    }, [room.code]);

    const loadInviteCandidates = async () => {
        try {
            setInvitesLoading(true);
            setInviteError(null);

            const { friends, online } = await getFriends();
            const onlineSet = new Set(online.map((friend) => friend.id));
            const candidates = friends.filter((friend) => onlineSet.has(friend.id));
            setInviteCandidates(candidates);
        } catch (error) {
            console.warn('[WT] Failed to load social friends for invite:', error);
            setInviteCandidates([]);
            setInviteError('Connect Social to invite friends directly.');
        } finally {
            setInvitesLoading(false);
        }
    };

    const handleInviteFriend = async (friend: Friend) => {
        if (!friend?.id || invitingFriendId) return;
        try {
            setInviteError(null);
            setInvitingFriendId(friend.id);
            const inviteText = `Join my Watch Together room for "${room.media_title}". Room code: ${room.code}`;
            await sendChatMessage(friend.id, inviteText);
            setInvitedFriendIds((prev) => ({ ...prev, [friend.id]: true }));
        } catch (error) {
            console.warn('[WT] Failed to send invite:', error);
            setInviteError('Failed to send invite. Please try again.');
        } finally {
            setInvitingFriendId(null);
        }
    };

    const handleCopyCode = async () => {
        await navigator.clipboard.writeText(room.code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSetReady = async () => {
        try {
            const durationFromParticipant = room.participants.find((p) => p.id === currentUserId)?.duration;
            const duration = mediaDuration ?? durationFromParticipant ?? 0;
            await wtSetReady(duration);
            setIsReady(true);
        } catch (error) {
            console.error('Failed to set ready:', error);
        }
    };

    const handleStartPlayback = async () => {
        if (!isHost || !allReady) return;
        setIsStarting(true);
        try {
            await wtStartPlayback();
            await onLaunchMpv(0);
            onPlaybackStart();
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
        <div className="space-y-6">
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

            {/* Invite Friends */}
            <div className="bg-zinc-800/40 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <p className="text-sm text-zinc-300 flex items-center gap-2">
                        <UserPlus className="w-4 h-4 text-purple-400" />
                        Invite Friends
                    </p>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-zinc-400 hover:text-white"
                    onClick={loadInviteCandidates}
                    disabled={invitesLoading}
                    aria-label="Refresh invite candidates"
                >
                    {invitesLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <RefreshCw className="w-4 h-4" />
                    )}
                </Button>
                </div>

                {inviteError && (
                    <p className="text-xs text-red-400">{inviteError}</p>
                )}

                {!inviteError && inviteCandidates.length === 0 && !invitesLoading && (
                    <p className="text-xs text-zinc-500">
                        No online friends available to invite right now.
                    </p>
                )}

                {inviteCandidates.length > 0 && (
                    <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                        {inviteCandidates.map((friend) => (
                            <div key={friend.id} className="flex items-center justify-between rounded-md bg-zinc-900/50 px-3 py-2">
                                <div className="min-w-0">
                                    <p className="text-sm text-white truncate">{friend.name}</p>
                                    <p className="text-xs text-green-400">Online</p>
                                </div>
                                <Button
                                    size="sm"
                                    onClick={() => handleInviteFriend(friend)}
                                    disabled={invitingFriendId === friend.id || !!invitedFriendIds[friend.id]}
                                    className="h-8 bg-purple-600 hover:bg-purple-700"
                                    aria-label={`Invite ${friend.name} to room`}
                                >
                                    {invitingFriendId === friend.id ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : invitedFriendIds[friend.id] ? (
                                        'Invited'
                                    ) : (
                                        'Invite'
                                    )}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
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
    );
}
