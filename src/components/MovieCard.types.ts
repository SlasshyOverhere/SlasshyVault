import { MediaItem } from "@/services/api"

export interface MovieCardProps {
  item: MediaItem
  onClick: (item: MediaItem) => void
  onFixMatch: (item: MediaItem) => void
  onRemoveFromHistory?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  onWatchTogether?: (item: MediaItem) => void
  onDownload?: (item: MediaItem) => void
  showNewBadge?: boolean
  disableEntryAnimation?: boolean
  aspectRatio?: "portrait" | "square"
  className?: string
  index?: number
  layout?: "grid" | "list"
}

// Custom comparison function for React.memo to prevent unnecessary re-renders
export function areMovieCardPropsEqual(prev: MovieCardProps, next: MovieCardProps) {
  // 1. Compare simple scalar props
  if (
    prev.index !== next.index ||
    prev.className !== next.className ||
    prev.aspectRatio !== next.aspectRatio ||
    prev.layout !== next.layout
  ) {
    return false
  }

  // 2. Callback props must remain in sync to avoid stale closures.
  if (
    prev.onClick !== next.onClick ||
    prev.onFixMatch !== next.onFixMatch ||
    prev.onRemoveFromHistory !== next.onRemoveFromHistory ||
    prev.onDelete !== next.onDelete ||
    prev.onWatchTogether !== next.onWatchTogether ||
    prev.onDownload !== next.onDownload ||
    prev.showNewBadge !== next.showNewBadge ||
    prev.disableEntryAnimation !== next.disableEntryAnimation
  ) {
    return false
  }

  // 3. Compare item fields that affect rendering
  const pItem = prev.item
  const nItem = next.item

  // Fast path: same object reference
  if (pItem === nItem) return true

  // Check unique ID first
  if (pItem.id !== nItem.id) return false

  // Check visual properties
  return (
    pItem.title === nItem.title &&
    pItem.overview === nItem.overview &&
    pItem.cast_names === nItem.cast_names &&
    pItem.file_path === nItem.file_path &&
    pItem.poster_path === nItem.poster_path &&
    pItem.progress_percent === nItem.progress_percent &&
    pItem.resume_position_seconds === nItem.resume_position_seconds &&
    pItem.duration_seconds === nItem.duration_seconds &&
    pItem.media_type === nItem.media_type &&
    pItem.is_cloud === nItem.is_cloud &&
    pItem.season_number === nItem.season_number &&
    pItem.episode_number === nItem.episode_number &&
    pItem.year === nItem.year &&
    pItem.history_group_count === nItem.history_group_count &&
    pItem.history_group_latest_label === nItem.history_group_latest_label
  )
}

export interface ContinueCardProps {
  item: MediaItem
  onClick: (item: MediaItem) => void
  index?: number
}

// Custom comparison for ContinueCard
export function areContinueCardPropsEqual(prev: ContinueCardProps, next: ContinueCardProps) {
  if (prev.index !== next.index) return false
  if (prev.onClick !== next.onClick) return false

  const pItem = prev.item
  const nItem = next.item

  if (pItem === nItem) return true
  if (pItem.id !== nItem.id) return false

  return (
    pItem.title === nItem.title &&
    pItem.poster_path === nItem.poster_path &&
    pItem.progress_percent === nItem.progress_percent &&
    pItem.resume_position_seconds === nItem.resume_position_seconds &&
    pItem.duration_seconds === nItem.duration_seconds
  )
}
