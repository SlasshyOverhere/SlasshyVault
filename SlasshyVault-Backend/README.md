# SlasshyVault Auth Server

OAuth-only backend for SlasshyVault desktop Google Drive sign-in.

## What It Does

One job: handle Google OAuth code exchange. The Tauri app opens a browser → user signs into Google → Google redirects here → backend exchanges the code for tokens → stores them in memory → redirects back to the Tauri app on `localhost:8085`.

Everything else (TMDB, OMDb, Watch Together relay, social) is now handled directly by the Tauri app.

## Quick Start

1. `npm install`
2. `cp .env.example .env` — fill in Google OAuth credentials
3. `npm start`

## Endpoints

| Endpoint | Method | What |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/auth/google` | GET | Starts OAuth (redirects to Google) |
| `/auth/callback` | GET | Google redirects here after user signs in |
| `/auth/session/:id` | GET | Tauri app fetches tokens after callback |
| `/auth/refresh` | POST | Refresh expired tokens |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `REDIRECT_URI` | ✅ | Must match Google Cloud Console — e.g. `https://your-app.onrender.com/auth/callback` |
| `PORT` | | Server port (default 3001) |
| `OAUTH_CALLBACK_URL` | | Where Google redirects after auth — default `http://localhost:8085/callback` |

## Deployment (Render)

1. Create a new Render Web Service
2. Build: `npm install`
3. Start: `npm start`
4. Set env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `REDIRECT_URI`
5. `REDIRECT_URI` = `https://<your-service>.onrender.com/auth/callback`
6. In Google Cloud Console, add that same URL to Authorized redirect URIs
