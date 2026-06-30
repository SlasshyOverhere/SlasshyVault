import { useState, useEffect, memo } from 'react'

export const Clock = memo(function Clock() {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-baseline gap-3">
        <h1 className="text-5xl font-black text-white tabular-nums drop-shadow-2xl flex items-center gap-2">
          <span>{String(now.getHours()).padStart(2, '0')}</span>
          <span className="text-white/40">:</span>
          <span>{String(now.getMinutes()).padStart(2, '0')}</span>
          <span className="text-white/40">:</span>
          <span>{String(now.getSeconds()).padStart(2, '0')}</span>
        </h1>
      </div>
      <p className="text-xs font-bold text-white/20 uppercase tracking-[0.25em]">
        {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
    </div>
  )
})
