import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import { X, Play, Tv2, Film } from 'lucide-react'

interface PlayConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  mediaType: 'movie' | 'tvshow' | 'tvepisode'
  seasonEpisode?: string
  onConfirm: () => void
}

export function PlayConfirmDialog({
  open,
  onOpenChange,
  title,
  mediaType,
  seasonEpisode,
  onConfirm,
}: PlayConfirmDialogProps) {
  const handleConfirm = () => {
    onOpenChange(false)
    onConfirm()
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <AnimatePresence>
      {open && (
        <LazyMotion features={domAnimation}>
          {/* Backdrop */}
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleCancel}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[300]"
          />

          {/* Dialog */}
          <m.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 flex items-center justify-center z-[301] p-4"
          >
            <div className="bg-black/80 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-white/10 border border-white/15">
                    {mediaType === 'movie' ? (
                      <Film className="size-5 text-white" />
                    ) : (
                      <Tv2 className="size-5 text-white" />
                    )}
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">
                      {title}
                    </h2>
                    {seasonEpisode && (
                      <p className="text-xs text-white/50">
                        {seasonEpisode}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                >
                  <X className="size-4 text-white/50" />
                </button>
              </div>

              {/* Content */}
              <div className="p-4">
                <p className="text-sm text-white/50 mb-4">
                  Do you want to play{' '}
                  <span className="text-white font-medium">{title}</span>
                  {seasonEpisode && (
                    <span className="text-white font-medium"> ({seasonEpisode})</span>
                  )}
                  ?
                </p>

                <button
                  type="button"
                  onClick={handleConfirm}
                  className="w-full py-2.5 px-4 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors flex items-center justify-center gap-2"
                >
                  <Play className="size-4 fill-current" />
                  Play
                </button>
              </div>
            </div>
          </m.div>
        </LazyMotion>
      )}
    </AnimatePresence>
  )
}
