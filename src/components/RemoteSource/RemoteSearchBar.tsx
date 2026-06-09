import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
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
    <div className="relative w-full max-w-xl mx-auto mb-6">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-neutral-500 pointer-events-none" />
      <Input
        placeholder="Search movies & TV shows..."
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        className="pl-10 pr-10 h-12 text-base bg-white/[0.04] border-white/[0.08] focus-visible:ring-white/20 placeholder:text-neutral-600"
      />
      {local && (
        <button
          onClick={() => { setLocal(''); onChange('') }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
