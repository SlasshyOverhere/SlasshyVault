import { useEffect, useMemo, useState } from "react"
import { Calendar, Clock, Play, Tv } from "lucide-react"
import { MediaItem, getCachedImageUrl, getMovieDetails, getTmdbImageUrl, searchTmdb } from "@/services/api"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface ContentDetailsModalProps {
  open: boolean
  item: MediaItem | null
  onOpenChange: (open: boolean) => void
  onPrimaryAction: (item: MediaItem) => void | Promise<void>
}

const heroArtworkCache = new Map<number, string | null>()
const runtimeMinutesCache = new Map<number, number | null>()

const resolveLocalImage = async (path?: string): Promise<string | null> => {
  if (!path) return null
  if (path.startsWith("http") || path.startsWith("asset://")) return path
  const filename = path.replace("image_cache/", "")
  return getCachedImageUrl(filename)
}

export function ContentDetailsModal({
  open,
  item,
  onOpenChange,
  onPrimaryAction,
}: ContentDetailsModalProps) {
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null)
  const [posterImageUrl, setPosterImageUrl] = useState<string | null>(null)
  const [runtimeMinutesOverride, setRuntimeMinutesOverride] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadArtwork = async () => {
      if (!open || !item) {
        setHeroImageUrl(null)
        setPosterImageUrl(null)
        setRuntimeMinutesOverride(null)
        return
      }

      const poster = await resolveLocalImage(item.poster_path)
      if (!cancelled) {
        setPosterImageUrl(poster)
      }

      const expectedType = item.media_type === "movie" ? "movie" : "tv"
      const itemTmdbId = Number.parseInt(item.tmdb_id || "", 10)
      const hasItemTmdbId = Number.isFinite(itemTmdbId) && itemTmdbId > 0
      const cachedRuntime = runtimeMinutesCache.get(item.id)

      if (!cancelled) {
        setRuntimeMinutesOverride(cachedRuntime ?? null)
      }

      let movieDetails: Awaited<ReturnType<typeof getMovieDetails>> = null
      if (item.media_type === "movie" && hasItemTmdbId && cachedRuntime === undefined) {
        movieDetails = await getMovieDetails(itemTmdbId)
        const runtime = movieDetails?.runtime && movieDetails.runtime > 0 ? movieDetails.runtime : null
        runtimeMinutesCache.set(item.id, runtime)
        if (!cancelled) {
          setRuntimeMinutesOverride(runtime)
        }
      }

      const cachedHero = heroArtworkCache.get(item.id)
      if (cachedHero !== undefined) {
        if (!cancelled) {
          setHeroImageUrl(cachedHero || poster)
        }
        return
      }

      let nextHero: string | null = null

      try {
        if (item.media_type === "tvepisode" && item.still_path) {
          nextHero = await resolveLocalImage(item.still_path)
        }

        if (!nextHero && item.media_type === "movie" && movieDetails?.backdrop_path) {
          nextHero = getTmdbImageUrl(movieDetails.backdrop_path, "original")
        }

        if (!nextHero) {
          const response = await searchTmdb(item.title)

          const exactMatch = response.results.find(
            (result) => String(result.id) === item.tmdb_id && result.media_type === expectedType
          )
          const fallbackMatch = response.results.find(
            (result) => result.media_type === expectedType && !!result.backdrop_path
          )

          const chosen = exactMatch ?? fallbackMatch
          nextHero = getTmdbImageUrl(chosen?.backdrop_path, "original")

          if (item.media_type === "movie" && runtimeMinutesCache.get(item.id) === undefined && chosen?.id) {
            const resolvedMovieDetails = await getMovieDetails(chosen.id)
            const runtime = resolvedMovieDetails?.runtime && resolvedMovieDetails.runtime > 0
              ? resolvedMovieDetails.runtime
              : null
            runtimeMinutesCache.set(item.id, runtime)
            if (!cancelled) {
              setRuntimeMinutesOverride(runtime)
            }

            if (!nextHero && resolvedMovieDetails?.backdrop_path) {
              nextHero = getTmdbImageUrl(resolvedMovieDetails.backdrop_path, "original")
            }
          }
        }
      } catch {
        // Fall through to poster fallback.
      }

      if (!nextHero) {
        nextHero = poster
      }

      heroArtworkCache.set(item.id, nextHero)
      if (!cancelled) {
        setHeroImageUrl(nextHero)
      }
    }

    void loadArtwork()
    return () => {
      cancelled = true
    }
  }, [open, item])

  const castList = useMemo(() => {
    if (!item?.cast_names) return []
    return item.cast_names
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 8)
  }, [item?.cast_names])

  if (!item) {
    return null
  }

  const isShow = item.media_type === "tvshow"
  const runtimeMinutesFromDuration = item.duration_seconds && item.duration_seconds > 0
    ? Math.max(1, Math.round(item.duration_seconds / 60))
    : null
  const runtimeMinutes = runtimeMinutesFromDuration ?? runtimeMinutesOverride
  const runtimeLabel = runtimeMinutes
    ? (runtimeMinutes >= 60
      ? `${Math.floor(runtimeMinutes / 60)}h ${runtimeMinutes % 60}m`
      : `${runtimeMinutes}m`)
    : "Runtime N/A"
  const sourceTitleRaw = item.file_path?.trim() || ""
  const sourceTitle = sourceTitleRaw.replace(/\.[^/.\\]+$/, "")
  const contentTypeLabel = isShow ? "TV Show" : "Movie"
  const castPreview = castList.slice(0, 6)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(1080px,96vw)] max-w-[1080px] overflow-hidden border-white/10 bg-[#090a0d] p-0 text-white [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:bg-black/70 [&>button]:p-1 [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:hover:bg-black/90">
        <DialogTitle className="sr-only">{item.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Content details and playback actions for {item.title}.
        </DialogDescription>

        <section className="relative h-[76vh] min-h-[460px] max-h-[760px] w-full overflow-hidden">
          {heroImageUrl ? (
            <>
              <img
                src={heroImageUrl}
                alt={item.title}
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <img
                src={heroImageUrl}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full object-cover object-center opacity-45 blur-xl scale-105"
              />
            </>
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#11141d] via-[#0e0f14] to-[#07080b]" />
          )}

          <div className="absolute inset-0 bg-gradient-to-r from-black/82 via-black/40 to-black/72" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/30" />

          <div className="absolute inset-x-0 bottom-0 p-4 sm:p-7">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex items-end gap-4">
                {posterImageUrl && (
                  <div className="hidden sm:block h-[150px] w-[102px] overflow-hidden rounded-xl border border-white/20 bg-black/30 shadow-2xl">
                    <img src={posterImageUrl} alt={`${item.title} poster`} className="h-full w-full object-cover" />
                  </div>
                )}

                <div className="max-w-3xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">{contentTypeLabel}</p>
                  <h2 className="mt-1 text-2xl font-semibold leading-tight text-white sm:text-4xl">{item.title}</h2>

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-white/80">
                    {!isShow ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        {item.year ?? "Year N/A"}
                        <span className="px-0.5 text-white/45">•</span>
                        <Clock className="h-3.5 w-3.5" />
                        {runtimeLabel}
                      </span>
                    ) : (
                      item.year && (
                        <span className="inline-flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {item.year}
                        </span>
                      )
                    )}
                  </div>

                  <p className="mt-3 line-clamp-2 text-sm leading-6 text-white/80">
                    {item.overview?.trim() || "No synopsis available for this title yet."}
                  </p>

                  {castPreview.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {castPreview.map((name) => (
                        <span
                          key={name}
                          className="rounded-full border border-white/25 bg-black/35 px-2.5 py-1 text-xs text-white/85"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  )}

                  {!!sourceTitle && (
                    <p className="mt-3 line-clamp-1 text-xs text-white/60">Source: {sourceTitle}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3">
                <Button
                  onClick={() => void onPrimaryAction(item)}
                  className="h-11 rounded-xl px-6 text-sm font-semibold shadow-xl"
                >
                  {isShow ? (
                    <>
                      <Tv className="mr-2 h-4 w-4" />
                      Open Episodes
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-4 w-4 fill-current" />
                      Play
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
