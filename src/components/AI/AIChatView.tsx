import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, AtSign, Bot, ChevronDown, ChevronUp, ExternalLink, Loader2, RefreshCw, Send, ShieldCheck, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import {
  type MediaItem,
  getLibraryFiltered,
  getTvDetails,
  getTvSeasonEpisodes,
  searchTmdb,
} from '@/services/api';
import {
  AiApiError,
  AiMessage,
  AiQuotaResponse,
  AiRateLimitHeaders,
  AiUpgradeStatusResponse,
  getAiQuota,
  getAiUpgradeRequestStatus,
  sendAiChat,
  submitAiAdditionalUpgradeRequest,
  submitAiUpgradeRequest,
} from '@/services/ai';
import { getGDriveAiChatHistory, saveGDriveAiChatHistory } from '@/services/gdrive';
import { getDefaultAuthServerUrl, getDevSettings, onSocialEvent, type SocialEvent } from '@/services/social';
import { isDev } from '@/config/social';

interface ChatLine {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface AiUpgradeLiveNotice {
  id: string;
  title: string;
  description: string;
  action: string;
  createdAt: number;
}

interface LinkedMediaItem {
  key: string;
  id: number;
  title: string;
  year?: number;
  media_type: 'movie' | 'tvshow' | 'tvepisode';
  source: 'local' | 'drive';
  tmdb_id?: string;
  season_number?: number;
  episode_number?: number;
  episode_title?: string;
}

interface MentionMatchState {
  query: string;
  start: number;
  end: number;
}

interface AIChatViewProps {
  launchItem?: MediaItem | null;
  launchNonce?: number;
  onLaunchHandled?: () => void;
}

type TmdbProfileSectionKey =
  | 'cast'
  | 'keyCrew'
  | 'productionCompanies'
  | 'genres'
  | 'releaseDetails'
  | 'plotSummary'
  | 'notableFacts'
  | 'similarTitles'
  | 'officialLinks';

interface TmdbProfileLink {
  label: string;
  url: string;
}

interface TmdbDeepProfileData {
  title: string;
  year: string | null;
  sections: Record<TmdbProfileSectionKey, string[]>;
  links: TmdbProfileLink[];
}

type TmdbProfilePanelKey = 'overview' | 'cast' | 'crew' | 'facts' | 'similar' | 'links';

interface TmdbTargetRef {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tmdbUrl: string;
}

interface TmdbMoreInfoData {
  title: string;
  subtitle: string | null;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tmdbUrl: string;
  imdbUrl: string | null;
  homepage: string | null;
  overview: string | null;
  tagline: string | null;
  genres: string[];
  runtimeText: string | null;
  statusText: string | null;
  releaseText: string | null;
  ratingText: string | null;
  popularityText: string | null;
  financials: string[];
  production: string[];
  languages: string[];
  keywords: string[];
  cast: Array<{ name: string; detail?: string | null }>;
  crew: Array<{ name: string; detail: string }>;
  recommendations: string[];
  similar: string[];
  providers: { region: string; flatrate: string[]; rent: string[]; buy: string[] } | null;
  releaseMeta: string[];
  mediaAssets: string[];
}

const LOCAL_HISTORY_FALLBACK_KEY = 'streamvault_ai_beta_history_v1';
const MAX_HISTORY_LINES = 40;
const DEFAULT_AI_MODEL = (import.meta.env.VITE_AI_MODEL || 'llama-3.1-8b-instant').trim();
const MAX_LINKED_ITEMS = 4;
const MAX_MENTION_RESULTS = 40;
const IST_TIMEZONE = 'Asia/Kolkata';
const usdToInrRateRaw = Number(import.meta.env.VITE_AI_USD_TO_INR_RATE);
const USD_TO_INR_RATE = Number.isFinite(usdToInrRateRaw) && usdToInrRateRaw > 0
  ? usdToInrRateRaw
  : 83;

const PROMPT_CHIPS = [
  'Find a sci-fi thriller from the last 5 years',
  'Recommend underrated detective movies',
  'What should I watch if I liked Interstellar?',
  'Give me 5 comfort TV shows',
];

function formatReset(resetAtMs?: number): string {
  if (!resetAtMs || Number.isNaN(resetAtMs)) return '--';
  const date = new Date(resetAtMs);
  return `${date.toLocaleDateString('en-IN', { timeZone: IST_TIMEZONE })} ${date.toLocaleTimeString('en-IN', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} IST`;
}

function formatIstTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.toLocaleTimeString('en-IN', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} IST`;
}

function formatPolicy(quota: AiQuotaResponse | null, rateLimit: AiRateLimitHeaders | null): string {
  const chats = quota?.limit || 10;
  const days = rateLimit?.windowDays || quota?.entitlement?.window_days || 7;
  return `${chats} chats / ${days} days`;
}

function createEmptyTmdbProfileSections(): Record<TmdbProfileSectionKey, string[]> {
  return {
    cast: [],
    keyCrew: [],
    productionCompanies: [],
    genres: [],
    releaseDetails: [],
    plotSummary: [],
    notableFacts: [],
    similarTitles: [],
    officialLinks: [],
  };
}

function cleanTmdbProfileLine(value: string): string {
  const cleaned = value
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*[-=*_]{3,}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^[-=*_~]{3,}$/.test(cleaned)) return '';
  return cleaned;
}

function normalizeTmdbSectionLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[:]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveTmdbProfileSection(label: string): TmdbProfileSectionKey | null {
  const normalized = normalizeTmdbSectionLabel(label);
  if (!normalized) return null;

  if (normalized === 'cast' || normalized === 'main cast') return 'cast';
  if (
    normalized === 'key crew'
    || normalized === 'crew'
    || normalized === 'main crew'
    || normalized === 'notable crew'
  ) {
    return 'keyCrew';
  }
  if (
    normalized === 'production companies'
    || normalized === 'production company'
    || normalized === 'production'
    || normalized === 'studios'
  ) {
    return 'productionCompanies';
  }
  if (normalized === 'genres' || normalized === 'genre') return 'genres';
  if (
    normalized === 'release details'
    || normalized === 'release info'
    || normalized === 'release information'
    || normalized === 'runtime'
    || normalized === 'release'
  ) {
    return 'releaseDetails';
  }
  if (
    normalized === 'plot summary'
    || normalized === 'plot'
    || normalized === 'overview'
    || normalized === 'story summary'
  ) {
    return 'plotSummary';
  }
  if (
    normalized === 'notable facts'
    || normalized === 'facts'
    || normalized === 'trivia'
  ) {
    return 'notableFacts';
  }
  if (
    normalized === 'similar recommended titles'
    || normalized === 'similar titles'
    || normalized === 'recommended titles'
    || normalized === 'recommendations'
    || normalized === 'similar recommended'
  ) {
    return 'similarTitles';
  }
  if (
    normalized === 'official places to learn more'
    || normalized === 'official links'
    || normalized === 'learn more'
    || normalized === 'links'
  ) {
    return 'officialLinks';
  }

  return null;
}

function normalizeProfileUrlCandidate(url: string): string {
  const trimmed = url.trim().replace(/[),.;]+$/, '');
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return trimmed;
  }
}

function inferProfileLinkLabel(url: string): string {
  if (/themoviedb\.org/i.test(url)) return 'TMDB';
  if (/imdb\.com/i.test(url)) return 'IMDb';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return 'Reference';
  }
}

function extractTmdbProfileLinks(line: string): TmdbProfileLink[] {
  const links: TmdbProfileLink[] = [];

  const markdownMatches = line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi);
  for (const match of markdownMatches) {
    const label = cleanTmdbProfileLine(match[1] || '');
    const url = normalizeProfileUrlCandidate(match[2] || '');
    if (!url) continue;
    links.push({
      label: label || inferProfileLinkLabel(url),
      url,
    });
  }

  const urlMatches = line.matchAll(/(https?:\/\/[^\s<>()]+)/gi);
  for (const match of urlMatches) {
    const url = normalizeProfileUrlCandidate(match[1] || '');
    if (!url) continue;
    let label = inferProfileLinkLabel(url);
    const prefix = cleanTmdbProfileLine(line.replace(match[1], '')).replace(/[:\-]+$/, '').trim();
    if (prefix && /^[a-z0-9 ./'&-]{2,40}$/i.test(prefix)) {
      label = prefix;
    }
    links.push({ label, url });
  }

  return links;
}

function parseTmdbTargetFromUrl(url: string): TmdbTargetRef | null {
  const match = url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
  if (!match?.[1] || !match[2]) return null;
  const tmdbId = Number(match[2]);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;
  const mediaType = match[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
  return {
    mediaType,
    tmdbId: Math.floor(tmdbId),
    tmdbUrl: `https://www.themoviedb.org/${mediaType}/${Math.floor(tmdbId)}`,
  };
}

function extractTmdbTargetFromProfile(profile: TmdbDeepProfileData): TmdbTargetRef | null {
  for (const link of profile.links) {
    const fromLink = parseTmdbTargetFromUrl(link.url);
    if (fromLink) return fromLink;
  }

  for (const line of profile.sections.officialLinks) {
    const matches = line.match(/https?:\/\/[^\s<>()]+/gi) || [];
    for (const match of matches) {
      const fromLine = parseTmdbTargetFromUrl(match);
      if (fromLine) return fromLine;
    }
  }

  return null;
}

function extractImdbUrlFromProfile(profile: TmdbDeepProfileData): string | null {
  for (const link of profile.links) {
    if (/imdb\.com\/title\/tt\d+/i.test(link.url)) {
      const clean = normalizeProfileUrlCandidate(link.url);
      return clean ? (clean.endsWith('/') ? clean : `${clean}/`) : null;
    }
  }
  return null;
}

function toStringArray(value: unknown, max = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      const row = entry as Record<string, unknown>;
      if (typeof row.name === 'string') return row.name.trim();
      if (typeof row.title === 'string') return row.title.trim();
      return '';
    })
    .filter(Boolean)
    .slice(0, max);
}

function toCastModalRows(value: unknown, max = 24): Array<{ name: string; detail?: string | null }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ name: string; detail?: string | null }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const character = typeof row.character === 'string' ? row.character.trim() : '';
    rows.push({ name, detail: character || null });
    if (rows.length >= max) break;
  }
  return rows;
}

function toCrewModalRows(value: unknown, max = 24): Array<{ name: string; detail: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ name: string; detail: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const job = typeof row.job === 'string' ? row.job.trim() : '';
    if (!name || !job) continue;
    rows.push({ name, detail: job });
    if (rows.length >= max) break;
  }
  return rows;
}

function toRecommendationModalRows(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const rows: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const title = typeof row.title === 'string'
      ? row.title.trim()
      : (typeof row.name === 'string' ? row.name.trim() : '');
    if (!title) continue;
    const releaseDate = typeof row.release_date === 'string'
      ? row.release_date.trim()
      : (typeof row.first_air_date === 'string' ? row.first_air_date.trim() : '');
    const year = releaseDate ? releaseDate.slice(0, 4) : '';
    const rating = Number(row.vote_average);
    const ratingText = Number.isFinite(rating) && rating > 0 ? ` • ${rating.toFixed(1)}/10` : '';
    rows.push(`${title}${year ? ` (${year})` : ''}${ratingText}`);
    if (rows.length >= max) break;
  }
  return rows;
}

function toProviderDialog(value: unknown): { region: string; flatrate: string[]; rent: string[]; buy: string[] } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const region = typeof row.region === 'string' ? row.region.trim() : '';
  if (!region) return null;
  return {
    region,
    flatrate: toStringArray(row.flatrate, 12),
    rent: toStringArray(row.rent, 12),
    buy: toStringArray(row.buy, 12),
  };
}

function extractTmdbProfileTitle(line: string): { title: string; year: string | null } | null {
  const normalized = cleanTmdbProfileLine(line);
  if (!/deep tmdb profile/i.test(normalized)) return null;

  const primary = normalized.match(/deep\s+tmdb\s+profile(?:\s+for|:)?\s*["“]?(.+?)["”]?\s*(\((?:19|20)\d{2}\))?/i);
  if (primary && primary[1]) {
    return {
      title: primary[1].trim().replace(/[.:]+$/, ''),
      year: primary[2] ? primary[2].replace(/[()]/g, '') : null,
    };
  }

  return null;
}

function dedupePreserveOrder(items: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const item of items) {
    const cleaned = cleanTmdbProfileLine(item);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cleaned);
    if (deduped.length >= maxItems) break;
  }

  return deduped;
}

function parseTmdbDeepProfileForCard(content: string): TmdbDeepProfileData | null {
  if (!content || content.trim().length < 120) return null;

  const lower = content.toLowerCase();
  const sectionHitCount = [
    'cast',
    'key crew',
    'production companies',
    'genres',
    'release details',
    'plot summary',
    'notable facts',
    'similar',
    'official places to learn more',
  ].reduce((count, token) => count + (lower.includes(token) ? 1 : 0), 0);

  if (!/deep tmdb profile/i.test(content) && sectionHitCount < 5) {
    return null;
  }

  const sections = createEmptyTmdbProfileSections();
  const links: TmdbProfileLink[] = [];
  const seenLinkUrls = new Set<string>();

  let title = '';
  let year: string | null = null;
  let currentSection: TmdbProfileSectionKey | null = null;

  const lines = content.replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const trimmedRaw = rawLine.trim();
    if (!trimmedRaw) continue;

    const cleaned = cleanTmdbProfileLine(trimmedRaw);
    if (!cleaned) continue;

    if (!title) {
      const titleData = extractTmdbProfileTitle(cleaned);
      if (titleData) {
        title = titleData.title;
        year = titleData.year;
        continue;
      }
    }

    const inlineSectionMatch = cleaned.match(/^([^:]{2,90}):\s+(.+)$/);
    if (inlineSectionMatch) {
      const sectionKey = resolveTmdbProfileSection(inlineSectionMatch[1]);
      if (sectionKey) {
        currentSection = sectionKey;
        const value = cleanTmdbProfileLine(inlineSectionMatch[2]);
        if (value) {
          sections[sectionKey].push(value);
          if (sectionKey === 'officialLinks') {
            for (const link of extractTmdbProfileLinks(value)) {
              const normalizedUrl = link.url.toLowerCase();
              if (seenLinkUrls.has(normalizedUrl)) continue;
              seenLinkUrls.add(normalizedUrl);
              links.push(link);
            }
          }
        }
        continue;
      }
    }

    const headingLabel = cleaned.replace(/:$/, '');
    const headingSection = resolveTmdbProfileSection(headingLabel);
    if (
      headingSection
      && (
        trimmedRaw.includes(':')
        || trimmedRaw.startsWith('#')
        || /^\*\*[^*]+\*\*$/.test(trimmedRaw)
      )
    ) {
      currentSection = headingSection;
      continue;
    }

    if (!currentSection) {
      if (!title && cleaned.length <= 120 && !/deep tmdb profile/i.test(cleaned)) {
        const titleWithYear = cleaned.match(/^(.+?)\s*\(((?:19|20)\d{2})\)$/);
        if (titleWithYear?.[1]) {
          title = titleWithYear[1].trim();
          year = titleWithYear[2] || null;
        } else {
          title = cleaned;
        }
      }
      continue;
    }

    sections[currentSection].push(cleaned);
    if (currentSection === 'officialLinks') {
      for (const link of extractTmdbProfileLinks(cleaned)) {
        const normalizedUrl = link.url.toLowerCase();
        if (seenLinkUrls.has(normalizedUrl)) continue;
        seenLinkUrls.add(normalizedUrl);
        links.push(link);
      }
    }
  }

  if (!title) {
    const quotedTitle = content.match(/["“]([^"”]{2,120})["”]/);
    if (quotedTitle?.[1]) {
      title = quotedTitle[1].trim();
    }
  }
  if (!title) title = 'Movie Profile';

  (Object.keys(sections) as TmdbProfileSectionKey[]).forEach((key) => {
    const maxBySection = key === 'plotSummary'
      ? 3
      : key === 'cast'
        ? 14
        : key === 'similarTitles'
          ? 12
          : 10;
    sections[key] = dedupePreserveOrder(sections[key], maxBySection);
  });

  if (links.length === 0) {
    for (const fallbackLink of extractTmdbProfileLinks(content)) {
      const normalizedUrl = fallbackLink.url.toLowerCase();
      if (seenLinkUrls.has(normalizedUrl)) continue;
      seenLinkUrls.add(normalizedUrl);
      links.push(fallbackLink);
    }
  }

  const filledSectionCount = [
    sections.cast,
    sections.keyCrew,
    sections.productionCompanies,
    sections.genres,
    sections.releaseDetails,
    sections.plotSummary,
    sections.notableFacts,
    sections.similarTitles,
  ].filter((items) => items.length > 0).length;

  if (filledSectionCount < 3) return null;

  return {
    title,
    year,
    sections,
    links,
  };
}

function TmdbDeepProfileCard({
  profile,
  onMoreInfo,
}: {
  profile: TmdbDeepProfileData;
  onMoreInfo?: () => void;
}) {
  const [activePanel, setActivePanel] = useState<TmdbProfilePanelKey>('overview');
  const [expanded, setExpanded] = useState(false);

  const topGenres = profile.sections.genres.slice(0, 4);
  const plotText = profile.sections.plotSummary.join(' ');
  const releaseHighlights = profile.sections.releaseDetails.slice(0, 4);
  const productionHighlights = profile.sections.productionCompanies.slice(0, 4);
  const facts = dedupePreserveOrder(
    [...profile.sections.notableFacts, ...releaseHighlights, ...productionHighlights],
    14
  );
  const officialLabelItems = dedupePreserveOrder(
    profile.sections.officialLinks.filter((item) => item && !/^https?:\/\//i.test(item)),
    10
  );

  const panelItems: Array<{ key: TmdbProfilePanelKey; label: string; enabled: boolean }> = [
    {
      key: 'overview',
      label: 'Overview',
      enabled: !!plotText || releaseHighlights.length > 0 || productionHighlights.length > 0,
    },
    { key: 'cast', label: 'Cast', enabled: profile.sections.cast.length > 0 },
    { key: 'crew', label: 'Crew', enabled: profile.sections.keyCrew.length > 0 },
    { key: 'facts', label: 'Facts', enabled: facts.length > 0 },
    { key: 'similar', label: 'Similar', enabled: profile.sections.similarTitles.length > 0 },
    { key: 'links', label: 'Links', enabled: profile.links.length > 0 || officialLabelItems.length > 0 },
  ];

  const visiblePanels = panelItems.filter((panel) => panel.enabled || panel.key === 'overview');
  const activePanelLabel = visiblePanels.find((panel) => panel.key === activePanel)?.label || 'Overview';

  useEffect(() => {
    if (!visiblePanels.some((panel) => panel.key === activePanel)) {
      setActivePanel(visiblePanels[0]?.key || 'overview');
    }
  }, [activePanel, visiblePanels]);

  const renderListPanel = (items: string[], emptyText: string) => {
    if (items.length === 0) {
      return <p className="text-xs text-neutral-400">{emptyText}</p>;
    }

    const visibleItems = expanded ? items : items.slice(0, 6);
    return (
      <div>
        <ul className="space-y-1.5">
          {visibleItems.map((item) => (
            <li key={`${activePanel}-${item}`} className="text-xs leading-relaxed text-neutral-100">
              {item}
            </li>
          ))}
        </ul>
        {!expanded && items.length > visibleItems.length && (
          <p className="mt-2 text-[11px] text-neutral-400">
            +{items.length - visibleItems.length} more
          </p>
        )}
      </div>
    );
  };

  const panelBody = (() => {
    if (activePanel === 'overview') {
      return (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-neutral-100">
            {plotText || 'Plot summary unavailable.'}
          </p>
          {(releaseHighlights.length > 0 || productionHighlights.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {releaseHighlights.map((item) => (
                <span
                  key={`release-${item}`}
                  className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] text-neutral-200"
                >
                  {item}
                </span>
              ))}
              {productionHighlights.map((item) => (
                <span
                  key={`company-${item}`}
                  className="rounded-full border border-sky-200/20 bg-sky-300/10 px-2 py-0.5 text-[10px] text-sky-100"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (activePanel === 'cast') {
      return renderListPanel(profile.sections.cast, 'Cast unavailable');
    }
    if (activePanel === 'crew') {
      return renderListPanel(profile.sections.keyCrew, 'Crew unavailable');
    }
    if (activePanel === 'facts') {
      return renderListPanel(facts, 'Facts unavailable');
    }
    if (activePanel === 'similar') {
      return renderListPanel(profile.sections.similarTitles, 'No similar titles listed');
    }

    const visibleLinks = expanded ? profile.links : profile.links.slice(0, 5);
    const visibleLabels = expanded ? officialLabelItems : officialLabelItems.slice(0, 5);

    return (
      <div className="space-y-2">
        {visibleLinks.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {visibleLinks.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-sky-200/30 bg-sky-300/12 px-2.5 py-1 text-[11px] font-medium text-sky-100 transition-colors hover:border-sky-100/45 hover:bg-sky-300/20"
              >
                <span>{link.label}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
        {visibleLabels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {visibleLabels.map((item) => (
              <span
                key={`official-${item}`}
                className="rounded-full border border-white/16 bg-white/8 px-2.5 py-1 text-[11px] text-neutral-200"
              >
                {item}
              </span>
            ))}
          </div>
        )}
        {visibleLinks.length === 0 && visibleLabels.length === 0 && (
          <p className="text-xs text-neutral-400">Links unavailable</p>
        )}
      </div>
    );
  })();

  return (
    <div className="relative overflow-hidden rounded-2xl border border-sky-200/20 bg-gradient-to-br from-[#0b1729] via-[#15162c] to-[#26181f] p-3 shadow-[0_14px_45px_-28px_rgba(56,189,248,0.85)]">
      <div className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-sky-300/15 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-14 -left-10 h-32 w-32 rounded-full bg-amber-200/10 blur-2xl" />

      <div className="relative">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-[15px] font-semibold leading-snug text-white">{profile.title}</h3>
            {profile.year && (
              <p className="mt-0.5 text-xs text-neutral-300">{profile.year}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {onMoreInfo && (
              <button
                type="button"
                onClick={onMoreInfo}
                className="inline-flex items-center gap-1 rounded-full border border-sky-200/35 bg-sky-300/14 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-50 transition-colors hover:bg-sky-300/24"
              >
                More Info
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-full border border-white/18 bg-white/8 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-200 transition-colors hover:bg-white/14"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? 'Compact' : 'Expand'}
            </button>
          </div>
        </div>

        {topGenres.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {topGenres.map((genre) => (
              <span
                key={genre}
                className="rounded-full border border-sky-200/30 bg-sky-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-sky-100"
              >
                {genre}
              </span>
            ))}
          </div>
        )}

        <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
          <span className="rounded-full border border-white/18 bg-white/6 px-2 py-0.5 text-neutral-200">
            Cast {profile.sections.cast.length}
          </span>
          <span className="rounded-full border border-white/18 bg-white/6 px-2 py-0.5 text-neutral-200">
            Crew {profile.sections.keyCrew.length}
          </span>
          <span className="rounded-full border border-white/18 bg-white/6 px-2 py-0.5 text-neutral-200">
            Similar {profile.sections.similarTitles.length}
          </span>
        </div>

        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
          {visiblePanels.map((panel) => (
            <button
              key={panel.key}
              type="button"
              onClick={() => setActivePanel(panel.key)}
              className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                activePanel === panel.key
                  ? 'border-sky-200/45 bg-sky-300/22 text-sky-50'
                  : 'border-white/16 bg-white/7 text-neutral-200 hover:bg-white/14'
              }`}
            >
              {panel.label}
            </button>
          ))}
        </div>

        <div className={`rounded-xl border border-white/14 bg-black/35 p-3 ${expanded ? 'max-h-[300px]' : 'max-h-[156px]'} overflow-y-auto`}>
          {panelBody}
        </div>

        <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-400">
          <span>Section: {activePanelLabel}</span>
          <span>{expanded ? 'Expanded view' : 'Compact view'}</span>
        </div>
      </div>
    </div>
  );
}

function parseAiError(error: unknown): string {
  if (error instanceof AiApiError) {
    const msg = error.message || '';
    if (error.status === 401 && /invalid access token/i.test(msg)) {
      return 'Session expired. Please sign in again and retry.';
    }
    if (error.status === 403 && /(banned|blocked)/i.test(msg)) {
      return 'AI chat access is blocked. Ask admin to unban you.';
    }
    return error.message || `AI request failed (${error.status})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected AI error';
}

function countWords(value: string): number {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 0;
  const matches = normalized.match(/[\p{L}\p{N}]+(?:['’`-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function countDetailChars(value: string): number {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

function consumeLocalQuota(previous: AiQuotaResponse | null): AiQuotaResponse | null {
  if (!previous) return previous;

  const nextUsed = Math.min(previous.limit, Math.max(0, previous.used + 1));
  const nextRemaining = Math.max(0, previous.limit - nextUsed);

  return {
    ...previous,
    used: nextUsed,
    remaining: nextRemaining,
    allowed: nextRemaining > 0,
    retry_after_ms: nextRemaining > 0
      ? 0
      : Math.max(0, (previous.reset_at_ms || 0) - Date.now()),
  };
}

function resolveMainBackendUrl(): string {
  let mainBackendUrl = getDefaultAuthServerUrl();
  if (isDev) {
    try {
      const devSettings = getDevSettings();
      if (typeof devSettings.authServerUrl === 'string' && devSettings.authServerUrl.trim()) {
        mainBackendUrl = devSettings.authServerUrl.trim();
      }
    } catch {
      // Ignore malformed dev settings; use default backend.
    }
  }

  return (mainBackendUrl || '').replace(/\/+$/, '');
}

function detectMentionAtCursor(value: string, cursor: number): MentionMatchState | null {
  if (!value) return null;
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const beforeCursor = value.slice(0, safeCursor);
  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex < 0) return null;

  // Require "@" to start a token (start of text or whitespace/punctuation boundary).
  const beforeAt = atIndex === 0 ? ' ' : beforeCursor.charAt(atIndex - 1);
  if (!/[\s([{,;:]/.test(beforeAt)) return null;

  const token = beforeCursor.slice(atIndex + 1);
  if (token.length > 120) return null;
  if (/[\s]/.test(token)) return null;

  return {
    query: token.toLowerCase(),
    start: atIndex,
    end: safeCursor,
  };
}

function trimText(value: unknown, maxLen = 600): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`;
}

function toPositiveWholeNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function convertUsdToInrWhole(value: unknown): number | null {
  const usdWhole = toPositiveWholeNumber(value);
  if (!usdWhole) return null;
  return Math.round(usdWhole * USD_TO_INR_RATE);
}

function formatInrWhole(value: unknown): string | null {
  const numeric = toPositiveWholeNumber(value);
  if (!numeric) return null;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(numeric);
}

function toCroreNumber(value: unknown): number | null {
  const numeric = toPositiveWholeNumber(value);
  if (!numeric) return null;
  return Number((numeric / 10000000).toFixed(2));
}

function formatCroreText(value: unknown): string | null {
  const croreNumber = toCroreNumber(value);
  if (!croreNumber || croreNumber < 1) return null;
  return `${croreNumber.toLocaleString('en-IN', { maximumFractionDigits: 2 })} crore`;
}

function toNamedList(value: unknown, max = 16): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const maybeName = (entry as Record<string, unknown>).name;
      return typeof maybeName === 'string' ? maybeName.trim() : '';
    })
    .filter(Boolean)
    .slice(0, max);
}

function toRecommendationList(value: unknown, max = 10): Array<{ id: number; title: string; release_date?: string | null; vote_average?: number | null }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ id: number; title: string; release_date?: string | null; vote_average?: number | null }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const idRaw = Number(row.id);
    const title = String(row.title || row.name || '').trim();
    if (!title || !Number.isFinite(idRaw)) continue;
    rows.push({
      id: Math.floor(idRaw),
      title,
      release_date: typeof row.release_date === 'string'
        ? row.release_date
        : (typeof row.first_air_date === 'string' ? row.first_air_date : null),
      vote_average: Number.isFinite(Number(row.vote_average)) ? Number(row.vote_average) : null,
    });
    if (rows.length >= max) break;
  }
  return rows;
}

function toCastList(value: unknown, max = 12): Array<{ name: string; character?: string | null }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ name: string; character?: string | null }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const character = typeof row.character === 'string' ? row.character.trim() : null;
    rows.push({ name, character });
    if (rows.length >= max) break;
  }
  return rows;
}

function toCrewList(value: unknown, max = 10): Array<{ name: string; job: string }> {
  if (!Array.isArray(value)) return [];
  const preferredJobs = new Set(['Director', 'Screenplay', 'Writer', 'Story', 'Creator']);
  const rows = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const job = typeof row.job === 'string' ? row.job.trim() : '';
      if (!name || !job) return null;
      return { name, job, preferred: preferredJobs.has(job) ? 1 : 0 };
    })
    .filter((entry): entry is { name: string; job: string; preferred: number } => !!entry)
    .sort((a, b) => b.preferred - a.preferred);

  return rows.slice(0, max).map(({ name, job }) => ({ name, job }));
}

function toProviderSummary(rawProviders: unknown): Record<string, unknown> | null {
  if (!rawProviders || typeof rawProviders !== 'object') return null;
  const rows = rawProviders as Record<string, unknown>;
  const region = (rows.US || rows.IN || rows.GB || rows.CA) as Record<string, unknown> | undefined;
  if (!region) return null;
  const flatrate = toNamedList(region.flatrate, 8);
  const rent = toNamedList(region.rent, 8);
  const buy = toNamedList(region.buy, 8);
  return {
    region: region === rows.US ? 'US' : (region === rows.IN ? 'IN' : (region === rows.GB ? 'GB' : 'CA')),
    flatrate,
    rent,
    buy,
  };
}

function summarizeMovieTmdb(raw: Record<string, unknown>): Record<string, unknown> {
  const credits = (raw.credits as Record<string, unknown> | undefined) || {};
  const recommendations = (raw.recommendations as Record<string, unknown> | undefined) || {};
  const similar = (raw.similar as Record<string, unknown> | undefined) || {};
  const keywordsBlock = (raw.keywords as Record<string, unknown> | undefined) || {};
  const keywordsRows = Array.isArray(keywordsBlock.keywords) ? keywordsBlock.keywords : keywordsBlock.results;
  const providers = (raw['watch/providers'] as Record<string, unknown> | undefined)?.results;
  const revenueInr = convertUsdToInrWhole(raw.revenue);
  const budgetInr = convertUsdToInrWhole(raw.budget);

  return {
    media_type: 'movie',
    tmdb_id: Number(raw.id) || null,
    title: trimText(raw.title, 180),
    original_title: trimText(raw.original_title, 180),
    release_date: trimText(raw.release_date, 40),
    status: trimText(raw.status, 80),
    runtime_minutes: Number(raw.runtime) || null,
    box_office_worldwide_inr: revenueInr,
    box_office_worldwide_formatted: formatInrWhole(revenueInr),
    box_office_worldwide_crore: toCroreNumber(revenueInr),
    box_office_worldwide_crore_text: formatCroreText(revenueInr),
    budget_inr: budgetInr,
    budget_formatted: formatInrWhole(budgetInr),
    budget_crore: toCroreNumber(budgetInr),
    budget_crore_text: formatCroreText(budgetInr),
    genres: toNamedList(raw.genres, 12),
    overview: trimText(raw.overview, 1400),
    tagline: trimText(raw.tagline, 240),
    rating: Number.isFinite(Number(raw.vote_average)) ? Number(raw.vote_average) : null,
    vote_count: Number.isFinite(Number(raw.vote_count)) ? Number(raw.vote_count) : null,
    popularity: Number.isFinite(Number(raw.popularity)) ? Number(raw.popularity) : null,
    production_companies: toNamedList(raw.production_companies, 10),
    spoken_languages: toNamedList(raw.spoken_languages, 10),
    cast: toCastList(credits.cast, 14),
    crew: toCrewList(credits.crew, 12),
    keywords: toNamedList(keywordsRows, 20),
    watch_providers: toProviderSummary(providers),
    recommendations: toRecommendationList(recommendations.results, 10),
    similar: toRecommendationList(similar.results, 10),
  };
}

function summarizeTvTmdb(raw: Record<string, unknown>): Record<string, unknown> {
  const aggregateCredits = (raw.aggregate_credits as Record<string, unknown> | undefined) || {};
  const recommendations = (raw.recommendations as Record<string, unknown> | undefined) || {};
  const similar = (raw.similar as Record<string, unknown> | undefined) || {};
  const keywordsBlock = (raw.keywords as Record<string, unknown> | undefined) || {};
  const keywordsRows = Array.isArray(keywordsBlock.results) ? keywordsBlock.results : keywordsBlock.keywords;
  const providers = (raw['watch/providers'] as Record<string, unknown> | undefined)?.results;
  const createdBy = Array.isArray(raw.created_by) ? raw.created_by : [];

  return {
    media_type: 'tvshow',
    tmdb_id: Number(raw.id) || null,
    name: trimText(raw.name, 180),
    original_name: trimText(raw.original_name, 180),
    first_air_date: trimText(raw.first_air_date, 40),
    last_air_date: trimText(raw.last_air_date, 40),
    status: trimText(raw.status, 80),
    type: trimText(raw.type, 80),
    number_of_seasons: Number(raw.number_of_seasons) || null,
    number_of_episodes: Number(raw.number_of_episodes) || null,
    genres: toNamedList(raw.genres, 12),
    overview: trimText(raw.overview, 1400),
    tagline: trimText(raw.tagline, 240),
    rating: Number.isFinite(Number(raw.vote_average)) ? Number(raw.vote_average) : null,
    vote_count: Number.isFinite(Number(raw.vote_count)) ? Number(raw.vote_count) : null,
    created_by: toNamedList(createdBy, 10),
    networks: toNamedList(raw.networks, 10),
    production_companies: toNamedList(raw.production_companies, 10),
    spoken_languages: toNamedList(raw.spoken_languages, 10),
    cast: toCastList(aggregateCredits.cast, 14),
    crew: toCrewList(aggregateCredits.crew, 12),
    keywords: toNamedList(keywordsRows, 20),
    watch_providers: toProviderSummary(providers),
    recommendations: toRecommendationList(recommendations.results, 10),
    similar: toRecommendationList(similar.results, 10),
  };
}

function summarizeEpisodeTmdb(
  rawEpisode: Record<string, unknown> | null,
  rawShow: Record<string, unknown> | null,
  linkedItem: LinkedMediaItem
): Record<string, unknown> {
  if (!rawEpisode) {
    return {
      media_type: 'tvepisode',
      tmdb_id: linkedItem.tmdb_id || null,
      season_number: linkedItem.season_number || null,
      episode_number: linkedItem.episode_number || null,
      title: linkedItem.episode_title || linkedItem.title,
      warning: 'Episode details unavailable from TMDB',
      show: rawShow ? summarizeTvTmdb(rawShow) : null,
    };
  }

  const credits = (rawEpisode.credits as Record<string, unknown> | undefined) || {};
  return {
    media_type: 'tvepisode',
    tmdb_id: Number(rawEpisode.id) || null,
    show_tmdb_id: rawShow ? Number(rawShow.id) || null : null,
    show_name: trimText(rawShow?.name, 180),
    season_number: Number(rawEpisode.season_number) || linkedItem.season_number || null,
    episode_number: Number(rawEpisode.episode_number) || linkedItem.episode_number || null,
    title: trimText(rawEpisode.name, 180) || linkedItem.episode_title || linkedItem.title,
    air_date: trimText(rawEpisode.air_date, 40),
    runtime_minutes: Number(rawEpisode.runtime) || null,
    overview: trimText(rawEpisode.overview, 1000),
    rating: Number.isFinite(Number(rawEpisode.vote_average)) ? Number(rawEpisode.vote_average) : null,
    vote_count: Number.isFinite(Number(rawEpisode.vote_count)) ? Number(rawEpisode.vote_count) : null,
    cast: toCastList(credits.cast, 10),
    crew: toCrewList(credits.crew, 10),
  };
}

function buildLinkedContextPrompt(question: string, contextRows: Array<Record<string, unknown>>): string {
  return [
    'The user linked StreamVault media items using @ mentions.',
    'Use the library and TMDB context below when answering.',
    'Use INR for currency output, and use crore format for values >= 1 crore.',
    'Use IST for any time/date reference.',
    'If data is missing, explicitly say it is unavailable instead of guessing.',
    'CONTEXT_START',
    JSON.stringify(contextRows, null, 2),
    'CONTEXT_END',
    `User question: ${question}`,
  ].join('\n\n');
}

function toLinkedMediaItemFromLaunch(item: MediaItem): LinkedMediaItem {
  const source: 'local' | 'drive' = item.is_cloud ? 'drive' : 'local';
  return {
    key: `${source}:${item.id}:launch`,
    id: item.id,
    title: item.title,
    year: item.year,
    media_type: item.media_type,
    source,
    tmdb_id: item.tmdb_id,
    season_number: item.season_number,
    episode_number: item.episode_number,
    episode_title: item.episode_title,
  };
}

function buildAutoTmdbDeepDivePrompt(linkedItem: LinkedMediaItem): string {
  const maybeYear = linkedItem.year ? ` (${linkedItem.year})` : '';
  return [
    `Give a deep TMDB profile for "${linkedItem.title}"${maybeYear}.`,
    'Include: cast, key crew, production companies, genres, release details, runtime, plot summary, notable facts, similar/recommended titles, and official places to learn more (TMDB/IMDb links).',
    'Use available data only and clearly mention unavailable fields.',
    'Format for in-app chat with clean section labels and concise lines.',
    'Avoid raw markdown-file formatting and avoid decorative symbols.',
  ].join(' ');
}

export function AIChatView({ launchItem = null, launchNonce = 0, onLaunchHandled }: AIChatViewProps) {
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [quota, setQuota] = useState<AiQuotaResponse | null>(null);
  const [quotaRateLimit, setQuotaRateLimit] = useState<AiRateLimitHeaders | null>(null);
  const [input, setInput] = useState('');
  const [loadingQuota, setLoadingQuota] = useState(false);
  const [sending, setSending] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<AiUpgradeStatusResponse | null>(null);
  const [loadingUpgradeStatus, setLoadingUpgradeStatus] = useState(false);
  const [submittingUpgrade, setSubmittingUpgrade] = useState(false);
  const [submittingAdditional, setSubmittingAdditional] = useState(false);
  const [referral1, setReferral1] = useState('');
  const [referral2, setReferral2] = useState('');
  const [upgradeNote, setUpgradeNote] = useState('');
  const [additionalReason, setAdditionalReason] = useState('');
  const [additionalDialogOpen, setAdditionalDialogOpen] = useState(false);
  const [tmdbMoreInfoOpen, setTmdbMoreInfoOpen] = useState(false);
  const [tmdbMoreInfoLoading, setTmdbMoreInfoLoading] = useState(false);
  const [tmdbMoreInfoError, setTmdbMoreInfoError] = useState<string | null>(null);
  const [tmdbMoreInfoData, setTmdbMoreInfoData] = useState<TmdbMoreInfoData | null>(null);
  const [dismissedQuotaNudge, setDismissedQuotaNudge] = useState(false);
  const [liveNotice, setLiveNotice] = useState<AiUpgradeLiveNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [driveHistoryEnabled, setDriveHistoryEnabled] = useState(false);
  const [libraryIndex, setLibraryIndex] = useState<LinkedMediaItem[]>([]);
  const [libraryIndexLoading, setLibraryIndexLoading] = useState(false);
  const [libraryIndexReady, setLibraryIndexReady] = useState(false);
  const [linkedItems, setLinkedItems] = useState<LinkedMediaItem[]>([]);
  const [mentionMatch, setMentionMatch] = useState<MentionMatchState | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const linkedContextCacheRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const linkedItemsRef = useRef<LinkedMediaItem[]>([]);
  const lastLaunchNonceRef = useRef<number>(0);
  const pendingAutoSendNonceRef = useRef<number>(0);
  const lastFocusedAssistantMessageIdRef = useRef<string>('');

  const { toast } = useToast();

  const minAdditionalWords = upgradeStatus?.additional_reason_min_words || quota?.additional_reason_min_words || 40;
  const minAdditionalChars = upgradeStatus?.additional_reason_min_chars || quota?.additional_reason_min_chars || 30;
  const additionalReasonWords = useMemo(() => countWords(additionalReason), [additionalReason]);
  const additionalReasonChars = useMemo(() => countDetailChars(additionalReason), [additionalReason]);
  const additionalReasonReady = additionalReasonWords >= minAdditionalWords || additionalReasonChars >= minAdditionalChars;
  const isBanned = !!quota?.ban?.is_banned;
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];

    const query = mentionMatch.query.trim().toLowerCase();
    const byQuery = query
      ? libraryIndex.filter((entry) => {
        const title = entry.title.toLowerCase();
        const episodeTitle = (entry.episode_title || '').toLowerCase();
        return title.includes(query) || episodeTitle.includes(query);
      })
      : libraryIndex;

    return byQuery.slice(0, MAX_MENTION_RESULTS);
  }, [mentionMatch, libraryIndex]);

  const remainingPercent = useMemo(() => {
    if (!quota || quota.limit <= 0) return 0;
    return Math.max(0, Math.min(100, (quota.remaining / quota.limit) * 100));
  }, [quota]);

  const canSend = useMemo(() => {
    const hasInput = input.trim().length > 0;
    const hasQuota = quota ? quota.remaining > 0 : true;
    return hasInput && hasQuota && !sending && !isBanned;
  }, [input, quota, sending, isBanned]);

  const buildUpgradeLiveNotice = (event: SocialEvent): AiUpgradeLiveNotice => {
    const payload = event as Record<string, unknown>;
    const action = String(payload.action || payload.status || 'updated').toLowerCase();
    const reviewNote = typeof payload.review_note === 'string' ? payload.review_note.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';

    let title = 'AI Limit Update';
    let description = message || 'Your AI limit request status changed.';

    if (action === 'approved') {
      title = 'AI Limit Request Approved';
      description = message || 'Your AI rate limit request was approved.';
    } else if (action === 'rejected') {
      title = 'AI Limit Request Rejected';
      description = message || 'Your AI rate limit request was rejected.';
    } else if (action === 'banned') {
      title = 'AI Chat Access Blocked';
      description = message || 'AI chat access is blocked by admin.';
    } else if (action === 'unbanned') {
      title = 'AI Chat Access Restored';
      description = message || 'AI chat access has been restored.';
    }

    if (reviewNote) {
      description = `${description} Note: ${reviewNote}`;
    }

    return {
      id: `ai-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      description,
      action,
      createdAt: Date.now(),
    };
  };

  useEffect(() => {
    let cancelled = false;

    const normalizeLines = (value: unknown): ChatLine[] => {
      if (!Array.isArray(value)) return [];
      return value
        .filter((line) => line && typeof line.content === 'string' && (line.role === 'user' || line.role === 'assistant'))
        .slice(-MAX_HISTORY_LINES);
    };

    const loadHistory = async () => {
      let loadedFromDrive = false;

      try {
        const raw = await getGDriveAiChatHistory();
        const parsed = JSON.parse(raw);
        const lines = normalizeLines(parsed);
        if (!cancelled) {
          setMessages(lines);
          setDriveHistoryEnabled(true);
          loadedFromDrive = true;
        }
      } catch {
        // Fallback to local cache when Drive history is unavailable.
        if (!cancelled) {
          setDriveHistoryEnabled(false);
        }
      }

      if (!loadedFromDrive) {
        try {
          const raw = localStorage.getItem(LOCAL_HISTORY_FALLBACK_KEY);
          if (raw && !cancelled) {
            const parsed = JSON.parse(raw);
            setMessages(normalizeLines(parsed));
          }
        } catch {
          // Ignore malformed local history.
        }
      }

      if (!cancelled) {
        setHistoryReady(true);
      }
    };

    loadHistory().catch(() => {
      if (!cancelled) {
        setHistoryReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyReady) return;

    const payload = JSON.stringify(messages.slice(-MAX_HISTORY_LINES));

    try {
      localStorage.setItem(LOCAL_HISTORY_FALLBACK_KEY, payload);
    } catch {
      // Ignore local fallback cache errors.
    }

    if (!driveHistoryEnabled) return;

    const timer = setTimeout(() => {
      saveGDriveAiChatHistory(payload).catch(() => {
        // Ignore Drive sync errors; local fallback still keeps recent history.
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [messages, historyReady, driveHistoryEnabled]);

  useEffect(() => {
    refreshQuota();
    refreshUpgradeStatus();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshUpgradeStatus().catch(() => {
        // Ignore periodic refresh errors.
      });
      refreshQuota().catch(() => {
        // Ignore periodic refresh errors.
      });
    }, 15000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onSocialEvent('ai_upgrade_update', (event) => {
      const payload = event as Record<string, unknown>;
      const action = String(payload.action || payload.status || '').toLowerCase();

      setLiveNotice(buildUpgradeLiveNotice(event));

      refreshUpgradeStatus().catch(() => {
        // Ignore transient refresh failures for realtime event.
      });
      refreshQuota().catch(() => {
        // Ignore transient refresh failures for realtime event.
      });

      if (action === 'approved' || action === 'unbanned') {
        setDismissedQuotaNudge(true);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!quota || quota.remaining > 0) {
      setDismissedQuotaNudge(false);
    }
  }, [quota?.remaining]);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    if (messages.length === 0) return;

    const latestMessage = messages[messages.length - 1];
    if (!latestMessage) return;

    if (latestMessage.role === 'assistant') {
      if (lastFocusedAssistantMessageIdRef.current === latestMessage.id) return;
      lastFocusedAssistantMessageIdRef.current = latestMessage.id;

      const target = container.querySelector<HTMLElement>(`[data-chat-line-id="${latestMessage.id}"]`);
      if (target) {
        container.scrollTo({
          top: Math.max(0, target.offsetTop - 6),
          behavior: 'smooth',
        });
        return;
      }
    }

    container.scrollTop = container.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (!mentionOpen || mentionOptions.length === 0) {
      if (mentionHighlightIndex !== 0) {
        setMentionHighlightIndex(0);
      }
      return;
    }
    if (mentionHighlightIndex >= mentionOptions.length) {
      setMentionHighlightIndex(0);
    }
  }, [mentionOpen, mentionOptions.length, mentionHighlightIndex]);

  useEffect(() => {
    linkedItemsRef.current = linkedItems;
  }, [linkedItems]);

  useEffect(() => {
    if (!launchItem || !launchNonce) return;
    if (launchNonce === lastLaunchNonceRef.current) return;

    const linked = toLinkedMediaItemFromLaunch(launchItem);
    const prompt = buildAutoTmdbDeepDivePrompt(linked);

    lastLaunchNonceRef.current = launchNonce;
    pendingAutoSendNonceRef.current = launchNonce;
    linkedItemsRef.current = [linked];
    setLinkedItems([linked]);
    setInput(prompt);
    setError(null);
    setMentionMatch(null);
    setMentionOpen(false);
    setMentionHighlightIndex(0);

    refreshQuota().catch(() => {
      // Fallback to last known quota state for auto-send.
    });

    onLaunchHandled?.();

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [launchItem, launchNonce, onLaunchHandled]);

  useEffect(() => {
    if (!pendingAutoSendNonceRef.current) return;
    if (sending || loadingQuota) return;
    if (!quota) return;
    if (!input.trim()) return;
    if (!DEFAULT_AI_MODEL) {
      pendingAutoSendNonceRef.current = 0;
      return;
    }
    if (isBanned) {
      pendingAutoSendNonceRef.current = 0;
      return;
    }
    if (quota.remaining <= 0) {
      pendingAutoSendNonceRef.current = 0;
      return;
    }

    pendingAutoSendNonceRef.current = 0;
    handleSend();
  }, [sending, loadingQuota, input, quota?.remaining, isBanned]);

  const refreshQuota = async () => {
    setLoadingQuota(true);
    try {
      const result = await getAiQuota();
      setQuota(result.quota);
      setQuotaRateLimit(result.rateLimit);
      if (result.quota.ban?.is_banned) {
        const banReason = result.quota.ban.reason?.trim();
        setError(
          banReason
            ? `AI chat is blocked. Reason: ${banReason}`
            : 'AI chat access is blocked. Ask admin to unban you.'
        );
      } else {
        setError(null);
      }
    } catch (err) {
      const message = parseAiError(err);
      setError(message);
    } finally {
      setLoadingQuota(false);
    }
  };

  const refreshUpgradeStatus = async () => {
    setLoadingUpgradeStatus(true);
    try {
      const result = await getAiUpgradeRequestStatus();
      setUpgradeStatus(result);
    } catch {
      // Ignore when user is not authenticated for social endpoints.
      setUpgradeStatus(null);
    } finally {
      setLoadingUpgradeStatus(false);
    }
  };

  const ensureLibraryIndexLoaded = async () => {
    if (libraryIndexReady || libraryIndexLoading) return;
    setLibraryIndexLoading(true);

    try {
      const [localMovies, localTv, cloudMovies, cloudTv] = await Promise.all([
        getLibraryFiltered('movie', '', false),
        getLibraryFiltered('tv', '', false),
        getLibraryFiltered('movie', '', true),
        getLibraryFiltered('tv', '', true),
      ]);

      const toLinkedItems = (rows: MediaItem[], source: 'local' | 'drive'): LinkedMediaItem[] => (
        rows.map((row) => ({
          key: `${source}:${row.id}`,
          id: row.id,
          title: row.title,
          year: row.year,
          media_type: row.media_type,
          source,
          tmdb_id: row.tmdb_id,
          season_number: row.season_number,
          episode_number: row.episode_number,
          episode_title: row.episode_title,
        }))
      );

      const dedupe = new Map<string, LinkedMediaItem>();
      [...toLinkedItems(localMovies, 'local'),
      ...toLinkedItems(localTv, 'local'),
      ...toLinkedItems(cloudMovies, 'drive'),
      ...toLinkedItems(cloudTv, 'drive')]
        .forEach((entry) => dedupe.set(entry.key, entry));

      const sorted = Array.from(dedupe.values()).sort((a, b) => {
        const titleDelta = a.title.localeCompare(b.title);
        if (titleDelta !== 0) return titleDelta;
        return a.key.localeCompare(b.key);
      });

      setLibraryIndex(sorted);
      setLibraryIndexReady(true);
    } catch (loadError) {
      console.error('[AI] Failed to load mention index:', loadError);
      toast({
        title: 'Mention Index Error',
        description: 'Could not load library index for @ mentions.',
        variant: 'destructive',
      });
    } finally {
      setLibraryIndexLoading(false);
    }
  };

  const removeLinkedItem = (key: string) => {
    setLinkedItems((previous) => {
      const next = previous.filter((entry) => entry.key !== key);
      linkedItemsRef.current = next;
      return next;
    });
  };

  const handleMentionPick = (picked: LinkedMediaItem) => {
    setLinkedItems((previous) => {
      if (previous.some((row) => row.key === picked.key)) return previous;
      const next = [...previous, picked].slice(-MAX_LINKED_ITEMS);
      linkedItemsRef.current = next;
      return next;
    });

    if (mentionMatch) {
      setInput((previous) => {
        const before = previous.slice(0, mentionMatch.start);
        const after = previous.slice(mentionMatch.end);
        const merged = `${before}${after}`.replace(/[ \t]{2,}/g, ' ');
        return merged.replace(/^\s+/, '');
      });
    }

    setMentionMatch(null);
    setMentionOpen(false);
    setMentionHighlightIndex(0);

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const fetchTmdbProxyJson = async (path: string): Promise<Record<string, unknown>> => {
    const baseUrl = resolveMainBackendUrl();
    if (!baseUrl) {
      throw new Error('Backend URL is not configured');
    }

    const normalizedPath = path.replace(/^\/+/, '');
    const response = await fetch(`${baseUrl}/api/tmdb/${normalizedPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `TMDB proxy failed (${response.status})`);
    }

    return response.json();
  };

  const fetchLinkedTmdbContext = async (linkedItem: LinkedMediaItem): Promise<Record<string, unknown>> => {
    const fromCache = linkedContextCacheRef.current.get(linkedItem.key);
    if (fromCache) return fromCache;

    const libraryContext: Record<string, unknown> = {
      source: linkedItem.source,
      title: linkedItem.title,
      year: linkedItem.year || null,
      media_type: linkedItem.media_type,
      tmdb_id: linkedItem.tmdb_id || null,
      season_number: linkedItem.season_number || null,
      episode_number: linkedItem.episode_number || null,
      episode_title: linkedItem.episode_title || null,
    };

    if (!linkedItem.tmdb_id) {
      const noTmdbContext = {
        library: libraryContext,
        tmdb: null,
        warning: 'No TMDB ID available for this item in the local index.',
      };
      linkedContextCacheRef.current.set(linkedItem.key, noTmdbContext);
      return noTmdbContext;
    }

    try {
      let tmdbSummary: Record<string, unknown> | null = null;
      const tmdbId = encodeURIComponent(linkedItem.tmdb_id);

      if (linkedItem.media_type === 'movie') {
        const params = new URLSearchParams({
          append_to_response: 'credits,keywords,release_dates,videos,watch/providers,recommendations,similar,images',
        });
        const rawMovie = await fetchTmdbProxyJson(`movie/${tmdbId}?${params.toString()}`);
        tmdbSummary = summarizeMovieTmdb(rawMovie);
      } else if (linkedItem.media_type === 'tvshow') {
        const params = new URLSearchParams({
          append_to_response: 'aggregate_credits,content_ratings,keywords,videos,watch/providers,recommendations,similar,images,external_ids',
        });
        const rawShow = await fetchTmdbProxyJson(`tv/${tmdbId}?${params.toString()}`);
        tmdbSummary = summarizeTvTmdb(rawShow);
      } else {
        const showParams = new URLSearchParams({
          append_to_response: 'aggregate_credits,content_ratings,keywords,videos,watch/providers,recommendations,similar,images,external_ids',
        });
        const rawShow = await fetchTmdbProxyJson(`tv/${tmdbId}?${showParams.toString()}`);
        const season = linkedItem.season_number || 1;
        const episode = linkedItem.episode_number || 1;
        const episodeParams = new URLSearchParams({
          append_to_response: 'credits,images,videos,external_ids',
        });
        const rawEpisode = await fetchTmdbProxyJson(`tv/${tmdbId}/season/${season}/episode/${episode}?${episodeParams.toString()}`);
        tmdbSummary = summarizeEpisodeTmdb(rawEpisode, rawShow, linkedItem);
      }

      const context = {
        library: libraryContext,
        tmdb: tmdbSummary,
      };
      linkedContextCacheRef.current.set(linkedItem.key, context);
      return context;
    } catch (proxyError) {
      console.warn('[AI] TMDB proxy context fetch failed, using fallback:', proxyError);
      try {
        if (linkedItem.media_type === 'movie') {
          const search = await searchTmdb(linkedItem.title);
          const movieMatch = search.results.find((row) => {
            const idMatch = linkedItem.tmdb_id && String(row.id) === String(linkedItem.tmdb_id);
            return idMatch || row.media_type === 'movie';
          });

          const fallbackContext = {
            library: libraryContext,
            tmdb: movieMatch ? {
              media_type: 'movie',
              tmdb_id: movieMatch.id,
              title: movieMatch.title || movieMatch.name || linkedItem.title,
              release_date: movieMatch.release_date || null,
              overview: trimText(movieMatch.overview, 900),
              rating: movieMatch.vote_average || null,
            } : null,
            warning: movieMatch ? 'TMDB fallback: search result summary only.' : 'TMDB fallback search returned no match.',
          };
          linkedContextCacheRef.current.set(linkedItem.key, fallbackContext);
          return fallbackContext;
        }

        if (linkedItem.tmdb_id && Number.isFinite(Number(linkedItem.tmdb_id))) {
          const showDetails = await getTvDetails(Number(linkedItem.tmdb_id));
          if (showDetails) {
            if (linkedItem.media_type === 'tvshow') {
              const fallbackShowContext = {
                library: libraryContext,
                tmdb: {
                  media_type: 'tvshow',
                  tmdb_id: showDetails.id,
                  name: showDetails.name,
                  overview: trimText(showDetails.overview, 1000),
                  number_of_seasons: showDetails.number_of_seasons,
                  seasons: showDetails.seasons?.slice(0, 12).map((season) => ({
                    season_number: season.season_number,
                    name: season.name,
                    episode_count: season.episode_count,
                  })) || [],
                },
                warning: 'TMDB fallback: basic show details only.',
              };
              linkedContextCacheRef.current.set(linkedItem.key, fallbackShowContext);
              return fallbackShowContext;
            }

            const season = linkedItem.season_number || 1;
            const seasonDetails = await getTvSeasonEpisodes(Number(linkedItem.tmdb_id), season);
            const episode = seasonDetails?.episodes.find(
              (row) => row.episode_number === (linkedItem.episode_number || 1)
            );
            const fallbackEpisodeContext = {
              library: libraryContext,
              tmdb: {
                media_type: 'tvepisode',
                show_tmdb_id: showDetails.id,
                show_name: showDetails.name,
                season_number: season,
                episode_number: linkedItem.episode_number || 1,
                title: episode?.name || linkedItem.episode_title || linkedItem.title,
                overview: trimText(episode?.overview, 900),
                air_date: episode?.air_date || null,
                rating: episode?.vote_average || null,
              },
              warning: 'TMDB fallback: episode summary from cached season metadata.',
            };
            linkedContextCacheRef.current.set(linkedItem.key, fallbackEpisodeContext);
            return fallbackEpisodeContext;
          }
        }
      } catch (fallbackError) {
        console.warn('[AI] TMDB fallback context failed:', fallbackError);
      }

      const failedContext = {
        library: libraryContext,
        tmdb: null,
        warning: 'Failed to fetch TMDB details for this linked item.',
      };
      linkedContextCacheRef.current.set(linkedItem.key, failedContext);
      return failedContext;
    }
  };

  const openTmdbMoreInfo = async (profile: TmdbDeepProfileData) => {
    setTmdbMoreInfoOpen(true);
    setTmdbMoreInfoLoading(true);
    setTmdbMoreInfoError(null);
    setTmdbMoreInfoData(null);

    const dedupeLines = (rows: string[], max = 40) => {
      const seen = new Set<string>();
      const normalized: string[] = [];
      for (const row of rows) {
        const clean = row.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(clean);
        if (normalized.length >= max) break;
      }
      return normalized;
    };

    const fallbackSearchTarget = async (): Promise<TmdbTargetRef | null> => {
      const movieParams = new URLSearchParams({
        query: profile.title,
        include_adult: 'false',
        language: 'en-US',
        page: '1',
      });
      const movieSearch = await fetchTmdbProxyJson(`search/movie?${movieParams.toString()}`);
      const movieResults = Array.isArray(movieSearch.results) ? movieSearch.results : [];
      const byYear = profile.year
        ? movieResults.find((row) => {
          if (!row || typeof row !== 'object') return false;
          const releaseDate = String((row as Record<string, unknown>).release_date || '');
          return releaseDate.startsWith(profile.year || '');
        })
        : null;
      const moviePick = (byYear || movieResults[0]) as Record<string, unknown> | undefined;
      const movieId = Number(moviePick?.id);
      if (Number.isFinite(movieId) && movieId > 0) {
        return {
          mediaType: 'movie',
          tmdbId: Math.floor(movieId),
          tmdbUrl: `https://www.themoviedb.org/movie/${Math.floor(movieId)}`,
        };
      }

      const tvParams = new URLSearchParams({
        query: profile.title,
        include_adult: 'false',
        language: 'en-US',
        page: '1',
      });
      const tvSearch = await fetchTmdbProxyJson(`search/tv?${tvParams.toString()}`);
      const tvResults = Array.isArray(tvSearch.results) ? tvSearch.results : [];
      const tvByYear = profile.year
        ? tvResults.find((row) => {
          if (!row || typeof row !== 'object') return false;
          const airDate = String((row as Record<string, unknown>).first_air_date || '');
          return airDate.startsWith(profile.year || '');
        })
        : null;
      const tvPick = (tvByYear || tvResults[0]) as Record<string, unknown> | undefined;
      const tvId = Number(tvPick?.id);
      if (Number.isFinite(tvId) && tvId > 0) {
        return {
          mediaType: 'tv',
          tmdbId: Math.floor(tvId),
          tmdbUrl: `https://www.themoviedb.org/tv/${Math.floor(tvId)}`,
        };
      }

      return null;
    };

    try {
      let target = extractTmdbTargetFromProfile(profile);
      if (!target) {
        target = await fallbackSearchTarget();
      }

      if (!target) {
        setTmdbMoreInfoError('Could not find a TMDB ID for this profile. Ask AI to include a TMDB movie/TV link.');
        return;
      }

      if (target.mediaType === 'movie') {
        const params = new URLSearchParams({
          append_to_response: 'credits,keywords,release_dates,videos,watch/providers,recommendations,similar,images,external_ids',
        });
        const rawMovie = await fetchTmdbProxyJson(`movie/${target.tmdbId}?${params.toString()}`);
        const summary = summarizeMovieTmdb(rawMovie) as Record<string, unknown>;
        const rawReleaseRows = Array.isArray((rawMovie.release_dates as Record<string, unknown> | undefined)?.results)
          ? (rawMovie.release_dates as Record<string, unknown>).results as Array<Record<string, unknown>>
          : [];
        const releaseMeta = dedupeLines(rawReleaseRows.map((row) => {
          const region = typeof row.iso_3166_1 === 'string' ? row.iso_3166_1 : '';
          const releaseRows = Array.isArray(row.release_dates) ? row.release_dates : [];
          const firstRelease = releaseRows[0] as Record<string, unknown> | undefined;
          const cert = typeof firstRelease?.certification === 'string' ? firstRelease.certification.trim() : '';
          return cert ? `${region}: ${cert}` : region;
        }).filter(Boolean), 20);

        const videosCount = Array.isArray((rawMovie.videos as Record<string, unknown> | undefined)?.results)
          ? ((rawMovie.videos as Record<string, unknown>).results as unknown[]).length
          : 0;
        const rawImages = (rawMovie.images as Record<string, unknown> | undefined) || {};
        const posterCount = Array.isArray(rawImages.posters) ? rawImages.posters.length : 0;
        const backdropCount = Array.isArray(rawImages.backdrops) ? rawImages.backdrops.length : 0;
        const logoCount = Array.isArray(rawImages.logos) ? rawImages.logos.length : 0;

        const imdbIdRaw = typeof (rawMovie.external_ids as Record<string, unknown> | undefined)?.imdb_id === 'string'
          ? ((rawMovie.external_ids as Record<string, unknown>).imdb_id as string).trim()
          : '';
        const imdbUrl = imdbIdRaw
          ? `https://www.imdb.com/title/${imdbIdRaw}/`
          : extractImdbUrlFromProfile(profile);

        const runtime = Number(summary.runtime_minutes);
        const rating = Number(summary.rating);
        const voteCount = Number(summary.vote_count);
        const popularity = Number(summary.popularity);
        const budgetText = typeof summary.budget_formatted === 'string' ? summary.budget_formatted : '';
        const budgetCrore = typeof summary.budget_crore_text === 'string' ? summary.budget_crore_text : '';
        const revenueText = typeof summary.box_office_worldwide_formatted === 'string' ? summary.box_office_worldwide_formatted : '';
        const revenueCrore = typeof summary.box_office_worldwide_crore_text === 'string' ? summary.box_office_worldwide_crore_text : '';

        const financials = dedupeLines([
          budgetCrore && budgetText ? `Budget: ${budgetCrore} (${budgetText})` : (budgetCrore ? `Budget: ${budgetCrore}` : (budgetText ? `Budget: ${budgetText}` : '')),
          revenueCrore && revenueText ? `Worldwide Box Office: ${revenueCrore} (${revenueText})` : (revenueCrore ? `Worldwide Box Office: ${revenueCrore}` : (revenueText ? `Worldwide Box Office: ${revenueText}` : '')),
        ], 4);

        setTmdbMoreInfoData({
          title: String(summary.title || profile.title || 'Movie'),
          subtitle: typeof summary.original_title === 'string' && summary.original_title !== summary.title
            ? summary.original_title
            : null,
          mediaType: 'movie',
          tmdbId: target.tmdbId,
          tmdbUrl: target.tmdbUrl,
          imdbUrl: imdbUrl || null,
          homepage: typeof rawMovie.homepage === 'string' ? rawMovie.homepage.trim() || null : null,
          overview: typeof summary.overview === 'string' ? summary.overview : null,
          tagline: typeof summary.tagline === 'string' ? summary.tagline : null,
          genres: toStringArray(summary.genres, 14),
          runtimeText: Number.isFinite(runtime) && runtime > 0 ? `${runtime} min` : null,
          statusText: typeof summary.status === 'string' ? summary.status : null,
          releaseText: typeof summary.release_date === 'string' ? summary.release_date : null,
          ratingText: Number.isFinite(rating) && rating > 0
            ? `${rating.toFixed(1)}/10${Number.isFinite(voteCount) && voteCount > 0 ? ` (${Math.floor(voteCount)} votes)` : ''}`
            : null,
          popularityText: Number.isFinite(popularity) && popularity > 0 ? popularity.toFixed(1) : null,
          financials,
          production: toStringArray(summary.production_companies, 20),
          languages: toStringArray(summary.spoken_languages, 16),
          keywords: toStringArray(summary.keywords, 40),
          cast: toCastModalRows(summary.cast, 30),
          crew: toCrewModalRows(summary.crew, 30),
          recommendations: toRecommendationModalRows(summary.recommendations, 24),
          similar: toRecommendationModalRows(summary.similar, 24),
          providers: toProviderDialog(summary.watch_providers),
          releaseMeta,
          mediaAssets: [
            `Videos: ${videosCount}`,
            `Posters: ${posterCount}`,
            `Backdrops: ${backdropCount}`,
            `Logos: ${logoCount}`,
          ],
        });
      } else {
        const params = new URLSearchParams({
          append_to_response: 'aggregate_credits,content_ratings,keywords,videos,watch/providers,recommendations,similar,images,external_ids',
        });
        const rawShow = await fetchTmdbProxyJson(`tv/${target.tmdbId}?${params.toString()}`);
        const summary = summarizeTvTmdb(rawShow) as Record<string, unknown>;
        const contentRatingRows = Array.isArray((rawShow.content_ratings as Record<string, unknown> | undefined)?.results)
          ? ((rawShow.content_ratings as Record<string, unknown>).results as Array<Record<string, unknown>>)
          : [];
        const releaseMeta = dedupeLines(contentRatingRows.map((row) => {
          const region = typeof row.iso_3166_1 === 'string' ? row.iso_3166_1 : '';
          const rating = typeof row.rating === 'string' ? row.rating.trim() : '';
          return rating ? `${region}: ${rating}` : region;
        }).filter(Boolean), 20);

        const videosCount = Array.isArray((rawShow.videos as Record<string, unknown> | undefined)?.results)
          ? ((rawShow.videos as Record<string, unknown>).results as unknown[]).length
          : 0;
        const rawImages = (rawShow.images as Record<string, unknown> | undefined) || {};
        const posterCount = Array.isArray(rawImages.posters) ? rawImages.posters.length : 0;
        const backdropCount = Array.isArray(rawImages.backdrops) ? rawImages.backdrops.length : 0;
        const logoCount = Array.isArray(rawImages.logos) ? rawImages.logos.length : 0;

        const imdbIdRaw = typeof (rawShow.external_ids as Record<string, unknown> | undefined)?.imdb_id === 'string'
          ? ((rawShow.external_ids as Record<string, unknown>).imdb_id as string).trim()
          : '';
        const imdbUrl = imdbIdRaw
          ? `https://www.imdb.com/title/${imdbIdRaw}/`
          : extractImdbUrlFromProfile(profile);

        const rating = Number(summary.rating);
        const voteCount = Number(summary.vote_count);
        const popularity = Number(summary.popularity);
        const episodeRuntimeRows = Array.isArray(rawShow.episode_run_time) ? rawShow.episode_run_time : [];
        const runtimeGuess = Number(episodeRuntimeRows[0]);

        const production = dedupeLines([
          ...toStringArray(summary.production_companies, 14).map((entry) => `Studio: ${entry}`),
          ...toStringArray(summary.networks, 12).map((entry) => `Network: ${entry}`),
          ...toStringArray(summary.created_by, 8).map((entry) => `Creator: ${entry}`),
        ], 30);

        setTmdbMoreInfoData({
          title: String(summary.name || profile.title || 'TV Show'),
          subtitle: typeof summary.original_name === 'string' && summary.original_name !== summary.name
            ? summary.original_name
            : null,
          mediaType: 'tv',
          tmdbId: target.tmdbId,
          tmdbUrl: target.tmdbUrl,
          imdbUrl: imdbUrl || null,
          homepage: typeof rawShow.homepage === 'string' ? rawShow.homepage.trim() || null : null,
          overview: typeof summary.overview === 'string' ? summary.overview : null,
          tagline: typeof summary.tagline === 'string' ? summary.tagline : null,
          genres: toStringArray(summary.genres, 14),
          runtimeText: Number.isFinite(runtimeGuess) && runtimeGuess > 0 ? `${runtimeGuess} min avg episode` : null,
          statusText: typeof summary.status === 'string' ? summary.status : null,
          releaseText: dedupeLines([
            typeof summary.first_air_date === 'string' ? `First Air Date: ${summary.first_air_date}` : '',
            typeof summary.last_air_date === 'string' ? `Last Air Date: ${summary.last_air_date}` : '',
            typeof summary.type === 'string' ? `Type: ${summary.type}` : '',
            Number.isFinite(Number(summary.number_of_seasons)) ? `Seasons: ${Math.floor(Number(summary.number_of_seasons))}` : '',
            Number.isFinite(Number(summary.number_of_episodes)) ? `Episodes: ${Math.floor(Number(summary.number_of_episodes))}` : '',
          ], 8).join(' • ') || null,
          ratingText: Number.isFinite(rating) && rating > 0
            ? `${rating.toFixed(1)}/10${Number.isFinite(voteCount) && voteCount > 0 ? ` (${Math.floor(voteCount)} votes)` : ''}`
            : null,
          popularityText: Number.isFinite(popularity) && popularity > 0 ? popularity.toFixed(1) : null,
          financials: [],
          production,
          languages: toStringArray(summary.spoken_languages, 16),
          keywords: toStringArray(summary.keywords, 40),
          cast: toCastModalRows(summary.cast, 30),
          crew: toCrewModalRows(summary.crew, 30),
          recommendations: toRecommendationModalRows(summary.recommendations, 24),
          similar: toRecommendationModalRows(summary.similar, 24),
          providers: toProviderDialog(summary.watch_providers),
          releaseMeta,
          mediaAssets: [
            `Videos: ${videosCount}`,
            `Posters: ${posterCount}`,
            `Backdrops: ${backdropCount}`,
            `Logos: ${logoCount}`,
          ],
        });
      }
    } catch (detailsError) {
      const message = detailsError instanceof Error ? detailsError.message : 'Failed to load TMDB details.';
      setTmdbMoreInfoError(message);
    } finally {
      setTmdbMoreInfoLoading(false);
    }
  };

  const addMessage = (line: ChatLine) => {
    setMessages((prev) => [...prev, line].slice(-MAX_HISTORY_LINES));
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    if (isBanned) {
      setError('AI chat access is blocked. Ask admin to unban you.');
      return;
    }

    if (quota && quota.remaining <= 0) {
      setError(`Free quota exhausted. Resets at ${formatReset(quota.reset_at_ms)}.`);
      return;
    }

    const linkedItemsSnapshot = linkedItemsRef.current.slice();
    const linkedMentionText = linkedItemsSnapshot
      .map((entry) => `@${entry.title}`)
      .join(' ')
      .trim();
    const userDisplayText = linkedMentionText
      ? `${linkedMentionText}\n${text}`
      : text;

    const userLine: ChatLine = {
      id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content: userDisplayText,
      createdAt: Date.now(),
    };

    addMessage(userLine);
    setInput('');
    setSending(true);
    setError(null);
    setMentionMatch(null);
    setMentionOpen(false);

    try {
      const linkedContextRows = linkedItemsSnapshot.length > 0
        ? await Promise.all(linkedItemsSnapshot.map((entry) => fetchLinkedTmdbContext(entry)))
        : [];
      const userContentForAi = linkedContextRows.length > 0
        ? buildLinkedContextPrompt(text, linkedContextRows)
        : text;

      const payloadMessages: AiMessage[] = [...messages, { ...userLine, content: userContentForAi }].map((line) => ({
        role: line.role,
        content: line.content,
      }));

      const result = await sendAiChat({
        model: DEFAULT_AI_MODEL,
        temperature: 0.7,
        messages: payloadMessages,
        metadata: {
          feature: 'streamvault-ai-beta',
          app: 'slasshy-desktop',
          requested_at: new Date().toISOString(),
        },
      });

      const assistantText = result.text?.trim() || 'No response text from wrapper.';

      addMessage({
        id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'assistant',
        content: assistantText,
        createdAt: Date.now(),
      });

      if (linkedItemsSnapshot.length > 0) {
        linkedItemsRef.current = [];
        setLinkedItems([]);
      }

      // Keep UI quota stable from authoritative /api/ai/quota instead of transient chat headers.
      setQuota((prev) => consumeLocalQuota(prev));
      setQuotaRateLimit(result.rateLimit);
    } catch (err) {
      const message = parseAiError(err);
      setError(message);
      toast({
        title: 'AI Chat Error',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSending(false);
      refreshQuota().catch(() => {
        // Keep UI responsive even if quota refresh fails.
      });
    }
  };

  const handleInputChange = (value: string, cursor: number) => {
    setInput(value);

    const mention = detectMentionAtCursor(value, cursor);
    setMentionMatch(mention);
    setMentionOpen(!!mention);
    setMentionHighlightIndex(0);

    if (mention) {
      ensureLibraryIndexLoaded().catch(() => {
        // Mention loader error is already handled with toast.
      });
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (event.key === 'ArrowDown' && mentionOptions.length > 0) {
        event.preventDefault();
        setMentionHighlightIndex((previous) => (previous + 1) % mentionOptions.length);
        return;
      }
      if (event.key === 'ArrowUp' && mentionOptions.length > 0) {
        event.preventDefault();
        setMentionHighlightIndex((previous) => {
          if (previous <= 0) return mentionOptions.length - 1;
          return previous - 1;
        });
        return;
      }
      if (event.key === 'Enter' && mentionOptions.length > 0) {
        event.preventDefault();
        handleMentionPick(mentionOptions[Math.max(0, mentionHighlightIndex)] || mentionOptions[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionOpen(false);
        setMentionMatch(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) handleSend();
    }
  };

  const handlePromptClick = (prompt: string) => {
    setInput(prompt);
    setMentionOpen(false);
    setMentionMatch(null);
  };

  const clearConversation = () => {
    setMessages([]);
    setError(null);
    localStorage.removeItem(LOCAL_HISTORY_FALLBACK_KEY);
    if (historyReady && driveHistoryEnabled) {
      saveGDriveAiChatHistory('[]').catch(() => {
        // Ignore Drive clear errors.
      });
    }
  };

  const handleUpgradeRequest = async () => {
    const first = referral1.trim();
    const second = referral2.trim();
    if (!first || !second) {
      setError('Please enter two referral values before submitting.');
      return;
    }
    if (first.toLowerCase() === second.toLowerCase()) {
      setError('Referral values must be different.');
      return;
    }

    setSubmittingUpgrade(true);
    try {
      await submitAiUpgradeRequest({
        referral1: first,
        referral2: second,
        note: upgradeNote.trim(),
      });
      setReferral1('');
      setReferral2('');
      setUpgradeNote('');
      await refreshUpgradeStatus();
      toast({
        title: 'Upgrade Request Sent',
        description: 'Your request was submitted for admin review.',
      });
    } catch (err) {
      const message = parseAiError(err);
      setError(message);
      toast({
        title: 'Request Failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSubmittingUpgrade(false);
    }
  };

  const handleAdditionalUpgradeRequest = async () => {
    const reason = additionalReason.trim();
    if (!reason) {
      setError('Please explain why you need additional rate limits.');
      return;
    }
    if (!additionalReasonReady) {
      setError(`Please provide at least ${minAdditionalWords} words or ${minAdditionalChars} characters.`);
      return;
    }

    setSubmittingAdditional(true);
    try {
      await submitAiAdditionalUpgradeRequest({ reason });
      setAdditionalReason('');
      setAdditionalDialogOpen(false);
      setDismissedQuotaNudge(true);
      await Promise.all([refreshUpgradeStatus(), refreshQuota()]);
      toast({
        title: 'Additional Request Sent',
        description: 'Your additional limit request was submitted for admin review.',
      });
    } catch (err) {
      const message = parseAiError(err);
      setError(message);
      toast({
        title: 'Request Failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSubmittingAdditional(false);
    }
  };

  const hasEntitlement = !!upgradeStatus?.entitlement;
  const latestRequest = upgradeStatus?.request;
  const latestRequestType = latestRequest?.request_type || 'referral';
  const hasApprovedUpgrade = hasEntitlement || latestRequest?.status === 'approved';
  const hasPendingAdditionalRequest = latestRequest?.status === 'pending' && latestRequestType === 'additional';
  const hasRejectedAdditionalRequest = latestRequest?.status === 'rejected' && latestRequestType === 'additional';
  const hasQuotaExhausted = !!quota && quota.remaining <= 0;
  const showQuotaNudge = hasQuotaExhausted && !isBanned && !dismissedQuotaNudge;

  return (
    <motion.div
      key="ai-chat-view"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="h-full min-h-0 box-border pt-10 pl-2 pb-2"
    >
      <div
        className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-3xl border border-white/10 bg-black/45 backdrop-blur-2xl shadow-elevation-3"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.14),transparent_45%),radial-gradient(circle_at_85%_85%,rgba(255,255,255,0.06),transparent_35%)]" />

        <div className="relative border-b border-white/10 px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/20 bg-white/10">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold tracking-wide text-white">AI Chat Beta</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={refreshQuota}
                className="border-white/15 bg-white/5 text-xs text-white hover:bg-white/10"
                disabled={loadingQuota}
              >
                {loadingQuota ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh Quota
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearConversation}
                className="border-white/15 bg-white/5 text-xs text-neutral-200 hover:bg-white/10"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/35 p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-neutral-300">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                Free quota
              </span>
              <span className="text-neutral-300">
                {quota ? `${quota.remaining}/${quota.limit} left` : '--'}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-sky-300 to-white"
                animate={{ width: `${remainingPercent}%` }}
                transition={{ duration: 0.35 }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400">
              <span>Resets: {formatReset(quota?.reset_at_ms)}</span>
              <span>Policy: {formatPolicy(quota, quotaRateLimit)}</span>
            </div>
            {isBanned && (
              <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-100">
                AI chat is blocked after repeated rejected requests. Ask admin to unban from AI admin panel.
              </div>
            )}
          </div>
        </div>

        <div className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-0 lg:grid-cols-[1fr_320px]">
          <div className="flex min-h-0 flex-col border-b border-white/10 lg:border-b-0 lg:border-r lg:border-white/10">
            <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
              {messages.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
                </div>
              ) : (
                <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <div className="space-y-3">
                    {messages.map((line) => (
                      (() => {
                        const deepProfile = line.role === 'assistant'
                          ? parseTmdbDeepProfileForCard(line.content)
                          : null;

                        return (
                          <motion.div
                            key={line.id}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            data-chat-line-id={line.id}
                            className={`flex ${line.role === 'user' ? 'justify-end' : 'justify-start'}`}
                          >
                            <div
                              className={`rounded-2xl text-sm leading-relaxed shadow-md ${
                                line.role === 'user'
                                  ? 'max-w-[88%] border border-white/20 bg-white px-4 py-3 text-black'
                                  : deepProfile
                                    ? 'max-w-[95%] border border-white/12 bg-white/[0.08] p-2 text-white'
                                    : 'max-w-[88%] border border-white/12 bg-white/[0.08] px-4 py-3 text-white'
                              }`}
                            >
                              {line.role === 'assistant' ? (
                                deepProfile ? (
                                  <TmdbDeepProfileCard
                                    profile={deepProfile}
                                    onMoreInfo={() => { openTmdbMoreInfo(deepProfile); }}
                                  />
                                ) : (
                                  <div
                                    className="max-w-none break-words text-sm leading-relaxed [&_a]:text-sky-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-sky-200 [&_blockquote]:mb-2 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-300 [&_code]:rounded [&_code]:bg-white/12 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_em]:text-neutral-200 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:leading-snug [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:leading-snug [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_li]:mb-1 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/45 [&_pre]:p-2 [&_strong]:font-semibold [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5"
                                  >
                                    <ReactMarkdown
                                      remarkPlugins={[remarkGfm]}
                                    >
                                      {line.content}
                                    </ReactMarkdown>
                                  </div>
                                )
                              ) : (
                                <p className="whitespace-pre-wrap break-words">{line.content}</p>
                              )}
                              <p className={`text-[10px] ${line.role === 'user' ? 'mt-2 text-black/60' : (deepProfile ? 'mt-1 px-1 text-neutral-400' : 'mt-2 text-neutral-400')}`}>
                                {formatIstTime(line.createdAt)}
                              </p>
                            </div>
                          </motion.div>
                        );
                      })()
                    ))}

                    <AnimatePresence>
                      {sending && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="flex justify-start"
                        >
                          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-neutral-300">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Thinking...
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="mx-4 mb-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-100 sm:mx-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <span>{error}</span>
              </div>
            )}

            <div className="border-t border-white/10 p-3 sm:p-4">
              <div className="relative rounded-2xl border border-white/12 bg-black/50 p-1.5">
                {linkedItems.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
                    {linkedItems.map((entry) => (
                      <span
                        key={entry.key}
                        className="inline-flex items-center gap-1 rounded-full border border-sky-300/35 bg-sky-500/15 px-2 py-1 text-[10px] text-sky-100"
                      >
                        <AtSign className="h-3 w-3" />
                        <span className="max-w-[170px] truncate">{entry.title}</span>
                        <span className="rounded-full border border-sky-200/25 px-1 py-0.5 text-[9px] uppercase tracking-wide text-sky-100/80">
                          {entry.source}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeLinkedItem(entry.key)}
                          className="rounded p-0.5 text-sky-100/80 transition hover:bg-sky-200/20 hover:text-white"
                          aria-label={`Remove linked item ${entry.title}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {mentionOpen && (
                  <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-white/20 bg-[#0b0f16] shadow-2xl ring-1 ring-black/70">
                    <div className="flex items-center justify-between border-b border-white/15 bg-[#0f141f] px-3 py-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-300">
                        Link Content With @
                      </p>
                      <span className="text-[10px] text-neutral-500">
                        {libraryIndexReady ? `${libraryIndex.length} indexed` : 'Loading index...'}
                      </span>
                    </div>
                    <div className="max-h-56 overflow-y-auto p-1.5">
                      {libraryIndexLoading && mentionOptions.length === 0 && (
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-neutral-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Loading your local + drive indexed content...
                        </div>
                      )}
                      {!libraryIndexLoading && mentionOptions.length === 0 && (
                        <div className="px-2 py-2 text-xs text-neutral-400">
                          No matching content found. Try a different title after <span className="text-neutral-200">@</span>.
                        </div>
                      )}
                      {mentionOptions.map((entry, index) => (
                        <button
                          key={entry.key}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleMentionPick(entry)}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors ${
                            mentionHighlightIndex === index
                              ? 'bg-[#1a2433] text-white'
                              : 'bg-[#0e131d] text-neutral-200 hover:bg-[#141c29]'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{entry.title}</p>
                            <p className="mt-0.5 text-[10px] text-neutral-400">
                              {entry.media_type === 'movie'
                                ? 'Movie'
                                : (entry.media_type === 'tvshow' ? 'TV Show' : `Episode S${entry.season_number || '?'}E${entry.episode_number || '?'}`)}
                              {entry.year ? ` · ${entry.year}` : ''}
                            </p>
                          </div>
                          <span className="ml-3 shrink-0 rounded-full border border-white/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-300">
                            {entry.source}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => {
                    const value = event.target.value;
                    const cursor = event.target.selectionStart ?? value.length;
                    handleInputChange(value, cursor);
                  }}
                  onKeyDown={handleInputKeyDown}
                  placeholder="Type @ to link local/drive content, then ask your question..."
                  className="h-14 w-full resize-none rounded-xl bg-transparent px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-500 focus:outline-none"
                />
                <div className="mt-1.5 flex items-center justify-between gap-2 px-1 pb-0.5">
                  <p className="text-[10px] text-neutral-500">
                    `@` link content, `Enter` send, `Shift+Enter` newline
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSend}
                    disabled={!canSend}
                    className="h-8 bg-white px-3 text-xs text-black hover:bg-neutral-200 disabled:opacity-50"
                  >
                    {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                    Send
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 overflow-hidden p-4 sm:p-5">
            <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">Quick Prompts</p>
              <div className="space-y-2">
                {PROMPT_CHIPS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => handlePromptClick(prompt)}
                    className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-left text-xs text-neutral-200 transition-all hover:border-white/20 hover:bg-white/[0.07]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/12 bg-white/[0.03] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">Higher Limit Request</p>
              {loadingUpgradeStatus ? (
                <div className="mt-3 inline-flex items-center gap-2 text-xs text-neutral-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading request status...
                </div>
              ) : (
                <>
                  {upgradeStatus?.entitlement && (
                    <div className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3 text-xs text-emerald-100">
                      Approved: {upgradeStatus.entitlement.max_chats} chats / {upgradeStatus.entitlement.window_days} days
                      <div className="mt-1 text-[11px] text-emerald-200/80">
                        Expires {formatReset(upgradeStatus.entitlement.expires_at_ms)}
                      </div>
                    </div>
                  )}

                  {!hasApprovedUpgrade && latestRequest?.status === 'pending' && (
                    <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">
                      Your request is pending admin review.
                    </div>
                  )}

                  {!hasApprovedUpgrade && latestRequest?.status === 'rejected' && (
                    <div className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-100">
                      Last request was rejected. You can submit a new one.
                    </div>
                  )}

                  {!hasApprovedUpgrade && latestRequest?.status !== 'pending' && (
                    <div className="mt-3 space-y-2">
                      <input
                        type="text"
                        value={referral1}
                        onChange={(e) => setReferral1(e.target.value)}
                        placeholder="Referral 1 (username/email/link)"
                        className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />
                      <input
                        type="text"
                        value={referral2}
                        onChange={(e) => setReferral2(e.target.value)}
                        placeholder="Referral 2 (username/email/link)"
                        className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />
                      <textarea
                        value={upgradeNote}
                        onChange={(e) => setUpgradeNote(e.target.value)}
                        placeholder="Optional note"
                        className="h-16 w-full resize-none rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleUpgradeRequest}
                        disabled={submittingUpgrade || !referral1.trim() || !referral2.trim()}
                        className="w-full bg-white text-black hover:bg-neutral-200 disabled:opacity-50"
                      >
                        {submittingUpgrade ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                        Request Higher Limit
                      </Button>
                    </div>
                  )}

                  {hasPendingAdditionalRequest && (
                    <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">
                      Your additional limit request is pending admin review.
                    </div>
                  )}

                  {hasRejectedAdditionalRequest && (
                    <div className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-100">
                      Your last additional limit request was rejected. You can submit a new one.
                    </div>
                  )}

                  {hasApprovedUpgrade && !hasPendingAdditionalRequest && (
                    <div className="mt-3 space-y-2">
                      <p className="text-[11px] text-neutral-400">
                        Need more than your current approved quota? Send an additional request with a detailed reason.
                      </p>
                      <textarea
                        value={additionalReason}
                        onChange={(e) => setAdditionalReason(e.target.value)}
                        placeholder={`Why do you need additional rate limits? (Minimum ${minAdditionalWords} words or ${minAdditionalChars} characters)`}
                        className="h-20 w-full resize-none rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />
                      <p className={`text-[11px] ${additionalReasonReady ? 'text-emerald-300' : 'text-amber-300'}`}>
                        {additionalReasonWords}/{minAdditionalWords} words or {additionalReasonChars}/{minAdditionalChars} chars
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleAdditionalUpgradeRequest}
                        disabled={submittingAdditional || !additionalReasonReady}
                        className="w-full bg-white text-black hover:bg-neutral-200 disabled:opacity-50"
                      >
                        {submittingAdditional ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                        Request Additional Limit
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>
      </div>

      <AnimatePresence>
        {liveNotice && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="fixed right-5 top-24 z-50 w-[min(92vw,400px)] rounded-2xl border border-white/20 bg-black/90 p-4 shadow-2xl backdrop-blur-xl"
          >
            <p className="text-sm font-semibold text-white">{liveNotice.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-300">{liveNotice.description}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[11px] text-neutral-500">
                {formatIstTime(liveNotice.createdAt)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setLiveNotice(null)}
                className="border-white/20 bg-transparent text-neutral-200 hover:bg-white/10"
              >
                Dismiss
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showQuotaNudge && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            className="fixed bottom-5 right-5 z-40 w-[min(92vw,360px)] rounded-2xl border border-white/20 bg-black/85 p-4 shadow-2xl backdrop-blur-xl"
          >
            <p className="text-sm font-semibold text-white">Ran out of AI credits?</p>
            <p className="mt-1 text-xs text-neutral-300">
              Ask for additional credits here. Provide a detailed reason and submit for review.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => setAdditionalDialogOpen(true)}
                disabled={hasPendingAdditionalRequest}
                className="bg-white text-black hover:bg-neutral-200 disabled:opacity-50"
              >
                Ask for More
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDismissedQuotaNudge(true)}
                className="border-white/20 bg-transparent text-neutral-200 hover:bg-white/10"
              >
                Later
              </Button>
            </div>
            {hasPendingAdditionalRequest && (
              <p className="mt-2 text-[11px] text-amber-300">You already have an additional request pending review.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={tmdbMoreInfoOpen} onOpenChange={setTmdbMoreInfoOpen}>
        <DialogContent className="max-w-4xl border-white/15 bg-[#0c0e14] text-white">
          <DialogHeader>
            <DialogTitle>
              {tmdbMoreInfoData ? `${tmdbMoreInfoData.title} · TMDB Full Details` : 'TMDB Full Details'}
            </DialogTitle>
            <DialogDescription className="text-neutral-300">
              Expanded metadata loaded directly from TMDB proxy.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[68vh] overflow-y-auto pr-1">
            {tmdbMoreInfoLoading && (
              <div className="flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] p-3 text-sm text-neutral-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading TMDB details...
              </div>
            )}

            {!tmdbMoreInfoLoading && tmdbMoreInfoError && (
              <div className="rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-100">
                {tmdbMoreInfoError}
              </div>
            )}

            {!tmdbMoreInfoLoading && !tmdbMoreInfoError && tmdbMoreInfoData && (
              <div className="space-y-3">
                <div className="rounded-2xl border border-white/12 bg-gradient-to-br from-[#11182a] to-[#1a1a29] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{tmdbMoreInfoData.title}</h3>
                      {tmdbMoreInfoData.subtitle && (
                        <p className="text-sm text-neutral-300">{tmdbMoreInfoData.subtitle}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded-full border border-sky-200/35 bg-sky-300/14 px-2 py-0.5 uppercase tracking-[0.08em] text-sky-100">
                        {tmdbMoreInfoData.mediaType}
                      </span>
                      <span className="rounded-full border border-white/18 bg-white/10 px-2 py-0.5 text-neutral-200">
                        TMDB #{tmdbMoreInfoData.tmdbId}
                      </span>
                    </div>
                  </div>

                  {tmdbMoreInfoData.tagline && (
                    <p className="mt-2 text-sm italic text-neutral-300">{tmdbMoreInfoData.tagline}</p>
                  )}
                  {tmdbMoreInfoData.overview && (
                    <p className="mt-2 text-sm leading-relaxed text-neutral-100">{tmdbMoreInfoData.overview}</p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                    {tmdbMoreInfoData.runtimeText && (
                      <span className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-neutral-200">
                        Runtime: {tmdbMoreInfoData.runtimeText}
                      </span>
                    )}
                    {tmdbMoreInfoData.releaseText && (
                      <span className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-neutral-200">
                        Release: {tmdbMoreInfoData.releaseText}
                      </span>
                    )}
                    {tmdbMoreInfoData.statusText && (
                      <span className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-neutral-200">
                        Status: {tmdbMoreInfoData.statusText}
                      </span>
                    )}
                    {tmdbMoreInfoData.ratingText && (
                      <span className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-neutral-200">
                        Rating: {tmdbMoreInfoData.ratingText}
                      </span>
                    )}
                    {tmdbMoreInfoData.popularityText && (
                      <span className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-neutral-200">
                        Popularity: {tmdbMoreInfoData.popularityText}
                      </span>
                    )}
                  </div>

                  {tmdbMoreInfoData.financials.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {tmdbMoreInfoData.financials.map((line) => (
                        <p key={line} className="text-xs text-emerald-200">{line}</p>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Genres</p>
                    <div className="flex flex-wrap gap-1.5">
                      {tmdbMoreInfoData.genres.length > 0 ? tmdbMoreInfoData.genres.map((genre) => (
                        <span key={genre} className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-[11px] text-neutral-100">
                          {genre}
                        </span>
                      )) : <span className="text-xs text-neutral-500">Unavailable</span>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Languages</p>
                    <div className="flex flex-wrap gap-1.5">
                      {tmdbMoreInfoData.languages.length > 0 ? tmdbMoreInfoData.languages.map((language) => (
                        <span key={language} className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-[11px] text-neutral-100">
                          {language}
                        </span>
                      )) : <span className="text-xs text-neutral-500">Unavailable</span>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Production</p>
                    {tmdbMoreInfoData.production.length > 0 ? (
                      <ul className="space-y-1">
                        {tmdbMoreInfoData.production.map((row) => (
                          <li key={row} className="text-xs text-neutral-100">{row}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Keywords</p>
                    <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      {tmdbMoreInfoData.keywords.length > 0 ? tmdbMoreInfoData.keywords.map((keyword) => (
                        <span key={keyword} className="rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-[11px] text-neutral-100">
                          {keyword}
                        </span>
                      )) : <span className="text-xs text-neutral-500">Unavailable</span>}
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Cast</p>
                    {tmdbMoreInfoData.cast.length > 0 ? (
                      <ul className="max-h-56 space-y-1 overflow-y-auto">
                        {tmdbMoreInfoData.cast.map((row) => (
                          <li key={`${row.name}-${row.detail || ''}`} className="text-xs text-neutral-100">
                            {row.name}{row.detail ? ` as ${row.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Crew</p>
                    {tmdbMoreInfoData.crew.length > 0 ? (
                      <ul className="max-h-56 space-y-1 overflow-y-auto">
                        {tmdbMoreInfoData.crew.map((row) => (
                          <li key={`${row.name}-${row.detail}`} className="text-xs text-neutral-100">
                            {row.name} ({row.detail})
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Recommendations</p>
                    {tmdbMoreInfoData.recommendations.length > 0 ? (
                      <ul className="max-h-40 space-y-1 overflow-y-auto">
                        {tmdbMoreInfoData.recommendations.map((row) => (
                          <li key={row} className="text-xs text-neutral-100">{row}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Similar Titles</p>
                    {tmdbMoreInfoData.similar.length > 0 ? (
                      <ul className="max-h-40 space-y-1 overflow-y-auto">
                        {tmdbMoreInfoData.similar.map((row) => (
                          <li key={row} className="text-xs text-neutral-100">{row}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Availability</p>
                    {tmdbMoreInfoData.providers ? (
                      <div className="space-y-1 text-xs text-neutral-100">
                        <p>Region: {tmdbMoreInfoData.providers.region}</p>
                        <p>Stream: {tmdbMoreInfoData.providers.flatrate.join(', ') || 'Unavailable'}</p>
                        <p>Rent: {tmdbMoreInfoData.providers.rent.join(', ') || 'Unavailable'}</p>
                        <p>Buy: {tmdbMoreInfoData.providers.buy.join(', ') || 'Unavailable'}</p>
                      </div>
                    ) : (
                      <p className="text-xs text-neutral-500">Unavailable</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/12 bg-black/30 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">Extra Metadata</p>
                    <ul className="space-y-1 text-xs text-neutral-100">
                      {tmdbMoreInfoData.releaseMeta.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                      {tmdbMoreInfoData.mediaAssets.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {tmdbMoreInfoData?.tmdbUrl && (
                <a
                  href={tmdbMoreInfoData.tmdbUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-sky-200/35 bg-sky-300/14 px-2.5 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-300/24"
                >
                  TMDB
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              {tmdbMoreInfoData?.imdbUrl && (
                <a
                  href={tmdbMoreInfoData.imdbUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-xs font-medium text-neutral-100 hover:bg-white/18"
                >
                  IMDb
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              {tmdbMoreInfoData?.homepage && (
                <a
                  href={tmdbMoreInfoData.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-xs font-medium text-neutral-100 hover:bg-white/18"
                >
                  Homepage
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTmdbMoreInfoOpen(false)}
              className="border-white/20 bg-transparent text-neutral-200 hover:bg-white/10"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={additionalDialogOpen} onOpenChange={setAdditionalDialogOpen}>
        <DialogContent className="max-w-xl border-white/15 bg-[#0f1016] text-white">
          <DialogHeader>
            <DialogTitle>Request Additional AI Credits</DialogTitle>
            <DialogDescription className="text-neutral-300">
              Explain why you need a higher AI limit. Minimum {minAdditionalWords} words or {minAdditionalChars} characters.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <textarea
              value={additionalReason}
              onChange={(e) => setAdditionalReason(e.target.value)}
              placeholder="Describe your use case in detail. Include what you are trying to do and why current limits are not enough."
              className="h-40 w-full resize-none rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
            />
            <div className="flex items-center justify-between text-xs">
              <span className={additionalReasonReady ? 'text-emerald-300' : 'text-amber-300'}>
                {additionalReasonWords}/{minAdditionalWords} words or {additionalReasonChars}/{minAdditionalChars} chars
              </span>
              {!additionalReasonReady && (
                <span className="text-neutral-400">
                  Add {Math.max(0, minAdditionalWords - additionalReasonWords)} words or {Math.max(0, minAdditionalChars - additionalReasonChars)} chars
                </span>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setAdditionalDialogOpen(false)}
              className="border-white/20 bg-transparent text-neutral-200 hover:bg-white/10"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAdditionalUpgradeRequest}
              disabled={submittingAdditional || !additionalReasonReady || hasPendingAdditionalRequest || isBanned}
              className="bg-white text-black hover:bg-neutral-200 disabled:opacity-50"
            >
              {submittingAdditional ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
