import { DownloadJob } from "@/services/api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FolderOpen,
  Loader2,
  PauseCircle,
  XCircle,
  Trash2,
  CheckSquare,
  History,
  ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DownloadsViewProps {
  jobs: DownloadJob[];
  onCancel: (job: DownloadJob) => void | Promise<void>;
  onOpen: (job: DownloadJob) => void | Promise<void>;
  onDeleteJob: (jobId: string) => void | Promise<void>;
  onClearHistory: () => void | Promise<void>;
}

const formatBytes = (bytes?: number | null) => {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[index]}`;
};

const formatSpeed = (bytesPerSecond?: number | null) => {
  if (!bytesPerSecond || bytesPerSecond === null) return "0 B/s";
  if (bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
};

const isActiveStatus = (status: string) =>
  status === "queued" || status === "preparing" || status === "downloading";

const statusMeta = (status: string) => {
  switch (status) {
    case "completed":
      return {
        icon: CheckCircle2,
        label: "Completed",
        className: "bg-white/10 text-white border-white/20",
      };
    case "failed":
      return {
        icon: AlertTriangle,
        label: "Failed",
        className: "bg-white/5 text-zinc-400 border-white/10",
      };
    case "cancelled":
      return {
        icon: XCircle,
        label: "Cancelled",
        className: "bg-white/5 text-zinc-500 border-white/10",
      };
    case "preparing":
      return {
        icon: Clock3,
        label: "Preparing",
        className: "bg-white/10 text-white border-white/20",
      };
    case "queued":
      return {
        icon: PauseCircle,
        label: "Queued",
        className: "bg-white/5 text-zinc-400 border-white/10",
      };
    default:
      return {
        icon: Download,
        label: "Downloading",
        className: "bg-white text-black border-white",
      };
  }
};

export function DownloadsView({ 
  jobs, 
  onCancel, 
  onOpen, 
  onDeleteJob, 
  onClearHistory 
}: DownloadsViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const activeJobs = jobs.filter((job) => isActiveStatus(job.status));
  const archivedJobs = [...jobs]
    .filter((job) => !isActiveStatus(job.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (window.confirm(`Delete ${selectedIds.size} selected items?`)) {
      for (const id of selectedIds) {
        await onDeleteJob(id);
      }
      setSelectedIds(new Set());
      setSelectionMode(false);
    }
  };

  const handleClearHistory = async () => {
    if (window.confirm("Clear all finished and failed downloads?")) {
      await onClearHistory();
      setIsHistoryOpen(false);
    }
  };

  const latestJob = archivedJobs[0];

  return (
    <div className="h-full overflow-hidden">
      <div className="h-full overflow-y-auto pt-24 pb-4 scrollbar-none">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
          className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:px-10 pb-12"
        >
        <section className="flex flex-shrink-0 flex-col gap-6 px-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-black tracking-tighter text-white sm:text-4xl">
              Downloads
            </h1>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">
              Parallel Engine v2
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <MetricChip label="Active" value={activeJobs.length} />
            <MetricChip
              label="Completed"
              value={jobs.filter((job) => job.status === "completed").length}
            />
            <MetricChip
              label="Failed"
              value={jobs.filter((job) => job.status === "failed").length}
            />
          </div>
        </section>

        <div className="flex flex-shrink-0 items-center justify-between border-b border-white/5 pb-4 px-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectionMode(!selectionMode);
                setSelectedIds(new Set());
              }}
              className={cn(
                "h-9 rounded-xl border-white/10 px-4 text-[10px] font-black uppercase tracking-widest transition-all",
                selectionMode ? "bg-white text-black hover:bg-white/90" : "bg-white/5 text-white/60 hover:bg-white/10"
              )}
            >
              {selectionMode ? "Cancel" : "Manage"}
            </Button>
            
            <AnimatePresence>
              {selectionMode && selectedIds.size > 0 && (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteSelected}
                    className="h-9 rounded-xl border-white/20 bg-white/10 px-4 text-[10px] font-black uppercase tracking-widest text-white hover:bg-white hover:text-black"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete ({selectedIds.size})
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearHistory}
            disabled={archivedJobs.length === 0}
            className="h-9 rounded-xl px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-30"
          >
            Clear History
          </Button>
        </div>

        <section className="w-full space-y-4">
          <SectionHeader 
            title="Active Downloads" 
            count={activeJobs.length}
          />
          {activeJobs.length === 0 ? (
            <EmptyDownloadsState compact />
          ) : (
            <div className="grid gap-3 min-w-0">
              {activeJobs.map((job) => (
                <DownloadRow 
                  key={job.id} 
                  job={job} 
                  onCancel={onCancel} 
                  onOpen={onOpen}
                  onDelete={onDeleteJob}
                  isSelectionMode={selectionMode}
                  isSelected={selectedIds.has(job.id)}
                  onToggleSelect={() => toggleSelect(job.id)}
                  compact
                />
              ))}
            </div>
          )}
        </section>

        <section className="w-full space-y-4">
          <SectionHeader 
            title="Completed" 
            count={archivedJobs.length}
            onExpand={archivedJobs.length > 1 ? () => setIsHistoryOpen(true) : undefined}
          />
          {archivedJobs.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-[2rem] border border-dashed border-white/5 bg-white/[0.01] px-8 py-12 text-center text-sm font-medium text-zinc-600">
              No historical data available.
            </div>
          ) : (
            <div className="grid gap-4">
              <DownloadRow 
                key={latestJob.id} 
                job={latestJob} 
                onCancel={onCancel} 
                onOpen={onOpen}
                onDelete={onDeleteJob}
                isSelectionMode={selectionMode}
                isSelected={selectedIds.has(latestJob.id)}
                onToggleSelect={() => toggleSelect(latestJob.id)}
              />
              {archivedJobs.length > 1 && (
                <button
                  onClick={() => setIsHistoryOpen(true)}
                  className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-3 transition-all hover:bg-white/[0.04] hover:border-white/10 group"
                >
                  <div className="flex items-center gap-3">
                    <History className="h-4 w-4 text-zinc-500 group-hover:text-white transition-colors" />
                    <span className="text-[11px] font-black uppercase tracking-widest text-zinc-500 group-hover:text-white">
                      View {archivedJobs.length - 1} more items in history
                    </span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-zinc-700 group-hover:text-white transition-all transform group-hover:translate-x-1" />
                </button>
              )}
            </div>
          )}
        </section>
      </motion.div>
    </div>

      {/* History Modal */}
      <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] bg-[#0D0D0D] border-white/10 p-0 overflow-hidden flex flex-col rounded-[2.5rem]">
          <DialogHeader className="p-8 pb-4 flex-shrink-0 border-b border-white/5">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <DialogTitle className="text-2xl font-black tracking-tighter text-white">Transfer Log</DialogTitle>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">Full acquisition history</p>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleClearHistory}
                className="h-9 rounded-xl px-4 text-[10px] font-black uppercase tracking-widest text-rose-500 hover:bg-rose-500/10"
              >
                Clear All
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden p-4">
            <ScrollArea className="h-full pr-4">
              <div className="grid gap-4 pb-8">
                {archivedJobs.map((job) => (
                  <DownloadRow 
                    key={job.id} 
                    job={job} 
                    onCancel={onCancel} 
                    onOpen={onOpen}
                    onDelete={onDeleteJob}
                    isSelectionMode={selectionMode}
                    isSelected={selectedIds.has(job.id)}
                    onToggleSelect={() => toggleSelect(job.id)}
                    compact
                  />
                ))}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetricChip({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-2 backdrop-blur-md transition-all hover:border-white/15 hover:bg-white/[0.05]">
      <span className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">{label}</span>
      <span className="text-sm font-black text-white">{value}</span>
    </div>
  );
}

function SectionHeader({ title, count, onExpand }: { title: string; count?: number; onExpand?: () => void }) {
  return (
    <div className="flex items-end justify-between px-2">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight text-white">{title}</h2>
          {count !== undefined && count > 0 && (
            <span className="flex h-5 items-center justify-center rounded-full bg-white/10 px-2 text-[10px] font-bold text-white/60 border border-white/5">
              {count}
            </span>
          )}
          {onExpand && (
            <button 
              onClick={onExpand}
              className="ml-1 p-1 rounded-lg hover:bg-white/10 transition-colors text-zinc-500 hover:text-white"
              title="View History"
            >
              <History className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyDownloadsState({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn(
      "group relative rounded-[2.5rem] border border-dashed border-white/10 bg-white/[0.01] px-6 text-center transition-all hover:bg-white/[0.02]",
      compact ? "py-10" : "py-20"
    )}>
      <div className={cn(
        "mx-auto flex items-center justify-center rounded-[2rem] border border-white/10 bg-white/5 transition-transform duration-500 group-hover:scale-110",
        compact ? "h-14 w-14" : "h-20 w-20"
      )}>
        <Download className={cn(compact ? "h-6 w-6" : "h-8 w-8", "text-white/40")} />
      </div>
      <h3 className={cn("font-bold text-white", compact ? "mt-5 text-base" : "mt-8 text-xl")}>Standby Mode</h3>
      <p className={cn(
        "mx-auto max-w-sm leading-relaxed text-zinc-500",
        compact ? "mt-2 text-xs" : "mt-3 text-sm"
      )}>
        The pipeline is idle. Initiate a transfer from the cloud drive to begin acquisition.
      </p>
    </div>
  );
}

function DownloadRow({
  job,
  onCancel,
  onOpen,
  onDelete,
  isSelectionMode,
  isSelected,
  onToggleSelect,
  compact,
}: {
  job: DownloadJob;
  onCancel: (job: DownloadJob) => void | Promise<void>;
  onOpen: (job: DownloadJob) => void | Promise<void>;
  onDelete: (jobId: string) => void | Promise<void>;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  compact?: boolean;
}) {
  const meta = statusMeta(job.status);
  const StatusIcon = meta.icon;
  const active = isActiveStatus(job.status);

  return (
    <motion.div 
      layout
      className={cn(
        "group relative rounded-[2rem] border transition-all w-full min-w-0 overflow-hidden",
        compact ? "p-4" : "p-6",
        isSelected 
          ? "border-white/30 bg-white/[0.08] shadow-elevation-2" 
          : "border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
      )}
      onClick={() => isSelectionMode && onToggleSelect?.()}
    >
      <div className={cn("flex flex-col xl:flex-row xl:items-center", compact ? "gap-4" : "gap-6")}>
        {isSelectionMode && (
          <div className="flex items-center justify-center">
            <div className={cn(
              "flex h-6 w-6 items-center justify-center rounded-lg border transition-all",
              isSelected ? "bg-white border-white text-black" : "border-white/20 text-transparent"
            )}>
              <CheckSquare size={14} strokeWidth={3} />
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1 overflow-hidden">
          <div className={cn("flex flex-wrap items-center gap-3", compact ? "mb-3" : "mb-4")}>
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider",
                meta.className,
              )}
            >
              <StatusIcon className="h-3 w-3" />
              {meta.label}
            </span>
            <span className="rounded-full border border-white/5 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              {job.sourceKind.replace(/-/g, " ")}
            </span>
          </div>
          
          <div className="space-y-1">
            <h3 className={cn("truncate font-bold tracking-tight text-white", compact ? "text-lg" : "text-xl")}>{job.title}</h3>
            <p className="truncate text-xs font-medium text-zinc-600 font-mono">{job.fileName}</p>
          </div>

          <div className={cn(
            "flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500",
            compact ? "mt-3" : "mt-5"
          )}>
            <div className="flex items-center gap-2">
              <span className="text-white/40">Size</span>
              <span className="text-white/80">{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white/40">Speed</span>
              <span className="text-white/80">{formatSpeed(job.speedBytesPerSecond)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white/40">Date</span>
              <span className="text-white/80">{new Date(job.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
          
          {job.error && (
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-4">
              <AlertTriangle className="h-4 w-4 text-zinc-500 mt-0.5 shrink-0" />
              <p className="text-xs font-medium text-zinc-400 leading-relaxed">
                {job.error}
              </p>
            </div>
          )}
        </div>

        <div className={cn("flex flex-col xl:items-end w-full xl:w-auto", compact ? "xl:min-w-[240px] gap-3" : "xl:min-w-[280px] gap-5")}>
          <div className="w-full">
            <div className="mb-3 flex items-center justify-between text-[11px] font-black uppercase tracking-widest text-zinc-500">
              <span>{active ? "Network Payload" : "Verification"}</span>
              <span className="text-white">{Math.round(job.progress)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <motion.div
                className="h-full bg-white shadow-[0_0_15px_rgba(255,255,255,0.5)]"
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                transition={{ duration: 0.8, ease: [0.19, 1, 0.22, 1] }}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!isSelectionMode && (
              <>
                {job.targetExists ? (
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onOpen(job);
                    }}
                    variant="outline"
                    className="h-11 rounded-xl border-white/10 bg-white/[0.04] px-6 text-xs font-black uppercase tracking-widest text-white hover:bg-white hover:text-black transition-all duration-300"
                  >
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Navigate
                  </Button>
                ) : (
                  !active && (
                    <div className="inline-flex h-11 items-center rounded-xl border border-white/10 bg-white/5 px-6 text-[10px] font-black uppercase tracking-widest text-zinc-500">
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Deleted
                    </div>
                  )
                )}
                {active && (
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onCancel(job);
                    }}
                    variant="outline"
                    className="h-11 rounded-xl border-white/10 bg-white/[0.02] px-6 text-xs font-black uppercase tracking-widest text-zinc-500 hover:bg-white/10 hover:text-white transition-all duration-300"
                  >
                    {job.status === "downloading" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <PauseCircle className="mr-2 h-4 w-4" />
                    )}
                    Abort
                  </Button>
                )}
                {!active && (
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(job.id);
                    }}
                    variant="ghost"
                    className="h-11 w-11 rounded-xl bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-white"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
