import { Play, Loader2, Info } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import type { ZipPlaybackLoadingState } from "@/utils/zipPlayback";

interface ZipPlaybackLoadingOverlayProps {
  loadingState: ZipPlaybackLoadingState | null;
  zIndexClassName?: string;
}

export function ZipPlaybackLoadingOverlay({
  loadingState,
  zIndexClassName = "z-[340]",
}: ZipPlaybackLoadingOverlayProps) {
  return (
    <AnimatePresence>
      {loadingState && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/80 backdrop-blur-md`}
        >
          <motion.div
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, y: 6 }}
            className="mx-4 w-full max-w-md rounded-3xl border border-white/[0.08] bg-black p-8 shadow-2xl shadow-black"
          >
            <div className="flex flex-col items-center text-center">
              {/* Play Icon container - Black & White theme */}
              <div className="relative mb-5 flex size-16 items-center justify-center rounded-full border border-white/15 bg-white/[0.03]">
                <motion.div
                  className="absolute inset-0 rounded-full border border-white/10"
                  animate={{ scale: [1, 1.25, 1], opacity: [0.15, 0.4, 0.15] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
                <Play className="size-6 text-white fill-white/10 ml-0.5" />
              </div>

              {/* Status Header */}
              <div className="mb-2.5 flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin text-white/50" />
                <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/40">
                  Preparing Playback
                </span>
              </div>

              <h3 className="mb-2 text-xl font-bold tracking-tight text-white">
                {loadingState.resume
                  ? "Resuming Playback"
                  : "Starting Playback"}
              </h3>

              <p className="mb-6 text-sm leading-relaxed text-white/60">
                The media player window should open shortly.
              </p>

              {/* Minimalist White Progress Bar */}
              <div className="w-full h-1 overflow-hidden rounded-full bg-white/10 mb-6">
                <motion.div
                  className="h-full rounded-full bg-white"
                  animate={{ x: ["-100%", "100%"] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                  style={{ width: "40%" }}
                />
              </div>

              {/* Info container - Black & White styling */}
              <div className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 text-left w-full">
                <Info className="mt-0.5 size-4 shrink-0 text-white/65" />
                <div className="text-xs leading-relaxed text-white/70">
                  <span className="font-semibold text-white">Note:</span> If the media player window does not open or nothing happens, please restart the application.
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
