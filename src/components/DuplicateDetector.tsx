import { useState, useCallback } from "react";
import { X, ChevronDown, ChevronRight, Copy, Loader2, Trash2, HardDrive, Cloud, Search } from "lucide-react";
import { cn } from "../lib/utils";
import { findDuplicateMedia, deleteMediaFiles, DuplicateGroup, MediaItem } from "../services/api";
import { ConfirmDialog } from "./ConfirmDialog";

interface DuplicateDetectorProps {
  isOpen: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DuplicateDetector({ isOpen, onClose, onDeleted }: DuplicateDetectorProps) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteResults, setDeleteResults] = useState<string | null>(null);
  const [confirmItem, setConfirmItem] = useState<MediaItem | null>(null);

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    setIsDone(false);
    setGroups([]);
    setDeleteResults(null);
    try {
      const result = await findDuplicateMedia();
      setGroups(result);
      // Auto-expand all groups
      setExpandedGroups(new Set(result.map((_, i) => i)));
    } catch (error) {
      console.error("Duplicate scan failed:", error);
    } finally {
      setIsScanning(false);
      setIsDone(true);
    }
  }, []);

  const toggleGroup = (index: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleDelete = async (item: MediaItem) => {
    setConfirmItem(item);
  };

  const executeDelete = async () => {
    const item = confirmItem;
    if (!item) return;
    setConfirmItem(null);
    setDeletingId(item.id);
    try {
      const result = await deleteMediaFiles([item.id]);
      setDeleteResults(result.message);
      // Remove deleted item from groups, remove empty groups
      setGroups((prev) =>
        prev
          .map((g) => ({ ...g, items: g.items.filter((i) => i.id !== item.id) }))
          .filter((g) => g.items.length > 1)
      );
      onDeleted?.();
    } catch (error) {
      console.error("Delete failed:", error);
      setDeleteResults("Delete failed. Check console for details.");
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  const totalDuplicates = groups.reduce((sum, g) => sum + g.items.length - 1, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-3xl max-h-[80vh] mx-4 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Copy className="size-5 text-amber-400" />
            <h2 className="text-lg font-semibold text-white">Duplicate Detector</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {!isScanning && !isDone && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Search className="size-12 text-neutral-600" />
              <p className="text-neutral-400 text-sm text-center max-w-md">
                Scan your library for duplicate entries — items with the same TMDB ID or very similar titles.
              </p>
              <button
                onClick={handleScan}
                className="px-6 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 text-sm font-medium hover:bg-amber-500/30 transition-colors"
              >
                Scan for Duplicates
              </button>
            </div>
          )}

          {isScanning && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="size-8 text-amber-400 animate-spin" />
              <p className="text-neutral-400 text-sm">Scanning library for duplicates...</p>
            </div>
          )}

          {isDone && !isScanning && groups.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Copy className="size-12 text-emerald-500/50" />
              <p className="text-emerald-400 font-medium">No duplicates found</p>
              <p className="text-neutral-500 text-sm">Your library is clean.</p>
            </div>
          )}

          {isDone && groups.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-neutral-400">
                  Found <span className="text-amber-400 font-medium">{groups.length}</span> duplicate group{groups.length !== 1 ? "s" : ""} with{" "}
                  <span className="text-amber-400 font-medium">{totalDuplicates}</span> extra item{totalDuplicates !== 1 ? "s" : ""}.
                </p>
                <button
                  onClick={handleScan}
                  className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Re-scan
                </button>
              </div>

              {deleteResults && (
                <div className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
                  {deleteResults}
                </div>
              )}

              {groups.map((group, gi) => (
                <div key={gi} className="border border-white/10 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleGroup(gi)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {expandedGroups.has(gi) ? (
                        <ChevronDown className="size-4 text-neutral-500" />
                      ) : (
                        <ChevronRight className="size-4 text-neutral-500" />
                      )}
                      <span className="text-sm font-medium text-neutral-200">{group.reason}</span>
                      <span className="text-xs text-neutral-500">{group.items.length} items</span>
                    </div>
                  </button>

                  {expandedGroups.has(gi) && (
                    <div className="divide-y divide-white/5">
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-neutral-200 truncate">
                                {item.title}
                                {item.year ? ` (${item.year})` : ""}
                              </span>
                              {item.is_cloud ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/15 text-sky-400 border border-sky-500/20">
                                  <Cloud className="size-2.5" />
                                  Cloud
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-500/15 text-neutral-400 border border-neutral-500/20">
                                  <HardDrive className="size-2.5" />
                                  Local
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-neutral-500 truncate mt-0.5">
                              {item.file_path || item.cloud_file_id || "No path"}
                            </p>
                          </div>
                          <span className="text-xs text-neutral-500 shrink-0">
                            {formatBytes(item.file_size_bytes)}
                          </span>
                          <button
                            onClick={() => handleDelete(item)}
                            disabled={deletingId === item.id}
                            className={cn(
                              "p-1.5 rounded-lg transition-colors shrink-0",
                              deletingId === item.id
                                ? "opacity-50 cursor-not-allowed"
                                : "hover:bg-red-500/20 text-neutral-500 hover:text-red-400"
                            )}
                            title="Delete this item"
                          >
                            {deletingId === item.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmItem}
        onOpenChange={() => setConfirmItem(null)}
        title="Delete Media"
        description={confirmItem ? `Delete "${confirmItem.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={executeDelete}
      />
    </div>
  );
}
