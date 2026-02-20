import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

export type TmdbProfileSectionKey =
  | 'cast'
  | 'keyCrew'
  | 'productionCompanies'
  | 'genres'
  | 'releaseDetails'
  | 'plotSummary'
  | 'notableFacts'
  | 'similarTitles'
  | 'officialLinks';

export interface TmdbProfileLink {
  label: string;
  url: string;
}

export interface TmdbDeepProfileData {
  title: string;
  year: string | null;
  sections: Record<TmdbProfileSectionKey, string[]>;
  links: TmdbProfileLink[];
}

export type TmdbProfilePanelKey = 'overview' | 'cast' | 'crew' | 'facts' | 'similar' | 'links';

export function cleanTmdbProfileLine(value: string): string {
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

export function dedupePreserveOrder(items: string[], maxItems: number): string[] {
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

export function TmdbDeepProfileCard({
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
