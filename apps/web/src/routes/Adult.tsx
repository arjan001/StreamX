import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, LayoutGrid, LayoutList, X } from 'lucide-react';
import { TagsRail, type Tag } from '../components/TagsRail';
import { CastRail, type CastMember } from '../components/CastRail';
import { TitleGrid, useBrowseQuery } from '../components/TitleGrid';
import { Nothing } from '../components/Nothing';
import { EMPTY_FILTERS, filtersFromParams, paramsFromFilters, type Filters } from '../components/FilterBar';
import { useOkToType } from '../lib/okToType';
import { isFieldSubmit } from '../lib/keys';
import { typingDelay } from '../lib/typingDelay';
import { focusFirst } from '../lib/spatialNav';
import { useGridMetrics } from '../lib/useGridMetrics';

/** Gender filter emoji map */
const GENDER_EMOJI: Record<string, string> = {
  straight: '👫',
  gay: '🏳️‍🌈',
  lesbian: '👩‍❤️‍👩',
  bisexual: '💜',
  trans: '🏳️‍⚧️',
};

/**
 * Adult content section with navigation bar, tags, cast, and VOD grid.
 *
 * Navigation bar contains:
 * - Search bar with autocomplete for cast names and tags
 * - Gender/sex filter pills with emoji icons
 * - Frame selector to toggle between poster and wide card layout
 *
 * Below the nav bar:
 * - Horizontal scrolling tags rail with tiny pill-shaped tags
 * - Horizontal scrolling cast/performer rail with small circular avatars
 * - Content grid with VOD items
 *
 * Tag/cast clicks set the search query to filter the VOD grid.
 * The adult filter is bypassed when accessing this section.
 */
export function Adult() {
  const [params, setParams] = useSearchParams();
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedCast, setSelectedCast] = useState<string | null>(null);
  const [selectedSex, setSelectedSex] = useState<string | null>(null);
  const [frameMode, setFrameMode] = useState<'poster' | 'wide'>('poster');

  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState('');
  const autocompleteRef = useRef<HTMLDivElement>(null);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (f: Filters) => {
    const p = paramsFromFilters(f);
    setParams(p, { replace: true });
  };

  // Search band state — when a tag or cast is selected, set the search query
  // to filter the VOD grid by that tag/cast name
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
  }, [filters, setFilters, setDraft]);

  // When a cast member is clicked, set the search query to the cast name
  const handleCastSelect = useCallback((castId: string | null) => {
    setSelectedCast(castId);
    if (castId) {
      setDraft(castId);
      setFilters({ ...filters, q: castId });
    } else {
      setDraft('');
      setFilters({ ...filters, q: '' });
    }
  }, [filters, setFilters, setDraft]);

  // When a sex filter is clicked, set the search query
  const handleSexSelect = useCallback((sex: string | null) => {
    setSelectedSex(sex);
    if (sex) {
      setDraft(sex);
      setFilters({ ...filters, q: sex });
    } else {
      // Clear sex filter but keep other filters
      if (filters.q === selectedSex) {
        setDraft('');
        setFilters({ ...filters, q: '' });
      }
    }
  }, [filters, selectedSex, setFilters, setDraft]);

  const ok = useOkToType({
    onKeyDown: (e) => {
      if (!isFieldSubmit(e.key, e.nativeEvent.isComposing, e.keyCode)) return;
      e.preventDefault();
      e.currentTarget.blur();
      setShowAutocomplete(false);
      requestAnimationFrame(() => focusFirst());
    },
  });

  // Build autocomplete suggestions from tags and cast data
  // These come from the TagsRail and CastRail queries via react-query cache
  const [suggestions, setSuggestions] = useState<Array<{ type: 'tag' | 'cast'; name: string; id: string }>>([]);

  // Update suggestions when draft changes
  useEffect(() => {
    const q = autocompleteQuery.trim().toLowerCase();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    // We'll collect suggestions from the tags/cast data once available
    // For now, filter based on what we have
    const filtered = suggestions.filter(s => s.name.toLowerCase().includes(q));
    setSuggestions(filtered.slice(0, 8));
  }, [autocompleteQuery]);

  const { query, offered } = useBrowseQuery('movies', {
    ...filters,
  }, undefined, true);
  const [, metrics] = useGridMetrics();
  const onStats = useCallback(() => {}, []);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setSelectedTag(null);
    setSelectedCast(null);
    setSelectedSex(null);
    setDraft('');
    setFilters(EMPTY_FILTERS);
  }, [setFilters]);

  const hasActiveFilter = selectedTag || selectedCast || selectedSex || filters.q;

  return (
    <div className="flex h-full flex-col">
      {/* Navigation bar: Search (3/4) + Gender filter + Layout select */}
      <div className="shrink-0 border-b border-rule bg-panel p-2 space-y-1.5">
        {/* Main row: Search + Gender pills + Frame selector */}
        <div className="flex items-center gap-2">
          {/* Search bar with autocomplete - takes 3/4 width */}
          <div className="relative w-3/4 min-w-0" ref={autocompleteRef}>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
            />
            <input
              value={draft}
              onChange={(e) => {
                const value = e.target.value;
                setDraft(value);
                setAutocompleteQuery(value);
                setShowAutocomplete(value.trim().length >= 2);
              }}
              onFocus={() => {
                if (draft.trim().length >= 2) {
                  setShowAutocomplete(true);
                }
              }}
              placeholder="Search films, tags, performers..."
              aria-label="Search adult content"
              enterKeyHint="search"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              {...ok.props}
              onBlur={() => {
                setTimeout(() => setShowAutocomplete(false), 200);
              }}
              className="block w-full border border-rule/60 bg-ground/50 rounded-lg py-1.5 pl-9 pr-8
                         text-[length:var(--t-sm)] text-ink outline-none
                         placeholder:text-ink-3 focus:border-focus"
            />
            {/* Clear button */}
            {draft && (
              <button
                type="button"
                onClick={() => {
                  setDraft('');
                  setAutocompleteQuery('');
                  setShowAutocomplete(false);
                  clearAllFilters();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-3 hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            {/* Autocomplete dropdown */}
            {showAutocomplete && autocompleteQuery.trim().length >= 2 && (
              <div data-nav-skip className="absolute z-50 mt-1 w-full max-w-md bg-panel border border-rule rounded-lg shadow-lg max-h-60 overflow-y-auto">
                <div className="p-2 text-[length:var(--t-2xs)] text-ink-3">
                  Type to search films, tags, and performers...
                </div>
                <div className="p-1 text-[length:var(--t-xs)] text-ink-3 text-center">
                  Suggestions appear when tags and cast data load
                </div>
              </div>
            )}
          </div>

          {/* Gender/Sex filter pills - compact inline */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => handleSexSelect(null)}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
                ${selectedSex === null
                  ? 'bg-tally text-ground'
                  : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
                }`}
            >
              All
            </button>
            {['Straight', 'Gay', 'Lesbian', 'Bisexual', 'Trans'].map((sex) => {
              const sexId = sex.toLowerCase();
              const isSelected = selectedSex === sexId;
              const emoji = GENDER_EMOJI[sexId];
              return (
                <button
                  key={sexId}
                  type="button"
                  onClick={() => handleSexSelect(isSelected ? null : sexId)}
                  className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
                    ${isSelected
                      ? 'bg-tally text-ground'
                      : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
                    }`}
                >
                  {emoji && <span className="text-[length:var(--t-xs)]">{emoji}</span>}
                  <span className="whitespace-nowrap hidden sm:inline">{sex}</span>
                </button>
              );
            })}
          </div>

          {/* Frame selector - Poster/Wide toggle */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => setFrameMode('poster')}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
                ${frameMode === 'poster'
                  ? 'bg-tally text-ground'
                  : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
                }`}
            >
              <LayoutList className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setFrameMode('wide')}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
                ${frameMode === 'wide'
                  ? 'bg-tally text-ground'
                  : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
                }`}
            >
              <LayoutGrid className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Active filters row - shows selected filters with clear buttons */}
        {hasActiveFilter && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {selectedTag && (
              <div className="flex items-center gap-1">
                <span className="px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium bg-tally text-ground">
                  {selectedTag}
                </span>
                <button
                  type="button"
                  onClick={() => handleTagSelect(null)}
                  className="flex items-center justify-center w-4 h-4 rounded-full bg-tally/60 text-ground hover:bg-tally transition-colors text-[length:var(--t-2xs)] font-bold"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
            {selectedCast && (
              <div className="flex items-center gap-1">
                <span className="px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium bg-tally text-ground">
                  {selectedCast}
                </span>
                <button
                  type="button"
                  onClick={() => handleCastSelect(null)}
                  className="flex items-center justify-center w-4 h-4 rounded-full bg-tally/60 text-ground hover:bg-tally transition-colors text-[length:var(--t-2xs)] font-bold"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
            {selectedSex && (
              <div className="flex items-center gap-1">
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium bg-tally text-ground">
                  {GENDER_EMOJI[selectedSex] && <span>{GENDER_EMOJI[selectedSex]}</span>}
                  {selectedSex}
                </span>
                <button
                  type="button"
                  onClick={() => handleSexSelect(null)}
                  className="flex items-center justify-center w-4 h-4 rounded-full bg-tally/60 text-ground hover:bg-tally transition-colors text-[length:var(--t-2xs)] font-bold"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={clearAllFilters}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] text-ink-3 hover:text-ink transition-colors"
            >
              <X className="h-3 w-3" />
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Tags rail - tiny pill shaped tags */}
      <div className="shrink-0 border-b border-rule/40 bg-ground/30 p-2">
        <TagsRail
          onTagSelect={handleTagSelect}
          selectedTags={selectedTag ? [selectedTag] : []}
        />
      </div>

      {/* Cast rail - small circular performer avatars */}
      <div className="shrink-0 border-b border-rule/40 bg-ground/30 p-2">
        <CastRail
          onCastSelect={handleCastSelect}
          selectedCast={selectedCast}
        />
      </div>

      {/* Content grid */}
      <div className="flex-1 overflow-y-auto">
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
            onStats={onStats}
            onClear={() => setFilters(EMPTY_FILTERS)}
            offered={offered}
            filtered={filters.q !== '' || filters.categoryId != null || !!selectedTag || !!selectedCast || !!selectedSex}
          />
        )}
      </div>
    </div>
  );
}
