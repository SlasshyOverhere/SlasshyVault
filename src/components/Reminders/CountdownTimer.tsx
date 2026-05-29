import { useEffect, useMemo, useState } from 'react'
import { Clock, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LazyMotion, m, domAnimation } from 'framer-motion'
import { getLocalTimezoneLabel, parseReleaseTarget, formatLocalReleaseTime } from './CountdownTimer.utils'

const getParts = (target: Date, now: Date) => {
  const totalMs = target.getTime() - now.getTime()
  const safeMs = Math.max(0, totalMs)
  const totalSeconds = Math.floor(safeMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return { totalMs, days, hours, minutes, seconds }
}

interface CountdownTimerProps {
  target: string | Date | null | undefined
  label?: string
  expiredLabel?: string
  forcePending?: boolean
  compact?: boolean
  banner?: boolean
  className?: string
  showTimezone?: boolean
}

export function CountdownTimer({
  target,
  label = 'Next episode in',
  expiredLabel = 'Available now',
  forcePending = false,
  compact = false,
  banner = false,
  className,
  showTimezone = true,
}: CountdownTimerProps) {
  const [now, setNow] = useState(() => new Date())
  const targetDate = useMemo(() => {
    if (!target) return null
    return target instanceof Date ? target : parseReleaseTarget(target)
  }, [target])

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!targetDate) {
    return null
  }

  const parts = getParts(targetDate, now)
  const isExpired = parts.totalMs <= 0 && !forcePending

  const blocks = [
    { label: 'Days', value: parts.days },
    { label: 'Hours', value: parts.hours },
    { label: 'Mins', value: parts.minutes },
    { label: 'Secs', value: parts.seconds },
  ]

  if (compact) {
    return (
      <div className={cn(
        "inline-flex h-8 items-center gap-2 rounded-xl border px-3 text-[10px] font-black uppercase tracking-widest backdrop-blur-md transition-all duration-300",
        isExpired
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
          : "border-white/10 bg-white/5 text-white/60 hover:border-white/20 hover:bg-white/10",
        className
      )}>
        {isExpired ? <CheckCircle2 className="size-3.5" /> : <Clock className="size-3.5 opacity-50" />}
        <span className="leading-none">{isExpired ? expiredLabel : parts.totalMs <= 0 ? 'Scheduled' : `${parts.days}d ${parts.hours}h ${parts.minutes}m`}</span>
      </div>
    )
  }

  if (banner) {
    return (
      <div className={cn("flex items-center gap-6", className)}>
        {blocks.map(block => (
          <div key={block.label} className="flex flex-col items-center">
            <div className="tabular-nums text-4xl font-black tracking-tighter text-white">
              {String(block.value).padStart(2, '0')}
            </div>
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white/20">
              {block.label}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={cn(
      "rounded-3xl border border-white/10 bg-black/40 p-4 shadow-2xl backdrop-blur-3xl overflow-hidden relative group",
      className
    )}>
      {/* Subtle Glow Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />

      <div className="mb-3 flex items-center justify-between gap-2 relative z-10">
        <div className="flex items-center gap-2">
          <div className={cn(
            "size-1.5 rounded-full animate-pulse",
            isExpired ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-white/30"
          )} />
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white/40">
            {isExpired ? 'Status' : label}
          </div>
        </div>
        {showTimezone && (
          <div className="rounded-lg bg-white/5 border border-white/10 px-1.5 py-0.5 text-[7px] font-black uppercase tracking-widest text-white/30">
            {getLocalTimezoneLabel()}
          </div>
        )}
      </div>

      {isExpired ? (
        <LazyMotion features={domAnimation}>
        <m.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-4 flex items-center gap-3 relative z-10"
        >
          <div className="size-8 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-400">
            <CheckCircle2 className="size-5" />
          </div>
          <div className="space-y-0.5">
            <div className="text-xs font-black text-emerald-100">{expiredLabel}</div>
            <div className="text-[9px] font-bold text-emerald-500/60 uppercase tracking-widest">Released and ready</div>
          </div>
        </m.div>
        </LazyMotion>
      ) : parts.totalMs <= 0 ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3 py-4 flex items-center gap-3 relative z-10">
          <div className="size-8 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400">
            <AlertCircle className="size-5" />
          </div>
          <div className="space-y-0.5">
            <div className="text-xs font-black text-amber-100">Pending Update</div>
            <div className="text-[9px] font-bold text-amber-500/60 uppercase tracking-widest">Awaiting exact release time</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 relative z-10">
          {blocks.map(block => (
            <div key={block.label} className="flex flex-col items-center gap-1.5">
              <div className="w-full aspect-square rounded-xl border border-white/[0.08] bg-white/[0.03] flex items-center justify-center shadow-inner group-hover:border-white/20 transition-colors">
                <div className="tabular-nums text-xl font-black tracking-tighter text-white">
                  {String(block.value).padStart(2, '0')}
                </div>
              </div>
              <div className="text-[8px] font-black uppercase tracking-[0.2em] text-white/25">
                {block.label}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-white/5 truncate text-center text-[9px] font-bold text-white/20 uppercase tracking-widest relative z-10">
        Scheduled for {formatLocalReleaseTime(targetDate.toISOString())}
      </div>
    </div>
  )
}
