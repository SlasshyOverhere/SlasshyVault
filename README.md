
# StreamVault

StreamVault is a cloud-first desktop media library app built with Tauri, Rust, React, and TypeScript.

It indexes video content from Google Drive, enriches it with TMDB metadata, and plays it through MPV with progress tracking, resume support, and archive-aware playback.

![Tauri](https://img.shields.io/badge/Tauri-v1-blue?style=flat-square)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square)
![Version](https://img.shields.io/badge/version-3.0.32-green?style=flat-square)

## What StreamVault Does

- Indexes your Google Drive video library into a local SQLite database
- Fetches posters, thumbnails, episode metadata, and overviews from TMDB
- Plays media through MPV with resume, history, and progress saving
- Detects cloud changes in the background and keeps the library updated
- Supports archive-aware playback for supported cases, including playable `.rar` archives
- Shows clear frontend warnings when archive media is not directly playable

## Key Features

- Cloud-first library management
- TV show and episode grouping
- Watch history and resume playback
- System tray support
- Windows notifications when the app is minimized or in the background
- In-app toast notifications while the app is open and focused
- Manual metadata correction with Fix Match
- Archive playback status and compatibility messaging

## Archive Support

StreamVault can detect and assess archived media before playback.

- `.zip`: supported where the archive entry can be played or prepared by the backend
- `.rar`: supported for playable archive cases
- `.tar`: currently not playable

If StreamVault detects a `.tar` file, it informs the user in the UI and explains why it cannot be indexed for playback right now.

## Playback

Playback is powered by MPV.

- Native playback for common video formats
- Resume from previous progress
- Watch history tracking
- Better MPV display titles for archived TV episodes, including `SxxExx`

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS, Radix UI, Framer Motion |
| Backend | Rust, Tauri |
| Database | SQLite |
| Playback | MPV |
| Metadata | TMDB |
| Cloud | Google Drive API |

## Prerequisites

Before running StreamVault locally, install:

1. Node.js 18+
2. Rust stable
3. MPV

Windows:

- Install MPV from [mpv.io](https://mpv.io/installation/) or a trusted Windows build
- Make sure `mpv.exe` is available in your system `PATH`, or configure it in app settings

## Local Development

```bash
git clone https://github.com/SlasshyOverhere/StreamVault.git
cd StreamVault/streamvault
npm install
npm run tauri dev
```

## Production Build

```bash
npm run tauri build
```

Installers are generated under `src-tauri/target/release/bundle/`.

## First-Time Setup

1. Launch StreamVault
2. Complete onboarding
3. Connect Google Drive
4. Add your TMDB API key if you want metadata and artwork
5. Run a library update

## Backend / Self-Hosting

Official backend repository:

- [StreamVault-Backend](https://github.com/SlasshyOverhere/StreamVault-Backend)

If you want to use your own backend:

1. Deploy the backend
2. Set `VITE_AUTH_SERVER_URL` in `.env`
3. Set backend-related environment variables for Tauri builds as needed
4. Build the app with those values

## Supported Video Formats

Common supported formats include:

`.mkv` `.mp4` `.avi` `.mov` `.webm` `.m4v` `.wmv` `.flv` `.ts` `.m2ts`

## Project Structure

```text
streamvault/
├── src/                 React frontend
├── src-tauri/           Rust + Tauri backend
├── package.json
└── README.md
```

## Recent Highlights

- Improved notification behavior and reduced repeated notifications
- Added `.rar` archive support for supported playback cases
- Added frontend archive compatibility messaging
- Added `.tar` detection with clear unsupported reason
- Fixed MPV archive playback titles so TV episodes show better metadata

## Contributing

Pull requests are welcome.

1. Fork the repo
2. Create a branch
3. Make your changes
4. Open a pull request

# Disclaimer

This project is entirely **vibe-coded** as a hobby project. 

---


## License

[MIT License](LICENSE)
