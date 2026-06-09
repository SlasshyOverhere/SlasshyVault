import { Film, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TmdbSearchResult } from './remote.types'

interface Props {
  results: TmdbSearchResult[]
  isLoading: boolean
  onSelect: (item: TmdbSearchResult) => void
}

export function RemoteSearchResults({ results, isLoading, onSelect }: Props) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="size-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-neutral-500">
        <SearchIcon />
        <p className="mt-4 text-sm">Search for movies or TV shows to get started</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {results.map((item) => (
        <button
          key={`${item.media_type}-${item.id}`}
          onClick={() => onSelect(item)}
          className="group text-left focus:outline-none"
        >
          <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-white/[0.04] border border-white/[0.06] group-hover:border-white/20 transition-all duration-300 group-hover:shadow-[0_0_30px_rgba(255,255,255,0.08)]">
            {item.poster_path ? (
              <img
                src={`https://image.tmdb.org/t/p/w342${item.poster_path}`}
                alt={item.title || item.name || ''}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Film className="size-8 text-neutral-600" />
              </div>
            )}

            {/* Type badge */}
            <div className="absolute top-2 left-2">
              <span className={cn(
                'px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider',
                item.media_type === 'movie'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  : 'bg-green-500/20 text-green-300 border border-green-500/30'
              )}>
                {item.media_type === 'movie' ? 'Movie' : 'Series'}
              </span>
            </div>
          </div>

          <div className="mt-2 px-0.5">
            <p className="text-sm font-semibold text-white truncate">
              {item.title || item.name}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-neutral-500">
                {item.release_date?.substring(0, 4) || item.first_air_date?.substring(0, 4) || ''}
              </span>
              {item.vote_average != null && item.vote_average > 0 && (
                <span className="flex items-center gap-1 text-xs text-yellow-500">
                  <Star className="size-3 fill-yellow-500" />
                  {item.vote_average.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

function SearchIcon() {
  return (
    <svg className="size-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )
}
