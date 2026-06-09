import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Trash2, FolderOpen } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onCleanup: () => void
  onKeep: () => void
}

export function RemoteCleanupDialog({ open, onOpenChange, title, onCleanup, onKeep }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-[#0A0A0A] border-neutral-800 text-neutral-100 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-neutral-100">Playback Complete</DialogTitle>
          <DialogDescription className="text-neutral-500 mt-2 text-sm">
            Playback of <span className="text-neutral-200 font-semibold">{title}</span> has finished.
            The cached file is still on your disk.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <p className="text-sm text-neutral-500 leading-relaxed">
            Do you want to clean up the cached file or keep it for future playback?
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Button
              onClick={() => { onCleanup(); onOpenChange(false) }}
              className="bg-red-500/5 hover:bg-red-500/15 text-red-400 border border-red-800/30 rounded-xl h-11 font-semibold transition-all duration-200"
            >
              <Trash2 className="size-4 mr-2" />
              Clean Up
            </Button>
            <Button
              onClick={() => { onKeep(); onOpenChange(false) }}
              className="bg-amber-600/10 hover:bg-amber-600/20 text-amber-400 border border-amber-700/30 rounded-xl h-11 font-semibold transition-all duration-200"
            >
              <FolderOpen className="size-4 mr-2" />
              Keep It
            </Button>
          </div>

          <p className="text-[11px] text-neutral-700 text-center font-medium">
            Unkept files will be automatically cleaned up based on your cache settings.
          </p>
        </div>

        <DialogFooter className="border-t border-neutral-800 pt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-neutral-500 hover:text-neutral-200 rounded-xl font-medium"
          >
            Ask Later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
