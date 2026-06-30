# Privacy Policy

*Last updated: June 30, 2026*

## 1. What We Collect

**Nothing.** SlasshyVault does not collect, store, transmit, or share any personal data. No analytics, no telemetry, no crash reports, no tracking. The full source is open for audit.

## 2. Google Drive Access

When you sign in, the Software requests `drive` and `userinfo.email` scopes. Tokens are stored locally and used only for Drive API calls. Revoke anytime at [Google Account permissions](https://myaccount.google.com/permissions).

## 3. OAuth Backend

A stateless Node.js service available at [github.com/SlasshyOverhere/SlasshyVault](https://github.com/SlasshyOverhere/SlasshyVault). Stores OAuth state in memory for 5 minutes max. No database, no Redis, no file storage, no user data logging.

## 4. Watch Together Relay

Deployed to your Cloudflare account. Uses Durable Objects for ephemeral room state. No database, no persistence. State is lost when the last participant leaves.

## 5. Third-Party APIs

Direct requests to TMDB, imdbapi.dev, and optionally OMDb. Only search queries or media IDs are sent. These services have their own privacy policies.

## 6. Data Storage

- **Config & Tokens:** `%APPDATA%/SlasshyVault/media_config.json`
- **Watch History:** Local SQLite database
- **Image Cache:** Local files

## 7. Data Deletion

Factory Reset in Settings deletes all local data. OAuth tokens can be revoked via Google Account. The Cloudflare Worker can be deleted from Settings. The Software never writes to your Drive.

## 8. Children

Not intended for children under 13. No data is collected regardless of age.

## 9. Changes

This policy may be updated. Latest version at this URL.

## 10. Contact

Open an issue on [GitHub](https://github.com/SlasshyOverhere/SlasshyVault).
