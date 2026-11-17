import { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, LayoutGrid, List, ChevronDown, User, X } from 'lucide-react';
import { TagsRail } from '../components/TagsRail';
import { TitleGrid, useBrowseQuery } from '../components/TitleGrid';
import { Nothing } from '../components/Nothing';
import { EMPTY_FILTERS, filtersFromParams, paramsFromFilters, type Filters } from '../components/FilterBar';
import { typingDelay } from '../lib/typingDelay';
import { useGridMetrics } from '../lib/useGridMetrics';
import { useShape } from '../lib/formFactor';
import { linkId } from '../lib/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { localAllItems } from '../lib/localRead';
import { useScope } from '../lib/scope';
import { aggregateCast, getInitials } from '../lib/adult';
import type { AdultCast } from '../lib/adult';

/**
 * Adult content section with FilterBar-style layout matching Movies tab.
 *
 * Layout matches the Movies/Series tabs:
 * - FilterBar-style strip with All pill, title count, and Gender toggle
 * - Horizontal scrolling gender chips (replacing Genres)
 * - Horizontal scrolling tags rail below the filter strip
 * - Content grid with VOD items
 *
 * The adult filter is bypassed when accessing this section.
 */
/** View mode: 'covers' shows portrait cards (default), 'tiles' shows landscape cards */
type ViewMode = 'covers' | 'tiles';

export function Adult() {
  const [params, setParams] = useSearchParams();
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedSex, setSelectedSex] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('tiles');
  const [genderOpen, setGenderOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const { scope } = useScope();

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = useCallback((f: Filters) => {
    const p = paramsFromFilters(f);
    setParams(p, { replace: true });
  }, [setParams]);

  // Search draft state with debounce
  const [draft, setDraft] = useState(filters.q);
  useEffect(() => { setDraft(filters.q); }, [filters.q]);
  useEffect(() => {
    const t = draft.trim();
    if (t === filters.q.trim()) return;
    const id = window.setTimeout(() => setFilters({ ...filters, q: t }), typingDelay());
    return () => window.clearTimeout(id);
  }, [draft, filters, setFilters]);

  // When a tag is clicked, set the search query to the tag name
  const handleTagSelect = useCallback((tagId: string | null) => {
    setSelectedTag(tagId);
    if (tagId) {
      setDraft(tagId);
      setFilters({ ...filters, q: tagId });
    } else {
      setDraft('');
      setFilters({ ...filters, q: '' });
    }
  }, [filters, setFilters]);

  // When a gender filter is clicked, set the search query
  const handleSexSelect = useCallback((sex: string | null) => {
    setSelectedSex(sex);
    if (sex) {
      setDraft(sex);
      setFilters({ ...filters, q: sex });
    } else {
      if (filters.q === selectedSex) {
        setDraft('');
        setFilters({ ...filters, q: '' });
      }
    }
  }, [filters, selectedSex, setFilters]);

  const { query, offered } = useBrowseQuery('movies', {
    ...filters,
  }, undefined, true);
  const { touchScreen } = useShape();

  // Fetch adult cast members for the cast rail
  const { data: castMembers } = useQuery<AdultCast[]>({
    queryKey: ['adult-cast', scope],
    queryFn: async (): Promise<AdultCast[]> => {
      try {
        const items = localAllItems('movies', { ...scope, adultOnly: true, limit: 500 });
        if (items.length === 0) return [];
        const batchSize = 10;
        const castItems: Array<{ cast?: ReadonlyArray<{ name: string; image?: string | null; sex?: string }> }> = [];
        for (let i = 0; i < Math.min(items.length, 200); i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map(item => api.movieDetail(item.id))
          );
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value?.detail?.cast) {
              const cast = result.value.detail.cast;
              const castArray = cast.map((member: any) => ({
                name: typeof member === 'string' ? member : (member.name ?? ''),
                image: typeof member === 'string' ? null : (member.image ?? null),
                sex: typeof member === 'string' ? undefined : (member.sex ?? undefined),
              }));
              castItems.push({ cast: castArray });
            }
          }
        }
        return aggregateCast(castItems);
      } catch (e) {
        // Silently fail — cast rail is optional
        console.warn('Failed to fetch adult cast:', e);
        return [];
      }
    },
    staleTime: 10 * 60_000,
  });

  // Search suggestions for adult content (titles + cast names)
  const [suggestions, setSuggestions] = useState<{ name: string; type: string }[]>([]);
  useEffect(() => {
    const t = draft.trim();
    if (t.length < 2) {
      setSuggestions([]);
      return;
    }
    const lower = t.toLowerCase();
    const results: { name: string; type: string }[] = [];
    const seen = new Set<string>();
    const add = (name: string, type: string) => {
      const key = `${type}:${name.toLowerCase()}`;
      if (!seen.has(key) && results.length < 8) {
        seen.add(key);
        results.push({ name, type });
      }
    };
    // Search movie titles
    const items = localAllItems('movies', { ...scope, adultOnly: true, limit: 500 });
    for (const item of items) {
      if (item.name?.toLowerCase().includes(lower)) {
        add(item.name, 'movie');
      }
    }
    // Search cast names
    if (castMembers) {
      for (const member of castMembers) {
        if (member.name.toLowerCase().includes(lower)) {
          add(member.name, 'actor');
        }
      }
    }
    setSuggestions(results);
  }, [draft, scope, castMembers]);

  // Grid metrics change based on view mode: covers = portrait (2:3), tiles = landscape (3:2)
  const cardWidth = viewMode === 'tiles' ? 300 : 168;
  const cardHeight = viewMode === 'tiles' ? 170 : 230;
  const minCols = viewMode === 'tiles' ? 3 : (touchScreen === 'phone' ? 6 : 5);
  const [gridRef, metrics] = useGridMetrics(cardWidth, cardHeight, minCols);

  // No-op stats callback (TitleGrid requires it, but we don't display the count in the new layout)
  const onStatsCallback = useCallback(() => {}, []);

  // Gender filter options
  const genderOptions = [
    { id: 'straight', label: 'Straight' },
    { id: 'gay', label: 'Gay' },
    { id: 'lesbian', label: 'Lesbian' },
    { id: 'bisexual', label: 'Bisexual' },
    { id: 'trans', label: 'Trans' },
  ];

  // Button style for view toggle
  const destBtn = (active: boolean) =>
    `dest tap flex shrink-0 items-center gap-1.5 border px-2 py-1 font-mono
     text-[length:var(--t-2xs)] tracking-wider transition-colors touch:py-2
     ${active
       ? 'border-tally text-tally'
       : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'}`;

  // Handle clicking a cast member to filter by their name
  const handleCastSelect = useCallback((castName: string) => {
    setDraft(castName);
    setFilters({ ...filters, q: castName });
  }, [filters, setFilters]);

  // Handle clicking a suggestion
  const handleSuggestionClick = useCallback((name: string, type: string) => {
    setDraft(name);
    setFilters({ ...filters, q: name });
    setSuggestionsOpen(false);
  }, [filters, setFilters]);

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar with search-first layout */}
      <div className="no-round relative border-b border-rule bg-panel/60">
        {/* Row 1: Search bar (75%) + Gender filter + View toggle */}
        <div className="relative z-[60] flex items-center gap-2 p-[4px]">
          {/* Search bar — 75% width */}
          <div className="relative min-w-0" style={{ maxWidth: '75%' }}>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
            <input
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setSuggestionsOpen(true); }}
              onFocus={() => setSuggestionsOpen(true)}
              onBlur={() => setTimeout(() => setSuggestionsOpen(false), 200)}
              placeholder="Search titles, cast…"
              aria-label="Search adult content"
              className="w-full border border-rule bg-panel py-1.5 pl-9 pr-8 text-[length:var(--t-sm)] text-ink
                         placeholder:text-ink-3 focus:border-focus focus:outline-none
                         touch:py-2.5 touch:text-[length:var(--t-md)]"
            />
            {draft.length > 0 && (
              <button
                type="button"
                onClick={() => { setDraft(''); setFilters({ ...filters, q: '' }); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
            {/* Autocomplete suggestions dropdown */}
            {suggestionsOpen && suggestions.length > 0 && (
              <div data-nav-contain className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto
                rounded-lg border border-rule bg-panel/95 shadow-lg backdrop-blur">
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.type}-${i}`}
                    type="button"
                    onClick={() => handleSuggestionClick(s.name, s.type)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[length:var(--t-xs)] text-ink
                               hover:bg-tally/10 focus:bg-tally/10 focus:outline-none"
                  >
                    {s.type === 'actor' ? (
                      <User className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    ) : (
                      <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    )}
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto shrink-0 text-[length:var(--t-2xs)] text-ink-3">{s.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Gender toggle + View toggle — fill remaining space */}
          <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
            <button
              type="button"
              aria-expanded={genderOpen}
              aria-label={genderOpen ? 'Hide gender filters' : 'Show gender filters'}
              onClick={() => setGenderOpen(!genderOpen)}
              className={`dest tap flex shrink-0 items-center gap-1.5 border px-2 py-1 font-mono
                text-[length:var(--t-2xs)] tracking-wider transition-colors touch:py-2
                ${genderOpen || selectedSex !== null
                  ? 'border-tally text-tally'
                  : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'}`}
            >
              <span>Gender{selectedSex ? ` · ${selectedSex}` : ''}</span>
              <ChevronDown className={`h-3 w-3 transition-transform ${genderOpen ? 'rotate-180' : ''}`} />
            </button>
          {genderOpen && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={() => { handleSexSelect(null); setGenderOpen(false); }}
                className={`shrink-0 whitespace-nowrap border px-2 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
                  touch:px-2.5 touch:py-1.5 touch:text-[length:var(--t-xs)]
                  ${!selectedSex
                    ? 'border-tally bg-tally/10 text-tally'
                    : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink'}`}
              >
                All
              </button>
              {genderOptions.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => { handleSexSelect(g.id); setGenderOpen(false); }}
                  className={`shrink-0 whitespace-nowrap border px-2 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
                    touch:px-2.5 touch:py-1.5 touch:text-[length:var(--t-xs)]
                    ${selectedSex === g.id
                      ? 'border-tally bg-tally/10 text-tally'
                      : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}

          {/* View mode toggle — Covers / Stills */}
          <button
            type="button"
            aria-label={viewMode === 'covers' ? 'Switch to tiles view' : 'Switch to covers view'}
            title={viewMode === 'covers' ? 'Stills view' : 'Covers view'}
            onClick={() => setViewMode(viewMode === 'covers' ? 'tiles' : 'covers')}
            className={`${destBtn(false)} shrink-0 px-1.5`}
          >
            {viewMode === 'covers' ? (
              <List className="h-3.5 w-3.5" />
            ) : (
              <LayoutGrid className="h-3.5 w-3.5" />
            )}
          </button>
          </div>
        </div>

        {/* Row 2: Cast rail with rounded images */}
        {castMembers && castMembers.length > 0 && (
          <div className="flex items-center gap-2 border-t border-rule/50 px-3 py-2 overflow-x-auto">
            <span className="shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
              Cast
            </span>
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
              {castMembers.slice(0, 30).map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => handleCastSelect(member.name)}
                  className="flex shrink-0 flex-col items-center gap-1 group"
                  title={`Filter by ${member.name}`}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-panel/60
                    border border-rule/50 group-hover:border-tally group-hover:bg-tally/10 transition-colors
                    overflow-hidden">
                    {member.image ? (
                      <img
                        src={member.image}
                        alt={member.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="text-[length:var(--t-xs)] font-medium text-ink-2">
                        {getInitials(member.name)}
                      </span>
                    )}
                  </div>
                  <span className="max-w-[4rem] truncate text-[length:var(--t-2xs)] text-ink-3
                    group-hover:text-ink transition-colors">
                    {member.name.split(' ')[0]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Row 3: Tags rail below */}
        <div className="flex items-center gap-1.5 border-t border-rule/50 px-3 py-1.5 overflow-x-auto">
          <span className="shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
            Tags
          </span>
          <TagsRail
            onTagSelect={handleTagSelect}
            selectedTags={selectedTag ? [selectedTag] : []}
          />
        </div>
      </div>

      {/* Content grid */}
      <div ref={gridRef} className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          {offered === null ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-ink-3">Loading...</div>
            </div>
          ) : offered === 0 ? (
            <Nothing Icon={Search} title="No VOD in this catalogue" body="This catalogue has no adult content." />
          ) : (
            <TitleGrid
              section="movies"
              query={query}
              metrics={metrics}
              onStats={onStatsCallback}
              onClear={() => setFilters(EMPTY_FILTERS)}
              offered={offered}
              filtered={filters.q !== '' || filters.categoryId != null || !!selectedTag || !!selectedSex}
              href={(it) => `/movie/${linkId(it)}?from=adult`}
              aspectRatio={viewMode === 'tiles' ? '3/2' : '2/3'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
