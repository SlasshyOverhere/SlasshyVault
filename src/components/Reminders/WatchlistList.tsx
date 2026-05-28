import { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Film, Tv, Clock, Bell, Edit2, Trash2, Loader2,
  X, Calendar, AlertTriangle, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WatchlistItem, deleteWatchlistItem, getTmdbImageUrl } from '@/services/api'
import { CountdownTimer } from './CountdownTimer'
import { formatLocalReleaseTime } from './CountdownTimer.utils'
import { cn } from '@/lib/utils'

interface WatchlistListProps {
  items: WatchlistItem[]
  onEdit: (item: WatchlistItem) => void
  onRefresh: () => void
  loading?: boolean
}

// ─── helpers ─────────────────────────────────────────────
const isOverdue = (n?: string | null) => n && new Date(n).getTime() < Date.now()

const getProgress = (created: string, notify: string) => {
  const c = new Date(created).getTime()
  const n = new Date(notify).getTime()
  const now = Date.now()
  if (now <= c) return 0
  if (now >= n) return 100
  return ((now - c) / (n - c)) * 100
}

const classify = (item: WatchlistItem) => {
  if (item.notification_enabled && item.notify_at) {
    return isOverdue(item.notify_at) ? 'overdue' as const : 'upcoming' as const
  }
  return 'saved' as const
}

// ─── filter tabs ─────────────────────────────────────────
type Filter = 'all' | 'upcoming' | 'overdue' | 'saved'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'saved', label: 'Saved' },
]

// ─── main component ──────────────────────────────────────
export function WatchlistList({ items, onEdit, onRefresh, loading = false }: WatchlistListProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [selected, setSelected] = useState<WatchlistItem | null>(null)

  const handleDelete = useCallback(async (id: number) => {
    setDeletingId(id)
    try {
      await deleteWatchlistItem(id)
      onRefresh()
      setSelected(null)
    } finally {
      setDeletingId(null)
    }
  }, [onRefresh])

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    return items.filter(i => classify(i) === filter)
  }, [items, filter])

  const selectedIdx = useMemo(
    () => (selected ? filtered.findIndex(i => i.id === selected.id) : -1),
    [filtered, selected],
  )

  const navSelected = useCallback((dir: 1 | -1) => {
    setSelected(prev => {
      if (!prev) return prev
      const idx = filtered.findIndex(i => i.id === prev.id)
      const next = idx + dir
      if (next < 0 || next >= filtered.length) return prev
      return filtered[next]
    })
  }, [filtered])

  // ── loading ────────────────────────────────────────────
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-5 pb-6">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="space-y-3 animate-pulse">
            <div className="aspect-[2/3] rounded-3xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
              <div className="w-full h-full skeleton-shimmer" />
            </div>
            <div className="space-y-2 px-1">
              <div className="size-4/5 rounded-lg bg-white/10" />
              <div className="h-3 w-1/2 rounded-lg bg-white/10" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── empty ──────────────────────────────────────────────
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center space-y-6 max-w-xs"
        >
          <div className="relative mx-auto size-28">
            <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-br from-white/[0.06] to-transparent blur-3xl" />
            <div className="relative size-28 rounded-[2rem] border border-white/[0.06] bg-white/[0.02] flex items-center justify-center">
              <Film className="size-12 text-white/15" />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xl font-black text-white tracking-tight">Nothing here yet</p>
            <p className="text-sm text-white/30 font-medium leading-relaxed">
              Discover something worth watching and save it for later.
            </p>
          </div>
        </motion.div>
      </div>
    )
  }

  // ── render ─────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col min-h-0">
      {/* filter bar */}
      <div className="shrink-0 flex items-center gap-1.5 pb-6 overflow-x-auto no-scrollbar">
        {FILTERS.map(f => (
          <button
            type="button"
            key={f.key}
            data-active={filter === f.key}
            onClick={() => { setFilter(f.key); setSelected(null) }}
            className={cn(
              'relative h-9 px-4 rounded-2xl border border-white/[0.06] text-[11px] font-black uppercase tracking-[0.18em] transition-all duration-300 shrink-0',
              filter === f.key
                ? 'bg-white text-black border-white shadow-glow-sm'
                : 'bg-white/[0.02] text-white/30 hover:text-white/60 hover:border-white/15',
            )}
          >
            {f.key === filter && (
              <motion.div
                layoutId="watchlist-filter"
                className="absolute inset-0 rounded-2xl bg-white"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              {f.label}
              {f.key !== 'all' && (
                <span className={cn(
                  'text-[9px] font-bold tabular-nums',
                  filter === f.key ? 'text-black/40' : 'text-white/15',
                )}>
                  {items.filter(i => f.key === 'all' || classify(i) === f.key).length}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* poster grid */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-2">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-5 pb-8">
          <AnimatePresence mode="popLayout">
            {filtered.map((item, i) => (
              <PosterCard
                key={item.id}
                item={item}
                index={i}
                isDeleting={deletingId === item.id}
                onSelect={() => setSelected(item)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* detail modal */}
      <AnimatePresence>
        {selected && (
          <DetailModal
            item={selected}
            onClose={() => setSelected(null)}
            onEdit={() => { onEdit(selected); setSelected(null) }}
            onDelete={() => handleDelete(selected.id)}
            isDeleting={deletingId === selected.id}
            hasPrev={selectedIdx > 0}
            hasNext={selectedIdx < filtered.length - 1}
            onPrev={() => navSelected(-1)}
            onNext={() => navSelected(1)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── poster card ─────────────────────────────────────────
function PosterCard({ item, index, isDeleting, onSelect }: {
  item: WatchlistItem
  index: number
  isDeleting: boolean
  onSelect: () => void
}) {
  const posterUrl = item.poster_path ? getTmdbImageUrl(item.poster_path, 'w300') : null
  const cat = classify(item)

  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: -10 }}
      transition={{ delay: index * 0.035, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      onClick={onSelect}
      className={cn(
        'group relative text-left w-full focus:outline-none',
        isDeleting && 'opacity-0 scale-90 transition-all duration-300 pointer-events-none',
      )}
    >
      {/* poster */}
      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-black/50 border border-white/[0.06] shadow-elevation-1 transition-all duration-500 group-hover:shadow-glow-sm group-hover:border-white/20 group-hover:scale-[1.02]">
        {posterUrl ? (
          <img
            src={posterUrl}
            alt={item.title}
            className="w-full h-full object-cover transition-all duration-700 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {item.media_type === 'movie'
              ? <Film className="size-10 text-white/10" />
              : <Tv className="size-10 text-white/10" />
            }
          </div>
        )}

        {/* status indicator dot */}
        <div className="absolute top-3 right-3 z-10">
          <div className={cn(
            'size-2.5 rounded-full border border-black/30 shadow-lg',
            cat === 'upcoming' ? 'bg-sky-400' :
            cat === 'overdue' ? 'bg-amber-400' :
            'bg-white/20',
          )} />
        </div>

        {/* hover overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-400">
          <div className="absolute bottom-0 left-0 right-0 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/15 backdrop-blur-md text-[8px] font-black uppercase tracking-widest text-white/80">
                {item.media_type === 'movie' ? <Film className="size-2.5" /> : <Tv className="size-2.5" />}
                {item.media_type}
              </span>
              {item.notification_enabled && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/15 backdrop-blur-md text-[8px] font-black uppercase tracking-widest text-white/80">
                  <Bell className="size-2.5" />
                  {item.notification_mode === 'spam' ? 'Spam' : 'Reminder'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* category accent bar at bottom */}
        <div className={cn(
          'absolute bottom-0 left-0 right-0 h-[3px]',
          cat === 'upcoming' ? 'bg-sky-400/60' :
          cat === 'overdue' ? 'bg-amber-400/60' :
          'bg-white/5',
        )} />
      </div>

      {/* label below poster */}
      <div className="mt-3 px-0.5 space-y-0.5">
        <p className="text-sm font-black text-white/90 leading-tight truncate tracking-tight">
          {item.title}
        </p>
        {item.notes ? (
          <p className="text-[11px] text-white/25 font-medium truncate">{item.notes}</p>
        ) : (
          <p className="text-[11px] text-white/10 font-medium truncate">&mdash;</p>
        )}
      </div>
    </motion.button>
  )
}

// ─── detail modal ────────────────────────────────────────
function DetailModal({ item, onClose, onEdit, onDelete, isDeleting, hasPrev, hasNext, onPrev, onNext }: {
  item: WatchlistItem
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  isDeleting: boolean
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
}) {
  const posterUrl = item.poster_path ? getTmdbImageUrl(item.poster_path, 'w500') : null
  const isSpam = item.notification_enabled && item.notification_mode === 'spam'
  const overdue = isOverdue(item.notify_at)
  const progress = item.notification_enabled && item.notify_at && item.created_at
    ? getProgress(item.created_at, item.notify_at) : 0

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8"
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-xl" role="button" tabIndex={-1} onClick={onClose} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose() }} />

      {/* card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.92, y: 30 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-2xl rounded-[2.5rem] border border-white/[0.08] bg-[#0a0a0a] overflow-hidden shadow-2xl"
      >
        {/* poster backdrop */}
        {posterUrl && (
          <div className="absolute inset-0 pointer-events-none">
            <div
              className="absolute inset-0 opacity-25 blur-3xl scale-110"
              style={{ backgroundImage: `url(${posterUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-[#0a0a0a]/60 to-[#0a0a0a]" />
          </div>
        )}

        {/* close + nav */}
        <div className="relative z-20 flex items-center justify-between p-5 pb-0">
          <div className="flex items-center gap-2">
            {hasPrev && (
              <button type="button" onClick={onPrev} className="size-9 rounded-xl border border-white/[0.06] bg-white/[0.03] flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-all">
                <ChevronLeft className="size-4" />
              </button>
            )}
            {hasNext && (
              <button type="button" onClick={onNext} className="size-9 rounded-xl border border-white/[0.06] bg-white/[0.03] flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-all">
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
          <button type="button" onClick={onClose} className="size-9 rounded-xl border border-white/[0.06] bg-white/[0.03] flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-all">
            <X className="size-4" />
          </button>
        </div>

        {/* body */}
        <div className="relative z-10 p-5 md:p-8 pt-4 md:pt-6 flex flex-col md:flex-row gap-6 md:gap-8">
          {/* poster */}
          <div className="shrink-0 w-full md:w-56 aspect-[2/3] rounded-2xl overflow-hidden bg-black/60 border border-white/10 shadow-elevation-1 mx-auto md:mx-0 max-w-[200px] md:max-w-none">
            {posterUrl ? (
              <img src={posterUrl} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white/10">
                {item.media_type === 'movie' ? <Film className="size-12" /> : <Tv className="size-12" />}
              </div>
            )}
          </div>

          {/* info */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* title + badges */}
            <div className="space-y-3">
              <h2 className="text-2xl md:text-3xl font-black text-white leading-tight tracking-tight">
                {item.title}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-white/40">
                  {item.media_type === 'movie' ? <Film className="size-3" /> : <Tv className="size-3" />}
                  {item.media_type}
                </span>
                <span className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest',
                  overdue
                    ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                    : item.notification_enabled
                      ? 'border-sky-500/20 bg-sky-500/10 text-sky-400'
                      : 'border-white/[0.04] bg-white/[0.02] text-white/20',
                )}>
                  <Bell className="size-3" />
                  {!item.notification_enabled ? 'No reminder' : isSpam ? 'Spam reminder' : 'Reminder set'}
                </span>
              </div>
            </div>

            {/* notes */}
            {item.notes && (
              <p className="text-sm text-white/40 leading-relaxed font-medium">
                {item.notes}
              </p>
            )}

            {/* notification section */}
            {item.notification_enabled && item.notify_at ? (
              <div className="space-y-4 rounded-2xl border border-white/[0.06] bg-black/40 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 text-sm font-bold text-white/60">
                    <Calendar className="size-4 opacity-40" />
                    <span className="truncate">{formatLocalReleaseTime(item.notify_at)}</span>
                  </div>
                  <CountdownTimer target={item.notify_at} compact />
                </div>

                {!overdue && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-bold text-white/20 uppercase tracking-widest">
                      <span>Time progress</span>
                      <span>{Math.round(Math.min(progress, 100))}%</span>
                    </div>
                    <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(progress, 100)}%` }}
                        transition={{ duration: 1, ease: 'easeOut' }}
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-white/30 to-white/60"
                      />
                    </div>
                  </div>
                )}

                {overdue && (
                  <div className="flex items-center gap-2 text-[11px] font-bold text-amber-400/70">
                    <AlertTriangle className="size-3.5" />
                    This reminder has passed. Edit to reschedule or disable.
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.04] bg-black/20 p-4">
                <div className="flex items-center gap-2 text-sm text-white/20 font-bold">
                  <Clock className="size-4" />
                  No reminder scheduled
                </div>
              </div>
            )}

            {/* actions */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={onEdit}
                className="flex-1 h-12 rounded-2xl bg-white text-black hover:bg-white/90 font-black text-xs uppercase tracking-[0.2em]"
              >
                <Edit2 className="size-4 mr-2" />
                Edit
              </Button>
              <Button
                onClick={onDelete}
                disabled={isDeleting}
                variant="ghost"
                className="flex-1 h-12 rounded-2xl border border-white/[0.08] text-white/40 hover:text-red-400 hover:border-red-400/30 hover:bg-red-400/10 font-black text-xs uppercase tracking-[0.2em]"
              >
                {isDeleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
                {isDeleting ? 'Deleting' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
