# Frontend Agent Prompt: StreamVault Cinema Search + Reminders

You are updating the StreamVault Tauri/React frontend. Backend support is already implemented; do not change the Rust backend unless you find a blocking contract issue.

Build a polished "Cinema" experience where users can search TMDB for any movie or TV show, inspect details, and create reminders for release/watch times. This should feel like an all-in-one cinema solution, not a settings-only utility.

Backend contract is in `src/services/api.ts`. Use these exported helpers:

- `searchTmdb(query)` returns movies and TV shows from TMDB.
- `getMovieDetails(movieId)` returns rich movie info.
- `getTvDetails(tvId)` returns TV show info with seasons.
- `getTvSeasonEpisodes(tvId, seasonNumber)` returns episode metadata.
- `getTmdbReleaseSchedule(tmdbId, mediaType, seasonNumber?, episodeNumber?)` returns TMDB's release/air date and a UTC `suggestedReminderAt`.
- `getMovieReminders(includeInactive?)`
- `createMovieReminder(reminder)`
- `updateMovieReminder(id, reminder)`
- `deleteMovieReminder(id)`
- `setMovieReminderActive(id, isActive)`
- `getConfig()` / `saveConfig(config)` now include `notifications_enabled`.

Important behavior:

- Reminders are stored as UTC ISO/RFC3339 strings in `reminder_at`.
- TMDB usually provides release dates, not exact release times. The backend suggests 9:00 AM local time for date-only releases. Show this clearly and let users edit date and time before saving.
- Users must be able to choose either:
  1. Use TMDB release/air date as the starting point.
  2. Manually enter or correct the reminder date/time.
- The app only auto-starts when `notifications_enabled` is true. Add a clear notification toggle in the relevant UI, and call `saveConfig({ ...config, notifications_enabled: enabled })`.
- When enabled, the backend scheduler pings due reminders with native notifications and emits a Tauri event named `movie-reminder-fired` with the `MovieReminder` payload. Listen for that event if you want in-app toast updates.

Suggested UX:

- Add a "Cinema" or "Discover" view reachable from the main navigation/sidebar.
- Use a focused search bar with filters/tabs for All, Movies, and TV.
- Result cards should show poster/backdrop, title/name, year/date, media type, rating, and overview snippet.
- Details view/modal should show poster/backdrop, overview, metadata, seasons/episodes for TV, and a primary "Set reminder" action.
- Reminder editor should include title, TMDB source label, release date from TMDB, editable date/time fields, optional notes, active toggle, and save/cancel.
- Add a reminders list showing upcoming reminders sorted by time, with edit, pause/resume, and delete controls.
- For TV shows, let users set a show-level reminder or drill into season episodes and set episode-specific reminders.
- Keep the design consistent with the existing StreamVault UI. Use existing UI primitives from `src/components/ui` and lucide icons where appropriate.

Implementation notes:

- Convert UTC `reminder_at` and `suggestedReminderAt` to local `datetime-local` values for input controls, then convert back to ISO/RFC3339 on save.
- `MovieReminderInput` uses camelCase fields: `tmdbId`, `mediaType`, `posterPath`, `seasonNumber`, `episodeNumber`, `releaseDate`, `reminderAt`, `source`, `notes`, `isActive`.
- Saved `MovieReminder` records come back with snake_case fields from Rust: `tmdb_id`, `media_type`, `poster_path`, `season_number`, `episode_number`, `release_date`, `reminder_at`, `is_active`.
- Use `getTmdbImageUrl(path, "w300" | "w500" | "original")` for TMDB image paths.
- Handle empty TMDB dates gracefully with a manual-only reminder flow.
- Do not block users from correcting TMDB data; manual edits are expected.

Definition of done:

- Users can search TMDB, open details for movie/TV, and create a reminder.
- Users can create reminders from TMDB suggested dates or fully manual date/time.
- Users can list, edit, pause/resume, and delete reminders.
- Notification/autostart toggle is wired to `notifications_enabled`.
- Due reminders produce an in-app toast/list refresh when `movie-reminder-fired` is received.
- The UI works on desktop and narrow widths without text overlap.
