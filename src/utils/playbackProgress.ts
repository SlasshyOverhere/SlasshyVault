import type { MediaItem } from "@/services/api"

export const AUTO_MARK_WATCHED_THRESHOLD_PERCENT = 93
export const PROMPT_MARK_COMPLETE_THRESHOLD_PERCENT = 80

export function getMediaProgressPercent(item: Pick<MediaItem, "progress_percent" | "resume_position_seconds" | "duration_seconds">): number {
  if (typeof item.progress_percent === "number") {
    return item.progress_percent
  }

  if (item.resume_position_seconds && item.duration_seconds) {
    return (item.resume_position_seconds / item.duration_seconds) * 100
  }

  return 0
}

export function isProgressPastAutoCompleteThreshold(progressPercent: number): boolean {
  return progressPercent > AUTO_MARK_WATCHED_THRESHOLD_PERCENT
}

export function shouldPromptToMarkComplete(progressPercent: number): boolean {
  return (
    progressPercent >= PROMPT_MARK_COMPLETE_THRESHOLD_PERCENT &&
    !isProgressPastAutoCompleteThreshold(progressPercent)
  )
}

export function isMediaMarkedWatched(item: Pick<MediaItem, "progress_percent" | "resume_position_seconds" | "duration_seconds" | "last_watched">): boolean {
  const progress = getMediaProgressPercent(item)

  return Boolean(
    isProgressPastAutoCompleteThreshold(progress) ||
    (
      (item.resume_position_seconds ?? 0) === 0 &&
      (item.duration_seconds ?? 0) > 0 &&
      item.last_watched
    ),
  )
}
