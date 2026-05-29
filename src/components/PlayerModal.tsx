import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ExternalLink } from 'lucide-react'

interface PlayerModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSelectPlayer: (player: 'mpv' | 'vlc' | 'builtin') => void
    title: string
}

export function PlayerModal({ open, onOpenChange, onSelectPlayer, title }: PlayerModalProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md bg-background/95 backdrop-blur-xl border-border/50">
                <DialogHeader>
                    <DialogTitle className="text-xl font-bold text-white">
                        Play with MPV
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        Watch <span className="font-medium text-foreground">{title}</span> in MPV Player
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    {/* MPV Option */}
                    <Button
                        variant="outline"
                        className="h-auto p-4 flex flex-col items-start gap-2 hover:bg-white/10 hover:border-white/50 transition-all duration-300 group"
                        onClick={() => {
                            onSelectPlayer('mpv')
                            onOpenChange(false)
                        }}
                    >
                        <div className="flex items-center gap-3 w-full">
                            <div className="p-2 rounded-lg bg-gradient-to-br from-gray-400 to-gray-600 text-white shadow-lg shadow-gray-500/20 group-hover:scale-110 transition-transform">
                                <ExternalLink className="size-5" />
                            </div>
                            <div className="flex-1 text-left">
                                <div className="font-semibold text-foreground group-hover:text-white transition-colors">
                                    MPV Player
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    External player • Best quality • Hardware acceleration
                                </div>
                            </div>
                        </div>
                        <div className="text-xs text-muted-foreground/70 pl-12">
                            Opens in a separate window with full MPV features
                        </div>
                    </Button>
                </div>

                {/* Quick tip */}
                <div className="text-xs text-center text-muted-foreground/60 border-t border-border/50 pt-4">
                    <span className="text-white">Tip:</span> Configure MPV path in Settings → Player
                </div>
            </DialogContent>
        </Dialog>
    )
}
