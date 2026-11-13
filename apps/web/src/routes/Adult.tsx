import { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, ChevronDown, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { TagsRail } from '../components/TagsRail';
import { TitleGrid, useBrowseQuery } from '../components/TitleGrid';
import { Nothing } from '../components/Nothing';
import { EMPTY_FILTERS, filtersFromParams, paramsFromFilters, type Filters, type QuickFilter, QUICK } from '../components/FilterBar';
import { typingDelay } from '../lib/typingDelay';
import { useGridMetrics } from '../lib/useGridMetrics';
import { useShape } from '../lib/formFactor';
import { linkId } from '../lib/api';
import { useTally } from '../lib/tally';

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
export function Adult() {
  const [params, setParams] = useSearchParams();
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedSex, setSelectedSex] = useState<string | null>(null);
  const [chipsOpen, setChipsOpen] = useState(true);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = useCallback((f: Filters) => {
    const p = paramsFromFilters(f);
    setParams(p, { replace: true });
  }, [setParams]);

  // Search band state — when a tag or sex is selected, set the search query
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
  const [gridRef, metrics] = useGridMetrics(168, 230, touchScreen === 'phone' ? 6 : 5);

  // Stats for title count display
  const [stats, setStats] = useState<{ total: number; loading: boolean; error: string | null }>({
    total: 0, loading: true, error: null,
  });
  const onStatsCallback = useCallback(
    (s: { total: number; loading: boolean; error: string | null }) =>
      setStats((p) =>
        p.total === s.total && p.loading === s.loading && p.error === s.error ? p : s,
      ),
    [],
  );

  const hasActiveFilter = selectedTag || selectedSex || filters.q || filters.quick !== null;
  const tallyOf = useTally();

  // Gender filter options matching the existing adult content genders
  const genderOptions = [
    { id: 'straight', label: 'Straight' },
    { id: 'gay', label: 'Gay' },
    { id: 'lesbian', label: 'Lesbian' },
    { id: 'bisexual', label: 'Bisexual' },
    { id: 'trans', label: 'Trans' },
  ];

  // Pill component matching FilterBar's Pill style
  const Pill = ({ active, onClick, children }: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap border px-2 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
        touch:px-2.5 touch:py-1.5 touch:text-[length:var(--t-xs)]
        ${active
          ? 'border-tally bg-tally/10 text-tally'
          : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink'}`}
    >
      {children}
    </button>
  );

  // Button style matching FilterBar's destBtn
  const destBtn = (active: boolean) =>
    `dest tap flex shrink-0 items-center gap-1.5 border px-2 py-1 font-mono
     text-[length:var(--t-2xs)] tracking-wider transition-colors touch:py-2
     ${active
       ? 'border-tally text-tally'
       : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'}`;

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar matching Movies tab layout */}
      <div className="no-round relative border-b border-rule bg-panel/60">
        <div className="relative z-[60] flex items-center gap-2 p-[4px]">
          {/* Filters icon button */}
          <button
            type="button"
            aria-label="Filters"
            title="Filters"
            onClick={() => {}}
            className={`${destBtn(false)} px-1.5`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>

          {/* All pill */}
          <Pill
            active={!selectedSex && !selectedTag && !filters.q && !filters.quick}
            onClick={() => {
              setSelectedSex(null);
              setSelectedTag(null);
              setDraft('');
              setFilters({ ...EMPTY_FILTERS, sort: 'default', dir: 'asc' });
            }}
          >
            All
          </Pill>

          {/* Just added & Top rated quick filters */}
          {QUICK.map((qf) => (
            <Pill
              key={qf.id}
              active={filters.quick === qf.id}
              onClick={() => setFilters({ ...filters, quick: filters.quick === qf.id ? null : qf.id })}
            >
              {qf.label}
            </Pill>
          ))}

          {/* Title count */}
          <span
            aria-live="polite"
            className="shrink-0 whitespace-nowrap font-mono text-[length:var(--t-2xs)] text-ink-2"
          >
            {stats.loading ? '…'
              : tallyOf(offered ?? 0) === null ? ''
                : `${tallyOf(offered ?? 0)} ${offered === 1 ? 'title' : 'titles'}`}
          </span>

          {/* Reset button when filters are active */}
          {hasActiveFilter && (
            <button
              type="button"
              aria-label="Reset filters"
              title="Reset filters"
              onClick={() => {
                setSelectedSex(null);
                setSelectedTag(null);
                setDraft('');
                setFilters({ ...EMPTY_FILTERS, sort: 'default', dir: 'asc' });
              }}
              className={destBtn(false)}
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          )}

          {/* Gender toggle button (replaces Genres) */}
          <button
            type="button"
            aria-expanded={chipsOpen}
            aria-label={chipsOpen ? 'Hide genders' : 'Show genders'}
            onClick={() => setChipsOpen(!chipsOpen)}
            className={destBtn(chipsOpen || (selectedSex !== null))}
          >
            <span>Gender{selectedSex ? ' · 1' : ''}</span>
            <ChevronDown className={`h-3 w-3 transition-transform ${chipsOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Horizontal scrolling gender chips */}
          {chipsOpen && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
              {genderOptions.map((gender) => {
                const isSelected = selectedSex === gender.id;
                return (
                  <Pill
                    key={gender.id}
                    active={isSelected}
                    onClick={() => handleSexSelect(isSelected ? null : gender.id)}
                  >
                    {gender.label}
                  </Pill>
                );
              })}
            </div>
          )}
        </div>

        {/* Tags rail - horizontal scrolling tags below filter strip */}
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
              filtered={filters.q !== '' || filters.categoryId != null || !!selectedTag || !!selectedSex || !!filters.quick}
              href={(it) => `/movie/${linkId(it)}?from=adult`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
