import { useEffect, useState } from "react";
import { Clock3, PlayCircle, Trash2, Tv, HardDrive } from "lucide-react";
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

export function HistoryEventCard({
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
    <div className="rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.025))] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.24)] backdrop-blur-xl">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onOpen?.(event)}
          disabled={!onOpen}
          className={cn(
            "relative h-24 w-16 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5",
            onOpen ? "cursor-pointer" : "cursor-default",
          )}
        >
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={title}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/40">
              <Tv className="h-5 w-5" />
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5 text-left">
            <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/75">
              {event.completed ? "Completed" : `${progress}% watched`}
            </div>
          </div>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/45">
                {event.media_type === "movie" ? "Movie Session" : "Episode Session"}
              </p>
              <h3 className="truncate text-base font-semibold text-white">{title}</h3>
              <p className="mt-0.5 text-xs text-white/60">{subtitle}</p>
            </div>

            <button
              type="button"
              onClick={() => onRemove(event)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/70 transition-colors hover:bg-white/[0.12] hover:text-white"
              aria-label="Remove history entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-white/70">
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1">
              <Clock3 className="h-3 w-3" />
              {formatEventTime(event.ended_at)}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1">
              <PlayCircle className="h-3 w-3" />
              {event.completed ? "Finished" : `${progress}% progress`}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1">
              <HardDrive className="h-3 w-3" />
              {event.is_cloud ? "Google Drive" : "Local"}
            </span>
          </div>

          {event.overview && (
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-white/60">
              {event.overview}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
