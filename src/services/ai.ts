import { invoke } from '@tauri-apps/api/tauri';
import { arch, locale, platform, type as osType, version as osVersion } from '@tauri-apps/api/os';
import { getDefaultAuthServerUrl, getDevSettings, getSocialCredentials, setSocialAccessToken } from './social';
import { isDev } from '../config/social';
import { getGDriveAccessToken } from './gdrive';

export type AiRole = 'user' | 'assistant' | 'system';

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiQuotaResponse {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  window_start_ms: number;
  reset_at_ms: number;
  retry_after_ms: number;
  fingerprint?: {
    has_device_id: boolean;
    has_device_signature: boolean;
  };
  tier?: 'free' | 'upgraded';
  user?: {
    google_id: string | null;
    authenticated: boolean;
  };
  entitlement?: {
    id: number;
    max_chats: number;
    window_days: number;
    expires_at_ms: number;
  } | null;
  ban?: AiBanInfo | null;
  rejected_requests_count?: number;
  rejection_ban_threshold?: number;
  additional_reason_min_words?: number;
  additional_reason_min_chars?: number;
  upgrade_request?: AiUpgradeRequest | null;
}

export interface AiBanInfo {
  is_banned: boolean;
  google_id: string;
  banned_at_ms: number;
  banned_by?: string | null;
  reason?: string | null;
  updated_at_ms?: number;
}

export interface AiRateLimitHeaders {
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
  windowDays: number;
}

export interface AiChatResponse {
  raw: unknown;
  text: string;
  rateLimit: AiRateLimitHeaders | null;
}

export interface AiUpgradeRequest {
  id: number;
  google_id: string;
  status: 'pending' | 'approved' | 'rejected';
  request_type?: 'referral' | 'additional';
  referral_1: string;
  referral_2: string;
  request_reason?: string | null;
  note: string | null;
  entitlement_id: number | null;
  requested_at_ms: number;
  reviewed_at_ms: number | null;
  reviewed_by: string | null;
  review_note: string | null;
}

export interface AiUpgradeEntitlement {
  id: number;
  google_id: string;
  max_chats: number;
  window_days: number;
  expires_at_ms: number;
  reason: string | null;
  granted_by: string | null;
  request_id: number | null;
  revoked_at_ms: number | null;
}

export interface AiUpgradeStatusResponse {
  request: AiUpgradeRequest | null;
  entitlement: AiUpgradeEntitlement | null;
  ban?: AiBanInfo | null;
  rejected_requests_count?: number;
  rejection_ban_threshold?: number;
  additional_reason_min_words?: number;
  additional_reason_min_chars?: number;
  defaults: {
    approved_max_chats: number;
    approved_window_days: number;
    approved_duration_days: number;
  };
}

interface SignedFetchResult<T> {
  data: T;
  rateLimit: AiRateLimitHeaders | null;
}

const AI_INSTALL_ID_KEY = 'streamvault_ai_install_id';
const AI_DEVICE_SIGNATURE_KEY = 'streamvault_ai_device_signature';
const REQUEST_TIMEOUT_MS = 30000;

export class AiApiError extends Error {
  status: number;
  payload?: unknown;
  rateLimit?: AiRateLimitHeaders | null;

  constructor(message: string, status: number, payload?: unknown, rateLimit?: AiRateLimitHeaders | null) {
    super(message);
    this.name = 'AiApiError';
    this.status = status;
    this.payload = payload;
    this.rateLimit = rateLimit;
  }
}

function ensureInstallId(): string {
  const existing = localStorage.getItem(AI_INSTALL_ID_KEY);
  if (existing && existing.trim()) return existing;

  const generated = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  localStorage.setItem(AI_INSTALL_ID_KEY, generated);
  return generated;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(digest);
}

async function getDeviceSignature(installId: string): Promise<string> {
  const cached = localStorage.getItem(AI_DEVICE_SIGNATURE_KEY);
  if (cached && cached.trim()) return cached;

  try {
    const [platformName, osFamily, cpuArch, kernelVersion, localeValue] = await Promise.all([
      platform(),
      osType(),
      arch(),
      osVersion(),
      locale().catch(() => null),
    ]);

    const base = [
      installId,
      platformName,
      osFamily,
      cpuArch,
      kernelVersion,
      localeValue || 'unknown',
    ].join('|');

    const signature = await sha256Hex(base);
    localStorage.setItem(AI_DEVICE_SIGNATURE_KEY, signature);
    return signature;
  } catch (sigError) {
    console.warn('[AI] Failed to get device signature, using fallback:', sigError);
    const fallback = await sha256Hex(`fallback|${installId}`);
    localStorage.setItem(AI_DEVICE_SIGNATURE_KEY, fallback);
    return fallback;
  }
}

function parseRateLimitHeaders(headers: Headers): AiRateLimitHeaders | null {
  const limit = Number(headers.get('x-ratelimit-limit'));
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const resetEpochSeconds = Number(headers.get('x-ratelimit-reset'));
  const windowDays = Number(headers.get('x-ratelimit-window-days'));

  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetEpochSeconds)) {
    return null;
  }

  return {
    limit: Math.max(0, Math.floor(limit)),
    remaining: Math.max(0, Math.floor(remaining)),
    resetEpochSeconds: Math.max(0, Math.floor(resetEpochSeconds)),
    windowDays: Number.isFinite(windowDays) ? Math.max(0, Math.floor(windowDays)) : 0,
  };
}

function extractErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const candidate = 'error' in payload ? (payload as { error: unknown }).error : undefined;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return `AI request failed (${status})`;
}

async function buildSignedHeaders(method: string, path: string, body: unknown): Promise<Record<string, string>> {
  const installId = ensureInstallId();
  const deviceSignature = await getDeviceSignature(installId);

  try {
    return await invoke<Record<string, string>>('ai_sign_headers', {
      method,
      path,
      body: body ?? {},
      installId,
      deviceSignature,
    });
  } catch {
    throw new AiApiError('Failed to sign AI request headers via backend', 503);
  }
}

async function resolveAuthTokenForAi(): Promise<string | null> {
  const stored = getSocialCredentials().accessToken?.trim() || '';
  let token = stored;

  try {
    const fresh = (await getGDriveAccessToken()).trim();
    if (fresh) {
      token = fresh;
      if (fresh !== stored) {
        setSocialAccessToken(fresh);
      }
    }
  } catch (tokenError) {
    console.warn('[AI] Failed to refresh access token, falling back to stored token:', tokenError);
  }

  return token || null;
}

async function signedFetch<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<SignedFetchResult<T>> {
  let mainBackendUrl = getDefaultAuthServerUrl();
  if (isDev) {
    try {
      const devSettings = getDevSettings();
      if (typeof devSettings.authServerUrl === 'string' && devSettings.authServerUrl.trim()) {
        mainBackendUrl = devSettings.authServerUrl.trim();
      }
    } catch (devSettingsError) {
      console.warn('[AI] Ignored malformed dev settings:', devSettingsError);
    }
  }

  if (!mainBackendUrl) {
    throw new AiApiError('Main backend URL is not configured in the app.', 503);
  }

  const url = `${mainBackendUrl}${path}`;
  const headers = await buildSignedHeaders(method, path, body ?? {});
  const accessToken = await resolveAuthTokenForAi();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });

    const rateLimit = parseRateLimitHeaders(response.headers);
    const rawText = await response.text();
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson && rawText ? JSON.parse(rawText) : rawText;

    if (!response.ok) {
      throw new AiApiError(extractErrorMessage(response.status, payload), response.status, payload, rateLimit);
    }

    return {
      data: payload as T,
      rateLimit,
    };
  } catch (error) {
    if (error instanceof AiApiError) {
      throw error;
    }
    if ((error as Error)?.name === 'AbortError') {
      throw new AiApiError('AI request timed out', 504);
    }
    throw new AiApiError((error as Error).message || 'AI request failed', 500);
  } finally {
    clearTimeout(timeout);
  }
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const textValue = 'text' in item ? (item as { text: unknown }).text : undefined;
          if (typeof textValue === 'string') return textValue;
        }
        return '';
      })
      .filter(Boolean);

    return parts.join('\n').trim();
  }
  return '';
}

function extractAssistantText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object') return '';

  const payload = raw as { [key: string]: unknown };
  const directKeys = ['text', 'answer', 'output_text', 'response', 'content', 'message'];

  for (const key of directKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  if (payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)) {
    const messageObj = payload.message as { content: unknown };
    const fromMessage = extractTextFromMessageContent(messageObj.content);
    if (fromMessage) return fromMessage;
  }

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const firstChoice = payload.choices[0] as { [key: string]: unknown };
    if (typeof firstChoice.text === 'string' && firstChoice.text.trim()) {
      return firstChoice.text.trim();
    }
    if (firstChoice.message && typeof firstChoice.message === 'object' && !Array.isArray(firstChoice.message)) {
      const messageObj = firstChoice.message as { content: unknown };
      const fromChoice = extractTextFromMessageContent(messageObj.content);
      if (fromChoice) return fromChoice;
    }
  }

  return JSON.stringify(raw, null, 2);
}

export async function getAiQuota(): Promise<{ quota: AiQuotaResponse; rateLimit: AiRateLimitHeaders | null }> {
  const result = await signedFetch<AiQuotaResponse>('/api/ai/quota', 'GET');
  return {
    quota: result.data,
    rateLimit: result.rateLimit,
  };
}

export async function sendAiChat(payload: { messages: AiMessage[]; [key: string]: unknown }): Promise<AiChatResponse> {
  const result = await signedFetch<unknown>('/api/ai/chat', 'POST', payload);
  return {
    raw: result.data,
    text: extractAssistantText(result.data),
    rateLimit: result.rateLimit,
  };
}

export async function getAiUpgradeRequestStatus(): Promise<AiUpgradeStatusResponse> {
  const result = await signedFetch<AiUpgradeStatusResponse>('/api/ai/upgrade-request', 'GET');
  return result.data;
}

export async function submitAiUpgradeRequest(payload: {
  referral1: string;
  referral2: string;
  note?: string;
}): Promise<{ success: boolean; request: AiUpgradeRequest }> {
  const body = {
    request_type: 'referral' as const,
    referral_1: payload.referral1,
    referral_2: payload.referral2,
    note: payload.note || '',
  };
  const result = await signedFetch<{ success: boolean; request: AiUpgradeRequest }>(
    '/api/ai/upgrade-request',
    'POST',
    body
  );
  return result.data;
}

export async function submitAiAdditionalUpgradeRequest(payload: {
  reason: string;
  note?: string;
}): Promise<{ success: boolean; request: AiUpgradeRequest }> {
  const body = {
    request_type: 'additional' as const,
    request_reason: payload.reason,
    note: payload.note || '',
  };
  const result = await signedFetch<{ success: boolean; request: AiUpgradeRequest }>(
    '/api/ai/upgrade-request',
    'POST',
    body
  );
  return result.data;
}
