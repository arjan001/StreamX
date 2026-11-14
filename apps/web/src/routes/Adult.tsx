import { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, LayoutGrid, List } from 'lucide-react';
import { TagsRail } from '../components/TagsRail';
import { TitleGrid, useBrowseQuery } from '../components/TitleGrid';
import { Nothing } from '../components/Nothing';
import { EMPTY_FILTERS, filtersFromParams, paramsFromFilters, type Filters } from '../components/FilterBar';
import { typingDelay } from '../lib/typingDelay';
import { useGridMetrics } from '../lib/useGridMetrics';
import { useShape } from '../lib/formFactor';
import { linkId } from '../lib/api';

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
  const [viewMode, setViewMode] = useState<ViewMode>('covers');

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

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar with search-first layout */}
      <div className="no-round relative border-b border-rule bg-panel/60">
        {/* Row 1: Search bar (75%) + Gender & view controls (25%) */}
        <div className="relative z-[60] flex items-center gap-2 p-[4px]">
          {/* Search bar — takes 3/4 of the available space */}
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search titles, tags…"
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
          </div>

          {/* Gender select — compact dropdown on the right */}
          <select
            value={selectedSex ?? ''}
            onChange={(e) => handleSexSelect(e.target.value || null)}
            aria-label="Filter by gender"
            className="shrink-0 border border-rule bg-panel py-1.5 px-2 text-[length:var(--t-2xs)] text-ink
                       focus:border-focus focus:outline-none touch:py-2.5"
          >
            <option value="">All genders</option>
            {genderOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>

          {/* View mode toggle */}
          <button
            type="button"
            aria-label={viewMode === 'covers' ? 'Switch to tiles view' : 'Switch to covers view'}
            title={viewMode === 'covers' ? 'Tiles view' : 'Covers view'}
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

        {/* Row 2: Tags rail below */}
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
