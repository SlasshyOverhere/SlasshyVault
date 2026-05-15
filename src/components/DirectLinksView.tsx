import { useState, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/tauri"
import { listen } from "@tauri-apps/api/event"
import { motion, AnimatePresence } from "framer-motion"
import {
  Link2, Plus, Trash2, RefreshCw,
  AlertCircle, CheckCircle, Loader2, Archive,
  Sparkles,
  HardDrive, ChevronDown
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useToast } from "@/components/ui/use-toast"
import type { MediaItem as ApiMediaItem } from "@/services/api"
import { DdlMediaLibrary } from "./DdlMediaLibrary"

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

function prettifyFilename(filename: string): { display: string; extension: string } {
  const dotIndex = filename.lastIndexOf(".")
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : ""
  const nameWithoutExt = dotIndex > 0 ? filename.slice(0, dotIndex) : filename
  const display = nameWithoutExt.replace(/\./g, " ")
  return { display, extension }
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
  viewMode?: "grid" | "list"
  onItemClick?: (item: ApiMediaItem) => void
  onFixMatch?: (item: ApiMediaItem) => void
  onDownload?: (item: ApiMediaItem) => void | Promise<void>
  onDelete?: (item: ApiMediaItem) => void
  onWatchTogether?: (item: ApiMediaItem) => void
}

export default function DirectLinksView({
  onIndexComplete,
  viewMode = "grid",
  onItemClick,
  onFixMatch,
  onDownload,
  onDelete,
  onWatchTogether,
}: DirectLinksViewProps) {
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
  const [isSourcesDropdownOpen, setIsSourcesDropdownOpen] = useState(false)
  const [mediaRefreshKey, setMediaRefreshKey] = useState(0)

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
    } catch (err: unknown) {
      console.error("Failed to fetch DDL sources:", err)
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
    return () => { unlisten?.() }
  }, [])

  useEffect(() => {
    if (addStep !== "indexing") { setIndexingTick(0); return }
    const interval = window.setInterval(() => setIndexingTick(c => c + 1), 250)
    return () => window.clearInterval(interval)
  }, [addStep])

  useEffect(() => {
    const missingSourceIds = sources
      .map(s => s.id)
      .filter(id => sourceMedia[id] == null)
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
        } catch { /* skip */ }
      })
    )
    return () => { cancelled = true }
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
          .filter(m => m.media_type !== "tvshow")
          .map(m => m.id)
      } catch { /* skip */ }
      setTimeout(() => {
        setShowAddModal(false)
        setAddUrl("")
        setAddStep("idle")
        setAddValidation(null)
        setAddProgress(null)
        void onIndexComplete?.({ mediaIds: indexedMediaIds, contentName: indexedSource.filename })
      }, 2000)
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err))
      setAddStep("error")
    }
  }

  const handleDelete = async (sourceId: string) => {
    try {
      await invoke("ddl_delete_source", { sourceId })
      setSources(s => s.filter(src => src.id !== sourceId))
      setSourceMedia(m => { const n = { ...m }; delete n[sourceId]; return n })
      setMediaRefreshKey(k => k + 1)
    } catch (err: unknown) {
      console.error("Failed to delete source:", err)
    }
  }

  const handleRefresh = async (sourceId: string) => {
    if (!refreshUrl.trim()) return
    setRefreshing(true)
    setRefreshError("")
    try {
      const result = await invoke<DdlRefreshResult>("ddl_refresh_link", { sourceId, newUrl: refreshUrl.trim() })
      if (result.accepted) {
        setRefreshModal(null)
        setRefreshUrl("")
        await fetchSources()
      } else {
        setRefreshError(result.message)
      }
    } catch (err: unknown) {
      setRefreshError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const handleCheckHealth = async (sourceId: string) => {
    setCheckingHealth(sourceId)
    try {
      const healthy = await invoke<boolean>("ddl_check_link_health", { sourceId })
      setSources(prev => prev.map(s => s.id === sourceId ? { ...s, lastVerifiedAt: new Date().toISOString().replace("Z", "") } : s))
      toast({
        title: healthy ? "Link healthy" : "Link expired",
        description: healthy ? "This source is still reachable." : "This source no longer responds.",
        variant: healthy ? "default" : "destructive",
      })
    } catch (err: unknown) {
      toast({ title: "Health check failed", description: String(err), variant: "destructive" })
    } finally {
      setCheckingHealth(null)
    }
  }

  return (
    <div className="flex flex-col relative h-full">

      <div className="px-8 py-12 relative z-10 flex flex-col h-full">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-muted border border-border">
                <Link2 className="w-5 h-5 text-foreground" />
              </div>
              <span className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em]">Stream Engine</span>
            </div>
            <h1 className="text-4xl font-black text-foreground tracking-tight mb-2">
              Direct <span className="text-muted-foreground">Links</span>
            </h1>
            <p className="text-sm text-muted-foreground max-w-md font-medium leading-relaxed">
              High-performance streaming from direct download archives.
              Supports ZIP &amp; RAR with instant random access.
            </p>
          </div>

          <Button onClick={() => { setShowAddModal(true); setAddStep("idle"); setAddUrl(""); setAddError(""); setAddProgress(null); setAddValidation(null) }}>
            <Plus className="w-4 h-4 mr-2" />
            Add New Archive
          </Button>
        </div>

        {/* Sources Dropdown */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((skeletonIdx) => (
              <div key={skeletonIdx} className="rounded-xl bg-card border border-border p-5 animate-pulse">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-5 w-3/5 rounded-lg bg-muted" />
                    <div className="h-3 w-2/5 rounded-lg bg-muted/60" />
                  </div>
                  <div className="flex gap-2">
                    <div className="w-9 h-9 rounded-lg bg-muted" />
                    <div className="w-9 h-9 rounded-lg bg-muted" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : sources.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 text-center rounded-2xl border border-dashed border-border bg-card/40"
          >
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Archive className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">No Active Links</h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed">
              Your direct streaming library is empty. Add a ZIP link to start watching instantly.
            </p>
          </motion.div>
        ) : (
          <div className="relative">
            <button
              onClick={() => setIsSourcesDropdownOpen(!isSourcesDropdownOpen)}
              className="flex items-center gap-3 w-full rounded-xl bg-card border border-border p-4 hover:border-white/20 transition-all duration-200 text-left cursor-pointer"
            >
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
                <HardDrive className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {sources.length} Active {sources.length === 1 ? "Source" : "Sources"}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    {sources.filter(s => !s.isExpired).length} healthy
                  </span>
                  {sources.filter(s => s.isExpired).length > 0 && (
                    <>
                      <span className="w-0.5 h-0.5 rounded-full bg-border" />
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-destructive" />
                        {sources.filter(s => s.isExpired).length} expired
                      </span>
                    </>
                  )}
                </div>
              </div>
              <ChevronDown className={cn(
                "w-4 h-4 text-muted-foreground transition-transform duration-200 shrink-0",
                isSourcesDropdownOpen && "rotate-180"
              )} />
            </button>

            <AnimatePresence>
              {isSourcesDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                  animate={{ opacity: 1, y: 0, scaleY: 1 }}
                  exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="absolute left-0 right-0 z-50 mt-2 rounded-xl bg-card border border-border shadow-xl shadow-black/40 max-h-[420px] overflow-y-auto origin-top"
                  style={{ transformOrigin: "top" }}
                >
                  {sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex items-center gap-3 p-3 border-b border-border/50 last:border-b-0 hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="relative flex-shrink-0">
                        <div className={cn(
                          "w-10 h-10 rounded-lg flex items-center justify-center",
                          source.isExpired ? "bg-destructive/10" : "bg-muted"
                        )}>
                          {source.isExpired ? (
                            <AlertCircle className="w-4 h-4 text-destructive" />
                          ) : (
                            <HardDrive className="w-4 h-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className={cn(
                          "absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card",
                          source.isExpired ? "bg-destructive" : "bg-emerald-500"
                        )} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-xs font-medium text-foreground truncate max-w-[55%]" title={source.filename}>
                            {(() => { const f = prettifyFilename(source.filename); return <>{f.display}<span className="text-muted-foreground/60">{f.extension}</span></> })()}
                          </p>
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-muted text-muted-foreground border border-border uppercase">
                            {source.archiveFormat}
                          </span>
                          {source.isExpired && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-destructive/10 text-destructive border border-destructive/20 uppercase">
                              Expired
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{formatBytes(source.fileSize)}</span>
                          <span className="w-0.5 h-0.5 rounded-full bg-border" />
                          <span>{source.videoCount} videos</span>
                          <span className="w-0.5 h-0.5 rounded-full bg-border" />
                          <span>{timeAgo(source.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {source.isExpired ? (
                          <Button variant="ghost" size="icon" className="h-8 w-8"
                            onClick={(e) => { e.stopPropagation(); setRefreshModal(source.id); setRefreshUrl(""); setRefreshError("") }}
                            title="Refresh link"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" className="h-8 w-8"
                            onClick={(e) => { e.stopPropagation(); handleCheckHealth(source.id) }}
                            disabled={!!checkingHealth}
                            title="Check health"
                          >
                            <RefreshCw className={cn("w-3.5 h-3.5", checkingHealth === source.id && "animate-spin")} />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); handleDelete(source.id) }}
                          title="Delete source"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 mt-4">
          <DdlMediaLibrary
            key={mediaRefreshKey}
            viewMode={viewMode}
            onItemClick={onItemClick ?? (() => {})}
            onFixMatch={onFixMatch ?? (() => {})}
            onDownload={onDownload}
            onDelete={onDelete}
            onWatchTogether={onWatchTogether}
          />
        </div>
      </div>

      {/* Add Archive Dialog */}
      <Dialog open={showAddModal} onOpenChange={(open) => { if (!open && addStep !== "validating" && addStep !== "indexing") setShowAddModal(false) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5" />
              Index Archive
            </DialogTitle>
            <DialogDescription>Add a direct download link to stream its contents.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Source URL</label>
              <Input
                type="url"
                placeholder="https://server.com/archive_01.zip"
                value={addUrl}
                onChange={e => setAddUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && addStep === 'idle') handleAdd() }}
                disabled={addStep === "validating" || addStep === "indexing"}
                autoFocus
              />
            </div>

            <AnimatePresence mode="wait">
              {addStep === "validating" && (
                <motion.div
                  key="validating"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground"
                >
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Validating endpoint...
                </motion.div>
              )}

              {addStep === "indexing" && addValidation && (
                <motion.div
                  key="indexing"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-4"
                >
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                      <CheckCircle className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{addValidation.filename}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(addValidation.fileSize)}</p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-muted/30 border border-border p-4 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{progressLabel}</p>
                        <p className="text-sm font-medium text-foreground">{progressMessage}</p>
                        {progressContext && <p className="text-xs text-muted-foreground">{progressContext}</p>}
                        {addProgress?.filename && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{addProgress.filename}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-semibold text-foreground">{Math.round(progressPercent)}%</p>
                        <p className="text-xs text-muted-foreground">{progressCurrent} / {progressTotal || 1}</p>
                      </div>
                    </div>

                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-foreground"
                        initial={{ width: "0%" }}
                        animate={isIndeterminateProgress
                          ? { width: ["18%", "56%", "28%"], x: ["0%", "52%", "0%"] }
                          : { width: `${progressPercent}%` }}
                        transition={isIndeterminateProgress
                          ? { duration: 1.35, repeat: Infinity, ease: "easeInOut" }
                          : { type: "spring", stiffness: 100, damping: 20 }}
                      />
                    </div>

                    {addProgress?.episodeTitle && (
                      <motion.div
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs text-muted-foreground truncate">
                          {addProgress.stage === "fetching-episode-metadata" ? "Metadata:" : "Discovered:"} {addProgress.episodeTitle}
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
                  className="flex flex-col items-center justify-center py-8 gap-3"
                >
                  <div className="w-14 h-14 rounded-full bg-foreground flex items-center justify-center">
                    <CheckCircle className="w-7 h-7 text-background" />
                  </div>
                  <p className="text-sm font-medium text-foreground uppercase tracking-wider">Mapping Complete</p>
                </motion.div>
              )}

              {addStep === "error" && (
                <motion.div
                  key="error"
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3 items-start"
                >
                  <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-destructive">Index Failed</p>
                    <p className="text-xs text-muted-foreground mt-1">{addError}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border">
              <div className="p-1.5 rounded-md bg-muted">
                <HardDrive className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Hosting provider must support <span className="text-foreground font-medium">HTTP Range</span> requests for faster seeking.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowAddModal(false)}
              disabled={addStep === "validating" || addStep === "indexing"}
            >
              Dismiss
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!addUrl.trim() || addStep === "validating" || addStep === "indexing" || addStep === "done"}
              className="min-w-[140px]"
            >
              {addStep === "validating" || addStep === "indexing" ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{addStep === "validating" ? "Validating..." : "Indexing..."}</>
              ) : addStep === "error" ? "Retry Index" : "Start Indexing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refresh Link Dialog */}
      <Dialog open={!!refreshModal} onOpenChange={(open) => { if (!open && !refreshing) setRefreshModal(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5" />
              Refresh Session
            </DialogTitle>
            <DialogDescription>Provide a fresh URL for the exact same archive to restore streaming.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                The previous link has expired. Please provide a fresh URL for the <span className="text-foreground font-medium">exact same archive</span>.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">New Session URL</label>
              <Input
                type="url"
                placeholder="https://server.com/new_session_url.zip"
                value={refreshUrl}
                onChange={e => setRefreshUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && refreshModal) handleRefresh(refreshModal) }}
                disabled={refreshing}
                autoFocus
              />
            </div>

            {refreshError && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-xs text-destructive"
              >
                {refreshError}
              </motion.div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRefreshModal(null)} disabled={refreshing}>
              Cancel
            </Button>
            <Button
              onClick={() => refreshModal && handleRefresh(refreshModal)}
              disabled={!refreshUrl.trim() || refreshing}
              className="min-w-[160px]"
            >
              {refreshing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Verify & Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}
