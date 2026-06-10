import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
}

export function RemoteSearchBar({ value, onChange }: Props) {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocal(value)
  }, [value])

  const handleChange = (v: string) => {
    setLocal(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onChange(v), 300)
  }

  return (
    <div className="relative w-full max-w-2xl">
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-neutral-500 pointer-events-none transition-colors duration-200 peer-focus-within:text-amber-400" />
        <input
          placeholder="Search movies & TV shows..."
          value={local}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full h-14 pl-12 pr-12 text-base font-medium bg-[#0A0A0A] border border-neutral-800 rounded-2xl text-neutral-100 placeholder-neutral-600 transition-all duration-200 focus:outline-none focus:border-amber-700/50 focus:ring-1 focus:ring-amber-700/30 focus:bg-[#0D0D0D]"
        />
        {local && (
          <button
            onClick={() => { setLocal(''); onChange('') }}
            className="absolute right-4 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/50 transition-all duration-200"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
