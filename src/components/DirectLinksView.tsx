import { useState, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/tauri"
import { listen } from "@tauri-apps/api/event"
import { motion, AnimatePresence } from "framer-motion"
import {
  Link2, Plus, Trash2, RefreshCw, ChevronDown, ChevronRight,
  Play, AlertCircle, CheckCircle, Loader2, Archive,
  X, HardDrive, FileVideo
} from "lucide-react"

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
  onPlayMedia?: (mediaId: number) => void
}

export default function DirectLinksView({ onPlayMedia }: DirectLinksViewProps) {
  const [sources, setSources] = useState<DdlSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [expandedSource, setExpandedSource] = useState<string | null>(null)
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

  const handleAdd = async () => {
    if (!addUrl.trim()) return
    setAddStep("validating")
    setAddError("")
    setAddProgress(null)
    try {
      const validation = await invoke<DdlValidationResult>("ddl_validate_url", { url: addUrl.trim() })
      setAddValidation(validation)
      setAddStep("indexing")
      await invoke<DdlSource>("ddl_index_archive", { url: addUrl.trim(), validation })
      setAddStep("done")
      await fetchSources()
      setTimeout(() => {
        setShowAddModal(false)
        setAddUrl("")
        setAddStep("idle")
        setAddValidation(null)
        setAddProgress(null)
      }, 1500)
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

  const handleExpand = async (sourceId: string) => {
    if (expandedSource === sourceId) {
      setExpandedSource(null)
      return
    }
    setExpandedSource(sourceId)
    if (!sourceMedia[sourceId]) {
      try {
        const media = await invoke<MediaItem[]>("ddl_get_source_media", { sourceId })
        setSourceMedia(m => ({ ...m, [sourceId]: media }))
      } catch (e) {
        console.error("Failed to fetch media:", e)
      }
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
      await invoke<boolean>("ddl_check_link_health", { sourceId })
      await fetchSources()
    } catch (e) {
      console.error("Health check failed:", e)
    } finally {
      setCheckingHealth(null)
    }
  }

  return (
    <div className="flex-1 h-screen overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <Link2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Direct Links</h1>
              <p className="text-xs text-neutral-500">Stream archives from any direct download URL</p>
            </div>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => { setShowAddModal(true); setAddStep("idle"); setAddUrl(""); setAddError(""); setAddProgress(null); setAddValidation(null) }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white text-black text-sm font-bold shadow-lg shadow-white/5 hover:bg-neutral-200 transition-all"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            Add Link
          </motion.button>
        </div>

        {/* Sources List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-neutral-500 animate-spin" />
          </div>
        ) : sources.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/5 mb-4">
              <Archive className="w-10 h-10 text-neutral-600" />
            </div>
            <h3 className="text-base font-semibold text-neutral-400 mb-1">No direct links yet</h3>
            <p className="text-sm text-neutral-600 max-w-sm">
              Add a direct download URL to a ZIP archive and stream its contents with MPV
            </p>
          </motion.div>
        ) : (
          <div className="space-y-3">
            {sources.map((source, idx) => (
              <motion.div
                key={source.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden hover:border-white/10 transition-colors"
              >
                {/* Source Header */}
                <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={() => handleExpand(source.id)}>
                  <div className={`p-2 rounded-lg ${source.isExpired ? 'bg-white/5' : 'bg-white/10'}`}>
                    {source.isExpired
                      ? <AlertCircle className="w-4 h-4 text-neutral-500" />
                      : <HardDrive className="w-4 h-4 text-white" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white truncate">{source.filename}</h3>
                      {source.isExpired && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white/10 text-neutral-400 border border-white/10">
                          EXPIRED
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-neutral-500">
                      <span>{formatBytes(source.fileSize)}</span>
                      <span>•</span>
                      <span>{source.videoCount} video{source.videoCount !== 1 ? 's' : ''}</span>
                      <span>•</span>
                      <span>{source.archiveFormat.toUpperCase()}</span>
                      <span>•</span>
                      <span>Added {timeAgo(source.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {source.isExpired && (
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={(e) => { e.stopPropagation(); setRefreshModal(source.id); setRefreshUrl(""); setRefreshError("") }}
                        className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors"
                        title="Refresh link"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </motion.button>
                    )}
                    {!source.isExpired && (
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={(e) => { e.stopPropagation(); if (!checkingHealth) handleCheckHealth(source.id) }}
                        className={`p-2 rounded-lg transition-colors ${checkingHealth === source.id ? 'text-white bg-white/10' : 'text-neutral-500 hover:bg-white/5'}`}
                        title="Check link health"
                        disabled={!!checkingHealth}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${checkingHealth === source.id ? 'animate-spin' : ''}`} />
                      </motion.button>
                    )}
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => { e.stopPropagation(); handleDelete(source.id) }}
                      className="p-2 rounded-lg hover:bg-white/10 text-neutral-500 hover:text-white transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </motion.button>
                    {expandedSource === source.id
                      ? <ChevronDown className="w-4 h-4 text-neutral-500" />
                      : <ChevronRight className="w-4 h-4 text-neutral-500" />
                    }
                  </div>
                </div>

                {/* Expanded Media List */}
                <AnimatePresence>
                  {expandedSource === source.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden border-t border-white/5"
                    >
                      <div className="p-3 space-y-1 max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
                        {sourceMedia[source.id] ? (
                          sourceMedia[source.id].filter(m => m.media_type !== 'tvshow').length === 0 ? (
                            <div className="text-center py-4 text-neutral-600 text-sm">No playable entries</div>
                          ) : (
                            sourceMedia[source.id]
                              .filter(m => m.media_type !== 'tvshow')
                              .map((media) => (
                                <motion.div
                                  key={media.id}
                                  whileHover={{ backgroundColor: "rgba(255,255,255,0.03)" }}
                                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group"
                                  onClick={() => {
                                    if (source.isExpired) {
                                      setRefreshModal(source.id)
                                      setRefreshUrl("")
                                      setRefreshError("")
                                    } else {
                                      onPlayMedia?.(media.id)
                                    }
                                  }}
                                >
                                  <FileVideo className="w-4 h-4 text-neutral-600 flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-neutral-300 truncate">
                                      {media.season_number != null && media.episode_number != null
                                        ? `S${String(media.season_number).padStart(2, '0')}E${String(media.episode_number).padStart(2, '0')} — `
                                        : ''
                                      }
                                      {media.title}
                                    </p>
                                    {media.zip_uncompressed_size && (
                                      <p className="text-xs text-neutral-600">{formatBytes(media.zip_uncompressed_size)}</p>
                                    )}
                                  </div>
                                  {source.isExpired ? (
                                    <AlertCircle className="w-4 h-4 text-neutral-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  ) : (
                                    <Play className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                  )}
                                </motion.div>
                              ))
                          )
                        ) : (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="w-4 h-4 text-neutral-500 animate-spin" />
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => { if (addStep !== "validating" && addStep !== "indexing") setShowAddModal(false) }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-lg mx-4 rounded-2xl bg-[#141416] border border-white/10 shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-5 border-b border-white/5">
                <h2 className="text-base font-bold text-white">Add Direct Link</h2>
                <button onClick={() => setShowAddModal(false)} className="p-1.5 rounded-lg hover:bg-white/5 text-neutral-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="text-xs font-medium text-neutral-400 mb-1.5 block">Archive URL</label>
                  <input
                    type="url"
                    placeholder="https://example.com/archive.zip"
                    value={addUrl}
                    onChange={e => setAddUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && addStep === 'idle') handleAdd() }}
                    disabled={addStep === "validating" || addStep === "indexing"}
                    className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/10 text-white text-sm placeholder:text-neutral-600 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/10 disabled:opacity-50 transition-colors"
                    autoFocus
                  />
                </div>

                {/* Status */}
                {addStep === "validating" && (
                  <div className="flex items-center gap-2 text-sm text-white/60">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Validating URL...
                  </div>
                )}
                {addStep === "indexing" && addValidation && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-amber-400">
                      <CheckCircle className="w-4 h-4" />
                      {addValidation.filename} — {formatBytes(addValidation.fileSize)}
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3 space-y-2.5">
                      <div className="flex items-center gap-2 text-sm text-white/80">
                        <Loader2 className="w-4 h-4 animate-spin text-white" />
                        <span>{addProgress?.message || "Indexing archive contents..."}</span>
                      </div>

                      {(addProgress?.current != null && addProgress?.total != null) ? (
                        <>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                            <div
                              className="h-full rounded-full bg-white transition-all duration-300"
                              style={{ width: `${Math.max(6, Math.min(100, (addProgress.current / Math.max(addProgress.total, 1)) * 100))}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-neutral-500">
                            <span>{addProgress.stage.replace(/-/g, ' ')}</span>
                            <span>{addProgress.current}/{addProgress.total}</span>
                          </div>
                        </>
                      ) : null}

                      {(addProgress?.season != null || addProgress?.episode != null || addProgress?.episodeTitle) ? (
                        <div className="rounded-lg bg-black/20 px-3 py-2 text-xs text-neutral-300 border border-white/5">
                          {addProgress.season != null && addProgress.episode != null
                            ? `S${String(addProgress.season).padStart(2, '0')}E${String(addProgress.episode).padStart(2, '0')}`
                            : addProgress.season != null
                              ? `Season ${addProgress.season}`
                              : 'Metadata'}
                          {addProgress.episodeTitle ? ` — ${addProgress.episodeTitle}` : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                {addStep === "done" && (
                  <div className="flex items-center gap-2 text-sm text-white">
                    <CheckCircle className="w-4 h-4" />
                    Archive indexed successfully!
                  </div>
                )}
                {addStep === "error" && (
                  <div className="flex items-start gap-2 text-sm text-neutral-400 bg-white/5 rounded-lg p-3 border border-white/10">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{addError}</span>
                  </div>
                )}

                <p className="text-xs text-neutral-600">
                  Paste a direct download URL to a ZIP archive. The file host must support HTTP Range requests.
                </p>
              </div>
              <div className="flex justify-end gap-2 p-5 pt-0">
                <button
                  onClick={() => setShowAddModal(false)}
                  disabled={addStep === "validating" || addStep === "indexing"}
                  className="px-4 py-2 rounded-lg text-sm text-neutral-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!addUrl.trim() || addStep === "validating" || addStep === "indexing" || addStep === "done"}
                  className="px-5 py-2 rounded-lg text-sm font-bold bg-white text-black disabled:opacity-40 hover:bg-neutral-200 transition-colors"
                >
                  {addStep === "error" ? "Retry" : "Index Archive"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Refresh Link Modal */}
      <AnimatePresence>
        {refreshModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => { if (!refreshing) setRefreshModal(null) }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-lg mx-4 rounded-2xl bg-[#141416] border border-white/10 shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-5 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-white" />
                  <h2 className="text-base font-bold text-white">Refresh Link</h2>
                </div>
                <button onClick={() => setRefreshModal(null)} className="p-1.5 rounded-lg hover:bg-white/5 text-neutral-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="flex items-start gap-2 text-sm text-neutral-400 bg-white/5 rounded-lg p-3 border border-white/10">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>The previous link has expired. Paste a fresh link to the <strong>same</strong> archive to continue.</span>
                </div>
                <input
                  type="url"
                  placeholder="https://example.com/same-archive.zip"
                  value={refreshUrl}
                  onChange={e => setRefreshUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && refreshModal) handleRefresh(refreshModal) }}
                  disabled={refreshing}
                  className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/10 text-white text-sm placeholder:text-neutral-600 focus:outline-none focus:border-white/20 disabled:opacity-50 transition-colors"
                  autoFocus
                />
                {refreshError && (
                  <div className="flex items-start gap-2 text-sm text-neutral-400 bg-white/5 rounded-lg p-3 border border-white/10">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{refreshError}</span>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 p-5 pt-0">
                <button onClick={() => setRefreshModal(null)} disabled={refreshing}
                  className="px-4 py-2 rounded-lg text-sm text-neutral-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  onClick={() => refreshModal && handleRefresh(refreshModal)}
                  disabled={!refreshUrl.trim() || refreshing}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold bg-white text-black disabled:opacity-40 hover:bg-neutral-200 transition-colors"
                >
                  {refreshing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Verify & Refresh
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
