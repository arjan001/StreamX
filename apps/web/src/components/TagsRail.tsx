import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { localAllItems } from '../lib/localRead';
import { useScope } from '../lib/scope';
import { aggregateTags, extractTagsFromTitle, extractTagsFromDescription } from '../lib/adult';

export interface Tag {
  id: string;
  name: string;
  count: number;
}

/**
 * Horizontal scrolling rail of pill-shaped tags with counts.
 *
 * Fetching is deferred 500ms after mount to avoid blocking navigation.
 * Tags are fetched in parallel batches for performance. Each tag is a tiny pill
 * that filters the VOD grid when clicked. Used in the adult section.
 */
export function TagsRail({ onTagSelect, selectedTags }: {
  onTagSelect: (tagId: string | null) => void;
  selectedTags: readonly string[];
}) {
  const { scope } = useScope();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEnabled(true), 500);
    return () => clearTimeout(t);
  }, []);

  const { data: tags, isLoading } = useQuery({
    queryKey: ['adult-tags', scope],
    queryFn: async (): Promise<Tag[]> => {
      // Fetch adult items with adultOnly flag to get all adult content
      const items = localAllItems('movies', { ...scope, adultOnly: true, limit: 2000 });
      if (items.length === 0) return [];

      // Phase 1: Extract tags from titles synchronously — no API calls needed
      const titleTagItems: Array<{ tags?: readonly string[] }> = items.map(item => ({
        tags: extractTagsFromTitle(item.name ?? ''),
      }));

      // Phase 2: Fetch detail for a subset to get plot description tags + API tags
      const batchSize = 10;
      const detailTagItems: Array<{ tags?: readonly string[] }> = [];

      for (let i = 0; i < Math.min(items.length, 500); i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(item => api.movieDetail(item.id, true))
        );
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value?.detail) {
            const detail = result.value.detail;
            const tagList: string[] = [];

            // Extract tags from plot description
            if (detail.plot) {
              tagList.push(...extractTagsFromDescription(detail.plot));
            }

            // Include API-provided genres, country, year — but NOT cast names
            // Cast names belong in the cast rail, not in the tags rail
            if (detail.genres?.length) {
              tagList.push(...detail.genres);
            }
            if (detail.country) {
              tagList.push(detail.country);
            }
            if (detail.releaseDate) {
              const year = detail.releaseDate.substring(0, 4);
              if (year.length === 4) tagList.push(year);
            }
            detailTagItems.push({ tags: tagList });
          }
        }
      }

      // Combine all tag sources: titles (all items) + details (sampled items)
      const allItems = [...titleTagItems, ...detailTagItems];
      return aggregateTags(allItems);
    },
    staleTime: 10 * 60_000,
    enabled,
  });

  if (isLoading || !enabled) {
    return (
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {[...Array(12)].map((_, i) => (
          <div key={i} className="flex-shrink-0 h-5 bg-panel/40 animate-pulse rounded-full" style={{ width: `${50 + Math.random() * 40}px` }} />
        ))}
      </div>
    );
  }

  if (!tags || tags.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
      {tags.map((tag) => {
        const isSelected = selectedTags.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => onTagSelect(isSelected ? null : tag.id)}
            className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
              ${isSelected
                ? 'bg-tally text-ground'
                : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
              }`}
          >
            <span className="whitespace-nowrap">{tag.name}</span>
            <span className={`text-[length:var(--t-2xs)] ${isSelected ? 'text-ground/60' : 'text-ink-3'}`}>
              ({tag.count})
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Sex filter rail for cast members.
 *
 * Shows sex/orientation filters derived from cast data with counts.
 * Fetching is deferred 500ms after mount to avoid blocking navigation.
 * This component is kept for backward compatibility but the inline pills
 * in Adult.tsx are the primary UI now.
 */
export function SexFilterRail({ onSexSelect, selectedSex }: {
  onSexSelect: (sex: string | null) => void;
  selectedSex: string | null;
}) {
  const { scope } = useScope();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEnabled(true), 500);
    return () => clearTimeout(t);
  }, []);

  const { data: sexFilters, isLoading } = useQuery({
    queryKey: ['adult-sex-filters', scope],
    queryFn: async (): Promise<Array<{ id: string; name: string; count: number }>> => {
      // Fetch adult items with adultOnly flag
      const items = localAllItems('movies', { ...scope, adultOnly: true, limit: 500 });
      if (items.length === 0) {
        return [
          { id: 'straight', name: 'Straight', count: 0 },
          { id: 'gay', name: 'Gay', count: 0 },
          { id: 'lesbian', name: 'Lesbian', count: 0 },
          { id: 'bisexual', name: 'Bisexual', count: 0 },
          { id: 'trans', name: 'Trans', count: 0 },
        ];
      }

      const sexCounts = new Map<string, number>();
      const batchSize = 10;

      // Fetch detail for more items to get better sex filter coverage
      for (let i = 0; i < Math.min(items.length, 200); i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(item => api.movieDetail(item.id, true))
        );
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value?.detail?.cast) {
            const cast = result.value.detail.cast;
            for (const member of cast) {
              if (typeof member === 'object' && member !== null && 'sex' in member) {
                const sex = (member as any).sex?.toLowerCase().trim();
                if (sex) {
                  sexCounts.set(sex, (sexCounts.get(sex) ?? 0) + 1);
                }
              }
            }
          }
        }
      }

      const variants = ['straight', 'gay', 'lesbian', 'bisexual', 'trans'];
      return variants.map(id => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        count: sexCounts.get(id) ?? 0,
      })).sort((a, b) => b.count - a.count);
    },
    staleTime: 10 * 60_000,
    enabled,
  });

  if (isLoading || !enabled) {
    return (
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex-shrink-0 h-5 bg-panel/40 animate-pulse rounded-full w-16" />
        ))}
      </div>
    );
  }

  if (!sexFilters || sexFilters.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
      <button
        type="button"
        onClick={() => onSexSelect(null)}
        className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
          ${selectedSex === null
            ? 'bg-tally text-ground'
            : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
          }`}
      >
        <span className="whitespace-nowrap">All</span>
      </button>
      {sexFilters.map((filter) => {
        const isSelected = selectedSex === filter.id;
        return (
          <button
            key={filter.id}
            type="button"
            onClick={() => onSexSelect(isSelected ? null : filter.id)}
            className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--t-2xs)] font-medium transition-colors
              ${isSelected
                ? 'bg-tally text-ground'
                : 'bg-panel/60 text-ink-2 hover:bg-panel/80'
              }`}
          >
            <span className="whitespace-nowrap">{filter.name}</span>
            {filter.count > 0 && (
              <span className={`text-[length:var(--t-2xs)] ${isSelected ? 'text-ground/60' : 'text-ink-3'}`}>
                ({filter.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
