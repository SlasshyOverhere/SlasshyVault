import { useEffect, useState } from 'react'
import { Bell, Clock3, Loader2, StickyNote } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { WatchlistItem, WatchlistItemInput } from '@/services/api'
import { CountdownTimer } from './CountdownTimer'

interface WatchlistEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: Partial<WatchlistItemInput> | WatchlistItem
  onSave: (item: WatchlistItemInput) => Promise<void>
}

const utcToLocalDatetime = (utcString?: string | null): string => {
  if (!utcString) return ''
  const date = new Date(utcString)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

const localDatetimeToUtc = (localString: string): string | null => {
  if (!localString) return null
  return new Date(localString).toISOString()
}

const intervalOptions = [
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every 1 hour' },
  { value: 120, label: 'Every 2 hours' },
  { value: -1, label: 'Manual interval' },
]

export function WatchlistEditor({
  open,
  onOpenChange,
  initialData,
  onSave,
}: WatchlistEditorProps) {
  const [loading, setLoading] = useState(false)
  const [title, setTitle] = useState('')
  const [titleError, setTitleError] = useState('')
  const [notes, setNotes] = useState('')
  const [notificationEnabled, setNotificationEnabled] = useState(false)
  const [notifyAt, setNotifyAt] = useState('')
  const [notifyAtError, setNotifyAtError] = useState('')
  const [notificationMode, setNotificationMode] = useState<'single' | 'spam'>('single')
  const [intervalPreset, setIntervalPreset] = useState<string>('30')
  const [manualInterval, setManualInterval] = useState('30')

  const typedData = (d: Partial<WatchlistItemInput> | WatchlistItem | undefined | null) => (d ?? {}) as Partial<WatchlistItemInput> & Partial<WatchlistItem>

  useEffect(() => {
    if (!open) return

    const data = typedData(initialData)
    setTitleError('')
    setNotifyAtError('')
    setTitle(data?.title || '')
    setNotes(data?.notes || '')
    setNotificationEnabled(data?.notification_enabled ?? data?.notificationEnabled ?? false)
    setNotifyAt(utcToLocalDatetime(data?.notify_at ?? data?.notifyAt))

    const rawMode = data?.notification_mode ?? data?.notificationMode ?? 'single'
    const mode: 'single' | 'spam' = rawMode === 'spam' ? 'spam' : 'single'
    setNotificationMode(mode)

    const interval = data?.notification_interval_minutes ?? data?.notificationIntervalMinutes ?? 30
    if ([30, 60, 120].includes(interval)) {
      setIntervalPreset(String(interval))
      setManualInterval('30')
    } else {
      setIntervalPreset('-1')
      setManualInterval(String(interval || 30))
    }
  }, [open, initialData])

  const handleSave = async () => {
    let hasError = false
    if (!title.trim()) {
      setTitleError('Title is required')
      hasError = true
    } else {
      setTitleError('')
    }
    if (notificationEnabled && !notifyAt) {
      setNotifyAtError('Notification time is required')
      hasError = true
    } else {
      setNotifyAtError('')
    }
    if (hasError) return

    setLoading(true)
    try {
      const data = typedData(initialData)
      const intervalMinutes = notificationMode === 'spam'
        ? intervalPreset === '-1'
          ? Number(manualInterval || 30)
          : Number(intervalPreset)
        : null

      await onSave({
        tmdbId: String(data?.tmdb_id || data?.tmdbId || ''),
        mediaType: data?.media_type || data?.mediaType || 'movie',
        title,
        posterPath: data?.poster_path || data?.posterPath || null,
        releaseDate: data?.release_date || data?.releaseDate || null,
        notes,
        isActive: data?.is_active ?? data?.isActive ?? true,
        notificationEnabled,
        notificationMode,
        notificationIntervalMinutes: intervalMinutes,
        notifyAt: notificationEnabled ? localDatetimeToUtc(notifyAt) : null,
      })
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  const isEdit = initialData && 'id' in initialData

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-background/95 backdrop-blur-[32px] border border-white/10 text-white p-0 overflow-hidden rounded-[2rem]">
        <DialogHeader className="p-8 pb-4">
          <DialogTitle className="text-2xl font-black tracking-tight flex items-center gap-3">
            <div className="size-10 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
              <Bell className="size-5 text-white/60" />
            </div>
            <div>
              <div>{isEdit ? 'Edit Watchlist Item' : 'Add To Watchlist'}</div>
              <div className="text-[10px] font-bold text-white/20 uppercase tracking-widest mt-1">
                Letterboxd-style queue with reminders
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="px-8 pb-8 space-y-6 max-h-[72vh] overflow-y-auto custom-scrollbar">
          <div className="space-y-3">
            <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30 ml-1">Title</Label>
            <Input
              id="watchlist-title"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setTitleError('') }}
              aria-label="Watchlist item title"
              aria-describedby="watchlist-title-error"
              aria-invalid={!!titleError}
              className="bg-white/5 border-white/10 focus:border-white/20 h-14 rounded-2xl px-5 text-base font-bold"
            />
            {titleError && (
              <p id="watchlist-title-error" className="text-[10px] font-bold text-red-400 ml-1 mt-1">{titleError}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30 ml-1">Notes</Label>
            <div className="relative">
              <StickyNote className="absolute left-5 top-1/2 -translate-y-1/2 size-4 text-white/20" />
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why is this on your watchlist?"
                className="bg-white/5 border-white/10 focus:border-white/20 h-14 rounded-2xl pl-12 pr-5 text-base font-bold placeholder:text-white/10"
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-5 rounded-[1.5rem] bg-white/[0.03] border border-white/10">
            <div>
              <Label className="text-sm font-black text-white">Enable Notification</Label>
              <p className="text-[10px] text-white/20 font-bold uppercase tracking-widest">
                Set when and how you want to be reminded
              </p>
            </div>
            <Switch
              checked={notificationEnabled}
              onCheckedChange={setNotificationEnabled}
              className="data-[state=checked]:bg-white/90"
            />
          </div>

          {notificationEnabled && (
            <div className="space-y-6">
              <div className="space-y-3">
                <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30 ml-1">Timer</Label>
                <div className="relative">
                  <Clock3 className="absolute left-5 top-1/2 -translate-y-1/2 size-4 text-white/20" />
                  <Input
                    id="watchlist-notify-at"
                    type="datetime-local"
                    value={notifyAt}
                    onChange={(e) => { setNotifyAt(e.target.value); setNotifyAtError('') }}
                    aria-label="Notification time"
                    aria-describedby="watchlist-notify-at-error"
                    aria-invalid={!!notifyAtError}
                    className="bg-white/5 border-white/10 focus:border-white/20 h-14 rounded-2xl pl-12 pr-5 text-base font-bold [color-scheme:dark]"
                  />
                  {notifyAtError && (
                    <p id="watchlist-notify-at-error" className="text-[10px] font-bold text-red-400 ml-1 mt-1">{notifyAtError}</p>
                  )}
                </div>
                {notifyAt && (
                  <CountdownTimer target={localDatetimeToUtc(notifyAt) || ''} compact className="bg-white/[0.03] border-white/10" />
                )}
              </div>

              <div className="space-y-3">
                <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30 ml-1">Notification Type</Label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'single', label: 'Single Reminder' },
                    { id: 'spam', label: 'Spam Reminder' },
                  ].map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      onClick={() => setNotificationMode(option.id as 'single' | 'spam')}
                      className={`h-12 rounded-2xl border text-xs font-black uppercase tracking-[0.18em] transition-all ${
                        notificationMode === option.id
                          ? 'bg-white text-black border-white'
                          : 'bg-white/[0.03] text-white/40 border-white/10 hover:text-white'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {notificationMode === 'spam' && (
                <div className="space-y-3">
                  <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30 ml-1">Spam Variation</Label>
                  <div className="grid grid-cols-1 gap-3">
                    <select
                      value={intervalPreset}
                      onChange={(e) => setIntervalPreset(e.target.value)}
                      aria-label="Spam reminder interval"
                      className="h-14 rounded-2xl border border-white/10 bg-white/5 px-5 text-sm font-bold text-white outline-none"
                    >
                      {intervalOptions.map((option) => (
                        <option key={option.value} value={option.value} className="bg-gray-950">
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {intervalPreset === '-1' && (
                      <Input
                        type="number"
                        min={1}
                        value={manualInterval}
                        onChange={(e) => setManualInterval(e.target.value)}
                        placeholder="Manual interval in minutes"
                        className="bg-white/5 border-white/10 focus:border-white/20 h-14 rounded-2xl px-5 text-base font-bold"
                      />
                    )}
                    <p className="text-[11px] text-white/35 leading-relaxed">
                      Spam reminder repeats until you manually stop it from the Watchlist or Reminders view.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="p-8 pt-4 bg-white/[0.02] border-t border-white/5">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-white/40 hover:text-white hover:bg-white/5 rounded-2xl h-14 px-8 font-black uppercase tracking-widest text-[11px]">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading || !title || (notificationEnabled && !notifyAt)}
            className="bg-white text-black hover:bg-neutral-200 font-black uppercase tracking-[0.2em] text-[11px] rounded-2xl h-14 px-10"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : isEdit ? 'Save Watchlist' : 'Add To Watchlist'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
