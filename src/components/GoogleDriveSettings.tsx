import { useState, useEffect } from 'react'
import { LazyMotion, m, domAnimation } from 'framer-motion'
import { Cloud, LogIn, LogOut, Loader2, CheckCircle2, HardDrive, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
    isGDriveConnected,
    getGDriveAccountInfo,
    startGDriveAuth,
    completeGDriveAuth,
    disconnectGDrive,
    formatStorageSize,
    DriveAccountInfo,
} from '@/services/gdrive'

// Note: Cloud indexing is now triggered from the sidebar "Index Drive" button
// This component only handles connection management

export function GoogleDriveSettings() {
    const [isConnected, setIsConnected] = useState(false)
    const [accountInfo, setAccountInfo] = useState<DriveAccountInfo | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isConnecting, setIsConnecting] = useState(false)
    const [isDisconnecting, setIsDisconnecting] = useState(false)
    const { toast } = useToast()

    useEffect(() => {
        checkConnectionStatus()
    }, [])


    const checkConnectionStatus = async () => {
        setIsLoading(true)
        try {
            const connected = await isGDriveConnected()
            setIsConnected(connected)

            if (connected) {
                const info = await getGDriveAccountInfo()
                setAccountInfo(info)
            }
        } catch (error) {
            console.error('[GDrive] Failed to check status:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleConnect = async () => {
        setIsConnecting(true)
        try {
            // Start OAuth - this opens the browser
            await startGDriveAuth()

            toast({
                title: "Authorization Started",
                description: "Complete sign-in in your browser. You'll be redirected back automatically."
            })

            // Wait for the OAuth callback (automatic via deep link or localhost)
            const info = await completeGDriveAuth()

            setIsConnected(true)
            setAccountInfo(info)

            toast({
                title: "Connected!",
                description: `Signed in as ${info.email}`
            })
        } catch (error) {
            console.error('[GDrive] Auth failed:', error)
            toast({
                title: "Connection Failed",
                description: String(error),
                variant: "destructive"
            })
        } finally {
            setIsConnecting(false)
        }
    }

    const handleDisconnect = async () => {
        setIsDisconnecting(true)
        try {
            await disconnectGDrive()
            setIsConnected(false)
            setAccountInfo(null)

            toast({
                title: "Disconnected",
                description: "Google Drive has been disconnected"
            })
        } catch (error) {
            console.error('[GDrive] Disconnect failed:', error)
            toast({
                title: "Error",
                description: "Failed to disconnect",
                variant: "destructive"
            })
        } finally {
            setIsDisconnecting(false)
        }
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <LazyMotion features={domAnimation}>
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h3 className="text-lg font-semibold text-foreground mb-1">Cloud Storage</h3>
                <p className="text-sm text-muted-foreground">
                    Connect to Google Drive to stream media directly from the cloud
                </p>
            </div>

            {/* Connection Status Card */}
            <m.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-5 rounded-xl bg-card border border-border"
            >
                <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={`p-3 rounded-xl ${isConnected ? 'bg-white/10' : 'bg-white/10'}`}>
                        {isConnected ? (
                            <CheckCircle2 className="size-6 text-white" />
                        ) : (
                            <Cloud className="size-6 text-white" />
                        )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold text-foreground">Google Drive</h4>
                            {isConnected && (
                                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-white/10 text-white">
                                    Connected
                                </span>
                            )}
                        </div>

                        {isConnected && accountInfo ? (
                            <div className="space-y-3">
                                {/* Account Info */}
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <User className="size-4" />
                                    <span>{accountInfo.email}</span>
                                </div>

                                {/* Storage Info */}
                                {accountInfo.storage_used !== undefined && accountInfo.storage_limit !== undefined && (
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <HardDrive className="size-4" />
                                            <span>
                                                {formatStorageSize(accountInfo.storage_used)} of{' '}
                                                {formatStorageSize(accountInfo.storage_limit)} used
                                            </span>
                                        </div>
                                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                                            <div
                                                className="h-full bg-gradient-to-r from-white to-gray-400 rounded-full transition-all"
                                                style={{
                                                    width: `${Math.min(100, (accountInfo.storage_used / accountInfo.storage_limit) * 100)}%`
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}

                                {/* Disconnect Button */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleDisconnect}
                                    disabled={isDisconnecting}
                                    className="mt-2"
                                >
                                    {isDisconnecting ? (
                                        <Loader2 className="size-4 mr-2 animate-spin" />
                                    ) : (
                                        <LogOut className="size-4 mr-2" />
                                    )}
                                    Disconnect
                                </Button>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">
                                    Connect your Google Drive to access your media library from anywhere.
                                    Stream movies and TV shows directly without downloading.
                                </p>

                                <Button
                                    onClick={handleConnect}
                                    disabled={isConnecting}
                                    className="gap-2"
                                >
                                    {isConnecting ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" />
                                            Opening browser…
                                        </>
                                    ) : (
                                        <>
                                            <LogIn className="size-4" />
                                            Connect Google Drive
                                        </>
                                    )}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </m.div>

        </div>
        </LazyMotion>
    )
}
