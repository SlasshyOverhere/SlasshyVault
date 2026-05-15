import { useState, useEffect } from 'react';
import { Wifi, WifiOff, AlertCircle } from 'lucide-react';

type SyncPhase = 'lobby' | 'loading' | 'playing' | 'paused';

interface SyncStatusIndicatorProps {
    isConnected: boolean;
    lastSyncTime?: number;
    positionDrift?: number; // seconds of drift from host
    syncPhase?: SyncPhase;
}

export function SyncStatusIndicator({
    isConnected,
    lastSyncTime,
    positionDrift = 0,
    syncPhase = 'lobby',
}: SyncStatusIndicatorProps) {
    const [timeSinceSync, setTimeSinceSync] = useState(0);

    useEffect(() => {
        if (!lastSyncTime) return;

        const interval = setInterval(() => {
            setTimeSinceSync(Math.floor((Date.now() - lastSyncTime) / 1000));
        }, 1000);

        return () => clearInterval(interval);
    }, [lastSyncTime]);

    // Show protocol-based state when active
    if (syncPhase === 'loading') {
        return (
            <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-full bg-amber-500/20 backdrop-blur-sm">
                <span className="animate-spin text-xs text-amber-400">⟳</span>
                <span className="text-xs font-medium text-amber-400">
                    Pre-buffering...
                </span>
            </div>
        );
    }

    if (syncPhase === 'paused') {
        return (
            <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-full bg-amber-500/20 backdrop-blur-sm">
                <span className="animate-pulse text-xs text-amber-400">●</span>
                <span className="text-xs font-medium text-amber-400">
                    Syncing...
                </span>
            </div>
        );
    }

    // Determine sync health for playing state
    const getSyncHealth = () => {
        if (syncPhase === 'lobby') return 'unknown';
        if (lastSyncTime === undefined) return 'unknown';
        if (!isConnected) return 'disconnected';
        if (Math.abs(positionDrift) > 5) return 'poor';
        if (Math.abs(positionDrift) > 2 || timeSinceSync > 15) return 'fair';
        return 'good';
    };

    const health = getSyncHealth();

    const healthConfig = {
        good: {
            color: 'text-green-500',
            bgColor: 'bg-green-500/20',
            icon: Wifi,
            label: 'In sync',
        },
        fair: {
            color: 'text-yellow-500',
            bgColor: 'bg-yellow-500/20',
            icon: Wifi,
            label: 'Syncing...',
        },
        poor: {
            color: 'text-red-500',
            bgColor: 'bg-red-500/20',
            icon: AlertCircle,
            label: 'Out of sync',
        },
        disconnected: {
            color: 'text-zinc-500',
            bgColor: 'bg-zinc-500/20',
            icon: WifiOff,
            label: 'Disconnected',
        },
        unknown: {
            color: 'text-zinc-400',
            bgColor: 'bg-zinc-400/20',
            icon: Wifi,
            label: 'Connecting...',
        },
    };

    const config = healthConfig[health];
    const Icon = config.icon;

    return (
        <div
            className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-full ${config.bgColor} backdrop-blur-sm`}
        >
            <Icon className={`w-4 h-4 ${config.color}`} />
            <span className={`text-xs font-medium ${config.color}`}>
                {config.label}
            </span>
            {health === 'poor' && positionDrift !== 0 && (
                <span className="text-xs text-zinc-400">
                    ({positionDrift > 0 ? '+' : ''}{positionDrift.toFixed(1)}s)
                </span>
            )}
        </div>
    );
}
