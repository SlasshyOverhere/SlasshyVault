import { useEffect, useState, memo } from "react";
import {
  CalendarRange,
  CheckCircle2,
  Clock3,
  HardDrive,
  PlayCircle,
  Timer,
  Trash2,
  Tv,
} from "lucide-react";

import { getCachedImageUrl, WatchHistoryEvent } from "@/services/api";
import { cn } from "@/lib/utils";

interface HistoryEventCardProps {
  event: WatchHistoryEvent;
  onOpen?: (event: WatchHistoryEvent) => void;
  onRemove: (event: WatchHistoryEvent) => void;
}

const formatEventTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value.replace(" ", "T") + "Z"));

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const getWatchedSeconds = (event: WatchHistoryEvent) => {
  const duration = Math.max(0, event.duration_seconds || 0);
  const fromPercent = duration > 0 ? Math.round(duration * ((event.progress_percent || 0) / 100)) : 0;
  const resumePosition = Math.max(0, event.resume_position_seconds || 0);

  if (event.completed) return duration || resumePosition;
  return Math.min(duration || Number.MAX_SAFE_INTEGER, Math.max(fromPercent, resumePosition));
};

const buildEpisodeLabel = (event: WatchHistoryEvent) => {
  if (
    event.media_type !== "tvepisode" ||
    event.season_number === undefined ||
    event.episode_number === undefined
  ) {
    return null;
  }

  const code = `S${String(event.season_number).padStart(2, "0")}E${String(
    event.episode_number,
  ).padStart(2, "0")}`;
  return event.episode_title ? `${code} • ${event.episode_title}` : code;
};

export const HistoryEventCard = memo(function HistoryEventCard({
  event,
  onOpen,
  onRemove,
}: HistoryEventCardProps) {
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const progress = Math.max(0, Math.min(100, Math.round(event.progress_percent || 0)));
  const episodeLabel = buildEpisodeLabel(event);
  const title = event.parent_title?.trim() || event.title;
  const subtitle =
    event.media_type === "movie"
      ? event.year?.toString() || "Movie"
      : episodeLabel || "Episode";
  const watchedSeconds = getWatchedSeconds(event);
  const canOpen = Boolean(onOpen);

  useEffect(() => {
    let cancelled = false;

    const loadPoster = async () => {
      if (!event.poster_path) {
        setPosterUrl(null);
        return;
      }

      const filename = event.poster_path.replace("image_cache/", "");
      const url = await getCachedImageUrl(filename);
      if (!cancelled && url) {
        setPosterUrl(url);
      }
    };

    void loadPoster();
    return () => {
      cancelled = true;
    };
  }, [event.poster_path]);

  return (
    <div className="rounded-[18px] border border-white/8 bg-[#161616]/88 px-3 py-3 shadow-[0_10px_26px_rgba(0,0,0,0.14)] backdrop-blur-xl">
      <div className="hidden grid-cols-[minmax(0,1.9fr)_110px_100px_110px_94px_44px] items-center gap-4 lg:grid">
        <button
          type="button"
          onClick={() => onOpen?.(event)}
          disabled={!canOpen}
          aria-label={canOpen ? `Open ${title}` : undefined}
          className={cn(
            "flex min-w-0 items-center gap-3 rounded-[14px] border border-transparent px-2 py-1.5 text-left transition-colors",
            canOpen ? "hover:border-white/8 hover:bg-white/[0.03]" : "cursor-default",
          )}
        >
          <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-[12px] border border-white/10 bg-white/5">
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/35">
                <Tv className="h-4 w-4" />
              </div>
            )}
          </div>

          <div className="min-w-0">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">
              {event.media_type === "movie" ? "Movie" : "Episode"}
            </p>
            <h3 className="truncate text-sm font-semibold tracking-tight text-white">{title}</h3>
            <p className="truncate text-xs text-white/52">{subtitle}</p>
            {event.overview && (
              <p className="mt-1 line-clamp-1 text-[11px] text-white/42">{event.overview}</p>
            )}
          </div>
        </button>

        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/32">Watched</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-white/70">
            <Clock3 className="h-3.5 w-3.5 text-white/38" />
            <span className="truncate">{formatEventTime(event.ended_at)}</span>
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/42">
            <CalendarRange className="h-3.5 w-3.5 text-white/30" />
            <span className="truncate">Started {formatEventTime(event.started_at)}</span>
          </p>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/32">Progress</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-white/70">
            <PlayCircle className="h-3.5 w-3.5 text-white/38" />
            {event.completed ? "Finished" : `${progress}%`}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-white/68 transition-all duration-300"
              style={{ width: `${Math.max(progress, event.completed ? 100 : 4)}%` }}
            />
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/32">Time</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-white/70">
            <Timer className="h-3.5 w-3.5 text-white/38" />
            {formatDuration(watchedSeconds)}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/32">Source</p>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/68">
            <HardDrive className="h-3 w-3" />
            {event.is_cloud ? "Drive" : "Local"}
          </div>
          {event.completed && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-1 text-[10px] text-white/72">
              <CheckCircle2 className="h-3 w-3" />
              Done
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onRemove(event)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Remove history entry"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:hidden">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => onOpen?.(event)}
            disabled={!canOpen}
            className={cn(
              "relative h-20 w-14 shrink-0 overflow-hidden rounded-[14px] border border-white/10 bg-white/5",
              canOpen ? "cursor-pointer" : "cursor-default",
            )}
          >
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/35">
                <Tv className="h-4 w-4" />
              </div>
            )}
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/34">
              {event.media_type === "movie" ? "Movie" : "Episode"}
            </p>
            <h3 className="truncate text-sm font-semibold tracking-tight text-white">{title}</h3>
            <p className="truncate text-xs text-white/54">{subtitle}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-white/64">
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1">
                {event.completed ? "Finished" : `${progress}%`}
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1">
                {formatDuration(watchedSeconds)}
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1">
                {event.is_cloud ? "Drive" : "Local"}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onRemove(event)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Remove history entry"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid gap-2 text-[11px] text-white/46 sm:grid-cols-2">
          <div className="flex items-center gap-1.5">
            <Clock3 className="h-3.5 w-3.5 text-white/34" />
            <span className="truncate">{formatEventTime(event.ended_at)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CalendarRange className="h-3.5 w-3.5 text-white/34" />
            <span className="truncate">Started {formatEventTime(event.started_at)}</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[10px] text-white/42">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-white/68 transition-all duration-300"
              style={{ width: `${Math.max(progress, event.completed ? 100 : 4)}%` }}
            />
          </div>
        </div>

        {event.overview && (
          <p className="line-clamp-2 text-xs leading-5 text-white/48">{event.overview}</p>
        )}
      </div>
    </div>
  );
})
