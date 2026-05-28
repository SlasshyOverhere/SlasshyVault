import { useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Play, RotateCcw, Clock, Film, Tv2, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'

interface ResumeDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    mediaType: 'movie' | 'tvshow' | 'tvepisode'
    seasonEpisode?: string // e.g., "S02E05"
    currentPosition: number // in seconds
    duration: number // in seconds
    posterUrl?: string
    onResume: () => void
    onStartOver: () => void
    isStreaming?: boolean // If true, shows different UI since actual progress is in browser localStorage
}

// Format seconds to HH:MM:SS or MM:SS
const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Format time remaining
const formatTimeRemaining = (current: number, total: number): string => {
    const remaining = total - current
    const mins = Math.floor(remaining / 60)

    if (mins < 1) return 'less than a minute'
    if (mins === 1) return '1 minute'
    if (mins < 60) return `${mins} minutes`

    const hrs = Math.floor(mins / 60)
    const remMins = mins % 60
    if (hrs === 1) {
        return remMins > 0 ? `1 hour ${remMins} mins` : '1 hour'
    }
    return remMins > 0 ? `${hrs} hours ${remMins} mins` : `${hrs} hours`
}

export function ResumeDialog({
    open,
    onOpenChange,
    title,
    mediaType,
    seasonEpisode,
    currentPosition,
    duration,
    posterUrl,
    onResume,
    onStartOver,
    isStreaming = false,
}: ResumeDialogProps) {
    const progressPercent = duration > 0 ? (currentPosition / duration) * 100 : 0
    const timeRemaining = formatTimeRemaining(currentPosition, duration)
    const hasProgressData = duration > 0 && currentPosition > 0

    const handleResume = () => {
        onOpenChange(false)
        onResume()
    }

    const handleStartOver = () => {
        onOpenChange(false)
        onStartOver()
    }

    // Handle keyboard shortcuts
    useEffect(() => {
        if (!open) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === 'r' || e.key === 'R') {
                e.preventDefault()
                handleResume()
            } else if (e.key === 's' || e.key === 'S') {
                e.preventDefault()
                handleStartOver()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [open])

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg bg-[#0c0a1a]/95 backdrop-blur-2xl border border-white/10 shadow-[0_0_80px_rgba(255,255,255,0.1)] rounded-2xl overflow-hidden">
                {/* Background glow effects */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute -top-20 -right-20 size-40 bg-gray-500/20 rounded-full blur-[80px]" />
                    <div className="absolute -bottom-20 -left-20 size-40 bg-gray-500/10 rounded-full blur-[80px]" />
                </div>

                <DialogHeader className="space-y-4 relative z-10">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-gradient-to-br from-gray-500/20 to-gray-500/20 border border-gray-500/30">
                            {mediaType === 'movie' ? (
                                <Film className="size-5 text-gray-400" />
                            ) : (
                                <Tv2 className="size-5 text-gray-400" />
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <DialogTitle className="text-xl font-bold text-white truncate">
                                {title}
                            </DialogTitle>
                            {seasonEpisode && (
                                <span className="text-sm font-medium text-gray-400">
                                    {seasonEpisode}
                                </span>
                            )}
                        </div>
                    </div>

                    <DialogDescription className="text-base space-y-5">
                        {/* Progress visualization - only show with real progress data */}
                        {hasProgressData && !isStreaming ? (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/10 p-5"
                            >
                                {/* Poster background (blurred) */}
                                {posterUrl && (
                                    <div
                                        className="absolute inset-0 opacity-15 blur-sm bg-cover bg-center"
                                        style={{ backgroundImage: `url(${posterUrl})` }}
                                    />
                                )}

                                <div className="relative z-10 space-y-5">
                                    {/* Time info */}
                                    <div className="flex items-center justify-center gap-3">
                                        <div className="p-2 rounded-lg bg-gray-500/20">
                                            <Clock className="size-4 text-gray-400" />
                                        </div>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-2xl font-bold text-white">
                                                {formatTime(currentPosition)}
                                            </span>
                                            <span className="text-white/40">/</span>
                                            <span className="text-lg text-white/50">
                                                {formatTime(duration)}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Progress bar - 3D style */}
                                    <div className="relative h-3 bg-white/10 rounded-full overflow-hidden">
                                        <motion.div
                                            initial={{ width: 0 }}
                                            animate={{ width: `${Math.min(progressPercent, 100)}%` }}
                                            transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
                                            className="absolute inset-y-0 left-0 bg-gradient-to-r from-gray-500 via-gray-400 to-gray-300 rounded-full"
                                        >
                                            {/* Glow effect */}
                                            <div className="absolute inset-0 bg-gradient-to-r from-gray-500 via-gray-400 to-gray-300 blur-sm opacity-60" />
                                            {/* Shine */}
                                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                                        </motion.div>
                                        {/* Progress dot */}
                                        <motion.div
                                            initial={{ left: 0 }}
                                            animate={{ left: `${Math.min(progressPercent, 100)}%` }}
                                            transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
                                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full bg-white shadow-lg shadow-gray-500/50"
                                        />
                                    </div>

                                    {/* Stats */}
                                    <div className="flex justify-between text-sm">
                                        <span className="text-white/50 flex items-center gap-1.5">
                                            <Sparkles className="size-3.5 text-gray-400" />
                                            {progressPercent.toFixed(0)}% watched
                                        </span>
                                        <span className="text-white/50">
                                            {timeRemaining} remaining
                                        </span>
                                    </div>
                                </div>
                            </motion.div>
                        ) : (
                            // Streaming or no progress data - show simpler UI
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/10 p-8"
                            >
                                {/* Poster background (blurred) */}
                                {posterUrl && (
                                    <div
                                        className="absolute inset-0 opacity-15 blur-sm bg-cover bg-center"
                                        style={{ backgroundImage: `url(${posterUrl})` }}
                                    />
                                )}
                                <div className="relative z-10 flex flex-col items-center gap-4">
                                    <div className="p-4 rounded-2xl bg-gradient-to-br from-gray-500/20 to-gray-500/20 border border-gray-500/30 shadow-lg shadow-gray-500/20">
                                        <Play className="size-8 text-gray-400 fill-gray-400" />
                                    </div>
                                    <p className="text-center text-white font-medium text-lg">
                                        You've watched this before
                                    </p>
                                    {isStreaming && (
                                        <p className="text-xs text-white/40 text-center">
                                            Your progress is saved in your browser
                                        </p>
                                    )}
                                </div>
                            </motion.div>
                        )}

                        <p className="text-center text-white/50">
                            {isStreaming || !hasProgressData
                                ? "Would you like to continue watching or start from the beginning?"
                                : "You stopped watching. Continue from where you left off?"}
                        </p>
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter className="flex-col sm:flex-row gap-3 pt-4 relative z-10">
                    <Button
                        variant="outline"
                        onClick={handleStartOver}
                        className="w-full sm:w-auto gap-2 bg-white/[0.04] border-white/10 hover:bg-white/[0.08] hover:border-white/20 text-white/70 hover:text-white rounded-xl py-5 transition-all duration-300"
                    >
                        <RotateCcw className="size-4" />
                        Start Over
                        <kbd className="hidden sm:inline-flex ml-2 size-5 items-center justify-center rounded bg-white/10 text-[10px] font-medium text-white/50">
                            S
                        </kbd>
                    </Button>
                    <Button
                        onClick={handleResume}
                        className="w-full sm:w-auto gap-2 bg-gradient-to-r from-white via-gray-200 to-white hover:from-gray-100 hover:via-white hover:to-gray-100 text-black font-semibold rounded-xl py-5 shadow-lg shadow-white/20 transition-all duration-300 hover:shadow-white/30"
                    >
                        <Play className="size-4 fill-current" />
                        {hasProgressData && !isStreaming ? `Resume at ${formatTime(currentPosition)}` : 'Continue Watching'}
                        <kbd className="hidden sm:inline-flex ml-2 size-5 items-center justify-center rounded bg-white/20 text-[10px] font-medium">
                            R
                        </kbd>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

