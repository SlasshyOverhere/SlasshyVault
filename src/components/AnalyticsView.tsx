import { useMemo, useState, useEffect } from "react"
import { LazyMotion, m, domAnimation } from "framer-motion"
import { Activity } from "lucide-react"
import type { AnalyticsData, HeatmapDay } from "@/services/api"
import { getCachedImageUrl } from "@/services/api"

// ==================== HELPERS ====================

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m"
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getHeatmapIntensity(seconds: number, maxSeconds: number): number {
  if (seconds <= 0 || maxSeconds <= 0) return 0
  const ratio = seconds / maxSeconds
  if (ratio < 0.15) return 1
  if (ratio < 0.35) return 2
  if (ratio < 0.6) return 3
  return 4
}

function getIntensityClass(level: number): string {
  switch (level) {
    case 0: return "bg-white/[0.03]"
    case 1: return "bg-white/15"
    case 2: return "bg-white/30"
    case 3: return "bg-white/55"
    case 4: return "bg-white/80"
    default: return "bg-white/[0.03]"
  }
}

// ==================== DIVIDER ====================

function Divider() {
  return <div className="my-8 h-px bg-white/[0.06]" />
}

// ==================== SECTION TITLE ====================

function SectionLabel({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold tracking-tight text-white">{title}</h3>
      {subtitle && <p className="text-xs text-white/35 mt-0.5">{subtitle}</p>}
    </div>
  )
}

// ==================== HEATMAP CALENDAR ====================

function HeatmapCalendar({ data }: { data: HeatmapDay[] }) {
  const [hoveredDay, setHoveredDay] = useState<HeatmapDay | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  const { weeks, maxSeconds } = useMemo(() => {
    const dateMap = new Map<string, HeatmapDay>()
    let max = 0
    for (const d of data) {
      dateMap.set(d.date, d)
      if (d.watch_seconds > max) max = d.watch_seconds
    }

    const today = new Date()
    const endDate = new Date(today)
    const startDate = new Date(today)
    startDate.setDate(startDate.getDate() - 363)
    startDate.setDate(startDate.getDate() - startDate.getDay())

    const weeksArr: { date: Date; day: HeatmapDay | null }[][] = []
    const current = new Date(startDate)
    while (current <= endDate) {
      const week: { date: Date; day: HeatmapDay | null }[] = []
      for (let i = 0; i < 7; i++) {
        const dateStr = current.toISOString().split("T")[0]
        week.push({ date: new Date(current), day: dateMap.get(dateStr) || null })
        current.setDate(current.getDate() + 1)
      }
      weeksArr.push(week)
    }
    return { weeks: weeksArr, maxSeconds: max }
  }, [data])

  return (
    <div className="relative flex flex-col items-center">
      <div className="flex gap-[3px] justify-center">
        {weeks.map((week) => (
          <div key={week[0]!.date.toISOString()} className="flex flex-col gap-[3px]">
            {week.map((day) => {
              const level = day.day ? getHeatmapIntensity(day.day.watch_seconds, maxSeconds) : 0
              return (
                <div
                  key={day.date.toISOString()}
                  className={`h-[12px] w-[12px] rounded-[3px] transition-colors cursor-pointer ${getIntensityClass(level)} hover:ring-1 hover:ring-white/30`}
                  onMouseEnter={(e) => {
                    setHoveredDay(day.day)
                    setTooltipPos({ x: e.clientX, y: e.clientY })
                  }}
                  onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHoveredDay(null)}
                />
              )
            })}
          </div>
        ))}
      </div>
      {hoveredDay && (
        <div
          className="fixed z-50 rounded-lg border border-white/10 bg-[#1a1a1a] px-3 py-2 text-xs shadow-xl pointer-events-none"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 40 }}
        >
          <div className="text-white font-medium">{new Date(hoveredDay.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          <div className="text-white/50">{formatDuration(hoveredDay.watch_seconds)} watched &middot; {hoveredDay.event_count} event{hoveredDay.event_count !== 1 ? "s" : ""}</div>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1.5 text-[10px] text-white/25">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <div key={l} className={`h-[12px] w-[12px] rounded-[3px] ${getIntensityClass(l)}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}

// ==================== SVG AREA CHART ====================

const CHART_PADDING = { top: 10, right: 10, bottom: 30, left: 45 }

function AreaChart({ data }: { data: { date: string; value: number }[] }) {
  if (data.length === 0) {
    return <div className="flex h-48 items-center justify-center text-sm text-white/30">No data yet</div>
  }

  const width = 800
  const height = 200
  const chartW = width - CHART_PADDING.left - CHART_PADDING.right
  const chartH = height - CHART_PADDING.top - CHART_PADDING.bottom

  const maxVal = Math.max(...data.map((d) => d.value), 1)
  const xStep = chartW / Math.max(data.length - 1, 1)

  const points = data.map((d, i) => ({
    x: CHART_PADDING.left + i * xStep,
    y: CHART_PADDING.top + chartH - (d.value / maxVal) * chartH,
  }))

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${CHART_PADDING.top + chartH} L ${points[0].x} ${CHART_PADDING.top + chartH} Z`

  const labelInterval = Math.max(Math.floor(data.length / 8), 1)
  const xLabels = data.reduce<{ x: number; label: string }[]>((acc, d, i) => {
    if (i % labelInterval === 0 || i === data.length - 1) {
      acc.push({
        x: CHART_PADDING.left + i * xStep,
        label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      })
    }
    return acc
  }, [])

  const ySteps = 4
  const yLabels = Array.from({ length: ySteps + 1 }, (_, i) => {
    const val = (maxVal / ySteps) * i
    return { y: CHART_PADDING.top + chartH - (val / maxVal) * chartH, label: formatDuration(val) }
  })

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.12" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yLabels.map((yl) => (
        <g key={yl.label}>
          <line x1={CHART_PADDING.left} y1={yl.y} x2={width - CHART_PADDING.right} y2={yl.y} stroke="white" strokeOpacity="0.05" />
          <text x={CHART_PADDING.left - 6} y={yl.y + 3} textAnchor="end" fill="white" fillOpacity="0.25" fontSize="9" fontFamily="inherit">{yl.label}</text>
        </g>
      ))}
      <path d={areaPath} fill="url(#areaGrad)" />
      <path d={linePath} fill="none" stroke="white" strokeWidth="1.5" strokeOpacity="0.5" />
      {xLabels.map((xl) => (
        <text key={xl.label} x={xl.x} y={height - 6} textAnchor="middle" fill="white" fillOpacity="0.25" fontSize="9" fontFamily="inherit">{xl.label}</text>
      ))}
    </svg>
  )
}

// ==================== DISTRIBUTION GRID ====================

function DistributionGrid({ items, maxVal }: { items: { label: string; value: number }[]; maxVal: number }) {
  return (
    <div className="flex flex-wrap gap-[3px]">
      {items.map((item, i) => {
        const level = maxVal > 0 ? getHeatmapIntensity(item.value, maxVal) : 0
        return (
          <div key={`${item.label}-${i}`} className="group relative">
            <div className={`size-7 rounded-[6px] flex items-center justify-center text-[10px] font-medium ${getIntensityClass(level)} ${level >= 3 ? "text-black" : "text-white/40"}`}>
              {item.label}
            </div>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 rounded-md border border-white/10 bg-[#1a1a1a] px-2 py-1 text-[10px] text-white whitespace-nowrap shadow-lg">
              {item.value} events
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== POSTER THUMBNAIL ====================

function PosterThumb({ path, title }: { path?: string | null; title: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (path) {
      const filename = path.replace("image_cache/", "")
      getCachedImageUrl(filename).then(setImgUrl)
    }
  }, [path])

  if (!imgUrl) {
    return (
      <div className="h-10 w-7 rounded bg-white/[0.04] flex items-center justify-center text-[10px] text-white/25 shrink-0">{title.charAt(0)}</div>
    )
  }

  return <img src={imgUrl} alt={title} className="h-10 w-7 rounded object-cover shrink-0" />
}

// ==================== MAIN COMPONENT ====================

interface AnalyticsViewProps {
  data: AnalyticsData
}

export function AnalyticsView({ data }: AnalyticsViewProps) {
  const [trendMode, setTrendMode] = useState<"all" | "movies" | "episodes">("all")

  const trendData = useMemo(() => {
    return data.daily_trend.map((d) => ({
      date: d.date,
      value: trendMode === "movies" ? d.movie_count * 1800 : trendMode === "episodes" ? d.episode_count * 1800 : d.watch_seconds,
    }))
  }, [data.daily_trend, trendMode])

  const hourItems = useMemo(() => {
    const map = new Map<number, number>()
    for (const h of data.hour_distribution) map.set(h.hour, h.event_count)
    return Array.from({ length: 24 }, (_, i) => ({
      label: i.toString().padStart(2, "0"),
      value: map.get(i) || 0,
    }))
  }, [data.hour_distribution])

  const dayItems = useMemo(() => {
    const map = new Map<number, number>()
    for (const d of data.day_distribution) map.set(d.day_of_week, d.event_count)
    return Array.from({ length: 7 }, (_, i) => ({
      label: DAY_LABELS[i].charAt(0),
      value: map.get(i) || 0,
    }))
  }, [data.day_distribution])

  const maxHourVal = Math.max(...hourItems.map((h) => h.value), 0)
  const maxDayVal = Math.max(...dayItems.map((d) => d.value), 0)

  const hasData = data.overview.total_events > 0

  if (!hasData) {
    return (
      <LazyMotion features={domAnimation}>
        <div className="px-6 py-16 text-center">
          <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Activity className="size-8 text-white/20 mx-auto mb-3" />
            <h3 className="text-base font-medium text-white/60 mb-1">No activity yet</h3>
            <p className="text-sm text-white/30">Start watching something to see your analytics</p>
          </m.div>
        </div>
      </LazyMotion>
    )
  }

  return (
    <LazyMotion features={domAnimation}>
      <div className="pb-8 px-6">
        <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>

        {/* Stats */}
        <div className="flex items-baseline gap-6 flex-wrap mb-8">
          {[
            { label: "Watch Time", value: formatDuration(data.overview.total_watch_time_seconds) },
            { label: "Movies", value: String(data.overview.movies_completed) },
            { label: "Episodes", value: String(data.overview.episodes_completed) },
            { label: "Streak", value: `${data.overview.current_streak_days}d` },
            { label: "Completion", value: `${Math.round(data.overview.total_completion_rate)}%` },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-white/30 mb-1">{s.label}</div>
              <div className="text-3xl font-bold tracking-tight text-white">{s.value}</div>
            </div>
          ))}
        </div>

        {/* Activity */}
        <SectionLabel title="Activity" subtitle="Last 365 days" />
        <HeatmapCalendar data={data.heatmap} />

        <Divider />

        {/* Trend */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-white">Watch Trend</h3>
            <p className="text-xs text-white/35 mt-0.5">Last 90 days</p>
          </div>
          <div className="flex gap-1">
            {(["all", "movies", "episodes"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                onClick={() => setTrendMode(mode)}
                className={`px-2.5 py-1 rounded-full text-xs transition-all ${trendMode === mode ? "bg-white text-black font-medium" : "text-white/35 hover:text-white/60"}`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <AreaChart data={trendData} />

        <Divider />

        {/* Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <SectionLabel title="By Type" />
            <div className="space-y-2.5">
              {(() => {
                const maxCount = Math.max(...data.content_breakdown.map((x) => x.count), 1)
                return data.content_breakdown.map((b) => {
                  const label = b.content_type === "movie" ? "Movies" : b.content_type === "tvepisode" ? "Episodes" : b.content_type
                  const pct = (b.count / maxCount) * 100
                  return (
                    <div key={b.content_type}>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-xs text-white/60">{label}</span>
                      <span className="text-[10px] text-white/30">{b.count} &middot; {formatDuration(b.total_seconds)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                      <m.div className="h-full rounded-full bg-white/30" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
                    </div>
                  </div>
                )
              })
              })()}
            </div>

            <div className="mt-6">
              <SectionLabel title="By Source" />
              <div className="space-y-2.5">
                {(() => {
                  const maxCount = Math.max(...data.source_breakdown.map((x) => x.count), 1)
                  return data.source_breakdown.map((b) => {
                    const label = b.source === "cloud" ? "Cloud" : "Local"
                    const pct = (b.count / maxCount) * 100
                    return (
                      <div key={b.source}>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs text-white/60">{label}</span>
                        <span className="text-[10px] text-white/30">{b.count} &middot; {formatDuration(b.total_seconds)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                        <m.div className="h-full rounded-full bg-white/30" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
                      </div>
                    </div>
                  )
              })
              })()}
              </div>
            </div>
          </div>

          {/* Most Watched */}
          <div>
            <SectionLabel title="Most Watched" subtitle="Top 10" />
            <div className="space-y-1">
              {data.top_watched.map((item, i) => (
                <div key={item.title} className="flex items-center gap-3 py-2">
                  <span className="w-4 text-[10px] text-white/20 text-right shrink-0">{i + 1}</span>
                  <PosterThumb path={item.poster_path} title={item.title} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{item.title}</div>
                    <div className="text-[10px] text-white/30">
                      {item.media_type === "tvshow" ? `${item.watch_count} eps` : `${item.watch_count}x`} &middot; {formatDuration(item.total_seconds)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Divider />

        {/* Habits */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <SectionLabel title="Watch Habits" subtitle="When you watch most" />
            <div className="mb-4">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-white/25 mb-2">Hour of Day</p>
              <DistributionGrid items={hourItems} maxVal={maxHourVal} />
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-white/25 mb-2">Day of Week</p>
              <DistributionGrid items={dayItems} maxVal={maxDayVal} />
            </div>
          </div>

          {/* Completion */}
          <div>
            <SectionLabel title="Completion Funnel" subtitle="How much you finish" />
            <div className="space-y-3">
              {[
                { label: "Started", value: data.completion_funnel.started, pct: 100 },
                { label: "In Progress", value: data.completion_funnel.in_progress_25, pct: (data.completion_funnel.in_progress_25 / Math.max(data.completion_funnel.started, 1)) * 100 },
                { label: "Mostly Done", value: data.completion_funnel.mostly_done_75, pct: (data.completion_funnel.mostly_done_75 / Math.max(data.completion_funnel.started, 1)) * 100 },
                { label: "Completed", value: data.completion_funnel.completed, pct: (data.completion_funnel.completed / Math.max(data.completion_funnel.started, 1)) * 100 },
              ].map((s, i) => (
                <div key={s.label}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-xs text-white/60">{s.label}</span>
                    <span className="text-[10px] text-white/30">{s.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                    <m.div className="h-full rounded-full bg-white/30" initial={{ width: 0 }} animate={{ width: `${Math.max(s.pct, 1)}%` }} transition={{ duration: 0.8, delay: i * 0.08, ease: "easeOut" }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Divider />

        {/* Recent Activity */}
        <SectionLabel title="Recent Activity" subtitle="Last 20 events" />
        <div className="space-y-0">
          {data.recent_events.map((evt) => {
            const displayTitle = evt.media_type === "tvepisode"
              ? `${evt.parent_title || evt.title} S${(evt.season_number || 0).toString().padStart(2, "0")}E${(evt.episode_number || 0).toString().padStart(2, "0")}`
              : evt.title
            return (
              <div key={evt.event_id} className="flex items-center gap-3 py-2.5 border-b border-white/[0.04] last:border-0">
                <PosterThumb path={evt.media_type === "tvepisode" ? evt.still_path : evt.poster_path} title={evt.title} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{displayTitle}</div>
                  <div className="text-[10px] text-white/30 mt-0.5">
                    {evt.media_type === "movie" ? "Movie" : "Episode"} &middot; {formatDuration(evt.duration_seconds * (evt.progress_percent / 100))} &middot; {formatTimeAgo(evt.ended_at)}
                    {evt.completed && <span className="text-white/40"> &middot; done</span>}
                  </div>
                </div>
                <span className="text-[10px] text-white/25 shrink-0">{Math.round(evt.progress_percent)}%</span>
              </div>
            )
          })}
        </div>

        </m.div>
      </div>
    </LazyMotion>
  )
}
