import { useMemo, useState, useCallback } from "react";
import { LazyMotion, m, AnimatePresence } from "framer-motion";

const loadFeatures = () => import("framer-motion").then((mod) => mod.domAnimation);
import {
  Cloud,
  Film,
  Loader2,
  Search,
  Tv,
  X,
  Clock,
  BarChart3,
  Activity,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
} from "lucide-react";

import { WatchHistoryEvent, AnalyticsData } from "@/services/api";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { HistoryEventCard } from "@/components/HistoryEventCard";
import { AnalyticsView } from "@/components/AnalyticsView";
import { cn } from "@/lib/utils";

type QuickFilter = "all" | "completed" | "in-progress" | "movies" | "episodes";
type DateRange = "all" | "today" | "7days" | "30days";
type SortMode = "recent" | "longest" | "title";
type SubView = "activity" | "stats";

interface FullHistoryViewProps {
  events: WatchHistoryEvent[];
  isHistorySyncing: boolean;
  isClearingHistory: boolean;
  onClearHistory: () => void;
  onOpenEvent?: (event: WatchHistoryEvent) => void;
  onRemoveEvent: (event: WatchHistoryEvent) => void;
  analyticsData?: AnalyticsData | null;
  onAnalyticsTabActive?: () => void;
  initialSubView?: SubView;
}

interface HistoryDayGroup {
  label: string;
  dateKey: string;
  totalWatchSeconds: number;
  items: WatchHistoryEvent[];
}

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "completed", label: "Finished" },
  { key: "in-progress", label: "In Progress" },
  { key: "movies", label: "Movies" },
  { key: "episodes", label: "Episodes" },
];

const DATE_RANGES: Array<{ key: DateRange; label: string }> = [
  { key: "all", label: "All Time" },
  { key: "today", label: "Today" },
  { key: "7days", label: "7 Days" },
  { key: "30days", label: "30 Days" },
];

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "recent", label: "Recent" },
  { key: "longest", label: "Longest" },
  { key: "title", label: "Title A-Z" },
];

const formatDateKey = (value: string) => {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
};

const watchDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const formatWatchDateLabel = (dateKey: string) => {
  if (dateKey === "Unknown") return "Unknown date";

  const date = new Date(`${dateKey}T00:00:00Z`);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  return watchDateFormatter.format(date);
};

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const getConsumedWatchSeconds = (event: WatchHistoryEvent) => {
  const duration = Math.max(0, event.duration_seconds || 0);
  const resumePosition = Math.max(0, event.resume_position_seconds || 0);
  const progressFromPercent = duration > 0 ? Math.round(duration * ((event.progress_percent || 0) / 100)) : 0;

  if (event.completed) return duration || resumePosition;
  return Math.min(duration || Number.MAX_SAFE_INTEGER, Math.max(resumePosition, progressFromPercent));
};

const matchesFilter = (event: WatchHistoryEvent, filter: QuickFilter) => {
  switch (filter) {
    case "completed":
      return event.completed;
    case "in-progress":
      return !event.completed;
    case "movies":
      return event.media_type === "movie";
    case "episodes":
      return event.media_type === "tvepisode";
    default:
      return true;
  }
};

const matchesSearch = (event: WatchHistoryEvent, query: string) => {
  if (!query) return true;

  const haystack = [
    event.title,
    event.parent_title,
    event.episode_title,
    event.overview,
    event.media_type,
    event.year?.toString(),
    event.season_number !== undefined && event.episode_number !== undefined
      ? `s${String(event.season_number).padStart(2, "0")}e${String(event.episode_number).padStart(2, "0")}`
      : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
};

const matchesDateRange = (event: WatchHistoryEvent, range: DateRange) => {
  if (range === "all") return true;

  const date = new Date(event.ended_at.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "today":
      return date.getTime() >= todayStart.getTime();
    case "7days":
      return date.getTime() >= todayStart.getTime() - 7 * 86400000;
    case "30days":
      return date.getTime() >= todayStart.getTime() - 30 * 86400000;
    default:
      return true;
  }
};

const sortEvents = (events: WatchHistoryEvent[], mode: SortMode) => {
  const sorted = [...events];
  switch (mode) {
    case "longest":
      return sorted.sort((a, b) => getConsumedWatchSeconds(b) - getConsumedWatchSeconds(a));
    case "title":
      return sorted.sort((a, b) => {
        const titleA = (a.parent_title || a.title).toLowerCase();
        const titleB = (b.parent_title || b.title).toLowerCase();
        return titleA.localeCompare(titleB);
      });
    case "recent":
    default:
      return sorted; // already sorted by ended_at DESC from backend
  }
};

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub?: string }) {
  return (
    <div className="flex-1 min-w-[120px] rounded-[18px] border border-white/[0.06] bg-white/[0.03] px-4 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="size-3.5 text-white/35" />
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/30">{label}</span>
      </div>
      <div className="text-lg font-semibold tracking-tight text-white">{value}</div>
      {sub && <div className="text-[10px] text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

export function FullHistoryView({
  events,
  isHistorySyncing,
  isClearingHistory,
  onClearHistory,
  onOpenEvent,
  onRemoveEvent,
  analyticsData,
  onAnalyticsTabActive,
  initialSubView = "activity",
}: FullHistoryViewProps) {
  const [subView, setSubView] = useState<SubView>(initialSubView);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [showSortMenu, setShowSortMenu] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();

  const handleSubViewChange = useCallback((view: SubView) => {
    setSubView(view);
    if (view === "stats" && onAnalyticsTabActive) {
      onAnalyticsTabActive();
    }
  }, [onAnalyticsTabActive]);

  const toggleDayCollapse = useCallback((dateKey: string) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  }, []);

  const stats = useMemo(() => {
    const completedCount = events.filter((event) => event.completed).length;
    const movieCount = events.filter((event) => event.media_type === "movie").length;
    const episodeCount = events.filter((event) => event.media_type === "tvepisode").length;
    const cloudCount = events.filter((event) => event.is_cloud).length;
    const totalWatchSeconds = events.reduce((sum, event) => sum + getConsumedWatchSeconds(event), 0);

    return {
      totalSessions: events.length,
      completedCount,
      inProgressCount: events.length - completedCount,
      movieCount,
      episodeCount,
      cloudCount,
      totalWatchSeconds,
    };
  }, [events]);

  const filteredEvents = useMemo(() => {
    const filtered = events.filter(
      (event) =>
        matchesFilter(event, filter) &&
        matchesSearch(event, normalizedQuery) &&
        matchesDateRange(event, dateRange),
    );
    return sortEvents(filtered, sortMode);
  }, [events, filter, normalizedQuery, dateRange, sortMode]);

  const groupedEvents = useMemo<HistoryDayGroup[]>(() => {
    const groups = new Map<string, WatchHistoryEvent[]>();

    filteredEvents.forEach((event) => {
      const key = formatDateKey(event.ended_at);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    });

    return Array.from(groups.entries()).map(([dateKey, items]) => ({
      dateKey,
      label: formatWatchDateLabel(dateKey),
      totalWatchSeconds: items.reduce((sum, item) => sum + getConsumedWatchSeconds(item), 0),
      items,
    }));
  }, [filteredEvents]);

  const hasFilters = filter !== "all" || normalizedQuery.length > 0 || dateRange !== "all";

  const handleClearConfirm = useCallback(() => {
    setShowClearDialog(false);
    onClearHistory();
  }, [onClearHistory]);

  return (
    <LazyMotion features={loadFeatures}>
    <div className="pt-16">
      {/* Sub-view tabs */}
      <div className="mb-1 flex items-center justify-end">
        <div className="inline-flex p-0.5 rounded-full bg-white/[0.04] backdrop-blur-xl border border-white/[0.08]">
          {[
            { id: "activity" as SubView, label: "Activity", icon: Activity },
            { id: "stats" as SubView, label: "Stats", icon: BarChart3 },
          ].map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => handleSubViewChange(tab.id)}
              className={cn(
                "relative flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-200 min-w-[80px] justify-center",
                subView === tab.id ? "text-black" : "text-white/45 hover:text-white/70",
              )}
            >
              {subView === tab.id && (
                <m.div
                  layoutId="HistorySubTab"
                  className="absolute inset-0 bg-white rounded-full shadow-md"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <tab.icon className="size-3.5" />
                {tab.label}
              </span>
            </button>
          ))}
        </div>

        {subView === "activity" && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-white/35">
              {isHistorySyncing ? <Loader2 className="size-3 animate-spin" /> : <Cloud className="size-3" />}
              {isHistorySyncing ? "Syncing" : "Synced"}
            </span>
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {subView === "stats" ? (
          <m.div
            key="stats"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {analyticsData ? (
              <AnalyticsView data={analyticsData} />
            ) : (
              <div className="flex min-h-[60vh] items-center justify-center rounded-[32px] border border-dashed border-white/10 bg-white/[0.02] p-8">
                <div className="text-center">
                  <div className="mx-auto mb-4 rounded-2xl border border-white/10 bg-white/[0.05] p-4 w-fit">
                    <BarChart3 className="size-8 text-white/40" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Loading analytics…</h3>
                </div>
              </div>
            )}
          </m.div>
        ) : (
          <m.div
            key="activity"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {/* Stat cards */}
            <div className="flex flex-wrap gap-2.5 mb-5">
              <StatCard icon={Activity} label="Sessions" value={stats.totalSessions.toString()} />
              <StatCard icon={Clock} label="Watch Time" value={formatDuration(stats.totalWatchSeconds)} />
              <StatCard icon={Film} label="Movies" value={stats.movieCount.toString()} />
              <StatCard icon={Tv} label="Episodes" value={stats.episodeCount.toString()} />
              <StatCard icon={Cloud} label="Cloud" value={stats.cloudCount.toString()} />
            </div>

            {/* Main content card */}
            <div className="rounded-[26px] border border-white/[0.08] bg-white/[0.03] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-6">
              {/* Header */}
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between mb-5">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-white">Watch History</h2>
                  <p className="text-xs text-white/35 mt-1">
                    {filteredEvents.length} {filteredEvents.length === 1 ? "entry" : "entries"}
                    {hasFilters && ` (filtered from ${events.length})`}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowClearDialog(true)}
                  disabled={events.length === 0 || isClearingHistory}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-xs font-medium text-white/50 transition-all duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {isClearingHistory ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                  Clear All
                </button>
              </div>

              {/* Search + Sort */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center mb-4">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/25" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title, episode, year..."
                    className="h-10 rounded-full border-white/[0.08] bg-white/[0.04] pl-10 text-white placeholder:text-white/25 [color-scheme:dark]"
                  />
                </div>

                {/* Sort button */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowSortMenu(!showSortMenu)}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-xs font-medium text-white/50 transition-all hover:bg-white/[0.08] hover:text-white"
                  >
                    <ArrowUpDown className="size-3.5" />
                    {SORT_OPTIONS.find((s) => s.key === sortMode)?.label}
                    <ChevronDown className="size-3" />
                  </button>
                  {showSortMenu && (
                    <>
                      <div className="fixed inset-0 z-40" role="button" tabIndex={-1} onClick={() => setShowSortMenu(false)} onKeyDown={(e) => { if (e.key === 'Escape') setShowSortMenu(false); }} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-xl border border-white/[0.08] bg-[#1a1a1a] py-1 shadow-2xl">
                        {SORT_OPTIONS.map((option) => (
                          <button
                            type="button"
                            key={option.key}
                            onClick={() => {
                              setSortMode(option.key);
                              setShowSortMenu(false);
                            }}
                            className={cn(
                              "w-full px-3 py-2 text-left text-xs transition-colors",
                              sortMode === option.key
                                ? "bg-white/[0.08] text-white"
                                : "text-white/50 hover:bg-white/[0.04] hover:text-white/70",
                            )}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Filter pills */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {QUICK_FILTERS.map((option) => (
                  <button
                    type="button"
                    key={option.key}
                    onClick={() => setFilter(option.key)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-[11px] font-medium transition-all duration-200",
                      filter === option.key
                        ? "bg-white text-black"
                        : "border border-white/[0.08] bg-white/[0.03] text-white/45 hover:text-white/70 hover:border-white/[0.15]",
                    )}
                  >
                    {option.label}
                  </button>
                ))}

                <div className="w-px h-6 bg-white/[0.08] mx-1 self-center" />

                {DATE_RANGES.map((option) => (
                  <button
                    type="button"
                    key={option.key}
                    onClick={() => setDateRange(option.key)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-[11px] font-medium transition-all duration-200",
                      dateRange === option.key
                        ? "bg-white text-black"
                        : "border border-white/[0.08] bg-white/[0.03] text-white/45 hover:text-white/70 hover:border-white/[0.15]",
                    )}
                  >
                    {option.label}
                  </button>
                ))}

                {hasFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilter("all");
                      setDateRange("all");
                      setQuery("");
                    }}
                    className="rounded-full px-3 py-1.5 text-[11px] font-medium text-white/30 hover:text-white/60 transition-colors"
                  >
                    Clear filters
                  </button>
                )}
              </div>

              <Separator className="bg-white/[0.06]" />
            </div>

            {/* Day groups */}
            <div className="mt-5 space-y-4">
              {groupedEvents.map((group) => {
                const isCollapsed = collapsedDays.has(group.dateKey);
                return (
                  <section
                    key={group.dateKey}
                    className="rounded-[22px] border border-white/[0.06] bg-white/[0.025] shadow-[0_18px_54px_rgba(0,0,0,0.16)] backdrop-blur-xl overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => toggleDayCollapse(group.dateKey)}
                      className="w-full flex items-center justify-between px-5 py-4 transition-colors hover:bg-white/[0.02]"
                    >
                      <div className="flex items-center gap-3">
                        <h3 className="text-base font-semibold text-white">{group.label}</h3>
                        <span className="text-xs text-white/30">
                          {group.items.length} {group.items.length === 1 ? "entry" : "entries"}
                        </span>
                        <span className="text-xs text-white/20">{formatDuration(group.totalWatchSeconds)}</span>
                      </div>
                      {isCollapsed ? (
                        <ChevronDown className="size-4 text-white/30" />
                      ) : (
                        <ChevronUp className="size-4 text-white/30" />
                      )}
                    </button>

                    <AnimatePresence initial={false}>
                      {!isCollapsed && (
                        <m.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: "easeInOut" }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 space-y-2.5 sm:px-5">
                            {group.items.map((event) => (
                              <HistoryEventCard
                                key={event.event_id}
                                event={event}
                                onOpen={event.media_id ? onOpenEvent : undefined}
                                onRemove={onRemoveEvent}
                              />
                            ))}
                          </div>
                        </m.div>
                      )}
                    </AnimatePresence>
                  </section>
                );
              })}

              {/* Empty state: no events at all */}
              {events.length === 0 && (
                <div className="flex min-h-[50vh] items-center justify-center rounded-[32px] border border-dashed border-white/[0.08] bg-white/[0.02] p-8">
                  <div className="max-w-md text-center">
                    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      <Film className="size-7 text-white/35" />
                    </div>
                    <h3 className="text-lg font-semibold text-white">No watch history yet</h3>
                    <p className="mt-2 text-sm leading-6 text-white/40">
                      Start watching something and your activity will appear here.
                    </p>
                  </div>
                </div>
              )}

              {/* Empty state: no matches */}
              {events.length > 0 && groupedEvents.length === 0 && (
                <div className="flex min-h-[40vh] items-center justify-center rounded-[32px] border border-dashed border-white/[0.08] bg-white/[0.02] p-8">
                  <div className="max-w-md text-center">
                    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      <Search className="size-7 text-white/35" />
                    </div>
                    <h3 className="text-lg font-semibold text-white">No entries match</h3>
                    <p className="mt-2 text-sm leading-6 text-white/40">
                      Try adjusting your search or filters.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {/* Clear History Confirmation Dialog */}
      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent className="sm:max-w-[400px] bg-[#141414] border-white/[0.08] rounded-[20px]">
          <DialogHeader>
            <DialogTitle className="text-white text-lg">Clear all watch history?</DialogTitle>
            <DialogDescription className="text-white/40 text-sm">
              This will permanently remove {events.length} watch {events.length === 1 ? "entry" : "entries"} and reset
              all resume positions. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => setShowClearDialog(false)}
              className="inline-flex h-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] px-5 text-sm font-medium text-white/60 transition-all hover:bg-white/[0.08] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleClearConfirm}
              disabled={isClearingHistory}
              className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-sm font-medium text-black transition-all hover:bg-white/90 disabled:opacity-50"
            >
              {isClearingHistory ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Clear History
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </LazyMotion>
  );
}
