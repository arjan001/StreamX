import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { aggregateCast } from '../lib/adult';
import { localAllItems } from '../lib/localRead';
import { useScope } from '../lib/scope';

export interface CastMember {
  id: string;
  name: string;
  image: string | null;
  sex?: string;
}

/**
 * Horizontal scrolling rail of cast members (performers).
 *
 * Fetching is deferred 500ms after mount to avoid blocking navigation.
 * Each cast member shows a small circular avatar with their name.
 * Used in the adult section to browse content by performer.
 */
export function CastRail({ onCastSelect, selectedCast }: {
  onCastSelect: (castId: string | null) => void;
  selectedCast: string | null;
}) {
  const { scope } = useScope();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEnabled(true), 500);
    return () => clearTimeout(t);
  }, []);

  const { data: cast, isLoading } = useQuery({
    queryKey: ['adult-cast', scope],
    queryFn: async (): Promise<CastMember[]> => {
      const items = localAllItems('movies', { ...scope, limit: 300 });
      if (items.length === 0) return [];

      const castData: Array<{ cast?: ReadonlyArray<{ name: string; image?: string | null; sex?: string }> }> = [];
      const batchSize = 10;
      for (let i = 0; i < Math.min(items.length, 100); i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(item => api.movieDetail(item.id))
        );
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value?.detail?.cast) {
            const detailCast = result.value.detail.cast;
            const normalizedCast: Array<{ name: string; image?: string | null; sex?: string }> = [];
            for (const member of detailCast) {
              if (typeof member === 'string' && member) {
                normalizedCast.push({ name: member, image: null });
              } else if (typeof member === 'object' && member !== null && typeof (member as any).name === 'string' && (member as any).name) {
                normalizedCast.push({
                  name: (member as any).name,
                  image: (member as any).image ?? null,
                  sex: (member as any).sex,
                });
              }
            }
            if (normalizedCast.length > 0) {
              castData.push({ cast: normalizedCast });
            }
          }
        }
      }

      return aggregateCast(castData);
    },
    staleTime: 10 * 60_000,
    enabled,
  });

  if (isLoading || !enabled) {
    return (
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="flex-shrink-0 w-10">
            <div className="aspect-square rounded-full bg-panel/40 animate-pulse" />
            <div className="mt-0.5 h-2 bg-panel/40 animate-pulse rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!cast || cast.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
      <button
        type="button"
        onClick={() => onCastSelect(null)}
        className={`flex-shrink-0 flex flex-col items-center gap-0.5 w-10 ${selectedCast === null ? 'opacity-100' : 'opacity-50'}`}
      >
        <div className={`aspect-square w-10 rounded-full bg-panel/60 flex items-center justify-center text-[length:var(--t-2xs)] font-semibold
          ${selectedCast === null ? 'ring-1.5 ring-tally bg-tally/20' : ''}`}>
          All
        </div>
        <span className="text-[length:var(--t-2xs)] text-ink-2 truncate w-full text-center">All</span>
      </button>
      {cast.map((member) => (
        <button
          key={member.id}
          type="button"
          onClick={() => onCastSelect(member.id)}
          className={`flex-shrink-0 flex flex-col items-center gap-0.5 w-10 ${selectedCast === member.id ? 'opacity-100' : 'opacity-70 hover:opacity-100'}`}
        >
          {member.image ? (
            <img
              src={member.image}
              alt={member.name}
              className={`aspect-square w-10 rounded-full object-cover ${selectedCast === member.id ? 'ring-1.5 ring-tally' : ''}`}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                const fallback = e.currentTarget.nextElementSibling;
                if (fallback) fallback.classList.remove('hidden');
              }}
            />
          ) : null}
          <div
            className={`aspect-square w-10 rounded-full bg-panel/60 flex items-center justify-center text-[length:var(--t-2xs)] font-semibold
              ${member.image ? 'hidden' : ''} ${selectedCast === member.id ? 'ring-1.5 ring-tally bg-tally/20' : ''}`}
          >
            {getInitials(member.name)}
          </div>
          <span className="text-[length:var(--t-2xs)] text-ink-2 truncate w-full text-center">{member.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Get initials from a name (e.g., "John Doe" -> "JD").
 */
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
