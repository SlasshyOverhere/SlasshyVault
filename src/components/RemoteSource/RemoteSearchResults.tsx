import { Film, Star, Clapperboard, Tv } from 'lucide-react'
import { LazyMotion, domAnimation, m } from 'framer-motion'
import type { TmdbSearchResult } from './remote.types'
import { getYear } from './remote.types'

interface Props {
  results: TmdbSearchResult[]
  isLoading: boolean
  onSelect: (item: TmdbSearchResult) => void
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-32">
      <div className="relative size-10">
        <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
        <div className="absolute inset-0 rounded-full border-2 border-amber-700/40 border-t-transparent animate-spin" />
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-neutral-600 select-none">
      <div className="size-16 mb-6 rounded-2xl border border-neutral-800 bg-[#0A0A0A] flex items-center justify-center">
        <Clapperboard className="size-7 text-neutral-700" />
      </div>
      <p className="text-sm font-medium text-neutral-500">Search for movies or TV shows to get started</p>
    </div>
  )
}

function ResultCard({ item, onSelect, index }: { item: TmdbSearchResult; onSelect: (item: TmdbSearchResult) => void; index: number }) {
  const isFirst = index === 0

  return (
    <m.button
      onClick={() => onSelect(item)}
      className={`group w-full text-left focus:outline-none ${isFirst ? '' : ''}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.04, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <div className={`flex gap-4 rounded-2xl border border-neutral-800/80 bg-[#0A0A0A] transition-all duration-300 ${
        isFirst
          ? 'p-5 hover:border-amber-700/30 hover:bg-[#0D0D0D]'
          : 'p-3.5 hover:border-neutral-700/50 hover:bg-[#0D0D0D]'
      }`}>
        <div className={`shrink-0 rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 ${
          isFirst ? 'size-28' : 'size-16'
        }`}>
          {item.poster_path ? (
            <img
              src={`https://image.tmdb.org/t/p/w185${item.poster_path}`}
              alt={item.title || item.name || ''}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Film className={isFirst ? 'size-6' : 'size-4'} />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={`font-semibold text-neutral-100 truncate leading-tight ${
                isFirst ? 'text-base' : 'text-sm'
              }`}>
                {item.title || item.name}
              </h3>
              <div className="flex items-center gap-2.5 mt-1 flex-wrap">
                <span className={`flex items-center gap-1 font-medium text-neutral-500 ${
                  isFirst ? 'text-xs' : 'text-[11px]'
                }`}>
                  {item.media_type === 'movie' ? (
                    <Clapperboard className="size-3" />
                  ) : (
                    <Tv className="size-3" />
                  )}
                  <span className={isFirst ? '' : 'hidden sm:inline'}>{item.media_type === 'movie' ? 'Movie' : 'Series'}</span>
                </span>
                {item.release_date || item.first_air_date ? (
                  <span className={`text-neutral-600 ${
                    isFirst ? 'text-xs' : 'text-[11px]'
                  }`}>
                    {getYear(item.release_date || item.first_air_date)}
                  </span>
                ) : null}
                {item.vote_average != null && item.vote_average > 0 && (
                  <span className="flex items-center gap-1 text-[11px] text-amber-500/80">
                    <Star className="size-3 fill-amber-500/60" />
                    {item.vote_average.toFixed(1)}
                  </span>
                )}
              </div>
              {isFirst && item.overview && (
                <p className="text-xs text-neutral-600 leading-relaxed mt-2 line-clamp-2">{item.overview}</p>
              )}
            </div>

            <div className={`shrink-0 text-[10px] font-bold uppercase tracking-widest rounded-lg border transition-colors duration-300 ${
              item.media_type === 'movie'
                ? 'bg-amber-500/5 text-amber-600/60 border-amber-700/20 group-hover:border-amber-700/30'
                : 'bg-sky-500/5 text-sky-600/60 border-sky-700/20 group-hover:border-sky-700/30'
            } ${isFirst ? 'px-2.5 py-1' : 'px-2 py-0.5'}`}>
              {item.media_type === 'movie' ? 'MOV' : 'TV'}
            </div>
          </div>
        </div>
      </div>
    </m.button>
  )
}

export function RemoteSearchResults({ results, isLoading, onSelect }: Props) {
  if (isLoading) return <Loading />
  if (results.length === 0) return <EmptyState />

  return (
    <LazyMotion features={domAnimation}>
      <div className="space-y-2">
        {results.map((item, index) => (
          <ResultCard key={`${item.media_type}-${item.id}`} item={item} onSelect={onSelect} index={index} />
        ))}
      </div>
    </LazyMotion>
  )
}
