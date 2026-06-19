# SlasshyVault

Cloud-first desktop media library. Indexes your Google Drive, enriches with TMDB metadata, plays through MPV.

![Tauri](https://img.shields.io/badge/Tauri-v1-blue?style=flat-square)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square)
![Version](https://img.shields.io/badge/version-3.0.55-black?style=flat-square)

## Features

- Google Drive library indexing with background change detection
- TMDB metadata, posters, and episode grouping
- MPV playback with resume and watch history
- External streaming via addon (direct URL or Go binary)
- Archive support (`.zip`, `.rar`)
- System tray, Windows notifications, toast alerts

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS |
| Backend | Rust, Tauri |
| Database | SQLite |
| Playback | MPV |
| Metadata | TMDB |
| Cloud | Google Drive API |

## Quick Start

```bash
# Prerequisites: Node.js 18+, Rust stable, MPV in PATH
git clone https://github.com/SlasshyOverhere/SlasshyVault.git
cd SlasshyVault
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

Installers output to `src-tauri/target/release/bundle/`.

## Project Structure

```text
├── src/                 React frontend
├── src-tauri/           Rust + Tauri backend
└── package.json
```

## Contributing

1. Fork, branch, change, PR.

## Disclaimer

SlasshyVault does not host, store, or distribute any media content. The "External" tab allows users to connect their own self-hosted addon to search and stream from third-party sources. SlasshyVault does not provide, endorse, or control any addon or its content. Users are solely responsible for compliance with applicable copyright laws in their jurisdiction. The developers assume no liability for misuse.

## License

[MIT](LICENSE)
