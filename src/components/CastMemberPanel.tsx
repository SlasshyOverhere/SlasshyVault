import { useState, useEffect } from "react"
import { Loader2, User, Film, Tv, Play } from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { searchMediaByCast, type MediaItem } from "@/services/api"

interface CastMemberPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  castName: string
  onItemClick: (item: MediaItem) => void
}

export function CastMemberPanel({ open, onOpenChange, castName, onItemClick }: CastMemberPanelProps) {
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !castName) {
      setItems([])
      return
    }

    setLoading(true)
    searchMediaByCast(castName).then(results => {
      setItems(results)
    }).finally(() => setLoading(false))
  }, [open, castName])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-[#090a0d] border-white/10 rounded-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">{castName}</DialogTitle>
        <DialogDescription className="sr-only">Library items featuring {castName}</DialogDescription>

        <ScrollArea className="max-h-[70vh]">
          <div className="p-5 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-full bg-white/10 flex items-center justify-center">
                <User className="size-5 text-white/60" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">{castName}</h3>
                <p className="text-xs text-white/40">
                  {loading ? "Searching..." : `${items.length} item${items.length !== 1 ? "s" : ""} in your library`}
                </p>
              </div>
            </div>

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-8 animate-spin text-white/40" />
              </div>
            )}

            {/* Empty */}
            {!loading && items.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Film className="size-10 text-white/20" />
                <p className="text-white/40 text-sm">No library items found for {castName}</p>
              </div>
            )}

            {/* Results */}
            {!loading && items.map(item => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  onOpenChange(false)
                  onItemClick(item)
                }}
                className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/10 transition-all duration-200 cursor-pointer text-left"
              >
                <div className="size-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                  {item.media_type === "movie" ? (
                    <Film className="size-4 text-white/40" />
                  ) : (
                    <Tv className="size-4 text-white/40" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{item.title}</p>
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest">
                    {item.media_type === "movie" ? "Movie" : "TV Series"} {item.year ? `· ${item.year}` : ""}
                  </p>
                </div>
                <Play className="size-4 text-white/30 shrink-0" />
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
