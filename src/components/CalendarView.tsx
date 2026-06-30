import { useState, useEffect, useMemo, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ChevronLeft, ChevronRight, Clock, Bell, ListChecks, Play } from "lucide-react"
import {
  getMovieReminders,
  getWatchlistItems,
  getWatchHistoryEvents,
  MovieReminder,
  WatchlistItem,
  WatchHistoryEvent,
} from "@/services/api"

interface CalendarEvent {
  date: string // YYYY-MM-DD
  type: "activity" | "reminder" | "watchlist"
  title: string
  id: number | string
  mediaId?: number | null
  detail?: string
}

const DOT_COLORS: Record<CalendarEvent["type"], string> = {
  activity: "bg-sky-400",
  reminder: "bg-amber-400",
  watchlist: "bg-emerald-400",
}

const BADGE_STYLES: Record<CalendarEvent["type"], string> = {
  activity: "bg-sky-500/15 text-sky-300 border-sky-500/25",
  reminder: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  watchlist: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
}

const BADGE_LABELS: Record<CalendarEvent["type"], string> = {
  activity: "Watched",
  reminder: "Reminder",
  watchlist: "Releasing",
}

const toDateString = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const getMonthDays = (year: number, month: number) => {
  const firstDay = new Date(year, month, 1)
  const startWeekday = firstDay.getDay() // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days: { date: Date; dayNum: number; isCurrentMonth: boolean }[] = []

  // Previous month padding
  const prevMonthDays = new Date(year, month, 0).getDate()
  for (let i = startWeekday - 1; i >= 0; i--) {
    days.push({ date: new Date(year, month - 1, prevMonthDays - i), dayNum: prevMonthDays - i, isCurrentMonth: false })
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ date: new Date(year, month, d), dayNum: d, isCurrentMonth: true })
  }
  // Next month padding
  const remaining = 42 - days.length // always 6 rows
  for (let d = 1; d <= remaining; d++) {
    days.push({ date: new Date(year, month + 1, d), dayNum: d, isCurrentMonth: false })
  }
  return days
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function CalendarView() {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(toDateString(today))
  const [reminders, setReminders] = useState<MovieReminder[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [historyEvents, setHistoryEvents] = useState<WatchHistoryEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [r, w, h] = await Promise.all([
          getMovieReminders(),
          getWatchlistItems(),
          getWatchHistoryEvents(),
        ])
        if (cancelled) return
        setReminders(r)
        setWatchlist(w)
        setHistoryEvents(h)
      } catch (e) {
        console.error("[Calendar] Failed to load data:", e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const events = useMemo((): CalendarEvent[] => {
    const evts: CalendarEvent[] = []

    for (const r of reminders) {
      if (!r.reminder_at) continue
      const d = toDateString(new Date(r.reminder_at))
      evts.push({ date: d, type: "reminder", title: r.title, id: r.id, detail: r.notes ?? undefined })
    }

    for (const w of watchlist) {
      if (!w.release_date) continue
      const d = toDateString(new Date(w.release_date))
      evts.push({ date: d, type: "watchlist", title: w.title, id: w.id, detail: w.media_type === "tv" ? "TV Show" : "Movie" })
    }

    for (const h of historyEvents) {
      const d = toDateString(new Date(h.started_at))
      evts.push({ date: d, type: "activity", title: h.title, id: h.event_id, mediaId: h.media_id, detail: h.media_type === "tvepisode" && h.season_number ? `S${String(h.season_number).padStart(2, "0")}E${String(h.episode_number).padStart(2, "0")}` : undefined })
    }

    return evts
  }, [reminders, watchlist, historyEvents])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      const arr = map.get(e.date) ?? []
      arr.push(e)
      map.set(e.date, arr)
    }
    return map
  }, [events])

  const days = useMemo(() => getMonthDays(year, month), [year, month])
  const monthLabel = new Date(year, month).toLocaleString(undefined, { month: "long", year: "numeric" })

  const goPrev = useCallback(() => {
    setSelectedDate(null)
    if (month === 0) { setMonth(11); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }, [month])

  const goNext = useCallback(() => {
    setSelectedDate(null)
    if (month === 11) { setMonth(0); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }, [month])

  const goToday = useCallback(() => {
    const now = new Date()
    setYear(now.getFullYear())
    setMonth(now.getMonth())
    setSelectedDate(toDateString(now))
  }, [])

  const selectedEvents = selectedDate ? (eventsByDate.get(selectedDate) ?? []) : []

  return (
    <div className="h-full flex flex-col px-6 pt-14 pb-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Calendar</h1>
          <p className="text-xs text-muted-foreground mt-1">Your media schedule at a glance</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goToday} className="px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-300 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">Today</button>
          <button onClick={goPrev} className="p-2 rounded-lg text-neutral-400 bg-white/5 border border-white/10 hover:bg-white/10 hover:text-white transition-colors"><ChevronLeft className="size-4" /></button>
          <span className="text-sm font-semibold text-white min-w-[140px] text-center">{monthLabel}</span>
          <button onClick={goNext} className="p-2 rounded-lg text-neutral-400 bg-white/5 border border-white/10 hover:bg-white/10 hover:text-white transition-colors"><ChevronRight className="size-4" /></button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-4 flex-shrink-0">
        {(["activity", "reminder", "watchlist"] as const).map(t => (
          <div key={t} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${DOT_COLORS[t]}`} />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">{BADGE_LABELS[t]}</span>
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAY_LABELS.map(d => (
            <div key={d} className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-widest py-2">{d}</div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 grid-rows-6 flex-1 gap-px bg-white/[0.03] rounded-xl overflow-hidden border border-white/[0.06]">
          {days.map((day, i) => {
            const key = toDateString(day.date)
            const dayEvents = eventsByDate.get(key) ?? []
            const isToday = key === toDateString(today)
            const isSelected = key === selectedDate
            const hasEvents = dayEvents.length > 0

            return (
              <button
                key={i}
                onClick={() => setSelectedDate(isSelected ? null : key)}
                className={`
                  relative flex flex-col items-center justify-start pt-2 min-h-[72px] transition-all duration-150
                  ${day.isCurrentMonth ? "bg-[#111]" : "bg-[#0a0a0a]"}
                  ${isSelected ? "ring-1 ring-white/40 bg-white/[0.06] z-10" : "hover:bg-white/[0.04]"}
                  ${isToday && !isSelected ? "ring-1 ring-white/20" : ""}
                `}
              >
                <span className={`
                  text-xs font-semibold leading-none
                  ${isSelected ? "text-white" : isToday ? "text-white" : day.isCurrentMonth ? "text-neutral-400" : "text-neutral-700"}
                  ${isToday ? "bg-white/10 rounded-full size-6 flex items-center justify-center" : ""}
                `}>
                  {day.dayNum}
                </span>

                {/* Event dots */}
                {hasEvents && (
                  <div className="flex items-center gap-0.5 mt-1.5 flex-wrap justify-center max-w-full px-1">
                    {[...new Set(dayEvents.map(e => e.type))].slice(0, 3).map(t => (
                      <span key={t} className={`size-1.5 rounded-full ${DOT_COLORS[t]}`} />
                    ))}
                    {dayEvents.length > 3 && (
                      <span className="text-[8px] text-muted-foreground ml-0.5">+{dayEvents.length}</span>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Detail Panel */}
      <AnimatePresence>
        {selectedDate && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden flex-shrink-0"
          >
            <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white">
                  {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                </h3>
                <span className="text-[10px] text-muted-foreground">{selectedEvents.length} event{selectedEvents.length !== 1 ? "s" : ""}</span>
              </div>

              {selectedEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No events on this day</p>
              ) : (
                <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                  {selectedEvents.map((evt, idx) => (
                    <div key={`${evt.type}-${evt.id}-${idx}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06] transition-colors group">
                      <div className="flex-shrink-0">
                        {evt.type === "activity" && <Clock className="size-3.5 text-sky-400" />}
                        {evt.type === "reminder" && <Bell className="size-3.5 text-amber-400" />}
                        {evt.type === "watchlist" && <ListChecks className="size-3.5 text-emerald-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-white truncate">{evt.title}</p>
                        {evt.detail && <p className="text-[10px] text-muted-foreground truncate">{evt.detail}</p>}
                      </div>
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${BADGE_STYLES[evt.type]}`}>
                        {BADGE_LABELS[evt.type]}
                      </span>
                      {evt.type === "activity" && evt.mediaId && (
                        <button className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 transition-all">
                          <Play className="size-3 text-white" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading state */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-20">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="size-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            Loading calendar data...
          </div>
        </div>
      )}
    </div>
  )
}
