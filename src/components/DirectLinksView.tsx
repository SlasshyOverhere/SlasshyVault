import { useState, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/tauri"
import { listen } from "@tauri-apps/api/event"
import { motion, AnimatePresence } from "framer-motion"
import {
  Link2, Plus, Trash2, RefreshCw,
  AlertCircle, CheckCircle, Loader2, Archive,
  Sparkles,
  X, HardDrive, FileVideo
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useToast } from "@/components/ui/use-toast"

interface DdlSource {
  id: string
  url: string
  filename: string
  fileSize: number
  archiveFormat: string
  entryCount: number
  videoCount: number
  cdOffset: number
  cdSize: number
  createdAt: string
  lastVerifiedAt: string
  isExpired: boolean
}

interface DdlValidationResult {
  supportsRange: boolean
  fileSize: number
  filename: string
  contentType: string
}

interface DdlRefreshResult {
  accepted: boolean
  message: string
}

interface MediaItem {
  id: number
  title: string
  media_type: string
  season_number?: number
  episode_number?: number
  zip_entry_path?: string
  zip_uncompressed_size?: number
  file_path?: string
}

interface DdlIndexProgressPayload {
  stage: string
  message: string
  filename?: string | null
  current?: number | null
  total?: number | null
  season?: number | null
  episode?: number | null
  episodeTitle?: string | null
}

function formatSeasonEpisode(season?: number | null, episode?: number | null): string | null {
  if (season == null && episode == null) return null
  if (season != null && episode != null) {
    return `S${String(season).padStart(2, "0")} E${String(episode).padStart(2, "0")}`
  }
  if (season != null) return `Season ${season}`
  return `Episode ${episode}`
}

type Step = "idle" | "validating" | "indexing" | "done" | "error"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr + "Z")
  const now = new Date()
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 60) return "just now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

interface DirectLinksViewProps {
  onIndexComplete?: (payload: { mediaIds: number[]; contentName: string }) => void | Promise<void>
}

export default function DirectLinksView({ onIndexComplete }: DirectLinksViewProps) {
  const { toast } = useToast()
  const [sources, setSources] = useState<DdlSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [sourceMedia, setSourceMedia] = useState<Record<string, MediaItem[]>>({})
  const [refreshModal, setRefreshModal] = useState<string | null>(null)
  const [refreshUrl, setRefreshUrl] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState("")
  const [checkingHealth, setCheckingHealth] = useState<string | null>(null)

  // Add modal state
  const [addUrl, setAddUrl] = useState("")
  const [addStep, setAddStep] = useState<Step>("idle")
  const [addError, setAddError] = useState("")
  const [addValidation, setAddValidation] = useState<DdlValidationResult | null>(null)
  const [addProgress, setAddProgress] = useState<DdlIndexProgressPayload | null>(null)
  const [indexingTick, setIndexingTick] = useState(0)

  const progressCurrent = addProgress?.current ?? 0
  const progressTotal = addProgress?.total ?? 0
  const isIndeterminateProgress = addStep === "indexing" && (
    addProgress?.stage === "probing-archive" ||
    addProgress?.stage === "fetching-show-metadata"
  )
  const progressPercent = progressTotal > 0 ? Math.max(4, Math.min(100, (progressCurrent / progressTotal) * 100)) : 4
  const progressContext = formatSeasonEpisode(addProgress?.season, addProgress?.episode)
  const progressDots = addStep === "indexing" ? ".".repeat((indexingTick % 4)) : ""
  const progressElapsedSeconds = Math.floor(indexingTick / 4)
  const progressMessage = addProgress?.message
    ? `${addProgress.message.replace(/\.+$/, "")}${progressDots}`
    : `Analyzing Headers${progressDots}`
  const progressLabel = addProgress?.stage === "fetching-episode-metadata"
    ? "TMDB Episode Metadata"
    : addProgress?.stage === "fetching-show-metadata"
      ? "TMDB Show Match"
      : addProgress?.stage === "archive-indexed"
        ? "Archive Analysis"
        : addProgress?.stage === "adding-entry"
          ? "Library Mapping"
          : addProgress?.stage === "probing-archive"
            ? "Archive Probe"
            : "Indexing"

  const fetchSources = useCallback(async () => {
    try {
      const result = await invoke<DdlSource[]>("ddl_get_sources")
      setSources(result)
    } catch (e) {
      console.error("Failed to fetch DDL sources:", e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSources() }, [fetchSources])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    void (async () => {
      unlisten = await listen<DdlIndexProgressPayload>("ddl-index-progress", (event) => {
        setAddProgress(event.payload)
      })
    })()

    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (addStep !== "indexing") {
      setIndexingTick(0)
      return
    }

    const interval = window.setInterval(() => {
      setIndexingTick(current => current + 1)
    }, 250)

    return () => {
      window.clearInterval(interval)
    }
  }, [addStep])

  useEffect(() => {
    const missingSourceIds = sources
      .map(source => source.id)
      .filter(sourceId => sourceMedia[sourceId] == null)

    if (missingSourceIds.length === 0) return

    let cancelled = false

    void Promise.all(
      missingSourceIds.map(async (sourceId) => {
        try {
          const media = await invoke<MediaItem[]>("ddl_get_source_media", { sourceId })
          if (cancelled) return
          setSourceMedia(current => {
            if (current[sourceId] != null) return current
            return { ...current, [sourceId]: media }
          })
        } catch (e) {
          console.error("Failed to fetch media:", e)
        }
      })
    )

    return () => {
      cancelled = true
    }
  }, [sources, sourceMedia])

  const handleAdd = async () => {
    if (!addUrl.trim()) return
    setAddStep("validating")
    setAddError("")
    setAddProgress(null)
    try {
      const validation = await invoke<DdlValidationResult>("ddl_validate_url", { url: addUrl.trim() })
      setAddValidation(validation)
      setAddStep("indexing")
      const indexedSource = await invoke<DdlSource>("ddl_index_archive", { url: addUrl.trim(), validation })
      setAddStep("done")
      await fetchSources()
      let indexedMediaIds: number[] = []
      try {
        const indexedMedia = await invoke<MediaItem[]>("ddl_get_source_media", { sourceId: indexedSource.id })
        setSourceMedia(current => ({ ...current, [indexedSource.id]: indexedMedia }))
        indexedMediaIds = indexedMedia
          .filter(media => media.media_type !== "tvshow")
          .map(media => media.id)
      } catch (e) {
        console.error("Failed to load indexed media:", e)
      }
      setTimeout(() => {
        setShowAddModal(false)
        setAddUrl("")
        setAddStep("idle")
        setAddValidation(null)
        setAddProgress(null)
        void onIndexComplete?.({
          mediaIds: indexedMediaIds,
          contentName: indexedSource.filename,
        })
      }, 2000)
    } catch (e: any) {
      setAddError(String(e))
      setAddStep("error")
    }
  }

  const handleDelete = async (sourceId: string) => {
    try {
      await invoke("ddl_delete_source", { sourceId })
      setSources(s => s.filter(src => src.id !== sourceId))
      setSourceMedia(m => { const n = { ...m }; delete n[sourceId]; return n })
    } catch (e) {
      console.error("Failed to delete source:", e)
    }
  }

  const handleRefresh = async (sourceId: string) => {
    if (!refreshUrl.trim()) return
    setRefreshing(true)
    setRefreshError("")
    try {
      const result = await invoke<DdlRefreshResult>("ddl_refresh_link", {
        sourceId, newUrl: refreshUrl.trim()
      })
      if (result.accepted) {
        setRefreshModal(null)
        setRefreshUrl("")
        await fetchSources()
      } else {
        setRefreshError(result.message)
      }
    } catch (e: any) {
      setRefreshError(String(e))
    } finally {
      setRefreshing(false)
    }
  }

  const handleCheckHealth = async (sourceId: string) => {
    setCheckingHealth(sourceId)
    try {
      const healthy = await invoke<boolean>("ddl_check_link_health", { sourceId })
      await fetchSources()
      toast({
        title: healthy ? "Link healthy" : "Link expired",
        description: healthy
          ? "This source is still reachable."
          : "This source no longer responds and was marked expired.",
        variant: healthy ? "default" : "destructive"
      })
    } catch (e) {
      console.error("Health check failed:", e)
      toast({
        title: "Health check failed",
        description: String(e),
        variant: "destructive"
      })
    } finally {
      setCheckingHealth(null)
    }
  }

  return (
    <div className="flex flex-col relative">

      <div className="max-w-5xl mx-auto px-8 py-12 relative z-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 animate-fade-in">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-white/10 border border-white/20 shadow-glow-sm">
                <Link2 className="w-5 h-5 text-white drop-shadow-white" />
              </div>
              <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em]">Stream Engine</span>
            </div>
            <h1 className="text-4xl font-black text-white tracking-tight mb-2">
              Direct <span className="text-white/40">Links</span>
            </h1>
            <p className="text-sm text-neutral-400 max-w-md font-medium leading-relaxed">
              High-performance streaming from direct download archives. 
              Supports ZIP & RAR with instant random access.
            </p>
          </div>
          
          <motion.button
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => { setShowAddModal(true); setAddStep("idle"); setAddUrl(""); setAddError(""); setAddProgress(null); setAddValidation(null) }}
            className="btn-primary flex items-center gap-2 group"
          >
            <Plus className="w-4 h-4 stroke-[3] transition-transform group-hover:rotate-90" />
            <span>Add New Archive</span>
          </motion.button>
        </div>

        {/* Sources List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4 animate-fade-in">
            <div className="relative">
              <div className="absolute inset-0 blur-2xl bg-white/20 rounded-full animate-pulse-soft" />
              <Loader2 className="w-10 h-10 text-white animate-spin relative" />
            </div>
            <span className="text-xs font-black text-white/20 uppercase tracking-widest">Initializing</span>
          </div>
        ) : sources.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="empty-state-enhanced py-32"
          >
            <div className="p-6 rounded-3xl bg-white/[0.03] border border-white/10 mb-6 relative group">
              <div className="absolute inset-0 bg-white/5 blur-3xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              <Archive className="w-16 h-16 text-neutral-500 relative" />
            </div>
            <h3 className="text-2xl font-black text-white mb-3">No Active Links</h3>
            <p className="text-neutral-500 max-w-xs mx-auto text-sm font-medium leading-relaxed">
              Your direct streaming library is empty. Add a ZIP link to start watching instantly.
            </p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 gap-4 animate-fade-in">
            {sources.map((source, idx) => (
              <motion.div
                key={source.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.08 }}
                className="group relative rounded-2xl transition-all duration-500 bg-white/[0.08] border-white/20 shadow-glow-sm"
              >
                {/* Source Header */}
                <div className="flex items-center gap-5 p-5 relative z-10">
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-500 shadow-elevation-2",
                    source.isExpired ? "bg-red-500/10 border border-red-500/20" : "bg-white/10 border border-white/20"
                  )}>
                    {source.isExpired
                      ? <AlertCircle className="w-6 h-6 text-red-400 animate-pulse-soft" />
                      : <HardDrive className="w-6 h-6 text-white" />
                    }
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="text-lg font-black text-white truncate tracking-tight">{source.filename}</h3>
                      {source.isExpired && (
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-red-500 text-white tracking-[0.1em] uppercase">
                          Expired
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-white/10 text-white/60 tracking-[0.1em] uppercase border border-white/5">
                        {source.archiveFormat}
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-4 text-[11px] font-bold text-neutral-500 uppercase tracking-wider">
                      <span className="flex items-center gap-1.5"><Archive className="w-3 h-3" /> {formatBytes(source.fileSize)}</span>
                      <span className="w-1 h-1 rounded-full bg-neutral-800" />
                      <span className="flex items-center gap-1.5"><FileVideo className="w-3 h-3" /> {source.videoCount} Items</span>
                      <span className="w-1 h-1 rounded-full bg-neutral-800" />
                      <span className="text-white/30">{timeAgo(source.createdAt)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pr-2">
                    {source.isExpired && (
                      <motion.button
                        whileHover={{ scale: 1.1, backgroundColor: "rgba(255,255,255,0.1)" }}
                        whileTap={{ scale: 0.9 }}
                        onClick={(e) => { e.stopPropagation(); setRefreshModal(source.id); setRefreshUrl(""); setRefreshError("") }}
                        className="p-3 rounded-xl text-white transition-colors border border-white/10"
                        title="Refresh link"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </motion.button>
                    )}
                    {!source.isExpired && (
                      <motion.button
                        whileHover={{ scale: 1.1, backgroundColor: "rgba(255,255,255,0.1)" }}
                        whileTap={{ scale: 0.9 }}
                        onClick={(e) => { e.stopPropagation(); if (!checkingHealth) handleCheckHealth(source.id) }}
                        className={cn(
                          "p-3 rounded-xl transition-all border border-white/5 hover:border-white/20",
                          checkingHealth === source.id ? "text-white bg-white/10" : "text-neutral-500"
                        )}
                        disabled={!!checkingHealth}
                      >
                        <RefreshCw className={cn("w-4 h-4", checkingHealth === source.id && "animate-spin")} />
                      </motion.button>
                    )}
                    <motion.button
                      whileHover={{ scale: 1.1, backgroundColor: "rgba(239,68,68,0.1)", color: "#f87171" }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => { e.stopPropagation(); handleDelete(source.id) }}
                      className="p-3 rounded-xl text-neutral-500 transition-colors border border-white/5 hover:border-red-500/20"
                    >
                      <Trash2 className="w-4 h-4" />
                    </motion.button>
                  </div>
                </div>

                {/*
                  Media list intentionally hidden for now.
                  Keep this block available for later re-enable if we want per-source episode browsing again.
                */}
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Add Link Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
            onClick={() => { if (addStep !== "validating" && addStep !== "indexing") setShowAddModal(false) }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="w-full max-w-xl glass-heavy rounded-3xl overflow-hidden shadow-elevation-3"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-6 border-b border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-white/10 border border-white/20">
                    <Plus className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-white tracking-tight">Index Archive</h2>
                    <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Add Direct Download Link</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowAddModal(false)} 
                  className="p-2 rounded-xl hover:bg-white/10 text-neutral-500 hover:text-white transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between items-end mb-1">
                    <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Source URL</label>
                    <span className="text-[10px] font-bold text-neutral-600 uppercase">HTTPS Required</span>
                  </div>
                  <input
                    type="url"
                    placeholder="https://server.com/archive_01.zip"
                    value={addUrl}
                    onChange={e => setAddUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && addStep === 'idle') handleAdd() }}
                    disabled={addStep === "validating" || addStep === "indexing"}
                    className="input-glass text-lg font-medium py-4"
                    autoFocus
                  />
                </div>

                {/* Dynamic Status Engine */}
                <AnimatePresence mode="wait">
                  {addStep === "validating" && (
                    <motion.div 
                      key="validating"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="flex flex-col items-center justify-center py-6 gap-3 bg-white/[0.02] rounded-2xl border border-white/5 shadow-inner"
                    >
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                      <span className="text-xs font-black text-white/40 uppercase tracking-[0.2em]">Verifying Endpoints</span>
                    </motion.div>
                  )}

                  {addStep === "indexing" && addValidation && (
                    <motion.div 
                      key="indexing"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="space-y-5"
                    >
                      <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/[0.04] border border-white/10">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                          <CheckCircle className="w-5 h-5 text-amber-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black text-white truncate uppercase tracking-tight">{addValidation.filename}</p>
                          <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">{formatBytes(addValidation.fileSize)}</p>
                        </div>
                      </div>

                      <div className="glass-light rounded-2xl p-5 space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1 min-w-0">
                            <p className="text-[10px] font-black uppercase tracking-widest text-white/40">{progressLabel}</p>
                            <p className="text-sm font-bold text-white leading-tight">{progressMessage}</p>
                            <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                              {progressContext && <span>{progressContext}</span>}
                              {addProgress?.filename && <span className="truncate max-w-[220px]">{addProgress.filename}</span>}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-lg font-black text-white leading-none">{Math.round(progressPercent)}%</p>
                            <p className="text-[10px] font-black uppercase tracking-widest text-white/60">{progressCurrent} / {progressTotal || 1}</p>
                          </div>
                        </div>

                        <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden border border-white/5 shadow-inner p-[1px]">
                          <motion.div
                            className="h-full rounded-full bg-gradient-to-r from-neutral-600 via-white to-neutral-400 shadow-glow-sm"
                            initial={{ width: "0%" }}
                            animate={isIndeterminateProgress
                              ? { width: ["18%", "56%", "28%"], x: ["0%", "52%", "0%"] }
                              : { width: `${progressPercent}%`, x: "0%" }}
                            transition={isIndeterminateProgress
                              ? { duration: 1.35, repeat: Infinity, ease: "easeInOut" }
                              : { type: "spring", stiffness: 100, damping: 20 }}
                          />
                        </div>

                        <div className="grid grid-cols-4 gap-2">
                          <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                            <p className="text-[9px] font-black uppercase tracking-widest text-neutral-500">Stage</p>
                            <p className="mt-1 text-xs font-bold text-white truncate">{addProgress?.stage || "pending"}</p>
                          </div>
                          <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                            <p className="text-[9px] font-black uppercase tracking-widest text-neutral-500">Current</p>
                            <p className="mt-1 text-xs font-bold text-white">{progressCurrent}</p>
                          </div>
                          <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                            <p className="text-[9px] font-black uppercase tracking-widest text-neutral-500">Total</p>
                            <p className="mt-1 text-xs font-bold text-white">{progressTotal || 1}</p>
                          </div>
                          <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                            <p className="text-[9px] font-black uppercase tracking-widest text-neutral-500">Elapsed</p>
                            <p className="mt-1 text-xs font-bold text-white">{progressElapsedSeconds}s</p>
                          </div>
                        </div>

                        {addProgress?.episodeTitle && (
                          <motion.div 
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="flex items-center gap-2 p-2.5 rounded-xl bg-black/40 border border-white/5"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-[11px] font-bold text-neutral-300 truncate">
                              {addProgress.stage === "fetching-episode-metadata" ? "Latest metadata:" : "Discovered:"} {addProgress.episodeTitle}
                            </span>
                          </motion.div>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {addStep === "done" && (
                    <motion.div 
                      key="done"
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="flex flex-col items-center justify-center py-8 gap-4 bg-white/5 rounded-2xl border border-white/10"
                    >
                      <div className="w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-glow">
                        <CheckCircle className="w-8 h-8 text-black" />
                      </div>
                      <span className="text-sm font-black text-white uppercase tracking-[0.3em]">Mapping Complete</span>
                    </motion.div>
                  )}

                  {addStep === "error" && (
                    <motion.div 
                      key="error"
                      initial={{ x: 20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      className="p-5 bg-red-500/10 border border-red-500/20 rounded-2xl flex gap-4 items-start"
                    >
                      <AlertCircle className="w-6 h-6 text-red-400 flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-black text-red-400 uppercase tracking-tight">Index Failed</p>
                        <p className="text-xs font-medium text-neutral-400 leading-relaxed">{addError}</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/[0.02] border border-white/5">
                  <div className="p-2 rounded-lg bg-white/5">
                    <HardDrive className="w-4 h-4 text-neutral-500" />
                  </div>
                  <p className="text-[10px] font-medium text-neutral-500 leading-relaxed uppercase tracking-tight">
                    Hosting provider must support <span className="text-white/60 font-bold">HTTP Range</span> requests for faster seeking.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 p-6 bg-white/[0.01] border-t border-white/5">
                <button
                  onClick={() => setShowAddModal(false)}
                  disabled={addStep === "validating" || addStep === "indexing"}
                  className="btn-ghost"
                >
                  Dismiss
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!addUrl.trim() || addStep === "validating" || addStep === "indexing" || addStep === "done"}
                  className="btn-primary min-w-[140px] inline-flex items-center justify-center gap-2"
                >
                  {addStep === "validating" || addStep === "indexing" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {addStep === "validating" ? "Validating..." : "Indexing..."}
                    </>
                  ) : addStep === "error" ? "Retry Index" : "Start Indexing"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Refresh Link Modal - Reusing the same premium pattern */}
      <AnimatePresence>
        {refreshModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
            onClick={() => { if (!refreshing) setRefreshModal(null) }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-full max-w-xl glass-heavy rounded-3xl overflow-hidden shadow-elevation-3"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-6 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-white/10 border border-white/20">
                    <RefreshCw className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-white tracking-tight">Refresh Session</h2>
                    <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Session Token Expired</p>
                  </div>
                </div>
                <button onClick={() => setRefreshModal(null)} className="btn-icon">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="p-5 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex gap-4 items-start shadow-inner">
                  <AlertCircle className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-neutral-400 leading-relaxed">
                    The previous direct link has expired. Please provide a fresh URL for the <span className="text-white font-bold">exact same archive</span> to restore stream functionality.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-white/40 uppercase tracking-widest block px-1">New Session URL</label>
                  <input
                    type="url"
                    placeholder="https://server.com/new_session_url.zip"
                    value={refreshUrl}
                    onChange={e => setRefreshUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && refreshModal) handleRefresh(refreshModal) }}
                    disabled={refreshing}
                    className="input-glass text-lg font-medium"
                    autoFocus
                  />
                </div>

                {refreshError && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs font-medium text-red-400"
                  >
                    {refreshError}
                  </motion.div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 p-6 bg-white/[0.01] border-t border-white/5">
                <button onClick={() => setRefreshModal(null)} disabled={refreshing} className="btn-ghost">
                  Cancel
                </button>
                <button
                  onClick={() => refreshModal && handleRefresh(refreshModal)}
                  disabled={!refreshUrl.trim() || refreshing}
                  className="btn-primary flex items-center gap-2 min-w-[160px]"
                >
                  {refreshing && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Verify & Restore</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
