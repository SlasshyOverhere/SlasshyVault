import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    WatchRoom,
    WatchEvent,
    MediaItem,
    wtCreateRoom,
    wtJoinRoom,
    wtLaunchMpv,
    wtSendMpvCommand,
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
    const [isConnected, setIsConnected] = useState(true);
    const [lastSyncTime, setLastSyncTime] = useState<number | undefined>();

    // Use refs to avoid stale closures in event listeners
    const selectedMediaRef = useRef(selectedMedia);
    const sessionIdRef = useRef(sessionId);
    const activeRoomRef = useRef(activeRoom);
    const mpvLaunchedRef = useRef(false); // Track if we already launched MPV

    // Keep refs updated
    useEffect(() => {
        selectedMediaRef.current = selectedMedia;
        console.log('[WT] selectedMedia updated:', selectedMedia?.id, selectedMedia?.title);
    }, [selectedMedia]);

    useEffect(() => {
        sessionIdRef.current = sessionId;
    }, [sessionId]);

    useEffect(() => {
        activeRoomRef.current = activeRoom;
    }, [activeRoom]);

    // Sync view with session state when modal opens
    useEffect(() => {
        if (isOpen) {
            if (isPlaying) {
                setView('playing');
            } else if (activeRoom) {
                setView('lobby');
            } else {
                setView('menu');
            }
        }
    }, [isOpen, activeRoom, isPlaying]);

    // Load saved nickname
    useEffect(() => {
        const saved = localStorage.getItem('wt_nickname');
        if (saved) setNickname(saved);
    }, []);

    // Memoized launch function to avoid stale closures
    const launchMpv = useCallback(async (startPosition: number = 0): Promise<void> => {
        // Prevent double launch
        if (mpvLaunchedRef.current) {
            console.log('[WT] MPV already launched, skipping');
            return;
        }

        const media = selectedMediaRef.current;
        const session = sessionIdRef.current;

        console.log('[WT] launchMpv called with:', {
            mediaId: media?.id,
            mediaTitle: media?.title,
            session,
            startPosition
        });

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

        // Mark as launched BEFORE the async call to prevent race conditions
        mpvLaunchedRef.current = true;

        console.log('[WT] Launching MPV for session:', session, 'media:', media.id, media.title);
        try {
            const pid = await wtLaunchMpv(media.id, session, startPosition);
            console.log('[WT] MPV launched with PID:', pid);
            setIsConnected(true);
            setError(null);
        } catch (err) {
            console.error('[WT] Failed to launch MPV:', err);
            setError(err instanceof Error ? err.message : 'Failed to launch player');
            // Reset flag on error so user can retry
            mpvLaunchedRef.current = false;
        }
    }, []);

    // Listen for Watch Together events - runs always, not just when modal is open
    useEffect(() => {
        console.log('[WT] Setting up event listeners');

        const unlisten = listen<WatchEvent>('wt-event', (event) => {
            const data = event.payload;
            console.log('[WT] Event received:', data.type, data);

            switch (data.type) {
                case 'room_updated':
                case 'participant_changed':
                    if (data.room) {
                        onSessionChange(data.room, sessionIdRef.current, isPlaying, selectedMediaRef.current || undefined);
                    }
                    break;
                case 'sync_command':
                    if (data.command && sessionIdRef.current) {
                        console.log('[WT] Applying sync command:', data.command);
                        wtSendMpvCommand(sessionIdRef.current, data.command.action, data.command.position);
                        setLastSyncTime(Date.now());
                    }
                    break;
                case 'playback_started':
                    console.log('[WT] Playback started event received');
                    setView('playing');
                    onSessionChange(activeRoomRef.current, sessionIdRef.current, true, selectedMediaRef.current || undefined);
                    // Launch MPV for participants (host already launched it)
                    launchMpv(data.position || 0);
                    break;
                case 'error':
                    console.error('[WT] Error event:', data.message);
                    setError(data.message || 'An error occurred');
                    break;
                case 'disconnected':
                    console.log('[WT] Disconnected');
                    setIsConnected(false);
                    onSessionChange(null, '', false);
                    setView('menu');
                    break;
            }
        });

        return () => {
            console.log('[WT] Cleaning up event listeners');
            unlisten.then((fn) => fn());
        };
    }, [launchMpv, onSessionChange, isPlaying]);

    // Listen for MPV ended event
    useEffect(() => {
        const unlisten = listen('wt-mpv-ended', () => {
            console.log('[WT] MPV ended');
            setView('lobby');
            onSessionChange(activeRoomRef.current, sessionIdRef.current, false, selectedMediaRef.current || undefined);
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [onSessionChange]);

    const handleCreateRoom = async () => {
        if (!selectedMedia || !nickname.trim()) {
            setError('Please select media and enter a nickname');
            return;
        }

        setIsLoading(true);
        setError(null);
        localStorage.setItem('wt_nickname', nickname);

        try {
            console.log('[WT] Creating room for media:', selectedMedia.id, selectedMedia.title);
            const newRoom = await wtCreateRoom(
                selectedMedia.id,
                selectedMedia.title,
                nickname.trim()
            );
            console.log('[WT] Room created:', newRoom.code);
            // Pass the media along with the session change
            onSessionChange(newRoom, newRoom.code, false, selectedMedia);
            setView('lobby');
        } catch (err) {
            console.error('[WT] Failed to create room:', err);
            setError(err instanceof Error ? err.message : 'Failed to create room');
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
        localStorage.setItem('wt_nickname', nickname);

        try {
            console.log('[WT] Joining room:', roomCode, 'with media:', selectedMedia.id);
            const joinedRoom = await wtJoinRoom(
                roomCode.trim().toUpperCase(),
                selectedMedia.id,
                nickname.trim()
            );
            console.log('[WT] Joined room:', joinedRoom.code);
            // Pass the media along with the session change
            onSessionChange(joinedRoom, joinedRoom.code, false, selectedMedia);
            setView('lobby');
        } catch (err) {
            console.error('[WT] Failed to join room:', err);
            setError(err instanceof Error ? err.message : 'Failed to join room');
        } finally {
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        // Just close the modal - don't leave the room
        setError(null);
        setRoomCode('');
        onClose();
    };

    const handleLeave = async () => {
        try {
            await wtLeaveRoom();
        } catch (error) {
            console.error('Failed to leave room:', error);
        }
        onSessionChange(null, '', false);
        setView('menu');
    };

    const handlePlaybackStart = () => {
        setView('playing');
        onSessionChange(activeRoom, sessionId, true, selectedMedia);
    };

    const isHost = activeRoom?.host_id === activeRoom?.participants.find(p => p.nickname === nickname)?.id;
    const currentUserId = activeRoom?.participants.find(p => p.nickname === nickname)?.id || '';

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
                <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-800">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-white">
                            <Users className="w-5 h-5 text-purple-500" />
                            Watch Together
                        </DialogTitle>
                    </DialogHeader>

                    {view === 'menu' && (
                        <div className="space-y-4">
                            {selectedMedia ? (
                                <div className="bg-zinc-800/50 rounded-lg p-3">
                                    <p className="text-xs text-zinc-400">Selected media</p>
                                    <p className="text-sm font-medium text-white truncate">
                                        {selectedMedia.title}
                                    </p>
                                </div>
                            ) : (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                                    <p className="text-sm text-red-400">No media selected. Please select a movie or episode first.</p>
                                </div>
                            )}

                            <div className="space-y-3">
                                <Input
                                    placeholder="Your nickname"
                                    value={nickname}
                                    onChange={(e) => setNickname(e.target.value)}
                                    className="bg-zinc-800 border-zinc-700 text-white"
                                />
                            </div>

                            <Tabs defaultValue="create" className="w-full">
                                <TabsList className="grid w-full grid-cols-2 bg-zinc-800">
                                    <TabsTrigger value="create">Create Room</TabsTrigger>
                                    <TabsTrigger value="join">Join Room</TabsTrigger>
                                </TabsList>

                                <TabsContent value="create" className="space-y-4 mt-4">
                                    <p className="text-sm text-zinc-400">
                                        Create a new room and invite friends to watch together.
                                    </p>
                                    <Button
                                        onClick={handleCreateRoom}
                                        disabled={!nickname.trim() || !selectedMedia || isLoading}
                                        className="w-full bg-purple-600 hover:bg-purple-700"
                                    >
                                        {isLoading ? (
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        ) : (
                                            <Plus className="w-4 h-4 mr-2" />
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
                                        className="bg-zinc-800 border-zinc-700 text-white text-center text-lg tracking-widest font-mono"
                                    />
                                    <Button
                                        onClick={handleJoinRoom}
                                        disabled={!nickname.trim() || !roomCode.trim() || !selectedMedia || isLoading}
                                        className="w-full bg-purple-600 hover:bg-purple-700"
                                    >
                                        {isLoading ? (
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        ) : (
                                            <LogIn className="w-4 h-4 mr-2" />
                                        )}
                                        Join Room
                                    </Button>
                                </TabsContent>
                            </Tabs>

                            {error && (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                                    <p className="text-sm text-red-400">{error}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {view === 'lobby' && activeRoom && (
                        <RoomLobby
                            room={activeRoom}
                            isHost={isHost}
                            currentUserId={currentUserId}
                            onPlaybackStart={handlePlaybackStart}
                            onLaunchMpv={launchMpv}
                            onLeave={handleLeave}
                        />
                    )}

                    {view === 'playing' && (
                        <div className="text-center py-8">
                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-purple-500/20 flex items-center justify-center">
                                <Users className="w-8 h-8 text-purple-500" />
                            </div>
                            <p className="text-lg font-medium text-white mb-2">
                                Watching Together
                            </p>
                            <p className="text-sm text-zinc-400 mb-6">
                                Your playback is synchronized with {activeRoom?.participants.length || 0} participants
                            </p>
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
                                    <p className="text-sm text-red-400">{error}</p>
                                </div>
                            )}
                            <div className="flex flex-col gap-2">
                                <Button
                                    variant="outline"
                                    onClick={handleClose}
                                    className="border-zinc-700"
                                >
                                    <X className="w-4 h-4 mr-2" />
                                    Close (Stay in Room)
                                </Button>
                                <Button
                                    variant="ghost"
                                    onClick={handleLeave}
                                    className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                                >
                                    Leave Room
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Sync status overlay during playback */}
            {isPlaying && (
                <SyncStatusIndicator
                    isConnected={isConnected}
                    lastSyncTime={lastSyncTime}
                />
            )}
        </>
    );
}
