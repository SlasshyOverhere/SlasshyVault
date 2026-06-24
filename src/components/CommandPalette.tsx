import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Home, Cloud, Radio, Link2, Clapperboard, Download, BarChart3,
  Settings, RefreshCw, Pin, ShieldCheck, Play, Search
} from 'lucide-react'
import type { MediaItem } from '@/services/api'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  setView: (view: string) => void
  onOpenSettings: () => void
  onCloudScan: () => void
  onSyncValidator: () => void
  onToggleSidebarPin: () => void
  continueWatching: MediaItem[]
  onPlayItem: (item: MediaItem) => void
}

interface CommandItem {
  id: string
  label: string
  shortcut?: string
  icon: React.ComponentType<{ className?: string }>
  group: 'Navigation' | 'Actions' | 'Recent'
  action: () => void
}

export function CommandPalette({
  open,
  onClose,
  setView,
  onOpenSettings,
  onCloudScan,
  onSyncValidator,
  onToggleSidebarPin,
  continueWatching,
  onPlayItem,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const navigate = useCallback((view: string) => {
    setView(view)
    onClose()
  }, [setView, onClose])

  const commands: CommandItem[] = useMemo(() => [
    // Navigation
    { id: 'nav-home', label: 'Home', icon: Home, group: 'Navigation', action: () => navigate('home') },
    { id: 'nav-cloud', label: 'Library', icon: Cloud, group: 'Navigation', action: () => navigate('cloud') },
    { id: 'nav-remote', label: 'External', icon: Radio, group: 'Navigation', action: () => navigate('remote') },
    { id: 'nav-directlinks', label: 'Direct Links', icon: Link2, group: 'Navigation', action: () => navigate('directlinks') },
    { id: 'nav-reminders', label: 'Watchlist', icon: Clapperboard, group: 'Navigation', action: () => navigate('reminders') },
    { id: 'nav-downloads', label: 'Downloads', icon: Download, group: 'Navigation', action: () => navigate('downloads') },
    { id: 'nav-history', label: 'History & Analytics', icon: BarChart3, group: 'Navigation', action: () => navigate('history') },
    // Actions
    { id: 'act-scan', label: 'Scan Library', shortcut: '', icon: RefreshCw, group: 'Actions', action: () => { onCloudScan(); onClose() } },
    { id: 'act-settings', label: 'Open Settings', shortcut: '', icon: Settings, group: 'Actions', action: () => { onOpenSettings(); onClose() } },
    { id: 'act-pin', label: 'Toggle Sidebar Pin', icon: Pin, group: 'Actions', action: () => { onToggleSidebarPin(); onClose() } },
    { id: 'act-sync', label: 'Open Sync Validator', icon: ShieldCheck, group: 'Actions', action: () => { onSyncValidator(); onClose() } },
    // Recent items
    ...continueWatching.slice(0, 5).map((item) => ({
      id: `recent-${item.id}`,
      label: item.title,
      icon: Play,
      group: 'Recent' as const,
      action: () => { onPlayItem(item); onClose() },
    })),
  ], [navigate, onOpenSettings, onCloudScan, onSyncValidator, onToggleSidebarPin, onClose, continueWatching, onPlayItem])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter((cmd) => cmd.label.toLowerCase().includes(q))
  }, [commands, query])

  // Group filtered commands
  const grouped = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {}
    for (const cmd of filtered) {
      if (!groups[cmd.group]) groups[cmd.group] = []
      groups[cmd.group].push(cmd)
    }
    return groups
  }, [filtered])

  // Flat list for keyboard navigation
  const flatFiltered = filtered

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Clamp active index when filtered changes
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, flatFiltered.length - 1)))
  }, [flatFiltered.length])

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, flatFiltered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatFiltered[activeIndex]?.action()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [flatFiltered, activeIndex, onClose])

  if (!open) return null

  // Track global index across groups for keyboard nav
  let globalIdx = 0

  return (
    <div className="fixed inset-0 z-[500] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-[500px] mx-4 rounded-xl border border-white/10 bg-[#121212]/95 shadow-2xl shadow-black/50 backdrop-blur-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
            placeholder="Type a command..."
            className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 h-8 text-sm px-0"
          />
          <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 text-[10px] text-muted-foreground font-mono">
            ESC
          </kbd>
        </div>

        {/* Command list */}
        <ScrollArea className="max-h-[340px]">
          <div ref={listRef} className="py-1">
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
                  {group}
                </div>
                {items.map((cmd) => {
                  const idx = globalIdx++
                  const isActive = idx === activeIndex
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      data-active={isActive}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-white/10 text-white' : 'text-muted-foreground hover:bg-white/5 hover:text-white'
                      }`}
                      onClick={cmd.action}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.shortcut && (
                        <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 text-[10px] text-muted-foreground font-mono">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
            {flatFiltered.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                No matching commands
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-white/5 text-[10px] text-muted-foreground/50">
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-4 items-center rounded border border-white/10 bg-white/5 px-1 font-mono">↑↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-4 items-center rounded border border-white/10 bg-white/5 px-1 font-mono">↵</kbd>
            Select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-4 items-center rounded border border-white/10 bg-white/5 px-1 font-mono">Esc</kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  )
}
