/**
 * StreamVault Social Service
 *
 * Handles all social features including:
 * - User profiles and privacy settings
 * - Friends management
 * - Activity feed
 * - Real-time chat
 * - "Currently watching" status
 */

// Types
export interface PrivacySettings {
  showStatsToFriends: boolean;
  showActivityToFriends: boolean;
  showCurrentlyWatching: boolean;
  allowFriendRequests: boolean;
}

export interface UserStats {
  totalWatchTime: number;
  moviesWatched: number;
  tvEpisodesWatched: number;
  favoriteGenres: string[];
  lastUpdated: number;
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  avatarUrl: string | null;
  bio?: string;
  favoriteGenre?: string;
  location?: string;
  joinedAt?: number;
  createdAt?: number;
  privacySettings: PrivacySettings;
  stats: UserStats;
}

export interface Friend {
  id: string;
  name: string;
  avatar: string | null;
  since: number;
  isOnline?: boolean;
  currentlyWatching?: CurrentlyWatching | null;
}

export interface FriendRequest {
  fromId: string;
  fromName: string;
  fromAvatar: string | null;
  sentAt: number;
}

export interface Activity {
  id: string;
  type: 'watched_movie' | 'watched_episode';
  contentId: string;
  title: string;
  genres?: string[];
  contentType: 'movie' | 'tv';
  posterPath?: string;
  season?: number;
  episode?: number;
  duration?: number;
  timestamp: number;
  userId?: string;
  userName?: string;
  userAvatar?: string;
}

export interface CurrentlyWatching {
  contentId: string;
  title: string;
  contentType: 'movie' | 'tv';
  posterPath?: string;
  season?: number;
  episode?: number;
  startedAt: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  timestamp: number;
}

export interface SocialEvent {
  type: 'friend_request' | 'friend_accepted' | 'friend_online' | 'friend_offline' |
        'friend_activity' | 'currently_watching' | 'chat_message' | 'typing' |
        'chat_message_sent' | 'heartbeat_ack' | 'profile_updated';
  [key: string]: unknown;
}

// Configuration
const SOCIAL_STORAGE_KEY = 'streamvault_social';
const PROFILE_CACHE_KEY = 'streamvault_profile_cache';
const DEV_SETTINGS_KEY = 'streamvault_dev_settings';
const DEFAULT_AUTH_SERVER_URL = 'https://streamvault-auth.onrender.com';
const PROFILE_SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE = 5000; // 5 seconds base delay

// Check if running in dev mode
export const isDev = import.meta.env.DEV;

// Get the auth server URL (supports dev override)
function getAuthServerUrl(): string {
  if (isDev) {
    try {
      const devSettings = localStorage.getItem(DEV_SETTINGS_KEY);
      if (devSettings) {
        const parsed = JSON.parse(devSettings);
        if (parsed.authServerUrl) {
          return parsed.authServerUrl;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }
  return import.meta.env.VITE_AUTH_SERVER_URL || DEFAULT_AUTH_SERVER_URL;
}

// Dev settings management
export function getDevSettings(): { authServerUrl: string } {
  try {
    const stored = localStorage.getItem(DEV_SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore
  }
  return { authServerUrl: DEFAULT_AUTH_SERVER_URL };
}

export function setDevSettings(settings: { authServerUrl: string }): void {
  try {
    localStorage.setItem(DEV_SETTINGS_KEY, JSON.stringify(settings));
    // Reconnect WebSocket with new URL
    if (socialWs) {
      socialWs.close();
      socialWs = null;
    }
    if (accessToken) {
      connectSocialWebSocket();
    }
  } catch (error) {
    console.error('[Social] Failed to save dev settings:', error);
  }
}

export function getDefaultAuthServerUrl(): string {
  return DEFAULT_AUTH_SERVER_URL;
}

// State
let accessToken: string | null = null;
let googleId: string | null = null;
let socialWs: WebSocket | null = null;
let wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts: number = 0;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let profileSyncInterval: ReturnType<typeof setInterval> | null = null;
let cachedProfile: UserProfile | null = null;
const eventListeners: Map<string, Set<(data: SocialEvent) => void>> = new Map();

/**
 * Storage helpers
 */
function getSocialStorage(): { accessToken?: string; googleId?: string } {
  try {
    const stored = localStorage.getItem(SOCIAL_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function setSocialStorage(data: { accessToken?: string; googleId?: string }) {
  try {
    const current = getSocialStorage();
    localStorage.setItem(SOCIAL_STORAGE_KEY, JSON.stringify({ ...current, ...data }));
  } catch (error) {
    console.error('[Social] Storage error:', error);
  }
}

/**
 * Initialize social features with access token
 */
export async function initSocial(token: string): Promise<UserProfile | null> {
  accessToken = token;
  setSocialStorage({ accessToken: token });

  const serverUrl = getAuthServerUrl();
  console.log('[Social] initSocial called');
  console.log('[Social] Using server URL:', serverUrl);
  console.log('[Social] Token length:', token?.length);

  try {
    const url = `${serverUrl}/api/social/init`;
    console.log('[Social] Fetching:', url);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('[Social] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Social] Init failed:', response.status, errorText);
      throw new Error(`Server error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[Social] Init response:', data);

    if (!data.success || !data.profile) {
      console.error('[Social] Invalid response:', data);
      return null;
    }

    googleId = data.profile.id;
    setSocialStorage({ googleId });

    // Cache profile locally
    setProfileCache(data.profile);

    // Connect WebSocket for real-time features
    connectSocialWebSocket();

    // Start periodic sync
    startProfileSync();

    return data.profile;
  } catch (error) {
    console.error('[Social] Init error:', error);
    return null;
  }
}

/**
 * Check if social is initialized
 */
export function isSocialInitialized(): boolean {
  const storage = getSocialStorage();
  return !!(storage.accessToken && storage.googleId);
}

/**
 * Get stored credentials
 */
export function getSocialCredentials(): { accessToken: string | null; googleId: string | null } {
  const storage = getSocialStorage();
  accessToken = storage.accessToken || null;
  googleId = storage.googleId || null;
  return { accessToken, googleId };
}

/**
 * Restore social connection on app start
 */
export async function restoreSocialConnection(): Promise<boolean> {
  const { accessToken: token } = getSocialCredentials();
  if (!token) return false;

  // Load cached profile immediately for instant UI
  getProfileCache();

  try {
    const profile = await syncProfile();
    if (profile) {
      connectSocialWebSocket();
      startProfileSync();
      return true;
    }
  } catch {
    // Token expired or invalid
    clearSocialStorage();
  }
  return false;
}

function clearSocialStorage() {
  localStorage.removeItem(SOCIAL_STORAGE_KEY);
  localStorage.removeItem(PROFILE_CACHE_KEY);
  accessToken = null;
  googleId = null;
  cachedProfile = null;
}

/**
 * Profile cache helpers
 */
function getProfileCache(): UserProfile | null {
  try {
    const stored = localStorage.getItem(PROFILE_CACHE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      cachedProfile = data.profile;
      return cachedProfile;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function setProfileCache(profile: UserProfile): void {
  try {
    cachedProfile = profile;
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
      profile,
      lastSynced: Date.now()
    }));
  } catch (error) {
    console.error('[Social] Profile cache error:', error);
  }
}

/**
 * Get cached profile instantly (for UI)
 */
export function getCachedProfile(): UserProfile | null {
  if (cachedProfile) return cachedProfile;
  return getProfileCache();
}

/**
 * Sync profile from cloud and update cache
 */
export async function syncProfile(): Promise<UserProfile | null> {
  try {
    const profile = await apiGet<UserProfile>('/api/social/profile');
    if (profile) {
      setProfileCache(profile);
      emitEvent('profile_updated', { type: 'profile_updated', profile });
    }
    return profile;
  } catch (error) {
    console.error('[Social] Profile sync error:', error);
    return getCachedProfile();
  }
}

/**
 * Start periodic profile sync
 */
function startProfileSync() {
  stopProfileSync();
  // Initial sync
  syncProfile();
  // Periodic sync every 10 minutes
  profileSyncInterval = setInterval(() => {
    syncProfile();
  }, PROFILE_SYNC_INTERVAL);
}

function stopProfileSync() {
  if (profileSyncInterval) {
    clearInterval(profileSyncInterval);
    profileSyncInterval = null;
  }
}

/**
 * WebSocket connection for real-time features
 */
function connectSocialWebSocket() {
  if (socialWs?.readyState === WebSocket.OPEN) return;

  // Prevent excessive reconnection attempts
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('[Social WS] Max reconnection attempts reached, stopping attempts');
    return;
  }

  const authServerUrl = getAuthServerUrl();
  const wsUrl = authServerUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  
  try {
    socialWs = new WebSocket(`${wsUrl}/ws/social?token=${accessToken}`);

    socialWs.onopen = () => {
      console.log('[Social WS] Connected');
      reconnectAttempts = 0; // Reset attempts on successful connection
      startHeartbeat();
    };

    socialWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SocialEvent;
        emitEvent(data.type, data);
      } catch (error) {
        console.error('[Social WS] Parse error:', error);
      }
    };

    socialWs.onclose = (event) => {
      console.log('[Social WS] Disconnected:', event.code, event.reason);
      stopHeartbeat();
      
      // Only attempt reconnection if it wasn't a manual close
      if (event.code !== 1000) { // 1000 means normal closure
        scheduleReconnect();
      }
    };

    socialWs.onerror = (error) => {
      console.error('[Social WS] Error:', error);
    };
  } catch (error) {
    console.error('[Social WS] Failed to create WebSocket:', error);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimeout) return;
  
  // Calculate delay with exponential backoff
  const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  
  console.log(`[Social WS] Scheduling reconnection in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  wsReconnectTimeout = setTimeout(() => {
    wsReconnectTimeout = null;
    if (accessToken) {
      connectSocialWebSocket();
    }
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socialWs?.readyState === WebSocket.OPEN) {
      socialWs.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Event handling
 */
export function onSocialEvent(eventType: string, callback: (data: SocialEvent) => void) {
  if (!eventListeners.has(eventType)) {
    eventListeners.set(eventType, new Set());
  }
  eventListeners.get(eventType)!.add(callback);

  return () => {
    eventListeners.get(eventType)?.delete(callback);
  };
}

function emitEvent(eventType: string, data: SocialEvent) {
  eventListeners.get(eventType)?.forEach(cb => cb(data));
  eventListeners.get('*')?.forEach(cb => cb(data)); // Wildcard listeners
}

/**
 * API Helpers
 */
async function apiGet<T>(endpoint: string, retries = 3): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${getAuthServerUrl()}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Social API] GET ${endpoint} failed (attempt ${attempt + 1}/${retries}):`, error);
      
      if (attempt < retries - 1) {
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  
  throw lastError!;
}

async function apiPost<T>(endpoint: string, body?: object, retries = 3): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${getAuthServerUrl()}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Social API] POST ${endpoint} failed (attempt ${attempt + 1}/${retries}):`, error);
      
      if (attempt < retries - 1) {
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  
  throw lastError!;
}

async function apiPatch<T>(endpoint: string, body: object, retries = 3): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${getAuthServerUrl()}${endpoint}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Social API] PATCH ${endpoint} failed (attempt ${attempt + 1}/${retries}):`, error);
      
      if (attempt < retries - 1) {
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  
  throw lastError!;
}

async function apiDelete(endpoint: string, retries = 3): Promise<void> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${getAuthServerUrl()}${endpoint}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Social API] DELETE ${endpoint} failed (attempt ${attempt + 1}/${retries}):`, error);
      
      if (attempt < retries - 1) {
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  
  if (lastError) {
    throw lastError;
  }
}

/**
 * Profile API
 */
export async function getProfile(): Promise<UserProfile | null> {
  try {
    return await apiGet<UserProfile>('/api/social/profile');
  } catch {
    return null;
  }
}

export async function updateProfile(updates: {
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  favoriteGenre?: string;
  location?: string;
}): Promise<UserProfile> {
  const profile = await apiPatch<UserProfile>('/api/social/profile', updates);
  // Update local cache immediately
  if (profile) {
    setProfileCache(profile);
    emitEvent('profile_updated', { type: 'profile_updated', profile });
  }
  return profile;
}

export async function updatePrivacySettings(settings: Partial<PrivacySettings>): Promise<PrivacySettings> {
  return apiPatch<PrivacySettings>('/api/social/privacy', settings);
}

export async function getFriendProfile(friendId: string): Promise<UserProfile | null> {
  try {
    return await apiGet<UserProfile>(`/api/social/profile/${friendId}`);
  } catch {
    return null;
  }
}

/**
 * Friends API
 */
export async function getFriends(): Promise<{ friends: Friend[]; online: Friend[] }> {
  return apiGet<{ friends: Friend[]; online: Friend[] }>('/api/social/friends');
}

export async function getPendingRequests(): Promise<FriendRequest[]> {
  return apiGet<FriendRequest[]>('/api/social/friends/requests');
}

export async function sendFriendRequest(targetUserId: string): Promise<void> {
  await apiPost('/api/social/friends/request', { targetUserId });
}

export async function acceptFriendRequest(fromUserId: string): Promise<void> {
  await apiPost('/api/social/friends/accept', { fromUserId });
}

export async function rejectFriendRequest(fromUserId: string): Promise<void> {
  await apiPost('/api/social/friends/reject', { fromUserId });
}

export async function removeFriend(friendId: string): Promise<void> {
  await apiDelete(`/api/social/friends/${friendId}`);
}

export async function searchUsers(query: string): Promise<{ id: string; displayName: string; avatarUrl: string | null }[]> {
  return apiGet(`/api/social/search?q=${encodeURIComponent(query)}`);
}

/**
 * Activity API
 */
export async function logActivity(activity: Omit<Activity, 'id' | 'timestamp'>): Promise<Activity> {
  return apiPost<Activity>('/api/social/activity', activity);
}

export async function getMyActivity(): Promise<Activity[]> {
  return apiGet<Activity[]>('/api/social/activity');
}

export async function getFriendsActivity(filters?: {
  contentType?: 'movie' | 'tv';
  genre?: string;
  userId?: string
}): Promise<Activity[]> {
  const params = new URLSearchParams();
  if (filters?.contentType) params.set('contentType', filters.contentType);
  if (filters?.genre) params.set('genre', filters.genre);
  if (filters?.userId) params.set('userId', filters.userId);

  const queryString = params.toString();
  return apiGet<Activity[]>(`/api/social/activity/feed${queryString ? `?${queryString}` : ''}`);
}

/**
 * Stats API
 */
export async function syncStats(stats: Partial<UserStats>): Promise<UserStats> {
  return apiPost<UserStats>('/api/social/stats/sync', stats);
}

/**
 * Currently Watching
 */
export function setCurrentlyWatching(content: Omit<CurrentlyWatching, 'startedAt'> | null): void {
  if (socialWs?.readyState === WebSocket.OPEN) {
    if (content) {
      socialWs.send(JSON.stringify({ type: 'currently_watching', content }));
    } else {
      socialWs.send(JSON.stringify({ type: 'stop_watching' }));
    }
  }
}

export async function getFriendsWatching(): Promise<(CurrentlyWatching & { userId: string; userName: string; userAvatar?: string })[]> {
  return apiGet('/api/social/watching');
}

/**
 * Chat API
 */
export async function getChatHistory(friendId: string): Promise<ChatMessage[]> {
  return apiGet<ChatMessage[]>(`/api/social/chat/${friendId}`);
}

export function sendChatMessage(friendId: string, text: string): void {
  if (socialWs?.readyState === WebSocket.OPEN) {
    socialWs.send(JSON.stringify({
      type: 'chat_message',
      friendId,
      text
    }));
  }
}

export function sendTypingIndicator(friendId: string): void {
  if (socialWs?.readyState === WebSocket.OPEN) {
    socialWs.send(JSON.stringify({
      type: 'typing',
      friendId
    }));
  }
}

/**
 * Disconnect and cleanup
 */
export function disconnectSocial(): void {
  stopHeartbeat();
  stopProfileSync();
  
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }
  
  if (socialWs) {
    // Close with normal closure code
    socialWs.close(1000, "Client disconnected");
    socialWs = null;
  }
  
  // Clear all event listeners
  eventListeners.clear();
  
  clearSocialStorage();
}

/**
 * Helper to format watch time
 */
export function formatWatchTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

/**
 * Helper to format relative time
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * Helper to detect when user scrolls to the end of a container
 */
export function onScrollEnd(element: HTMLElement, callback: () => void) {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        callback();
      }
    },
    { threshold: 1.0 }
  );

  // Create a sentinel element at the end of the list
  const sentinel = document.createElement('div');
  sentinel.style.height = '1px';
  element.appendChild(sentinel);
  
  observer.observe(sentinel);
  
  return () => {
    observer.unobserve(sentinel);
    element.removeChild(sentinel);
  };
}
