import { useState, useEffect, useCallback } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { X, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "../lib/utils";
import { runSyncValidation, fixSyncIssues, SyncIssue } from "../services/api";

interface SyncValidatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  ghost: "Ghost Entries",
  missing: "Missing Files",
  failed: "Failed Indexings",
  orphaned_zip: "Orphaned ZIP Entries",
  stale_token: "Stale Changes Token",
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  ghost: "DB entries pointing to files deleted from Google Drive",
  missing: "Files on Drive not yet indexed in your library",
  failed: "Files that failed to index previously",
  orphaned_zip: "ZIP child entries whose parent archive was removed",
  stale_token: "Changes token needs refresh for incremental sync",
};

export function SyncValidatorModal({ isOpen, onClose }: SyncValidatorModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [issues, setIssues] = useState<Map<string, SyncIssue[]>>(new Map());
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [fixingCategory, setFixingCategory] = useState<string | null>(null);
  const [confirmCategory, setConfirmCategory] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [fixResults, setFixResults] = useState<Map<string, { fixed: number; failed: number }>>(new Map());

  const categories = ["ghost", "missing", "failed", "orphaned_zip", "stale_token"];

  const startValidation = useCallback(async () => {
    setCurrentStep(0);
    setIssues(new Map());
    setIsRunning(true);
    setIsComplete(false);
    setFixResults(new Map());

    try {
      await runSyncValidation();
    } catch (error) {
      console.error("Validation failed:", error);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      unlisteners.push(
        await listen<{ step: number; total: number; category: string }>(
          "sync-validation-progress",
          (event) => {
            setCurrentStep(event.payload.step);
          }
        )
      );

      unlisteners.push(
        await listen<{ category: string; issues: SyncIssue[]; count: number }>(
          "sync-validation-result",
          (event) => {
            const { category, issues: newIssues } = event.payload;
            setIssues((prev) => {
              const next = new Map(prev);
              next.set(category, newIssues);
              return next;
            });
            if (newIssues.length > 0) {
              setExpandedCategories((prev) => new Set(prev).add(category));
            }
          }
        )
      );

      unlisteners.push(
        await listen<{ total_issues: number }>(
          "sync-validation-complete",
          () => {
            setIsRunning(false);
            setIsComplete(true);
          }
        )
      );

      unlisteners.push(
        await listen<{ category: string; fixed: number; failed: number }>(
          "sync-fix-result",
          (event) => {
            const { category, fixed, failed } = event.payload;
            setFixResults((prev) => new Map(prev).set(category, { fixed, failed }));
            setFixingCategory(null);
            // Auto re-validate to refresh the list
            void startValidation();
          }
        )
      );
    };

    void setup();
    void startValidation();

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [isOpen, startValidation]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleFix = async (category: string) => {
    const categoryIssues = issues.get(category) || [];
    const fixableIds = categoryIssues
      .filter((i) => i.fixable && i.file_id)
      .map((i) => i.file_id!);

    if (fixableIds.length === 0 && category !== "stale_token") return;

    setFixingCategory(category);
    setConfirmCategory(null);

    try {
      await fixSyncIssues(category, category === "stale_token" ? [] : fixableIds);
    } catch (error) {
      console.error("Fix failed:", error);
      setFixingCategory(null);
    }
  };

  const totalIssues = Array.from(issues.values()).reduce((sum, arr) => sum + arr.length, 0);
  const fixedIssues = Array.from(fixResults.values()).reduce((sum, r) => sum + r.fixed, 0);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Sync Validator</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div className="px-6 py-3 border-b border-white/5">
            <div className="flex items-center gap-3 text-sm text-neutral-400">
              <Loader2 className="size-4 animate-spin text-emerald-400" />
              <span>
                Checking {CATEGORY_LABELS[categories[currentStep - 1]] || "..."} ({currentStep}/5)
              </span>
            </div>
            <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${(currentStep / 5) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {categories.map((cat) => {
            const catIssues = issues.get(cat) || [];
            const isExpanded = expandedCategories.has(cat);
            const fixResult = fixResults.get(cat);
            const isFixing = fixingCategory === cat;

            return (
              <div key={cat} className="border border-white/5 rounded-xl overflow-hidden">
                <button
                  onClick={() => toggleCategory(cat)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown className="size-4 text-neutral-500" />
                    ) : (
                      <ChevronRight className="size-4 text-neutral-500" />
                    )}
                    <span className="text-sm font-medium text-white">
                      {CATEGORY_LABELS[cat]}
                    </span>
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        catIssues.length === 0
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-amber-500/10 text-amber-400"
                      )}
                    >
                      {fixResult ? `${fixResult.fixed} fixed` : `${catIssues.length} issues`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {catIssues.length > 0 && !fixResult && !isRunning && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmCategory(cat);
                        }}
                        disabled={isFixing}
                        className={cn(
                          "px-3 py-1 text-xs font-medium rounded-lg transition-colors",
                          isFixing
                            ? "bg-white/5 text-neutral-500 cursor-wait"
                            : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                        )}
                      >
                        {isFixing ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          `Fix (${catIssues.filter((i) => i.fixable).length})`
                        )}
                      </button>
                    )}
                  </div>
                </button>

                {isExpanded && catIssues.length > 0 && (
                  <div className="px-4 pb-3 space-y-1.5">
                    <p className="text-xs text-neutral-500 mb-2">
                      {CATEGORY_DESCRIPTIONS[cat]}
                    </p>
                    {catIssues.map((issue, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2 px-3 py-2 rounded-lg bg-white/[0.02]"
                      >
                        {fixResult ? (
                          <CheckCircle2 className="size-3.5 text-emerald-400 mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle className="size-3.5 text-amber-400 mt-0.5 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-xs text-white truncate">{issue.file_name}</p>
                          <p className="text-xs text-neutral-500">{issue.reason}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Summary */}
          {isComplete && (
            <div className="mt-4 p-4 rounded-xl bg-white/[0.03] border border-white/5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">
                    {totalIssues === 0
                      ? "All synced — no issues found"
                      : `${totalIssues} issue${totalIssues === 1 ? "" : "s"} across ${
                          Array.from(issues.entries()).filter(([, v]) => v.length > 0).length
                        } categories`}
                  </p>
                  {fixedIssues > 0 && (
                    <p className="text-xs text-emerald-400 mt-1">
                      {fixedIssues} issue{fixedIssues === 1 ? "" : "s"} fixed
                    </p>
                  )}
                </div>
                <button
                  onClick={startValidation}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-neutral-300 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                >
                  <RefreshCw className="size-3" />
                  Re-validate
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Fix confirmation dialog */}
        {confirmCategory && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-neutral-900 border border-white/10 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white">
                Fix {CATEGORY_LABELS[confirmCategory]}?
              </h3>
              <p className="text-xs text-neutral-400">
                {confirmCategory === "ghost" &&
                  `This will remove ${(issues.get(confirmCategory) || []).filter((i) => i.fixable).length} entries from your library that no longer exist on Google Drive.`}
                {confirmCategory === "missing" &&
                  `This will queue ${(issues.get(confirmCategory) || []).filter((i) => i.fixable).length} files for indexing on the next scan.`}
                {confirmCategory === "failed" &&
                  "This will clear failure records and retry indexing on the next scan."}
                {confirmCategory === "orphaned_zip" &&
                  `This will remove ${(issues.get(confirmCategory) || []).filter((i) => i.fixable).length} orphaned ZIP child entries from your library.`}
                {confirmCategory === "stale_token" &&
                  "This will refresh the Google Drive changes token for incremental sync."}
              </p>
              <p className="text-xs text-amber-400/80">
                {confirmCategory === "ghost" || confirmCategory === "orphaned_zip"
                  ? "This action cannot be undone."
                  : "This is a safe operation."}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmCategory(null)}
                  className="px-4 py-2 text-xs font-medium text-neutral-300 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleFix(confirmCategory)}
                  className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors"
                >
                  {confirmCategory === "ghost" || confirmCategory === "orphaned_zip"
                    ? `Remove ${(issues.get(confirmCategory) || []).filter((i) => i.fixable).length}`
                    : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
