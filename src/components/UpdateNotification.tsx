import { motion } from "framer-motion"
import { Download, X } from "lucide-react"
import { UpdateInfo } from "@/services/api"

interface UpdateNotificationProps {
  updateInfo: UpdateInfo
  onUpdateNow: () => void
  onDismiss: () => void
}

const DISMISS_KEY_PREFIX = "streamvault_update_dismissed_"

export function isUpdateDismissed(version: string): boolean {
  return localStorage.getItem(`${DISMISS_KEY_PREFIX}${version}`) === "true"
}

export function dismissUpdate(version: string): void {
  localStorage.setItem(`${DISMISS_KEY_PREFIX}${version}`, "true")
}

export function UpdateNotification({ updateInfo, onUpdateNow, onDismiss }: UpdateNotificationProps) {
  // Parse release notes into bullet points (take first 3 lines)
  const noteLines = (updateInfo.release_notes || "")
    .split("\n")
    .map(l => l.replace(/^[-*•]\s*/, "").trim())
    .filter(l => l.length > 0)
    .slice(0, 3)

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.95, opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed inset-0 z-[250] flex items-center justify-center"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onDismiss} />
      <div className="relative mx-4 w-full max-w-lg rounded-xl border border-white/10 bg-[#141414]/95 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/10">
              <Download className="w-5 h-5 text-neutral-300" />
            </div>
            <div className="flex items-center gap-2.5">
              <span className="text-base font-semibold text-neutral-200">
                Update Available
              </span>
              <span className="px-2 py-0.5 text-xs font-medium bg-white/10 text-neutral-400 rounded">
                v{updateInfo.latest_version}
              </span>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="p-1.5 rounded-lg text-neutral-600 hover:text-neutral-300 hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Release notes preview */}
        {noteLines.length > 0 && (
          <div className="px-5 pt-1 pb-3 space-y-1">
            {noteLines.map((line, i) => (
              <div key={i} className="flex items-start gap-2.5 text-sm text-neutral-500">
                <span className="text-neutral-600 mt-px flex-shrink-0">—</span>
                <span className="line-clamp-1">{line}</span>
              </div>
            ))}
          </div>
        )}

        {/* Action */}
        <div className="px-5 pb-4 pt-1">
          <button
            onClick={onUpdateNow}
            className="w-full py-2.5 px-4 rounded-lg bg-white/10 hover:bg-white/15 text-neutral-200 text-sm font-medium transition-colors border border-white/10"
          >
            Update Now
          </button>
        </div>
      </div>
    </motion.div>
  )
}
