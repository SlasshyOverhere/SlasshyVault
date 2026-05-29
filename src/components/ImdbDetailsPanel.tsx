import { useState, useEffect } from "react"
import { Star, Loader2, Trophy, Film, Globe, Clock, Calendar, Users, ExternalLink, MessageSquare } from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getImdbDetails, getTmdbReviews, type ImdbDetails, type TmdbReview } from "@/services/api"

interface ImdbDetailsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  imdbId?: string
  tmdbId?: number
  mediaType?: string
}

export function ImdbDetailsPanel({ open, onOpenChange, imdbId, tmdbId, mediaType }: ImdbDetailsPanelProps) {
  const [data, setData] = useState<ImdbDetails | null>(null)
  const [reviews, setReviews] = useState<TmdbReview[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open) {
      setData(null)
      setReviews([])
      setError(false)
      return
    }
    if (!imdbId && !tmdbId) return

    setLoading(true)
    setError(false)
    getImdbDetails({ imdbId, tmdbId, mediaType }).then(result => {
      if (result) {
        setData(result)
      } else {
        setError(true)
      }
    }).finally(() => setLoading(false))

    // Fetch TMDB reviews in parallel
    if (tmdbId && mediaType) {
      getTmdbReviews(tmdbId, mediaType).then(setReviews)
    }
  }, [open, imdbId, tmdbId, mediaType])

  const formatVotes = (votes: number | null) => {
    if (!votes) return null
    if (votes >= 1_000_000) return `${(votes / 1_000_000).toFixed(1)}M`
    if (votes >= 1_000) return `${(votes / 1_000).toFixed(0)}K`
    return votes.toLocaleString()
  }

  const metacriticColor = (score: number | null) => {
    if (!score) return ""
    if (score >= 61) return "bg-green-500/20 text-green-400 border-green-500/30"
    if (score >= 40) return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
    return "bg-red-500/20 text-red-400 border-red-500/30"
  }

  const yearLabel = () => {
    if (!data?.start_year) return null
    if (data.end_year && data.end_year !== data.start_year) return `${data.start_year}\u2013${data.end_year}`
    return String(data.start_year)
  }

  const runtimeLabel = () => {
    if (!data?.runtime_seconds) return null
    const mins = Math.round(data.runtime_seconds / 60)
    if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`
    return `${mins}m`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-[#090a0d] border-white/10 rounded-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">{data?.title || "IMDb Details"}</DialogTitle>
        <DialogDescription className="sr-only">Detailed information from IMDb</DialogDescription>

        <ScrollArea className="max-h-[80vh]">
          <div className="p-6 space-y-6">
            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="size-8 animate-spin text-white/40" />
              </div>
            )}

            {/* Error */}
            {error && !loading && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Film className="size-10 text-white/20" />
                <p className="text-white/40 text-sm">Unable to load IMDb details</p>
                <button
                  onClick={() => onOpenChange(true)}
                  className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Data */}
            {data && !loading && (
              <>
                {/* Poster Image */}
                {data.primary_image_url && (
                  <div className="flex justify-center mb-4">
                    <img
                      src={data.primary_image_url}
                      alt={data.title || "Poster"}
                      className="w-32 h-auto rounded-lg shadow-lg"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}

                {/* Header */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded bg-[#f5c518] text-black text-[10px] font-black uppercase tracking-wider">
                      IMDb
                    </span>
                    {data.mpaa_rating && (
                      <span className="px-2 py-0.5 rounded bg-white/10 border border-white/10 text-white/70 text-[10px] font-bold uppercase tracking-wider">
                        {data.mpaa_rating}
                      </span>
                    )}
                    {yearLabel() && (
                      <span className="text-white/40 text-xs font-medium flex items-center gap-1">
                        <Calendar className="size-3" />
                        {yearLabel()}
                      </span>
                    )}
                    {runtimeLabel() && (
                      <span className="text-white/40 text-xs font-medium flex items-center gap-1">
                        <Clock className="size-3" />
                        {runtimeLabel()}
                      </span>
                    )}
                    {data.origin_countries && data.origin_countries.length > 0 && (
                      <span className="text-white/40 text-xs font-medium flex items-center gap-1">
                        <Globe className="size-3" />
                        {data.origin_countries.join(", ")}
                      </span>
                    )}
                  </div>
                  {data.title && (
                    <h2 className="text-2xl font-black text-white tracking-tight">{data.title}</h2>
                  )}
                </div>

                {/* Rating Hero */}
                <div className="flex items-start gap-4">
                  {data.aggregate_rating && data.aggregate_rating > 0 && (
                    <div className="flex flex-col items-center gap-1 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-center gap-1.5">
                        <Star className="size-5 fill-amber-400 text-amber-400" />
                        <span className="text-3xl font-black text-amber-400">{data.aggregate_rating.toFixed(1)}</span>
                        <span className="text-white/30 text-xs font-medium">/10</span>
                      </div>
                      {data.vote_count && (
                        <span className="text-white/40 text-[10px] font-medium">
                          {formatVotes(data.vote_count)} votes
                        </span>
                      )}
                    </div>
                  )}
                  {data.metacritic_score != null && (
                    <div className={`flex flex-col items-center gap-1 px-3 py-3 rounded-xl border ${metacriticColor(data.metacritic_score)}`}>
                      <span className="text-2xl font-black">{data.metacritic_score}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Metacritic</span>
                      {data.metacritic_url && (
                        <a
                          href={data.metacritic_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] opacity-50 hover:opacity-100 transition-opacity flex items-center gap-0.5"
                        >
                          <ExternalLink className="size-2.5" />
                        </a>
                      )}
                    </div>
                  )}
                  {data.total_nominations != null && data.total_nominations > 0 && (
                    <div className="flex flex-col items-center gap-1 px-3 py-3 rounded-xl bg-white/5 border border-white/10">
                      <div className="flex items-center gap-1.5">
                        <Trophy className="size-4 text-yellow-400" />
                        <span className="text-xl font-black text-white">{data.total_wins ?? 0}</span>
                      </div>
                      <span className="text-white/40 text-[10px] font-medium">
                        {data.total_wins ?? 0} wins / {data.total_nominations} noms
                      </span>
                    </div>
                  )}
                </div>

                {/* Plot */}
                {data.plot && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Storyline</h3>
                    <p className="text-sm text-white/70 leading-relaxed">{data.plot}</p>
                  </div>
                )}

                {/* People */}
                {(data.directors || data.writers || data.stars) && (
                  <div className="space-y-3">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20 flex items-center gap-1.5">
                      <Users className="size-3" />
                      Cast & Crew
                    </h3>
                    <div className="space-y-2">
                      {data.directors && data.directors.length > 0 && (
                        <div className="flex gap-2">
                          <span className="text-white/30 text-xs font-bold min-w-[70px]">Director</span>
                          <span className="text-white/70 text-xs">{data.directors.join(", ")}</span>
                        </div>
                      )}
                      {data.writers && data.writers.length > 0 && (
                        <div className="flex gap-2">
                          <span className="text-white/30 text-xs font-bold min-w-[70px]">Writers</span>
                          <span className="text-white/70 text-xs">{data.writers.join(", ")}</span>
                        </div>
                      )}
                      {data.stars && data.stars.length > 0 && (
                        <div className="flex gap-2">
                          <span className="text-white/30 text-xs font-bold min-w-[70px]">Stars</span>
                          <span className="text-white/70 text-xs">{data.stars.join(", ")}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Genres & Interests */}
                {data.genres && data.genres.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Genres</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {data.genres.map(g => (
                        <span key={g} className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/60 text-[11px] font-medium">
                          {g}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {data.interests && data.interests.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Interests</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {data.interests.slice(0, 12).map(i => (
                        <span key={i} className="px-2 py-0.5 rounded-full bg-white/[0.03] border border-white/5 text-white/40 text-[10px] font-medium">
                          {i}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Box Office */}
                {data.production_budget && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Box Office</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {data.production_budget && (
                        <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                          <div className="text-white/30 text-[10px] font-bold uppercase">Budget</div>
                          <div className="text-white/80 text-sm font-bold">{data.production_budget}</div>
                        </div>
                      )}
                      {data.domestic_gross && (
                        <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                          <div className="text-white/30 text-[10px] font-bold uppercase">Domestic</div>
                          <div className="text-white/80 text-sm font-bold">{data.domestic_gross}</div>
                        </div>
                      )}
                      {data.worldwide_gross && (
                        <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                          <div className="text-white/30 text-[10px] font-bold uppercase">Worldwide</div>
                          <div className="text-white/80 text-sm font-bold">{data.worldwide_gross}</div>
                        </div>
                      )}
                      {data.opening_weekend_gross && (
                        <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                          <div className="text-white/30 text-[10px] font-bold uppercase">Opening Weekend</div>
                          <div className="text-white/80 text-sm font-bold">{data.opening_weekend_gross}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Awards */}
                {data.awards && data.awards.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20 flex items-center gap-1.5">
                      <Trophy className="size-3" />
                      Awards
                    </h3>
                    <div className="space-y-1.5">
                      {data.awards.map((award, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
                          <Trophy className="size-3 text-yellow-400 shrink-0" />
                          <span className="text-white/70 text-xs font-medium">{award.event}</span>
                          {award.year && <span className="text-white/30 text-[10px]">{award.year}</span>}
                          <span className="text-white/50 text-[10px]">&mdash;</span>
                          <span className="text-white/60 text-[10px]">{award.category}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* TMDB Reviews */}
                {reviews.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20 flex items-center gap-1.5">
                      <MessageSquare className="size-3" />
                      Reviews
                    </h3>
                    <div className="space-y-3">
                      {reviews.map((review, i) => (
                        <div key={i} className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/5 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-white/70 text-xs font-bold">{review.author}</span>
                            {review.rating != null && (
                              <span className="flex items-center gap-0.5 text-amber-400 text-[10px] font-bold">
                                <Star className="size-2.5 fill-amber-400" />
                                {review.rating}
                              </span>
                            )}
                            {review.created_at && (
                              <span className="text-white/20 text-[10px]">
                                {new Date(review.created_at).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <p className="text-white/50 text-[11px] leading-relaxed line-clamp-4">{review.content}</p>
                          {review.url && (
                            <a
                              href={review.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors"
                            >
                              Read full review <ExternalLink className="size-2.5" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
