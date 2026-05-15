import { useMemo, useState } from "react";
import {
  Cloud,
  Film,
  HardDrive,
  Loader2,
  Search,
  ChevronDown,
  Tv,
  X,
} from "lucide-react";

import { WatchHistoryEvent } from "@/services/api";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { HistoryEventCard } from "@/components/HistoryEventCard";

type QuickFilter = "all" | "completed" | "in-progress" | "movies" | "episodes" | "cloud" | "local";

interface FullHistoryViewProps {
  events: WatchHistoryEvent[];
  isHistorySyncing: boolean;
  isClearingHistory: boolean;
  onClearHistory: () => void;
  onOpenEvent?: (event: WatchHistoryEvent) => void;
  onRemoveEvent: (event: WatchHistoryEvent) => void;
}

interface HistoryDayGroup {
  label: string;
  dateKey: string;
  totalWatchSeconds: number;
  items: WatchHistoryEvent[];
}

const FILTER_OPTIONS: Array<{
  key: QuickFilter;
  label: string;
}> = [
  { key: "all", label: "All entries" },
  { key: "completed", label: "Finished" },
  { key: "in-progress", label: "In progress" },
  { key: "movies", label: "Movies" },
  { key: "episodes", label: "Episodes" },
  { key: "cloud", label: "Cloud" },
  { key: "local", label: "Local" },
];

const formatDateKey = (value: string) => {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
};

const formatWatchDateLabel = (dateKey: string) => {
  if (dateKey === "Unknown") return "Unknown date";

  const date = new Date(`${dateKey}T00:00:00Z`);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
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
    case "cloud":
      return event.is_cloud;
    case "local":
      return !event.is_cloud;
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

export function FullHistoryView({
  events,
  isHistorySyncing,
  isClearingHistory,
  onClearHistory,
  onOpenEvent,
  onRemoveEvent,
}: FullHistoryViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuickFilter>("all");

  const normalizedQuery = query.trim().toLowerCase();

  const stats = useMemo(() => {
    const completedCount = events.filter((event) => event.completed).length;
    const cloudCount = events.filter((event) => event.is_cloud).length;
    const totalWatchSeconds = events.reduce((sum, event) => sum + getConsumedWatchSeconds(event), 0);
    const lastSevenDaysBoundary = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentCount = events.filter((event) => {
      const date = new Date(event.ended_at.replace(" ", "T") + "Z");
      return !Number.isNaN(date.getTime()) && date.getTime() >= lastSevenDaysBoundary;
    }).length;

    return {
      totalSessions: events.length,
      completedCount,
      inProgressCount: events.length - completedCount,
      cloudCount,
      recentCount,
      totalWatchSeconds,
    };
  }, [events]);

  const filteredEvents = useMemo(
    () =>
      events.filter((event) => matchesFilter(event, filter) && matchesSearch(event, normalizedQuery)),
    [events, filter, normalizedQuery],
  );

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

  const hasFilters = filter !== "all" || normalizedQuery.length > 0;

  return (
    <div className="pt-24">
      <div className="rounded-[30px] border border-white/10 bg-[#1b1b1b]/88 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-6">
        <div className="space-y-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="space-y-1">
              <h2 className="text-[28px] font-semibold tracking-tight text-white">History</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm text-white/45">
                <span>{filteredEvents.length} {filteredEvents.length === 1 ? "entry" : "entries"}</span>
                <span className="text-white/20">•</span>
                <span>{formatDuration(filteredEvents.reduce((sum, item) => sum + getConsumedWatchSeconds(item), 0))} watched</span>
                <span className="text-white/20">•</span>
                <span className="inline-flex items-center gap-1.5">
                  {isHistorySyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
                  {isHistorySyncing ? "Syncing" : "Synced"}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onClearHistory}
              disabled={events.length === 0 || isClearingHistory}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-white/70 transition-all duration-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isClearingHistory ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              Clear
            </button>
          </div>

          <div className="rounded-[24px] border border-white/8 bg-[#202020]/82 p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="relative w-full xl:max-w-[520px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search title, episode, year..."
                  className="h-11 rounded-full border-white/10 bg-[#2a2a2a] pl-10 text-white placeholder:text-white/30 [color-scheme:dark]"
                />
              </div>

              <div className="relative xl:w-[190px]">
                <select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as QuickFilter)}
                  aria-label="Filter history entries"
                  className="h-11 w-full appearance-none rounded-full border border-white/10 bg-[#2a2a2a] px-4 pr-10 text-sm text-white outline-none transition-colors hover:bg-[#323232] focus:border-white/20 [color-scheme:dark]"
                >
                  {FILTER_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key} className="bg-[#111111] text-white">
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              </div>
            </div>

            <Separator className="my-4 bg-white/8" />

            <div className="flex flex-wrap items-center gap-3 text-xs text-white/40">
              <span className="inline-flex items-center gap-1.5">
                <Film className="h-3.5 w-3.5" />
                {events.filter((event) => event.media_type === "movie").length} movies
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Tv className="h-3.5 w-3.5" />
                {events.filter((event) => event.media_type === "tvepisode").length} episodes
              </span>
              <span className="inline-flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5" />
                {events.filter((event) => !event.is_cloud).length} local
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Cloud className="h-3.5 w-3.5" />
                {stats.cloudCount} cloud
              </span>
              {hasFilters && <span className="text-white/60">Filtered view</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        {groupedEvents.map((group) => (
          <section key={group.dateKey} className="rounded-[26px] border border-white/8 bg-[#181818]/86 p-4 shadow-[0_18px_54px_rgba(0,0,0,0.16)] backdrop-blur-xl sm:p-5">
            <div className="mb-4 flex flex-col gap-3 border-b border-white/8 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="mt-1 text-xl font-semibold text-white">{group.label}</h3>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-white/45">
                <span>{group.items.length} {group.items.length === 1 ? "entry" : "entries"}</span>
                <span>{formatDuration(group.totalWatchSeconds)}</span>
              </div>
            </div>

            <div className="space-y-3">
              {group.items.map((event) => (
                <HistoryEventCard
                  key={event.event_id}
                  event={event}
                  onOpen={event.media_id ? onOpenEvent : undefined}
                  onRemove={onRemoveEvent}
                />
              ))}
            </div>
          </section>
        ))}

        {events.length === 0 && (
          <div className="flex min-h-[60vh] items-center justify-center rounded-[32px] border border-dashed border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-8">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
                <Film className="h-8 w-8 text-white/40" />
              </div>
              <h3 className="text-xl font-semibold text-white">No watch entries yet</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">
                Start watching a movie or episode and SlasshyVault will capture the full watch entry here with exact time,
                progress, source, and timeline grouping.
              </p>
            </div>
          </div>
        )}

        {events.length > 0 && groupedEvents.length === 0 && (
          <div className="flex min-h-[40vh] items-center justify-center rounded-[32px] border border-dashed border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-8">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
                <Search className="h-8 w-8 text-white/40" />
              </div>
              <h3 className="text-xl font-semibold text-white">No entries match this filter</h3>
              <p className="mt-2 text-sm leading-6 text-white/55">
                Adjust the search or switch filters to reveal the entries hidden by the current view.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
