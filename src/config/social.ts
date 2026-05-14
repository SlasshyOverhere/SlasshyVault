// Social Service Configuration

export const SOCIAL_STORAGE_KEY = 'slasshyvault_social';
export const PROFILE_CACHE_KEY = 'slasshyvault_profile_cache';
export const SOCIAL_LAST_SYNC_KEY = 'slasshyvault_social_last_sync';
export const SOCIAL_SYNCED_ACTIVITY_KEYS_KEY = 'slasshyvault_social_synced_activity_keys';
export const SOCIAL_DEFAULT_SYNC_CURSOR = '1970-01-01 00:00:00';
export const MAX_SYNCED_ACTIVITY_KEYS = 1000;
export const DEV_SETTINGS_KEY = 'slasshyvault_dev_settings';
export const DEFAULT_AUTH_SERVER_URL = (
  (import.meta.env.VITE_AUTH_SERVER_URL as string | undefined)?.trim()
  || 'https://streamvault-backend-server.onrender.com'
);
export const PROFILE_SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutes
export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAY_BASE = 5000; // 5 seconds base delay

// Check if running in dev mode
export const isDev = import.meta.env.DEV;
