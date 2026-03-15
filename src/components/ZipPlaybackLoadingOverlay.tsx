import { Archive, Info, Loader2 } from "lucide-react";
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
          className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/72 backdrop-blur-md`}
        >
          <motion.div
            initial={{ scale: 0.94, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, y: 8 }}
            className="mx-4 w-full max-w-xl rounded-[28px] border border-white/10 bg-[#0e1015]/95 p-7 shadow-2xl shadow-black/50"
          >
            <div className="flex items-start gap-4">
              <div className="relative mt-0.5 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                <motion.div
                  className="absolute inset-0 rounded-2xl border border-white/10"
                  animate={{ scale: [1, 1.18, 1], opacity: [0.2, 0.55, 0.2] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                />
                <Archive className="h-6 w-6 text-white/80" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-white/80" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/45">
                    Preparing ZIP Playback
                  </span>
                </div>
                <h3 className="mb-2 text-xl font-semibold tracking-tight text-white">
                  {loadingState.resume
                    ? "Resuming ZIP episode"
                    : "Opening ZIP episode"}
                </h3>
                <p className="mb-3 text-sm leading-relaxed text-white/70">
                  {loadingState.detail}
                </p>
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/35">
                      Episode
                    </div>
                    <div className="mt-1 line-clamp-1 text-sm font-medium text-white/85">
                      {loadingState.title}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/35">
                      Estimated Startup
                    </div>
                    <div className="mt-1 text-sm font-medium text-white/85">
                      About {loadingState.estimatedSeconds}s for{" "}
                      {loadingState.sizeLabel}
                    </div>
                  </div>
                </div>
                <div className="overflow-hidden rounded-full bg-white/8">
                  <motion.div
                    className="h-1.5 rounded-full bg-gradient-to-r from-white/55 via-white to-white/55"
                    animate={{ x: ["-45%", "120%"] }}
                    transition={{ duration: 1.35, repeat: Infinity, ease: "easeInOut" }}
                    style={{ width: "42%" }}
                  />
                </div>
                <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-400/10 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
                    <div className="text-sm leading-relaxed text-amber-50/90">
                      For more uninterrupted ZIP playback, set{" "}
                      <span className="font-semibold text-white">
                        ZIP Cache Directory
                      </span>{" "}
                      and{" "}
                      <span className="font-semibold text-white">
                        ZIP Cache Size Limit (GB)
                      </span>{" "}
                      in{" "}
                      <span className="font-semibold text-white">
                        Settings -&gt; Cloud -&gt; ZIP Archive Support
                      </span>
                      .
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
