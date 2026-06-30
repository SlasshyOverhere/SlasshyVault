# Watch Together

Synchronize playback across users via a WebSocket relay. You can deploy your own Cloudflare Worker or use an existing relay URL.

## One-Click Deploy

1. Go to Settings → Watch Together.
2. Enter a Cloudflare API token with `Workers Scripts: Edit` permission.
3. Click **Deploy Relay**. The app uploads the Worker automatically.
4. Share the relay URL with friends.

## Manual Deploy with Wrangler

```bash
git clone https://github.com/SlasshyOverhere/SlasshyVault
cd SlasshyVault/src-tauri/relay
mkdir my-relay && cd my-relay && cp ../worker.js .
cat > wrangler.toml << 'EOF'
name = "slasshyvault-together-relay"
main = "worker.js"
compatibility_date = "2026-05-01"
[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]
EOF
npx wrangler deploy
```

Paste the resulting `wss://` URL in Settings → Watch Together.
