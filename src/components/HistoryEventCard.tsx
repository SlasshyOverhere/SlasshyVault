import { useEffect, useState, memo } from "react";
import {
  CheckCircle2,
  Clock3,
  HardDrive,
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
  return event.episode_title ? `${code} \u2022 ${event.episode_title}` : code;
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
    <div className="group relative rounded-[18px] border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-[0_12px_40px_rgba(0,0,0,0.3)] overflow-hidden">
      {/* Desktop layout */}
      <div className="hidden lg:flex items-center gap-4 px-4 py-3">
        {/* Poster */}
        <button
          type="button"
          onClick={() => onOpen?.(event)}
          disabled={!canOpen}
          aria-label={canOpen ? `Open ${title}` : undefined}
          className={cn(
            "relative h-[72px] w-12 shrink-0 overflow-hidden rounded-[10px] border border-white/[0.08] bg-white/[0.04]",
            canOpen ? "cursor-pointer" : "cursor-default",
          )}
        >
          {posterUrl ? (
            <img src={posterUrl} alt={title} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center bg-white/[0.04] text-white/30">
              <Tv className="size-4" />
            </div>
          )}
        </button>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/30">
              {event.media_type === "movie" ? "Movie" : "Episode"}
            </span>
            {event.completed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-black">
                <CheckCircle2 className="size-2.5" />
                Done
              </span>
            )}
          </div>
          <h3 className="mt-0.5 truncate text-sm font-semibold tracking-tight text-white">{title}</h3>
          <p className="truncate text-xs text-white/45">{subtitle}</p>
        </div>

        {/* Watched time */}
        <div className="hidden xl:block min-w-[140px]">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/25">Watched</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-white/60">
            <Clock3 className="size-3 text-white/30" />
            {formatEventTime(event.ended_at)}
          </p>
        </div>

        {/* Duration pill */}
        <div className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/55">
          {formatDuration(watchedSeconds)}
        </div>

        {/* Source pill */}
        <div className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/55 inline-flex items-center gap-1.5">
          <HardDrive className="size-3" />
          {event.is_cloud ? "Cloud" : "Local"}
        </div>

        {/* Delete */}
        <button
          type="button"
          onClick={() => onRemove(event)}
          className="inline-flex size-8 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-white/40 transition-all hover:bg-white/[0.08] hover:text-white opacity-0 group-hover:opacity-100"
          aria-label="Remove history entry"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {/* Mobile layout */}
      <div className="flex flex-col gap-3 p-3 lg:hidden">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => onOpen?.(event)}
            disabled={!canOpen}
            className={cn(
              "relative h-20 w-14 shrink-0 overflow-hidden rounded-[10px] border border-white/[0.08] bg-white/[0.04]",
              canOpen ? "cursor-pointer" : "cursor-default",
            )}
          >
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center bg-white/[0.04] text-white/30">
                <Tv className="size-4" />
              </div>
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">
                {event.media_type === "movie" ? "Movie" : "Episode"}
              </span>
              {event.completed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-black">
                  <CheckCircle2 className="size-2.5" />
                  Done
                </span>
              )}
            </div>
            <h3 className="mt-0.5 truncate text-sm font-semibold tracking-tight text-white">{title}</h3>
            <p className="truncate text-xs text-white/45">{subtitle}</p>
          </div>

          <button
            type="button"
            onClick={() => onRemove(event)}
            className="inline-flex size-8 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-white/40 transition-all hover:bg-white/[0.08] hover:text-white"
            aria-label="Remove history entry"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-white/50">
            <Clock3 className="size-3" />
            {formatEventTime(event.ended_at)}
          </span>
          <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-white/50">
            {event.completed ? "Finished" : `${progress}%`}
          </span>
          <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-white/50">
            {formatDuration(watchedSeconds)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-white/50">
            <HardDrive className="size-3" />
            {event.is_cloud ? "Cloud" : "Local"}
          </span>
        </div>

        {event.overview && (
          <p className="line-clamp-2 text-xs leading-5 text-white/40">{event.overview}</p>
        )}
      </div>

      {/* Progress bar at bottom */}
      <div className="h-[3px] w-full bg-white/[0.04]">
        <div
          className={cn(
            "h-full transition-all duration-500",
            event.completed ? "bg-white/50" : "bg-white/30",
          )}
          style={{ width: `${Math.max(progress, event.completed ? 100 : 2)}%` }}
        />
      </div>
    </div>
  );
});
