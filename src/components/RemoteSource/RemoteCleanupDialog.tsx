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
      <DialogContent className="sm:max-w-md bg-[#141414] border-white/[0.08] text-white">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Playback Complete</DialogTitle>
          <DialogDescription className="text-neutral-400 mt-2">
            Playback of <span className="text-white font-semibold">{title}</span> has finished.
            The cached file is still on your disk.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-3">
          <p className="text-sm text-neutral-400 leading-relaxed">
            Do you want to clean up the cached file or keep it for future playback?
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Button
              onClick={() => { onCleanup(); onOpenChange(false) }}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20"
            >
              <Trash2 className="size-4 mr-2" />
              Clean Up
            </Button>
            <Button
              onClick={() => { onKeep(); onOpenChange(false) }}
              className="bg-white/10 hover:bg-white/20 text-white border border-white/20"
            >
              <FolderOpen className="size-4 mr-2" />
              Keep It
            </Button>
          </div>

          <p className="text-[10px] text-neutral-600 text-center">
            Unkept files will be automatically cleaned up based on your cache settings.
          </p>
        </div>

        <DialogFooter className="border-t border-white/[0.06] pt-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-neutral-400 hover:text-white"
          >
            Ask Later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
