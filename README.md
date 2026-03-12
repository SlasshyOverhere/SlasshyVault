# StreamVault

A modern, cloud-first media library manager built with **Tauri**, **Rust**, and **React**. Indexes your Google Drive video collection, fetches rich metadata from TMDB, and provides seamless playback through **MPV**.

![Monochrome Design](https://img.shields.io/badge/design-monochrome-black?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-v1-blue?style=flat-square)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square)
![Version](https://img.shields.io/badge/version-3.0.2-green?style=flat-square)

## Features

### Cloud-First Library
- **Google Drive Integration** - Index your entire Google Drive with one click
- **Real-time Change Detection** - Monitors Google Drive for new content using Changes API (5-second polling)
- **Incremental Updates** - Only indexes new content, skips already-indexed files
- **Background Sync** - Detects new files even when minimized to system tray
- **Windows Notifications** - Get notified when new media is added to your library

### Metadata & Organization
- **TMDB Integration** - Fetches posters, backdrops, overviews, and ratings
- **TV Show Support** - Properly groups episodes by series and season with episode thumbnails
- **Fix Match** - Manually correct misidentified media
- **Episode Browser** - Browse seasons and episodes with full metadata

### Playback
- **MPV Integration** - Native playback of any format (MKV, MP4, AVI, HDR, etc.) without transcoding
- **Resume Playback** - Remembers your position across all media
- **Watch History** - Track what you've watched

### User Experience
- **Monochrome UI** - Sleek black & white design with smooth animations
- **System Tray** - Runs in background with Windows notifications for new content
- **Onboarding** - Guided setup for first-time users
- **Context Menus** - Right-click actions for quick operations

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, TailwindCSS, Radix UI, Framer Motion |
| Backend | Rust, Tauri |
| Database | SQLite (rusqlite) |
| Playback | MPV (via IPC) |
| Metadata | TMDB API |
| Cloud | Google Drive API |

## Backend (Fork / Self-Host)

Official backend repository:

- `https://github.com/SlasshyOverhere/StreamVault-Backend`

If you want to fork/build your own backend:

1. Fork and deploy the backend repo above.
2. In frontend `.env`, set:
   - `VITE_AUTH_SERVER_URL=https://your-backend-domain`
3. For Tauri-side backend routing, set environment variables before building:
   - `STREAMVAULT_AUTH_SERVER_URL=https://your-backend-domain`
   - `STREAMVAULT_TMDB_PROXY_URL=https://your-backend-domain/api/tmdb` (optional explicit TMDB proxy override)
   - `STREAMVAULT_WS_URL=wss://your-backend-domain/ws/watchtogether`
4. Update `AUTH_SERVER_URL` in `src-tauri/src/gdrive.rs` to your deployed backend URL (used for `/auth/google` and `/auth/refresh`).
5. Build the app after these values are configured.

## Supported Formats

`.mkv` `.mp4` `.avi` `.mov` `.webm` `.m4v` `.wmv` `.flv` `.ts` `.m2ts`

## Prerequisites

1. **Node.js** v18+
2. **Rust** (latest stable)
3. **MPV Media Player**
   - **Windows:** Download from [mpv.io](https://mpv.io/installation/) or [SourceForge builds](https://sourceforge.net/projects/mpv-player-windows/files/) and add to system `PATH`
   - **Linux:** `sudo apt install mpv` or equivalent
   - **macOS:** `brew install mpv`

## Installation

```bash
# Clone the repository
git clone https://github.com/SlasshyOverhere/StreamVault.git
cd StreamVault

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

## Building

```bash
# Create production build
npm run tauri build
```

Build output: `src-tauri/target/release/`

Installers will be generated in `src-tauri/target/release/bundle/`

## Configuration

### First Launch
1. Complete the onboarding wizard
2. Connect Google Drive for cloud media
3. Enter your TMDB API key (optional, for metadata)
4. Click "Update Library" to index your content

### Settings
- **Google Drive** - Connect/disconnect cloud storage
- **TMDB API Key** - Required for poster and metadata fetching
- **Player Preferences** - Configure MPV path and behavior

### Getting a TMDB API Key
1. Create an account at [themoviedb.org](https://www.themoviedb.org/)
2. Go to Settings > API
3. Request an API key (free for personal use)
4. Copy the "API Read Access Token" into StreamVault settings

### Google Drive Setup
1. Click "Connect Google Drive" in Settings
2. Authorize StreamVault to access your Drive
3. Use "Update Library" button in sidebar to scan your cloud media

## Project Structure

```
streamvault/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── services/           # API & utility functions
│   └── App.tsx            # Main application
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── main.rs        # Tauri commands & app logic
│   │   ├── database.rs    # SQLite operations
│   │   ├── media_manager.rs # Cloud file parsing
│   │   ├── gdrive.rs      # Google Drive API client
│   │   ├── tmdb.rs        # TMDB API client
│   │   └── mpv_ipc.rs     # MPV player control
│   └── tauri.conf.json    # Tauri configuration
└── package.json
```

## How It Works

1. **Cloud Sync** - Monitors Google Drive for changes using Changes API (5-second polling)
2. **Parsing** - Extracts title, year, season/episode from filenames
3. **Metadata Fetch** - Queries TMDB for rich metadata and downloads images
4. **Database Storage** - Stores everything in local SQLite for fast access
5. **Duplicate Detection** - Skips already-indexed files automatically
6. **Playback** - Launches MPV with IPC for progress tracking and resume support

## What's New in v3.0.2

- **Cloud-Only Mode** - Removed local library support, app is now fully cloud-based
- **Simplified UI** - Single "Update Library" button for cloud indexing
- **Background Polling** - 5-second change detection runs even when minimized to tray
- **Incremental Indexing** - Only indexes new files not already in database
- **Streamlined Navigation** - Removed local tab from sidebar and settings

## What's New in v3.0.0

- **Monochrome Design** - Complete UI overhaul with black/white/grayscale aesthetic
- **Full Drive Indexing** - Index entire Google Drive with one click
- **Simplified Cloud Settings** - Removed folder-based cloud management
- **Improved Change Detection** - Better Google Drive sync with Changes API

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT License](LICENSE)

## Acknowledgments

- [Tauri](https://tauri.app/) - Desktop app framework
- [MPV](https://mpv.io/) - Media player
- [TMDB](https://www.themoviedb.org/) - Metadata provider
- [Google Drive API](https://developers.google.com/drive) - Cloud storage
- [Radix UI](https://www.radix-ui.com/) - UI primitives
