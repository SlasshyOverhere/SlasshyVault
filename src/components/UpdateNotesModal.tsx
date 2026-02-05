import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, CheckCircle, Bug, LogIn, Zap } from 'lucide-react'

const CURRENT_VERSION = '3.0.6'

interface UpdateNotesModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isFromSettings?: boolean
}

export function UpdateNotesModal({ open, onOpenChange, isFromSettings = false }: UpdateNotesModalProps) {
  const handleClose = () => {
    if (!isFromSettings) {
      // Mark as shown in localStorage
      markUpdateNotesAsShown()
    }
    onOpenChange(false)
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200]"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 flex items-center justify-center z-[201] p-4"
          >
            <div className="bg-card/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between p-5 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-gradient-to-br from-white/20 to-white/5">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">What's New</h2>
                    <p className="text-xs text-muted-foreground">Version {CURRENT_VERSION}</p>
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                >
                  <X className="w-5 h-5 text-muted-foreground" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Required Login */}
                <Section
                  icon={<LogIn className="w-4 h-4" />}
                  title="Google Sign-In Required"
                  color="from-blue-500/20 to-blue-500/5"
                >
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>• Sign in with Google to access the app</li>
                    <li>• Your data is stored in your own Google Drive</li>
                    <li>• MPV auto-detected on first login</li>
                  </ul>
                </Section>

                {/* Beta Features */}
                <Section
                  icon={<Zap className="w-4 h-4" />}
                  title="Beta Features (Experimental)"
                  color="from-purple-500/20 to-purple-500/5"
                >
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>• <span className="text-purple-400 font-medium">Watch Together</span> - Watch with friends in sync</li>
                    <li>• <span className="text-purple-400 font-medium">Social Features</span> - Friends, chat, activity</li>
                    <li>• Enable in Settings → General → Beta Features</li>
                    <li>• These features are experimental and may not work perfectly</li>
                  </ul>
                </Section>

                {/* Performance */}
                <Section
                  icon={<Zap className="w-4 h-4" />}
                  title="Faster Startup"
                  color="from-green-500/20 to-green-500/5"
                >
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>• App loads instantly after login</li>
                    <li>• Social features load in background</li>
                  </ul>
                </Section>

                {/* Bug Fixes */}
                <Section
                  icon={<Bug className="w-4 h-4" />}
                  title="Bug Fixes"
                  color="from-orange-500/20 to-orange-500/5"
                >
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>• Fixed loading spinner position in Social tab</li>
                    <li>• Fixed Watch Together showing when beta is off</li>
                    <li>• Improved login flow reliability</li>
                  </ul>
                </Section>
              </div>

              {/* Footer */}
              <div className="p-5 border-t border-white/10">
                <button
                  onClick={handleClose}
                  className="w-full py-2.5 px-4 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors flex items-center justify-center gap-2"
                >
                  <CheckCircle className="w-4 h-4" />
                  Got it!
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// Section component for organizing update notes
function Section({
  icon,
  title,
  color,
  children
}: {
  icon: React.ReactNode
  title: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-lg bg-gradient-to-br ${color}`}>
          {icon}
        </div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="pl-8">
        {children}
      </div>
    </div>
  )
}

// Utility functions for managing update notes state
const UPDATE_NOTES_KEY = 'streamvault_update_notes_shown'

export function getUpdateNotesConfig(): { version: string; shown: boolean } | null {
  try {
    const stored = localStorage.getItem(UPDATE_NOTES_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.error('Failed to read update notes config:', e)
  }
  return null
}

export function shouldShowUpdateNotes(): boolean {
  const config = getUpdateNotesConfig()
  // Show if no config exists, or if version doesn't match current
  if (!config) return true
  if (config.version !== CURRENT_VERSION) return true
  return !config.shown
}

export function markUpdateNotesAsShown(): void {
  try {
    localStorage.setItem(UPDATE_NOTES_KEY, JSON.stringify({
      version: CURRENT_VERSION,
      shown: true
    }))
  } catch (e) {
    console.error('Failed to save update notes config:', e)
  }
}

export function resetUpdateNotesForVersion(version: string): void {
  try {
    localStorage.setItem(UPDATE_NOTES_KEY, JSON.stringify({
      version: version,
      shown: false
    }))
  } catch (e) {
    console.error('Failed to reset update notes config:', e)
  }
}

export const CURRENT_APP_VERSION = CURRENT_VERSION
