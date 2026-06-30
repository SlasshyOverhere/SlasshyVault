# Self-Hosting the Backend

The only external dependency is a tiny OAuth backend for Google sign-in. It's a single Express file with no database.

## Deploy on Render (Free)

1. Fork the repo.
2. dashboard.render.com → New Web Service.
3. Root dir: `SlasshyVault-Backend`.
4. Build: `npm install` | Start: `npm start`.
5. Set env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `REDIRECT_URI`.
6. Add redirect URI to Google Cloud Console: `https://your-app.onrender.com/auth/callback`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | — | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | ✅ | — | From Google Cloud Console |
| `REDIRECT_URI` | ✅ | — | Must match Google's authorized redirect URIs |
| `PORT` | — | 3001 | Server port |
| `OAUTH_CALLBACK_URL` | — | `http://localhost:8085/callback` | Redirect target for the Tauri app |

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/auth/google` | GET | Redirect to Google consent |
| `/auth/callback` | GET | Google's OAuth callback |
| `/auth/session/:id` | GET | App fetches tokens after callback |
| `/auth/refresh` | POST | Refresh access token |
