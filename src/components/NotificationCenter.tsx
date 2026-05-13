import React from "react"
import { Bell, Clapperboard, Film, Inbox, Tv } from "lucide-react"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export type NotificationCenterFilter = "all" | "movie_add" | "show_add" | "reminder" | "other"

export interface NotificationCenterItem {
  id: string
  category: Exclude<NotificationCenterFilter, "all">
  title: string
  message: string
  createdAt: string
  read: boolean
}

interface NotificationCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: NotificationCenterItem[]
  activeFilter: NotificationCenterFilter
  onFilterChange: (filter: NotificationCenterFilter) => void
  onClearAll: () => void
}

const FILTERS: Array<{ id: NotificationCenterFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "show_add", label: "Show Add" },
  { id: "movie_add", label: "Movie Add" },
  { id: "reminder", label: "Reminders" },
  { id: "other", label: "Other" },
]

function formatNotificationTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown time"

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const NotificationItem = React.memo(function NotificationItem({ item }: { item: NotificationCenterItem }) {
  return (
    <div
      className={cn(
        "rounded-[1.75rem] border px-5 py-4 transition-colors",
        item.read
          ? "border-white/6 bg-white/[0.025]"
          : "border-white/12 bg-white/[0.05]",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-black/30">
          <NotificationIcon category={item.category} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h4 className="truncate text-sm font-black tracking-tight text-white">{item.title}</h4>
              <p className="mt-1 text-sm leading-relaxed text-white/55">{item.message}</p>
            </div>
            <div className="shrink-0 text-[10px] font-black uppercase tracking-[0.18em] text-white/25">
              {formatNotificationTime(item.createdAt)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

function NotificationIcon({ category }: { category: NotificationCenterItem["category"] }) {
  if (category === "reminder") {
    return <Clapperboard className="w-4 h-4 text-white/80" />
  }
  if (category === "movie_add") {
    return <Film className="w-4 h-4 text-white/70" />
  }
  if (category === "show_add") {
    return <Tv className="w-4 h-4 text-white/70" />
  }
  return <Bell className="w-4 h-4 text-white/60" />
}

export function NotificationCenter({
  open,
  onOpenChange,
  items,
  activeFilter,
  onFilterChange,
  onClearAll,
}: NotificationCenterProps) {
  const filteredItems =
    activeFilter === "all" ? items : items.filter((item) => item.category === activeFilter)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl border-white/10 bg-[#090909]/95 p-0 text-white shadow-[0_0_120px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <DialogHeader className="border-b border-white/5 px-6 py-5">
          <div className="flex items-center justify-between gap-4 pr-12">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] shadow-inner">
                <Inbox className="w-5 h-5 text-white/70" />
              </div>
              <div>
                <DialogTitle className="text-xl font-black tracking-tight">Notifications</DialogTitle>
                <p className="mt-1 text-[10px] font-black uppercase tracking-[0.22em] text-white/25">
                  Activity and reminder history
                </p>
              </div>
            </div>
            <button
              onClick={onClearAll}
              aria-label="Clear all notifications"
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-[10px] font-black uppercase tracking-[0.22em] text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
              type="button"
            >
              Clear All
            </button>
          </div>
        </DialogHeader>

        <div className="px-6 pt-5">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-label={`Filter by ${filter.label}`}
                onClick={() => onFilterChange(filter.id)}
                className={cn(
                  "rounded-2xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.22em] transition-all",
                  activeFilter === filter.id
                    ? "bg-white text-black"
                    : "border border-white/10 bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/80",
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <ScrollArea className="max-h-[65vh] px-6 pb-6 pt-5 [&>div]:scrollbar-none">
          <div className="space-y-3">
            {filteredItems.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[2rem] border border-white/5 bg-white/[0.02] px-6 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.04]">
                  <Bell className="w-7 h-7 text-white/20" />
                </div>
                <h3 className="mt-5 text-lg font-black tracking-tight text-white">No notifications yet</h3>
                <p className="mt-2 max-w-sm text-sm text-white/30">
                  Library additions and reminder alerts will appear here as they happen.
                </p>
              </div>
            ) : (
              filteredItems.map((item) => (
                <NotificationItem key={item.id} item={item} />
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
