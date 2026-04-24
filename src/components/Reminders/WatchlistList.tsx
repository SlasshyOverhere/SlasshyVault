import { Bell, Clock3, Edit2, Film, Loader2, Tv, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CountdownTimer, formatLocalReleaseTime } from './CountdownTimer'
import { WatchlistItem, deleteWatchlistItem, getTmdbImageUrl } from '@/services/api'
import { cn } from '@/lib/utils'
import { useState } from 'react'

interface WatchlistListProps {
  items: WatchlistItem[]
  onEdit: (item: WatchlistItem) => void
  onRefresh: () => void
}

export function WatchlistList({ items, onEdit, onRefresh }: WatchlistListProps) {
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteWatchlistItem(id)
      onRefresh()
    } finally {
      setDeletingId(null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <div className="space-y-3 max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto">
            <Bell className="w-8 h-8 text-white/30" />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight">Your Watchlist is empty</h2>
          <p className="text-sm text-white/40 leading-relaxed font-medium">
            Use Discover to pin movies or shows here, then add single or spam reminders when you want a nudge.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full pr-3">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 pb-6">
        {items.map((item) => {
          const isSpam = item.notification_enabled && item.notification_mode === 'spam'
          const isDeleting = deletingId === item.id
          return (
            <div
              key={item.id}
              className={cn(
                'group relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4',
                !item.is_active && 'opacity-50 grayscale-[0.4]'
              )}
            >
              <div className="flex gap-4">
                <div className="shrink-0 w-20 aspect-[2/3] rounded-2xl overflow-hidden bg-black/40 border border-white/10">
                  {item.poster_path ? (
                    <img src={getTmdbImageUrl(item.poster_path, 'w185') || ''} alt={item.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/10">
                      {item.media_type === 'movie' ? <Film className="w-6 h-6" /> : <Tv className="w-6 h-6" />}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-[15px] font-black text-white">{item.title}</h3>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className="rounded-md bg-white/[0.04] px-2 py-1 text-[8px] font-black uppercase tracking-widest text-white/35">
                          {item.media_type}
                        </span>
                        {item.notification_enabled && (
                          <span className="rounded-md border border-white/[0.08] bg-white/[0.025] px-2 py-1 text-[8px] font-black uppercase tracking-widest text-white/60">
                            {isSpam ? 'Spam Reminder' : 'Single Reminder'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-white/30 hover:text-white hover:bg-white/10" onClick={() => onEdit(item)}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-400/10" onClick={() => handleDelete(item.id)} disabled={isDeleting}>
                        {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>

                  {item.notes && (
                    <p className="text-[12px] text-white/40 leading-relaxed line-clamp-2">{item.notes}</p>
                  )}

                  <div className="flex flex-col gap-2">
                    {item.notify_at && item.notification_enabled ? (
                      <>
                        <div className="flex items-center gap-2 text-[10px] font-bold text-white/55 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
                          <Clock3 className="w-3.5 h-3.5 opacity-40" />
                          <span className="truncate">{formatLocalReleaseTime(item.notify_at)}</span>
                        </div>
                        <CountdownTimer target={item.notify_at} compact className="justify-start" />
                      </>
                    ) : (
                      <div className="text-[10px] font-bold uppercase tracking-widest text-white/25">
                        Notifications disabled
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
