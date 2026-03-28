import { describe, expect, it } from "vitest"

import {
  AUTO_MARK_WATCHED_THRESHOLD_PERCENT,
  getMediaProgressPercent,
  isMediaMarkedWatched,
  isProgressPastAutoCompleteThreshold,
  shouldPromptToMarkComplete,
} from "./playbackProgress"

describe("playbackProgress", () => {
  it("treats progress above 93 percent as auto-complete", () => {
    expect(AUTO_MARK_WATCHED_THRESHOLD_PERCENT).toBe(93)
    expect(isProgressPastAutoCompleteThreshold(93)).toBe(false)
    expect(isProgressPastAutoCompleteThreshold(93.01)).toBe(true)
  })

  it("prompts only for the near-complete band below auto-complete", () => {
    expect(shouldPromptToMarkComplete(79.9)).toBe(false)
    expect(shouldPromptToMarkComplete(80)).toBe(true)
    expect(shouldPromptToMarkComplete(93)).toBe(true)
    expect(shouldPromptToMarkComplete(93.01)).toBe(false)
  })

  it("derives progress from explicit percent or resume position", () => {
    expect(getMediaProgressPercent({ progress_percent: 88, resume_position_seconds: 10, duration_seconds: 100 })).toBe(88)
    expect(getMediaProgressPercent({ progress_percent: undefined, resume_position_seconds: 47, duration_seconds: 50 })).toBe(94)
    expect(getMediaProgressPercent({ progress_percent: undefined, resume_position_seconds: 0, duration_seconds: 50 })).toBe(0)
  })

  it("marks media watched when progress is above threshold or last watched is stored", () => {
    expect(isMediaMarkedWatched({
      progress_percent: 94,
      resume_position_seconds: 100,
      duration_seconds: 100,
      last_watched: null,
    })).toBe(true)

    expect(isMediaMarkedWatched({
      progress_percent: 92,
      resume_position_seconds: 0,
      duration_seconds: 1200,
      last_watched: "2026-03-28T00:00:00Z",
    })).toBe(true)

    expect(isMediaMarkedWatched({
      progress_percent: 92,
      resume_position_seconds: 1104,
      duration_seconds: 1200,
      last_watched: null,
    })).toBe(false)
  })
})
