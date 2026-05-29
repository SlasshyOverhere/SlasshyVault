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
  ArrowDownToLine,
  HardDrive,
  Cloud,
  Globe,
} from "lucide-react";
import { LazyMotion, m, AnimatePresence, domAnimation } from "framer-motion";
import { useState, useMemo, memo } from "react";
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

const formatTimeRemaining = (job: DownloadJob): string | null => {
  if (job.status !== "downloading" || !job.speedBytesPerSecond || job.speedBytesPerSecond <= 0) return null;
  const remaining = job.totalBytes - job.downloadedBytes;
  const seconds = remaining / job.speedBytesPerSecond;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `${h}h ${m}m`;
};

type DownloadJobStatus = 'queued' | 'preparing' | 'downloading' | 'completed' | 'failed' | 'cancelled';

const isActiveStatus = (status: DownloadJobStatus): status is 'queued' | 'preparing' | 'downloading' =>
  status === "queued" || status === "preparing" || status === "downloading";

const statusMeta = (status: DownloadJobStatus) => {
  switch (status) {
    case "completed":
      return {
        icon: CheckCircle2,
        label: "Completed",
        className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
      };
    case "failed":
      return {
        icon: AlertTriangle,
        label: "Failed",
        className: "bg-red-500/10 text-red-400 border-red-500/20",
      };
    case "cancelled":
      return {
        icon: XCircle,
        label: "Cancelled",
        className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
      };
    case "preparing":
      return {
        icon: Clock3,
        label: "Preparing",
        className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
      };
    case "queued":
      return {
        icon: PauseCircle,
        label: "Queued",
        className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
      };
    default:
      return {
        icon: Download,
        label: "Downloading",
        className: "bg-white text-black border-white",
      };
  }
};

type TabFilter = "all" | "active" | "completed" | "failed";

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
  const [activeTab, setActiveTab] = useState<TabFilter>("all");

  const activeJobs = useMemo(() => jobs.filter((job) => isActiveStatus(job.status)), [jobs]);
  const archivedJobs = useMemo(() => [...jobs]
    .filter((job) => !isActiveStatus(job.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [jobs]);

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
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(ids.map(id => onDeleteJob(id)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Failed to delete job:", result.reason);
        }
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

  const stats = useMemo(() => ({
    active: activeJobs.length,
    completed: jobs.filter((j) => j.status === "completed").length,
    failed: jobs.filter((j) => j.status === "failed").length,
    total: jobs.length,
  }), [jobs, activeJobs]);

  const TABS: Array<{ id: TabFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: jobs.length },
    { id: "active", label: "Active", count: activeJobs.length },
    { id: "completed", label: "Completed", count: stats.completed },
    { id: "failed", label: "Failed", count: stats.failed },
  ];

  return (
    <LazyMotion features={domAnimation}>
      <div className="h-full overflow-hidden relative">
      <div className="absolute inset-0 bg-gradient-mesh opacity-20 pointer-events-none" />
      <div className="absolute inset-0 bg-sheen opacity-10 pointer-events-none" />
      <div className="absolute inset-0 noise-overlay opacity-[0.02] pointer-events-none" />

      <div className="relative h-full overflow-y-auto pt-24 pb-4 scrollbar-none">
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
          className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:px-10 pb-12"
        >
          {/* Header */}
          <section className="flex flex-shrink-0 flex-col gap-6 px-2 sm:flex-row sm:items-center sm:justify-between">
            <m.div
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.19, 1, 0.22, 1] }}
              className="flex items-center gap-4"
            >
              <div className="relative group">
                <div className="absolute -inset-2 bg-white/10 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                <div className="relative size-12 rounded-[1.25rem] bg-white/5 border border-white/10 flex items-center justify-center shadow-elevation-1">
                  <ArrowDownToLine className="size-6 text-white/70" />
                </div>
              </div>
              <div className="space-y-0.5">
                <h1 className="text-4xl font-black tracking-tighter leading-none text-white">
                  Downloads
                </h1>
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "size-1 rounded-full transition-all duration-500",
                    activeJobs.length > 0 ? "bg-emerald-500/50 animate-pulse shadow-[0_0_6px_rgba(16,185,129,0.5)]" : "bg-white/10"
                  )} />
                  <p className="text-white/20 text-[9px] font-black uppercase tracking-[0.3em]">
                    {activeJobs.length > 0 ? `${activeJobs.length} active transfer${activeJobs.length !== 1 ? 's' : ''}` : "Parallel Engine v2"}
                  </p>
                </div>
              </div>
            </m.div>

            <m.div
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.19, 1, 0.22, 1], delay: 0.1 }}
              className="flex flex-wrap items-center gap-3"
            >
              <MetricChip label="Active" value={stats.active} active={stats.active > 0} />
              <MetricChip label="Completed" value={stats.completed} />
              <MetricChip label="Failed" value={stats.failed} alert={stats.failed > 0} />
            </m.div>
          </section>

          {/* Toolbar */}
          <m.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.19, 1, 0.22, 1], delay: 0.15 }}
            className="flex flex-shrink-0 items-center justify-between border-b border-white/5 pb-4 px-2"
          >
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
                  <m.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDeleteSelected}
                      className="h-9 rounded-xl border-red-500/20 bg-red-500/10 px-4 text-[10px] font-black uppercase tracking-widest text-red-400 hover:bg-red-500/20 hover:text-red-300"
                    >
                      <Trash2 className="mr-2 size-3.5" />
                      Delete ({selectedIds.size})
                    </Button>
                  </m.div>
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
          </m.div>

          {/* Tab Bar */}
          <m.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.19, 1, 0.22, 1], delay: 0.2 }}
            className="flex w-fit items-center gap-1 rounded-2xl p-1 bg-white/[0.03] border border-white/[0.05] backdrop-blur-md mx-2"
          >
            {TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative px-5 py-2 rounded-xl text-[9px] font-black uppercase tracking-[0.2em] transition-all duration-500",
                  activeTab === tab.id
                    ? "bg-white text-black shadow-glow-sm"
                    : "text-white/30 hover:text-white/60 hover:bg-white/5"
                )}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={cn(
                    "ml-2 tabular-nums",
                    activeTab === tab.id ? "text-black/50" : "text-white/20"
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </m.div>

          {/* Active Downloads Section */}
          {(activeTab === "all" || activeTab === "active") && (
          <section className="w-full space-y-4">
            <SectionHeader title="Acquisition Queue" subtitle="Active transfers and pending items" />
            {activeJobs.length === 0 ? (
              <EmptyDownloadsState />
            ) : (
              <AnimatePresence mode="popLayout">
                <div className="grid gap-3 min-w-0">
                  {activeJobs.map((job, idx) => (
                    <m.div
                      key={job.id}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, ease: [0.19, 1, 0.22, 1], delay: Math.min(idx, 8) * 0.04 }}
                    >
                      <DownloadRow 
                        job={job} 
                        onCancel={onCancel} 
                        onOpen={onOpen}
                        onDelete={onDeleteJob}
                        isSelectionMode={selectionMode}
                        isSelected={selectedIds.has(job.id)}
                        onToggleSelect={() => toggleSelect(job.id)}
                        compact
                      />
                    </m.div>
                  ))}
                </div>
              </AnimatePresence>
            )}
          </section>
          )}

          {/* Completed / Archived Section */}
          {(activeTab === "all" || activeTab === "completed" || activeTab === "failed") && (
            <ArchivedSection
              archivedJobs={archivedJobs}
              activeTab={activeTab}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onCancel={onCancel}
              onOpen={onOpen}
              onDelete={onDeleteJob}
              onShowHistory={() => setIsHistoryOpen(true)}
            />
          )}
        </m.div>
      </div>

      {/* History Dialog */}
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
                {archivedJobs.map((job, idx) => (
                  <m.div
                    key={job.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: Math.min(idx, 10) * 0.03 }}
                  >
                    <DownloadRow 
                      job={job} 
                      onCancel={onCancel} 
                      onOpen={onOpen}
                      onDelete={onDeleteJob}
                      isSelectionMode={selectionMode}
                      isSelected={selectedIds.has(job.id)}
                      onToggleSelect={() => toggleSelect(job.id)}
                      compact
                    />
                  </m.div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </LazyMotion>
  );
}

function MetricChip({
  label,
  value,
  active,
  alert,
}: {
  label: string;
  value: number;
  active?: boolean;
  alert?: boolean;
}) {
  return (
    <div className={cn(
      "flex items-center gap-3 rounded-2xl border px-4 py-2 backdrop-blur-md transition-all",
      active
        ? "border-white/15 bg-white/[0.05] hover:bg-white/[0.07]"
        : alert
          ? "border-red-500/15 bg-red-500/[0.04] hover:bg-red-500/[0.06]"
          : "border-white/5 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]"
    )}>
      {active && <span className="size-1.5 rounded-full bg-emerald-500/70 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.4)]" />}
      {alert && <span className="size-1.5 rounded-full bg-red-500/70 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]" />}
      <span className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">{label}</span>
      <span className={cn(
        "text-sm font-black",
        active ? "text-emerald-400" : alert ? "text-red-400" : "text-white"
      )}>{value}</span>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-end justify-between px-2">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold tracking-tight text-white">{title}</h2>
        {subtitle && (
          <span className="hidden sm:block text-[9px] font-black uppercase tracking-[0.2em] text-white/15">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

function ArchivedSection({
  archivedJobs,
  activeTab,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onCancel,
  onOpen,
  onDelete,
  onShowHistory,
}: {
  archivedJobs: DownloadJob[];
  activeTab: TabFilter;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onCancel: (job: DownloadJob) => void | Promise<void>;
  onOpen: (job: DownloadJob) => void | Promise<void>;
  onDelete: (jobId: string) => void | Promise<void>;
  onShowHistory: () => void;
}) {
  const filteredArchived = activeTab === "completed"
    ? archivedJobs.filter(j => j.status === "completed")
    : activeTab === "failed"
      ? archivedJobs.filter(j => j.status === "failed" || j.status === "cancelled")
      : archivedJobs;
  const latestFiltered = filteredArchived[0];

  if (!filteredArchived.length) {
    return (
      <section className="w-full space-y-4">
        <SectionHeader title="Transfer Log" subtitle="Finished downloads and history" />
        <div className="flex h-24 items-center justify-center rounded-[2rem] border border-dashed border-white/5 bg-white/[0.01] px-8 py-12 text-center text-sm font-medium text-zinc-600">
          No historical data available.
        </div>
      </section>
    );
  }

  return (
    <section className="w-full space-y-4">
      <SectionHeader title="Transfer Log" subtitle="Finished downloads and history" />
      <div className="grid gap-4">
        <DownloadRow 
          job={latestFiltered} 
          onCancel={onCancel} 
          onOpen={onOpen}
          onDelete={onDelete}
          isSelectionMode={selectionMode}
          isSelected={selectedIds.has(latestFiltered.id)}
          onToggleSelect={() => onToggleSelect(latestFiltered.id)}
        />
        {filteredArchived.length > 1 && (
          <m.button
            type="button"
            onClick={onShowHistory}
            whileHover={{ scale: 1.005 }}
            className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-3.5 transition-all hover:bg-white/[0.04] hover:border-white/10 group"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-xl bg-white/[0.03] border border-white/5 group-hover:bg-white/[0.06] transition-colors">
                <History className="size-4 text-zinc-500 group-hover:text-white transition-colors" />
              </div>
              <span className="text-[11px] font-black uppercase tracking-widest text-zinc-500 group-hover:text-white transition-colors">
                View {filteredArchived.length - 1} more item{filteredArchived.length - 1 !== 1 ? 's' : ''}
              </span>
            </div>
            <ChevronRight className="size-4 text-zinc-700 group-hover:text-white transition-all transform group-hover:translate-x-1" />
          </m.button>
        )}
      </div>
    </section>
  );
}

function EmptyDownloadsState() {
  return (
    <m.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
      className="group relative rounded-[2.5rem] border border-dashed border-white/10 bg-white/[0.01] px-6 text-center transition-all hover:bg-white/[0.02] py-14"
    >
      <div className="mx-auto flex items-center justify-center rounded-[2rem] border border-white/10 bg-white/5 transition-transform duration-500 group-hover:scale-110 size-14">
        <Download className="size-6 text-white/40" />
      </div>
      <h3 className="font-bold text-white mt-5 text-base">Standby Mode</h3>
      <p className="mx-auto max-w-sm text-zinc-500 mt-2 text-xs leading-relaxed">
        The pipeline is idle. Initiate a transfer from the cloud drive to begin acquisition.
      </p>
    </m.div>
  );
}

const DownloadRow = memo(function DownloadRow({
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
  const timeRemaining = formatTimeRemaining(job);

  return (
    <m.div
      layout
      className={cn(
        "group relative rounded-[2rem] border transition-all w-full min-w-0 overflow-hidden",
        compact ? "p-4 xl:p-5" : "p-6",
        isSelected 
          ? "border-white/30 bg-white/[0.08] shadow-elevation-2" 
          : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03] hover:shadow-elevation-1"
      )}
      onClick={() => isSelectionMode && onToggleSelect?.()}
    >
      <div className={cn("flex flex-col xl:flex-row xl:items-center", compact ? "gap-4" : "gap-6")}>
        {isSelectionMode && (
          <div className="flex items-center justify-center shrink-0">
            <div className={cn(
              "flex size-6 items-center justify-center rounded-lg border transition-all",
              isSelected ? "bg-white border-white text-black" : "border-white/20 text-transparent"
            )}>
              <CheckSquare size={14} strokeWidth={3} />
            </div>
          </div>
        )}

        {/* Left: Icon area for source type */}
        <div className="hidden sm:flex shrink-0">
          <div className={cn(
            "flex size-12 items-center justify-center rounded-[1.25rem] border transition-all",
            isSelected
              ? "border-white/20 bg-white/[0.08]"
              : "border-white/[0.06] bg-white/[0.02] group-hover:bg-white/[0.04] group-hover:border-white/[0.1]"
          )}>
            {job.sourceKind === "gdrive" ? (
              <Cloud className="size-5 text-white/40" />
            ) : job.sourceKind === "direct" ? (
              <Globe className="size-5 text-white/40" />
            ) : (
              <HardDrive className="size-5 text-white/40" />
            )}
          </div>
        </div>

        {/* Center: Content */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className={cn("flex flex-wrap items-center gap-2.5", compact ? "mb-2.5" : "mb-3")}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider",
                meta.className,
              )}
            >
              <StatusIcon className="size-3" />
              {meta.label}
            </span>
            <span className="rounded-full border border-white/5 bg-white/[0.03] px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest text-zinc-500">
              {job.sourceKind.replace(/-/g, " ")}
            </span>
          </div>
          
          <div className="space-y-0.5">
            <h3 className="truncate font-bold tracking-tight text-white text-base sm:text-lg">{job.title}</h3>
            <p className="truncate text-xs font-medium text-zinc-600 font-mono">{job.fileName}</p>
          </div>

          <div className={cn(
            "flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500",
            compact ? "mt-2.5" : "mt-4"
          )}>
            <div className="flex items-center gap-1.5">
              <span className="text-white/30">Size</span>
              <span className="text-white/70">{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span>
            </div>
            {job.status === "downloading" && (
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">Speed</span>
                <span className="text-white/70">{formatSpeed(job.speedBytesPerSecond)}</span>
              </div>
            )}
            {timeRemaining && (
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">ETA</span>
                <span className="text-white/70">{timeRemaining}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-white/30">Date</span>
              <span className="text-white/70">{new Date(job.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
          
          {job.error && (
            <div className="mt-3 flex items-start gap-3 rounded-2xl border border-red-500/10 bg-red-500/[0.03] p-3.5">
              <AlertTriangle className="size-4 text-red-400/70 mt-0.5 shrink-0" />
              <p className="text-xs font-medium text-zinc-400 leading-relaxed">
                {job.error}
              </p>
            </div>
          )}
        </div>

        {/* Right: Progress + Actions */}
        <div className={cn("flex flex-col xl:items-end w-full xl:w-auto", compact ? "xl:min-w-[240px] gap-3" : "xl:min-w-[280px] gap-4")}>
          <div className="w-full">
            <div className="mb-2 flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
              <span className={active ? "text-white/40" : "text-zinc-600"}>
                {active ? "Progress" : "Complete"}
              </span>
              <span className={cn(
                "tabular-nums",
                active ? "text-white" : "text-zinc-500"
              )}>{Math.round(job.progress)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <m.div
                className={cn(
                  "h-full transition-all",
                  active ? "bg-white shadow-[0_0_15px_rgba(255,255,255,0.5)]" : "bg-white/30"
                )}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                transition={{ duration: 0.8, ease: [0.19, 1, 0.22, 1] }}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 w-full xl:justify-end">
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
                    className="h-10 rounded-xl border-white/10 bg-white/[0.04] px-5 text-[10px] font-black uppercase tracking-widest text-white hover:bg-white hover:text-black transition-all duration-300"
                  >
                    <FolderOpen className="mr-2 size-3.5" />
                    Navigate
                  </Button>
                ) : (
                  !active && (
                    <div className="inline-flex h-10 items-center rounded-xl border border-white/10 bg-white/5 px-5 text-[10px] font-black uppercase tracking-widest text-zinc-500">
                      <Trash2 className="mr-2 size-3.5" />
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
                    className="h-10 rounded-xl border-white/10 bg-white/[0.02] px-5 text-[10px] font-black uppercase tracking-widest text-zinc-500 hover:bg-white/10 hover:text-white transition-all duration-300"
                  >
                    {job.status === "downloading" ? (
                      <Loader2 className="mr-2 size-3.5 animate-spin" />
                    ) : (
                      <PauseCircle className="mr-2 size-3.5" />
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
                    className="size-10 rounded-xl bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-white"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </m.div>
  );
});
