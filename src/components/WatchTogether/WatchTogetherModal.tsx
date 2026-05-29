import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    WatchRoom,
    WatchEvent,
    MediaItem,
    wtCreateRoom,
    wtJoinRoom,
    wtGetClientId,
    wtLaunchMpv,
    wtLeaveRoom,
} from '@/services/api';
import { RoomLobby } from './RoomLobby';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Plus, LogIn, Loader2, X } from 'lucide-react';

interface WatchTogetherModalProps {
    isOpen: boolean;
    onClose: () => void;
    selectedMedia?: MediaItem;
    // Session state managed by parent (App.tsx)
    activeRoom: WatchRoom | null;
    sessionId: string;
    isPlaying: boolean;
    onSessionChange: (room: WatchRoom | null, sessionId: string, isPlaying: boolean, media?: MediaItem) => void;
}

type ModalView = 'menu' | 'lobby' | 'playing';

function buildMediaMatchKey(media?: MediaItem): string | undefined {
    if (!media) return undefined;

    const tokens: string[] = [];

    if (media.cloud_file_id?.trim()) {
        tokens.push(`cloud:${encodeURIComponent(media.cloud_file_id.trim().toLowerCase())}`);
    }

    if (media.file_path?.trim()) {
        const normalizedPath = media.file_path.replace(/\\/g, '/');
        const fileName = normalizedPath.split('/').pop()?.trim();
        if (fileName) {
            tokens.push(`file:${encodeURIComponent(fileName.toLowerCase())}`);
        }
    }

    if (media.tmdb_id?.trim()) {
        tokens.push(`tmdb:${encodeURIComponent(media.tmdb_id.trim().toLowerCase())}`);
    }

    const title = media.title?.trim();
    if (title) {
        tokens.push(`title:${encodeURIComponent(title.toLowerCase())}`);
    }

    if (media.file_size_bytes && media.file_size_bytes > 0) {
        tokens.push(`size:${media.file_size_bytes}`);
    }

    if (media.duration_seconds && media.duration_seconds > 0) {
        tokens.push(`dur:${Math.round(media.duration_seconds)}`);
    }

    if (tokens.length === 0) {
        return undefined;
    }

    // Send all available keys; server accepts join if identity token overlaps and verifier tokens match.
    return Array.from(new Set(tokens)).join('|');
}

export function WatchTogetherModal({
    isOpen,
    onClose,
    selectedMedia,
    activeRoom,
    sessionId,
    isPlaying,
    onSessionChange,
}: WatchTogetherModalProps) {
    const [view, setView] = useState<ModalView>('menu');
    const [nickname, setNickname] = useState('');
    const [roomCode, setRoomCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [lastSyncTime, setLastSyncTime] = useState<number | undefined>();
    const [currentUserId, setCurrentUserId] = useState('');
    const [syncPhase, setSyncPhase] = useState<'lobby' | 'loading' | 'playing' | 'paused'>('lobby');
    const [participantStatus, setParticipantStatus] = useState<Map<string, {state: string; loadProgress: number}>>(new Map());

    // Use refs to avoid stale closures in event listeners
    const selectedMediaRef = useRef(selectedMedia);
    const sessionIdRef = useRef(sessionId);
    const activeRoomRef = useRef(activeRoom);
    const mpvLaunchedRef = useRef(false); // Track if we already launched MPV
    const sessionCounterRef = useRef(0); // Increment on each room join to scope event listeners
    const handleCloseRef = useRef(false); // Prevent double invocation of handleClose
    const wasOpenRef = useRef(false); // Track previous isOpen for initialization

    // Keep refs updated
    useEffect(() => {
        selectedMediaRef.current = selectedMedia;
    }, [selectedMedia]);

    useEffect(() => {
        sessionIdRef.current = sessionId;
    }, [sessionId]);

    useEffect(() => {
        activeRoomRef.current = activeRoom;
    }, [activeRoom]);

    // Reset refs when room is cleared (inline during render)
    if (!activeRoom && mpvLaunchedRef.current) {
        mpvLaunchedRef.current = false;
    }
    if (!activeRoom && currentUserId) {
        setCurrentUserId('');
    }

    // Initialize view/syncPhase when modal opens (instead of useEffect)
    if (isOpen && !wasOpenRef.current) {
        const desiredView = isPlaying ? 'playing' : activeRoom ? 'lobby' : 'menu';
        const desiredPhase = isPlaying ? 'playing' : 'lobby';
        if (view !== desiredView) setView(desiredView);
        if (syncPhase !== desiredPhase) setSyncPhase(desiredPhase);
    }
    wasOpenRef.current = isOpen;

    // Load saved nickname
    useEffect(() => {
        const saved = localStorage.getItem('wt_nickname');
        if (saved) setNickname(saved);
    }, []);

    // Memoized launch function to avoid stale closures
    const launchMpv = useCallback(async (startPosition: number = 0): Promise<void> => {
        if (mpvLaunchedRef.current) {
            return;
        }

        const media = selectedMediaRef.current;
        const session = sessionIdRef.current;

        if (!media) {
            const errorMsg = 'Cannot launch MPV: No media selected';
            console.error('[WT]', errorMsg);
            setError(errorMsg);
            return;
        }

        if (!session) {
            const errorMsg = 'Cannot launch MPV: No session ID';
            console.error('[WT]', errorMsg);
            setError(errorMsg);
            return;
        }

        mpvLaunchedRef.current = true;

        try {
            await wtLaunchMpv(media.id, session, startPosition);
            setIsConnected(true);
            setError(null);
        } catch (err) {
            console.error('[WT] Failed to launch MPV:', err);
            setError(err instanceof Error ? err.message : 'Failed to launch player');
            setIsConnected(false);
            mpvLaunchedRef.current = false;
        }
    }, []);

    // Listen for Watch Together events - runs always, not just when modal is open
    useEffect(() => {
        const currentSession = sessionCounterRef.current;
        const unlisten = listen<WatchEvent>('wt-event', (event) => {
            const data = event.payload;

            // Ignore stale events from previous room sessions
            if (sessionCounterRef.current !== currentSession) return;

            switch (data.type as string) {
                case 'room_updated':
                case 'participant_changed':
                    if (data.room) {
                        const roomIsPlaying = data.room.is_playing || data.room.state === 'playing';
                        onSessionChange(data.room, sessionIdRef.current, roomIsPlaying, selectedMediaRef.current || undefined);
                    }
                    break;
                case 'sync_command':
                    setLastSyncTime(Date.now());
                    setIsConnected(true);
                    break;
                case 'state_update':
                    setLastSyncTime(Date.now());
                    setIsConnected(true);
                    break;
                case 'playback_started':
                    setView('playing');
                    setSyncPhase('playing');
                    setLastSyncTime(Date.now());
                    setIsConnected(true);
                    selectedMediaRef.current = selectedMedia;
                    sessionIdRef.current = sessionId;
                    onSessionChange(activeRoomRef.current, sessionIdRef.current, true, selectedMediaRef.current || undefined);
                    launchMpv(data.position || 0);
                    break;
                case 'prepare':
                    setSyncPhase('loading');
                    setLastSyncTime(Date.now());
                    break;
                case 'play_at':
                case 'sync_resume':
                    setSyncPhase('playing');
                    setView('playing');
                    setLastSyncTime(Date.now());
                    onSessionChange(activeRoomRef.current, sessionIdRef.current, true, selectedMediaRef.current || undefined);
                    launchMpv();
                    break;
                case 'pause':
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if ((event.payload as any).reason === 'buffering') {
                        setSyncPhase('paused');
                    }
                    break;
                case 'participant_status':
                    setParticipantStatus(prev => {
                        const next = new Map(prev);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const p = event.payload as any;
                        next.set(p.participantId, {
                            state: p.state,
                            loadProgress: p.loadProgress || 0,
                        });
                        return next;
                    });
                    break;
                case 'error':
                    console.error('[WT] Error event:', data.message);
                    setError(data.message || 'An error occurred');
                    break;
                case 'disconnected':
                    setIsConnected(false);
                    setCurrentUserId('');
                    setLastSyncTime(undefined);
                    setSyncPhase('lobby');
                    setParticipantStatus(new Map());
                    mpvLaunchedRef.current = false;
                    // TODO: Call wtStopMpv() if backend exposes it to kill MPV on disconnect
                    onSessionChange(null, '', false);
                    setView('menu');
                    break;
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [launchMpv, onSessionChange, sessionId, selectedMedia]);

    // Listen for MPV ended event
    useEffect(() => {
        const unlisten = listen('wt-mpv-ended', () => {
            mpvLaunchedRef.current = false;
            setView('lobby');
            onSessionChange(activeRoomRef.current, sessionIdRef.current, false, selectedMediaRef.current || undefined);
        });

        // Fallback: if mpvLaunchedRef stays true for 30 seconds after a playback start
        // without receiving wt-mpv-ended, reset it (handles MPV crash without event)
        const fallbackInterval = setInterval(() => {
            if (mpvLaunchedRef.current) {
                mpvLaunchedRef.current = false;
            }
        }, 30000);

        return () => {
            unlisten.then((fn) => fn());
            clearInterval(fallbackInterval);
        };
    }, [onSessionChange]);

    const handleCreateRoom = async () => {
        if (!selectedMedia || !nickname.trim()) {
            setError('Please select media and enter a nickname');
            return;
        }

        setIsLoading(true);
        setError(null);
        const sanitizedNickname = nickname.trim().slice(0, 30).replace(/<[^>]*>/g, '');
        localStorage.setItem('wt_nickname', sanitizedNickname);

        try {
            const newRoom = await wtCreateRoom(
                selectedMedia.id,
                selectedMedia.title,
                buildMediaMatchKey(selectedMedia),
                sanitizedNickname,
                selectedMedia.file_path
            );
            const localClientId = await wtGetClientId();
            if (localClientId) {
                setCurrentUserId(localClientId);
            }
            mpvLaunchedRef.current = false;
            sessionCounterRef.current += 1;
            setIsConnected(true);
            // Pass the media along with the session change
            onSessionChange(newRoom, newRoom.code, false, selectedMedia);
            setView('lobby');
        } catch (err) {
            console.error('[WT] Failed to create room:', err);
            setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to create room');
        } finally {
            setIsLoading(false);
        }
    };

    const handleJoinRoom = async () => {
        if (!selectedMedia || !nickname.trim() || !roomCode.trim()) {
            setError('Please fill in all fields');
            return;
        }

        setIsLoading(true);
        setError(null);
        const sanitizedNickname = nickname.trim().slice(0, 30).replace(/<[^>]*>/g, '');
        localStorage.setItem('wt_nickname', sanitizedNickname);

        try {
            const joinedRoom = await wtJoinRoom(
                roomCode.trim().toUpperCase(),
                selectedMedia.id,
                selectedMedia.title,
                buildMediaMatchKey(selectedMedia),
                sanitizedNickname,
                selectedMedia.file_path
            );
            const localClientId = await wtGetClientId();
            if (localClientId) {
                setCurrentUserId(localClientId);
            }
            const roomIsPlaying = joinedRoom.is_playing || joinedRoom.state === 'playing';
            mpvLaunchedRef.current = false;
            sessionCounterRef.current += 1;
            setIsConnected(true);
            onSessionChange(joinedRoom, joinedRoom.code, roomIsPlaying, selectedMedia);

            if (roomIsPlaying) {
                setView('playing');
                await launchMpv(joinedRoom.current_position || 0);
            } else {
                setView('lobby');
            }
        } catch (err) {
            console.error('[WT] Failed to join room:', err);
            setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to join room');
        } finally {
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        if (handleCloseRef.current) return;
        handleCloseRef.current = true;
        setError(null);
        setRoomCode('');
        onClose();
        setTimeout(() => { handleCloseRef.current = false; }, 300);
    };

    const handleLeave = async () => {
        try {
            await wtLeaveRoom();
        } catch (error) {
            console.error('Failed to leave room:', error);
        }
        mpvLaunchedRef.current = false;
        // TODO: Call wtStopMpv() if backend exposes it to kill MPV on leave
        setCurrentUserId('');
        setLastSyncTime(undefined);
        setIsConnected(false);
        onSessionChange(null, '', false);
        setView('menu');
    };

    const handlePlaybackViewUpdate = () => {
        setView('playing');
        onSessionChange(activeRoom, sessionId, true, selectedMedia);
    };

    const resolvedCurrentUserId = currentUserId
        || activeRoom?.participants.find(p => p.nickname === nickname)?.id
        || '';
    const isHost = !!activeRoom && activeRoom.host_id === resolvedCurrentUserId;

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
                <DialogContent className="sm:max-w-md bg-card border-border/50">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Users className="size-5" />
                            Watch Together
                        </DialogTitle>
                    </DialogHeader>

                    {view === 'menu' && (
                        <div className="space-y-4">
                            {selectedMedia ? (
                                <div className="bg-secondary/50 rounded-xl p-3 border border-border/30">
                                    <p className="text-xs text-muted-foreground">Selected media</p>
                                    <p className="text-sm font-medium truncate">{selectedMedia.title}</p>
                                </div>
                            ) : (
                                <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-3">
                                    <p className="text-sm text-destructive">No media selected. Please select a movie or episode first.</p>
                                </div>
                            )}

                            <Input
                                placeholder="Your nickname"
                                value={nickname}
                                onChange={(e) => setNickname(e.target.value)}
                                className="input-modern"
                            />

                            <Tabs defaultValue="create" className="w-full">
                                <TabsList className="grid w-full grid-cols-2">
                                    <TabsTrigger value="create">Create Room</TabsTrigger>
                                    <TabsTrigger value="join">Join Room</TabsTrigger>
                                </TabsList>

                                <TabsContent value="create" className="space-y-4 mt-4">
                                    <p className="text-sm text-muted-foreground">
                                        Create a new room and invite friends to watch together.
                                    </p>
                                    <Button
                                        onClick={handleCreateRoom}
                                        disabled={!nickname.trim() || !selectedMedia || isLoading}
                                        className="btn-primary w-full"
                                        aria-label="Create a watch together room"
                                    >
                                        {isLoading ? (
                                            <Loader2 className="size-4 mr-2 animate-spin" />
                                        ) : (
                                            <Plus className="size-4 mr-2" />
                                        )}
                                        Create Room
                                    </Button>
                                </TabsContent>

                                <TabsContent value="join" className="space-y-4 mt-4">
                                    <Input
                                        placeholder="Enter room code"
                                        value={roomCode}
                                        onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                                        maxLength={6}
                                        className="input-modern text-center text-lg tracking-widest font-mono"
                                    />
                                    <Button
                                        onClick={handleJoinRoom}
                                        disabled={!nickname.trim() || !roomCode.trim() || !selectedMedia || isLoading}
                                        className="btn-primary w-full"
                                        aria-label="Join a watch together room"
                                    >
                                        {isLoading ? (
                                            <Loader2 className="size-4 mr-2 animate-spin" />
                                        ) : (
                                            <LogIn className="size-4 mr-2" />
                                        )}
                                        Join Room
                                    </Button>
                                </TabsContent>
                            </Tabs>

                            {error && (
                                <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-3">
                                    <p className="text-sm text-destructive">{error}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {view === 'lobby' && activeRoom && (
                        <RoomLobby
                            room={activeRoom}
                            isHost={isHost}
                            currentUserId={resolvedCurrentUserId}
                            mediaDuration={selectedMedia?.duration_seconds}
                            onPlaybackStart={handlePlaybackViewUpdate}
                            onLaunchMpv={launchMpv}
                            onLeave={handleLeave}
                            syncPhase={syncPhase}
                            participantStatus={participantStatus}
                            onSyncPhaseChange={setSyncPhase}
                        />
                    )}

                    {view === 'playing' && (
                        <div className="text-center py-8">
                            <div className="size-16 mx-auto mb-6 rounded-full bg-white/10 flex items-center justify-center border border-white/10">
                                <Users className="size-8" />
                            </div>
                            <p className="text-lg font-bold mb-2">Watching Together</p>
                            <p className="text-sm text-muted-foreground mb-8">
                                Your playback is synchronized with {activeRoom?.participants.length || 0} participants
                            </p>
                            {error && (
                                <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-3 mb-4">
                                    <p className="text-sm text-destructive">{error}</p>
                                </div>
                            )}
                            <div className="flex flex-col gap-2">
                                <Button
                                    variant="outline"
                                    onClick={handleClose}
                                    className="btn-secondary"
                                    aria-label="Close modal but stay in room"
                                >
                                    <X className="size-4 mr-2" />
                                    Close (Stay in Room)
                                </Button>
                                <Button
                                    variant="ghost"
                                    onClick={handleLeave}
                                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                    aria-label="Leave watch together room"
                                >
                                    Leave Room
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Sync status overlay during playback */}
            {(isPlaying || syncPhase === 'loading' || syncPhase === 'paused') && (
                <SyncStatusIndicator
                    isConnected={isConnected}
                    lastSyncTime={lastSyncTime}
                    syncPhase={syncPhase}
                />
            )}
        </>
    );
}
