import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Check, Film, Loader2, Search, Star, Tv } from "lucide-react"
import { fixMatch, MediaItem, searchTmdb, TmdbSearchResult } from "@/services/api"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

interface FixMatchModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: MediaItem | null
  onSuccess: () => void | Promise<void>
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w92"
const DIRECT_MATCH_INPUT_RE =
  /(^\d+$)|(^tt\d+$)|(imdb\.com\/title\/tt\d+)|(themoviedb\.org\/(?:movie|tv)\/\d+)/i

const getResultTitle = (result: TmdbSearchResult) => result.title || result.name || "Untitled"

const getResultYear = (result: TmdbSearchResult): string | null => {
  const date = result.release_date || result.first_air_date
  if (!date) return null

  const year = new Date(date).getFullYear()
  if (Number.isNaN(year)) return null

  return year.toString()
}

export function FixMatchModal({ open, onOpenChange, item, onSuccess }: FixMatchModalProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<TmdbSearchResult[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const searchTokenRef = useRef(0)
  const { toast } = useToast()
  const isDirectMatchInput = useMemo(() => DIRECT_MATCH_INPUT_RE.test(query.trim()), [query])

  const runSearch = useCallback(async (searchQuery: string, mediaType: "movie" | "tv") => {
    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      setResults([])
      setSelectedId(null)
      return
    }

    if (DIRECT_MATCH_INPUT_RE.test(trimmedQuery)) {
      setResults([])
      setSelectedId(null)
      return
    }

    const currentToken = ++searchTokenRef.current
    setIsSearching(true)

    try {
      const response = await searchTmdb(trimmedQuery)
      if (currentToken !== searchTokenRef.current) return

      const filtered = response.results.filter((result) => result.media_type === mediaType)
      setResults(filtered)
      setSelectedId((currentId) => {
        if (currentId && filtered.some((result) => result.id === currentId)) {
          return currentId
        }
        return filtered[0]?.id ?? null
      })
    } catch (error) {
      if (currentToken !== searchTokenRef.current) return

      console.error("TMDB search failed", error)
      const errorMessage = typeof error === "string" ? error : (error as { message?: string })?.message || "Unknown error"
      toast({
        title: "Search Failed",
        description: errorMessage.includes("API key")
          ? "TMDB API key not configured. Please add it in Settings."
          : `Search error: ${errorMessage}`,
        variant: "destructive"
      })
    } finally {
      if (currentToken === searchTokenRef.current) {
        setIsSearching(false)
      }
    }
  }, [toast])

  useEffect(() => {
    if (!open || !item) {
      searchTokenRef.current += 1
      setQuery("")
      setResults([])
      setSelectedId(null)
      setIsSearching(false)
      setIsUpdating(false)
      return
    }

    const initialQuery = item.title.trim()
    const mediaType = item.media_type === "movie" ? "movie" : "tv"

    setQuery(initialQuery)
    setResults([])
    setSelectedId(null)

    void runSearch(initialQuery, mediaType)
  }, [open, item, runSearch])

  const handleSearch = async () => {
    if (!item) return
    const mediaType = item.media_type === "movie" ? "movie" : "tv"
    await runSearch(query, mediaType)
  }

  const handleSave = async () => {
    if (!item) {
      return
    }

    const matchInput = selectedId !== null ? selectedId.toString() : query.trim()
    if (!matchInput) {
      toast({ title: "Error", description: "Please select a match first", variant: "destructive" })
      return
    }

    setIsUpdating(true)
    try {
      const type = item.media_type === "movie" ? "movie" : "tv"
      await fixMatch(item.id, matchInput, type)

      toast({ title: "Success", description: "Metadata updated successfully" })
      onOpenChange(false)

      try {
        await Promise.resolve(onSuccess())
      } catch (refreshError) {
        console.error("Failed to refresh UI after match update", refreshError)
      }
    } catch (error) {
      console.error("Failed to fix match", error)
      const errorMessage = typeof error === "string"
        ? error
        : (error as { message?: string })?.message || "Failed to update metadata."

      toast({ title: "Error", description: errorMessage, variant: "destructive" })
    } finally {
      setIsUpdating(false)
    }
  }

  const selectedResult = useMemo(
    () => results.find((result) => result.id === selectedId) || null,
    [results, selectedId]
  )
  const canSave = Boolean(selectedResult || isDirectMatchInput)

  const expectedTypeLabel = item?.media_type === "movie" ? "movie" : "show"

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    void handleSearch()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Fix Match</DialogTitle>
          <DialogDescription>
            Search TMDB for this {expectedTypeLabel}, or paste a TMDB or IMDb URL or ID, and update its metadata automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 min-h-0 flex-1">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search by title, or paste TMDB/IMDb URL or ID..."
              disabled={isSearching || isUpdating}
            />
            <Button onClick={handleSearch} disabled={!query.trim() || isSearching || isUpdating}>
              {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </Button>
          </div>

          <div className="text-xs space-y-1">
            {query.trim() && !isSearching && !isDirectMatchInput && query.trim().length < 3 && (
              <p className="text-amber-400">Enter at least 3 characters for a valid search.</p>
            )}
            <p className="text-muted-foreground">
            {isSearching
              ? "Searching TMDB..."
              : isDirectMatchInput
                ? "Direct match input detected. Click Update Match to fetch metadata from that TMDB/IMDb link or ID."
              : `Found ${results.length} ${results.length === 1 ? "result" : "results"} for ${expectedTypeLabel}s`}
            </p>
          </div>

          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {!isSearching && results.length === 0 && !isDirectMatchInput && (
              <div className="rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
                No results found. Try adjusting the search title.
              </div>
            )}

            {results.map((result) => {
              const isSelected = selectedId === result.id
              const title = getResultTitle(result)
              const year = getResultYear(result)
              const posterUrl = result.poster_path ? `${TMDB_IMAGE_BASE}${result.poster_path}` : null

              return (
                <button
                  key={`${result.media_type}-${result.id}`}
                  type="button"
                  onClick={() => setSelectedId(result.id)}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    "hover:bg-muted/50",
                    isSelected ? "border-primary/70 bg-primary/10" : "border-border/60"
                  )}
                  disabled={isUpdating}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-[50px] h-[75px] rounded-md border border-border/60 overflow-hidden bg-muted/30 flex items-center justify-center shrink-0">
                      {posterUrl ? (
                        <img src={posterUrl} alt={title} className="w-full h-full object-cover" />
                      ) : result.media_type === "movie" ? (
                        <Film className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <Tv className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium line-clamp-1">{title}</div>
                          <div className="text-xs text-muted-foreground">
                            {result.media_type === "movie" ? "Movie" : "TV Show"}
                            {year ? ` • ${year}` : ""}
                          </div>
                        </div>

                        {typeof result.vote_average === "number" && result.vote_average > 0 && (
                          <div className="flex items-center gap-1 text-xs text-yellow-400 shrink-0">
                            <Star className="w-3.5 h-3.5 fill-yellow-400 text-yellow-400" />
                            {result.vote_average.toFixed(1)}
                          </div>
                        )}
                      </div>

                      {result.overview && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{result.overview}</p>
                      )}
                    </div>

                    {isSelected && (
                      <Check className="w-4 h-4 text-primary shrink-0 mt-1" />
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isUpdating}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isUpdating || !canSave}>
            {isUpdating ? "Updating..." : "Update Match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
