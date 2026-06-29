import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import { X, FlaskConical, Check } from 'lucide-react'

interface BetaConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function BetaConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: BetaConfirmDialogProps) {
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
            <div className="bg-black/90 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-purple-500/20 border border-purple-500/20">
                    <FlaskConical className="size-5 text-purple-400" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">
                      Beta Features Warning
                    </h2>
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
              <div className="p-5 space-y-4">
                <p className="text-sm text-white/80 leading-relaxed">
                  These features are experimental and for public testing only:
                </p>
                <ul className="text-sm text-white/60 space-y-2 list-disc pl-5">
                  <li>Watch Together - Watch with friends in sync</li>
                  <li>Social Features - Friends, chat, activity feed</li>
                </ul>
                <p className="text-sm text-white/80 leading-relaxed">
                  These features may not work properly, may have bugs, and could stop working at any time.
                </p>
                <p className="text-sm text-white font-medium">
                  Do you want to enable beta features?
                </p>

                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                   <button
                    type="button"
                    onClick={handleCancel}
                    className="w-full py-2.5 px-4 rounded-xl bg-white/10 text-white font-medium text-sm hover:bg-white/20 transition-colors flex items-center justify-center gap-2"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="w-full py-2.5 px-4 rounded-xl bg-purple-500 hover:bg-purple-600 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    <Check className="size-4" />
                    Enable Beta Features
                  </button>
                </div>
              </div>
            </div>
          </m.div>
        </LazyMotion>
      )}
    </AnimatePresence>
  )
}
