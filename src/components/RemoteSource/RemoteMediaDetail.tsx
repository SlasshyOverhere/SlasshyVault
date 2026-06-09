import { useState, useEffect } from 'react'
import { Film, Star, Calendar, ChevronLeft, Play, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { invoke } from '@tauri-apps/api/tauri'
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

export function RemoteMediaDetail({ item, onBack, onFetchMovieStreams, onFetchEpisodeStreams, fetching }: Props) {
  const [imdbId, setImdbId] = useState<string | null>(null)
  const [seasons, setSeasons] = useState<TvSeason[]>([])
  const [activeSeason, setActiveSeason] = useState<number>(1)
  const [seasonData, setSeasonData] = useState<Map<number, TmdbEpisodeInfo[]>>(new Map())
  const [loadingSeason, setLoadingSeason] = useState<Set<number>>(new Set())

  // Fetch IMDb ID (resolved from TMDB) + season info
  useEffect(() => {
    const load = async () => {
      try {
        if (item.media_type === 'movie') {
          const details = await invoke<any>('get_movie_details', { movieId: item.id })
          setImdbId(details.imdb_id || null)
        } else {
          // Load seasons from TMDB
          const details = await invoke<any>('get_tv_details', { tvId: item.id })
          const s = (details.seasons || []).filter((s: TvSeason) => s.season_number > 0)
          setSeasons(s)
          if (s.length > 0) {
            setActiveSeason(s[0].season_number)
          }
          // Resolve IMDb ID from TMDB external_ids endpoint
          try {
            const extIds = await invoke<any>('get_imdb_details', {
              imdbId: null,
              tmdbId: item.id,
              mediaType: 'tv',
            })
            if (extIds?.imdb_id) setImdbId(extIds.imdb_id)
          } catch {
            // IMDb ID not required for episode browsing, only for fetching streams
          }
        }
      } catch (e) {
        console.error('Failed to load details:', e)
      }
    }
    load()
  }, [item.id, item.media_type])

  // Fetch episodes for active season
  useEffect(() => {
    if (item.media_type !== 'tv' || seasonData.has(activeSeason)) return

    setLoadingSeason((prev) => new Set(prev).add(activeSeason))
    invoke<TmdbSeasonDetails>('get_tv_season_episodes', {
      tvId: item.id,
      seasonNumber: activeSeason,
    })
      .then((data) => {
        setSeasonData((prev) => {
          const next = new Map(prev)
          next.set(activeSeason, data.episodes || [])
          return next
        })
      })
      .catch((e) => console.error('Failed to load episodes:', e))
      .finally(() => {
        setLoadingSeason((prev) => {
          const next = new Set(prev)
          next.delete(activeSeason)
          return next
        })
      })
  }, [item.id, item.media_type, activeSeason, imdbId, seasonData])

  const episodes = seasonData.get(activeSeason) || []

  const poster = item.poster_path
    ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
    : null

  // ── Movie view ──
  if (item.media_type === 'movie') {
    return (
      <div className="space-y-6">
        <button onClick={onBack} className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors">
          <ChevronLeft className="size-4" />
          Back to search results
        </button>

        <div className="flex gap-6">
          <div className="shrink-0 w-48 aspect-[2/3] rounded-xl overflow-hidden bg-white/[0.04] border border-white/[0.06]">
            {poster ? (
              <img src={poster} alt={item.title || ''} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Film className="size-8 text-neutral-600" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-3">
            <h2 className="text-2xl font-bold text-white">{item.title || item.name}</h2>

            <div className="flex items-center gap-4 text-sm text-neutral-400">
              {item.release_date && (
                <span className="flex items-center gap-1">
                  <Calendar className="size-3.5" />
                  {item.release_date}
                </span>
              )}
              {item.vote_average != null && item.vote_average > 0 && (
                <span className="flex items-center gap-1 text-yellow-500">
                  <Star className="size-3.5 fill-yellow-500" />
                  {item.vote_average.toFixed(1)}
                </span>
              )}
            </div>

            {item.overview && (
              <p className="text-sm text-neutral-400 leading-relaxed line-clamp-4">{item.overview}</p>
            )}

            <div className="pt-4">
              <Button
                onClick={() => imdbId && onFetchMovieStreams(imdbId)}
                disabled={!imdbId || fetching}
                className="bg-white/10 hover:bg-white/20 text-white border border-white/20"
              >
                {fetching ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Play className="size-4 mr-2" />}
                {fetching ? 'Loading...' : 'Fetch Streams'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── TV Series view ──
  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors">
        <ChevronLeft className="size-4" />
        Back to search results
      </button>

      {/* Show header */}
      <div className="flex gap-6 pb-6 border-b border-white/[0.06]">
        <div className="shrink-0 w-32 aspect-[2/3] rounded-xl overflow-hidden bg-white/[0.04] border border-white/[0.06]">
          {poster ? (
            <img src={poster} alt={item.name || ''} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Film className="size-8 text-neutral-600" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <h2 className="text-2xl font-bold text-white">{item.name}</h2>
          <div className="flex items-center gap-4 text-sm text-neutral-400">
            {item.first_air_date && (
              <span className="flex items-center gap-1">
                <Calendar className="size-3.5" />
                {item.first_air_date.substring(0, 4)}
              </span>
            )}
            {item.vote_average != null && item.vote_average > 0 && (
              <span className="flex items-center gap-1 text-yellow-500">
                <Star className="size-3.5 fill-yellow-500" />
                {item.vote_average.toFixed(1)}
              </span>
            )}
            <span className="text-neutral-500">{seasons.length} seasons</span>
          </div>
          {item.overview && (
            <p className="text-sm text-neutral-400 leading-relaxed line-clamp-3">{item.overview}</p>
          )}
        </div>
      </div>

      {/* Season tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
        {seasons.map((s) => (
          <button
            key={s.season_number}
            onClick={() => setActiveSeason(s.season_number)}
            className={cn(
              'shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200',
              activeSeason === s.season_number
                ? 'bg-white/15 text-white border border-white/20'
                : 'bg-white/[0.04] text-neutral-400 border border-transparent hover:bg-white/[0.08] hover:text-neutral-200',
            )}
          >
            Season {s.season_number}
            {s.name && s.name !== `Season ${s.season_number}` && (
              <span className="ml-1 text-xs text-neutral-500">– {s.name}</span>
            )}
          </button>
        ))}
      </div>

      {/* Episode grid */}
      <div className="space-y-3">
        {loadingSeason.has(activeSeason) && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 text-neutral-400 animate-spin" />
          </div>
        )}

        {!loadingSeason.has(activeSeason) && episodes.length === 0 && (
          <div className="text-center py-12 text-neutral-500 text-sm">No episodes found for this season.</div>
        )}

        {!loadingSeason.has(activeSeason) && episodes.map((ep) => (
          <div
            key={ep.episode_number}
            className="flex gap-4 p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-white/15 transition-all duration-200 group"
          >
            {/* Thumbnail */}
            <div className="shrink-0 w-40 aspect-video rounded-lg overflow-hidden bg-white/[0.04]">
              {ep.still_path ? (
                <img
                  src={`https://image.tmdb.org/t/p/w300${ep.still_path}`}
                  alt={ep.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Film className="size-5 text-neutral-600" />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 flex flex-col justify-center">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-500">
                  S{String(activeSeason).padStart(2, '0')}E{String(ep.episode_number).padStart(2, '0')}
                </span>
                <h3 className="text-sm font-semibold text-white truncate">{ep.name}</h3>
                {ep.vote_average != null && ep.vote_average > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-yellow-500 shrink-0">
                    <Star className="size-3 fill-yellow-500" />
                    {ep.vote_average.toFixed(1)}
                  </span>
                )}
              </div>
              {ep.overview && (
                <p className="text-xs text-neutral-500 mt-1 line-clamp-2">{ep.overview}</p>
              )}
            </div>

            {/* Fetch Streams button */}
            <div className="shrink-0 flex items-center">
              <Button
                onClick={() => imdbId && onFetchEpisodeStreams(imdbId, activeSeason, ep.episode_number, ep.name)}
                disabled={!imdbId || fetching}
                size="sm"
                className="bg-white/10 hover:bg-white/20 text-white border border-white/20 h-9"
              >
                {fetching ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
