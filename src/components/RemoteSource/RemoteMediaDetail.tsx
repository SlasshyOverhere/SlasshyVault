import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { Film, Star, Calendar, ChevronLeft, Play, Loader2, ListVideo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { invoke } from '@tauri-apps/api/tauri'
import { getCachedImageUrl } from '@/services/api'
import { cn } from '@/lib/utils'
import type { TmdbSearchResult } from './remote.types'

interface Props {
  item: TmdbSearchResult
  onBack: () => void
  onFetchMovieStreams: (imdbId: string) => void
  onFetchEpisodeStreams: (imdbId: string, season: number, episode: number, episodeTitle: string) => void
  fetching?: boolean
}

interface TvSeason {
  season_number: number
  episode_count: number
  name?: string
  poster_path?: string
}

interface TmdbEpisodeInfo {
  episode_number: number
  name: string
  overview?: string
  still_path?: string
  air_date?: string
  runtime?: number
  vote_average?: number
}

interface TmdbSeasonDetails {
  season_number: number
  name: string
  episodes: TmdbEpisodeInfo[]
}

// Resolve an image path: TMDB paths (/...) get TMDB URL, local cache paths get getCachedImageUrl
function tmdbImage(path: string | null | undefined, size: string): string | null {
  if (!path) return null
  // Full URL or asset:// already resolved
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('asset://')) return path
  // TMDB paths start with /
  if (path.startsWith('/')) return `https://image.tmdb.org/t/p/${size}${path}`
  return null // local cache path, handle separately
}

// Episode thumbnail with async image resolution (handles TMDB + local cache paths)
const EpisodeThumbnail = memo(function EpisodeThumbnail({
  stillPath, alt,
}: {
  stillPath: string | null | undefined, alt: string
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!stillPath) { setImgUrl(null); return }

      if (stillPath.startsWith('http://') || stillPath.startsWith('https://') || stillPath.startsWith('asset://')) {
        if (!cancelled) setImgUrl(stillPath)
        return
      }

      if (stillPath.startsWith('/')) {
        if (!cancelled) setImgUrl(`https://image.tmdb.org/t/p/w300${stillPath}`)
        return
      }

      let filename = stillPath
      if (filename.startsWith('image_cache/')) filename = filename.replace('image_cache/', '')
      try {
        const url = await getCachedImageUrl(filename)
        if (!cancelled) setImgUrl(url)
      } catch {
        if (!cancelled) setImgUrl(null)
      }
    }
    load()
    return () => { cancelled = true }
  }, [stillPath])

  if (!imgUrl) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-neutral-900">
        <Film className="size-5 text-neutral-700" />
      </div>
    )
  }

  return (
    <img
      src={imgUrl}
      alt={alt}
      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
    />
  )
})

export function RemoteMediaDetail({ item, onBack, onFetchMovieStreams, onFetchEpisodeStreams, fetching }: Props) {
  const [imdbId, setImdbId] = useState<string | null>(null)
  const [seasons, setSeasons] = useState<TvSeason[]>([])
  const [activeSeason, setActiveSeason] = useState<number>(1)
  const [seasonData, setSeasonData] = useState<Map<number, TmdbEpisodeInfo[]>>(new Map())
  const [fetchedBackdrop, setFetchedBackdrop] = useState<string | null>(null)
  const loadingSeasons = useRef(new Set<number>())

  const fetchSeason = useCallback((seasonNum: number) => {
    if (loadingSeasons.current.has(seasonNum)) return
    loadingSeasons.current.add(seasonNum)
    invoke<TmdbSeasonDetails>('get_tv_season_episodes', {
      tvId: item.id,
      seasonNumber: seasonNum,
    })
      .then((data) => {
        setSeasonData((prev) => {
          if (prev.has(seasonNum)) return prev
          const next = new Map(prev)
          next.set(seasonNum, data.episodes || [])
          return next
        })
      })
      .catch(() => {})
      .finally(() => {
        loadingSeasons.current.delete(seasonNum)
      })
  }, [item.id])

  useEffect(() => {
    const load = async () => {
      try {
        if (item.media_type === 'movie') {
          const details = await invoke<any>('get_movie_details', { movieId: item.id })
          setImdbId(details.imdb_id || null)
          if (details.backdrop_path) setFetchedBackdrop(details.backdrop_path)
        } else {
          const details = await invoke<any>('get_tv_details', { tvId: item.id })
          if (details.backdrop_path) setFetchedBackdrop(details.backdrop_path)
          const s = (details.seasons || []).filter((s: TvSeason) => s.season_number > 0)
          setSeasons(s)
          if (s.length > 0) {
            setActiveSeason(s[0].season_number)
          }
          try {
            const extIds = await invoke<any>('get_imdb_details', {
              imdbId: null,
              tmdbId: item.id,
              mediaType: 'tv',
            })
            if (extIds?.imdb_id) setImdbId(extIds.imdb_id)
          } catch {}
        }
      } catch (e) {
        console.error('Failed to load details:', e)
      }
    }
    load()
  }, [item.id, item.media_type])

  useEffect(() => {
    if (seasonData.has(activeSeason)) return
    fetchSeason(activeSeason)
  }, [activeSeason, seasonData, fetchSeason])

  const episodes = seasonData.get(activeSeason) || []
  const activeSeasonInfo = seasons.find(s => s.season_number === activeSeason)
  const episodeCount = activeSeasonInfo?.episode_count ?? 0

  const poster = tmdbImage(item.poster_path, 'w342')
  const backdrop = tmdbImage(item.backdrop_path || fetchedBackdrop, 'w1280')

  // ── Movie view ──
  if (item.media_type === 'movie') {
    return (
      <div className="max-w-4xl">
        <button onClick={onBack} className="flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-200 transition-colors mb-6 group">
          <ChevronLeft className="size-4 transition-transform duration-200 group-hover:-translate-x-0.5" />
          Back
        </button>

        <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-[#0A0A0A]">
          {backdrop && (
            <div className="absolute inset-0">
              <img src={backdrop} alt="" className="w-full h-full object-cover opacity-20" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-[#0A0A0A]/80 to-[#0A0A0A]/40" />
            </div>
          )}

          <div className="relative flex gap-8 p-8">
            <div className="shrink-0 w-44 aspect-[2/3] rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 shadow-2xl">
              {poster ? (
                <img src={poster} alt={item.title || ''} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Film className="size-8 text-neutral-700" />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col justify-center space-y-4">
              <div>
                <h2 className="text-3xl font-bold text-neutral-100 leading-tight">{item.title || item.name}</h2>
                <div className="flex items-center gap-3 mt-2 text-sm text-neutral-500">
                  {item.release_date && (
                    <span className="flex items-center gap-1.5">
                      <Calendar className="size-3.5 text-neutral-600" />
                      {item.release_date}
                    </span>
                  )}
                  {item.vote_average != null && item.vote_average > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Star className="size-3.5 text-amber-500/70 fill-amber-500/40" />
                      <span className="text-amber-500/80 font-medium">{item.vote_average.toFixed(1)}</span>
                    </span>
                  )}
                </div>
              </div>

              {item.overview && (
                <p className="text-sm text-neutral-400 leading-relaxed line-clamp-4 max-w-xl">{item.overview}</p>
              )}

              <div className="pt-2">
                <Button
                  onClick={() => imdbId && onFetchMovieStreams(imdbId)}
                  disabled={!imdbId || fetching}
                  className="bg-amber-600 hover:bg-amber-500 text-white border border-amber-500/30 shadow-lg shadow-amber-900/30 h-11 px-6 rounded-xl font-semibold transition-all duration-200 active:scale-[0.97]"
                >
                  {fetching ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Play className="size-4 mr-2 fill-current" />}
                  {fetching ? 'Loading streams...' : 'Find streams'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── TV Series view ──
  return (
    <div className="max-w-4xl space-y-6">
      <button onClick={onBack} className="flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-200 transition-colors group">
        <ChevronLeft className="size-4 transition-transform duration-200 group-hover:-translate-x-0.5" />
        Back
      </button>

      {/* Show header */}
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-[#0A0A0A]">
        {backdrop && (
          <div className="absolute inset-0">
            <img src={backdrop} alt="" className="w-full h-full object-cover opacity-15" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-[#0A0A0A]/80 to-[#0A0A0A]/40" />
          </div>
        )}

        <div className="relative flex gap-6 p-6">
          <div className="shrink-0 w-28 aspect-[2/3] rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 shadow-xl">
            {poster ? (
              <img src={poster} alt={item.name || ''} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Film className="size-6 text-neutral-700" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-2.5 flex flex-col justify-center">
            <h2 className="text-2xl font-bold text-neutral-100">{item.name}</h2>
            <div className="flex items-center gap-3 text-sm text-neutral-500 flex-wrap">
              {item.first_air_date && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-3.5 text-neutral-600" />
                  {item.first_air_date.substring(0, 4)}
                </span>
              )}
              {item.vote_average != null && item.vote_average > 0 && (
                <span className="flex items-center gap-1.5">
                  <Star className="size-3.5 text-amber-500/70 fill-amber-500/40" />
                  <span className="text-amber-500/80 font-medium">{item.vote_average.toFixed(1)}</span>
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <ListVideo className="size-3.5 text-neutral-600" />
                {seasons.length} {seasons.length === 1 ? 'season' : 'seasons'}
              </span>
            </div>
            {item.overview && (
              <p className="text-sm text-neutral-500 leading-relaxed line-clamp-2 max-w-xl">{item.overview}</p>
            )}
          </div>
        </div>
      </div>

      {/* Season selector */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {seasons.map((s) => (
          <button
            key={s.season_number}
            onClick={() => setActiveSeason(s.season_number)}
            className={cn(
              'shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 border',
              activeSeason === s.season_number
                ? 'bg-amber-600/15 text-amber-400 border-amber-700/30 shadow-sm'
                : 'bg-[#0A0A0A] text-neutral-500 border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300 hover:border-neutral-700',
            )}
          >
            <span>Season {s.season_number}</span>
            {s.name && s.name !== `Season ${s.season_number}` && (
              <span className="ml-1.5 text-xs text-neutral-600 font-medium">&middot; {s.name}</span>
            )}
          </button>
        ))}
      </div>

      {/* Episode list */}
      <div className="space-y-2">
        {!seasonData.has(activeSeason) ? (
          Array.from({ length: episodeCount || 8 }, (_, i) => (
            <div key={i} className="flex gap-4 p-4 rounded-2xl bg-[#0A0A0A] border border-neutral-800/80">
              <div className="shrink-0 w-44 aspect-video rounded-xl bg-neutral-800 animate-pulse" />
              <div className="flex-1 flex flex-col justify-center gap-2">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-16 bg-neutral-800 rounded animate-pulse" />
                  <div className="h-4 w-48 bg-neutral-800 rounded animate-pulse" />
                </div>
                <div className="h-3 w-full max-w-sm bg-neutral-800 rounded animate-pulse" />
              </div>
              <div className="shrink-0 flex items-center">
                <div className="size-10 rounded-xl bg-neutral-800 animate-pulse" />
              </div>
            </div>
          ))
        ) : episodes.length === 0 ? (
          <div className="text-center py-16 text-sm text-neutral-600 font-medium">No episodes found for this season.</div>
        ) : (
          episodes.map((ep) => (
            <div
              key={ep.episode_number}
              className="flex gap-4 p-4 rounded-2xl bg-[#0A0A0A] border border-neutral-800/80 hover:bg-[#0D0D0D] hover:border-neutral-700/50 transition-all duration-200 group"
            >
              <div className="shrink-0 w-44 aspect-video rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800">
                <EpisodeThumbnail
                  stillPath={ep.still_path}
                  alt={ep.name}
                />
              </div>

              <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-neutral-600 tabular-nums shrink-0">
                    S{String(activeSeason).padStart(2, '0')} &middot; E{String(ep.episode_number).padStart(2, '0')}
                  </span>
                  <h3 className="text-sm font-semibold text-neutral-200 truncate">{ep.name}</h3>
                  {ep.vote_average != null && ep.vote_average > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-500/70 shrink-0">
                      <Star className="size-3 fill-amber-500/40" />
                      {ep.vote_average.toFixed(1)}
                    </span>
                  )}
                </div>
                {ep.overview && (
                  <p className="text-xs text-neutral-600 leading-relaxed line-clamp-2">{ep.overview}</p>
                )}
              </div>

              <div className="shrink-0 flex items-center">
                <button
                  onClick={() => imdbId && onFetchEpisodeStreams(imdbId, activeSeason, ep.episode_number, ep.name)}
                  disabled={!imdbId || fetching}
                  className="size-10 flex items-center justify-center rounded-xl bg-amber-600/10 border border-amber-700/20 text-amber-500/70 hover:bg-amber-600/20 hover:text-amber-400 hover:border-amber-600/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
                >
                  {fetching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4 fill-current" />
                  )}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
