import { Star } from 'lucide-react';
import { isFav, toggleFav, usePrefs, type FavSection } from '../lib/prefs';
import { Tooltip } from './Tooltip';

/**
 * Star one item.
 *
 * Keyed on the PROVIDER id, not the catalogue row id, so a favourite survives the
 * nightly re-ingest that renumbers every row. Channels, films and series only —
 * a country is a filter, not something you star.
 */
export function FavButton({
  section, streamId, size = 'sm', className,
}: {
  section: FavSection;
  streamId: number | null;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [prefs] = usePrefs();
  if (streamId === null) return null;
  const on = prefs.favs[section].includes(streamId);
  const box = size === 'md' ? 'h-4 w-4' : 'h-3 w-3';

  return (
    /* The tooltip names the remote button that does the same thing, which is the
       only way anybody learns it — a `title=` here was invisible on the one device
       that has a dedicated star key. */
    <Tooltip label={on ? 'Remove from favourites' : 'Add to favourites'} intent="favourite">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFav(section, streamId);
        }}
        aria-pressed={on}
        aria-label={on ? 'Remove from favourites' : 'Add to favourites'}
        className={`shrink-0 transition-colors ${
          on ? 'text-tally' : 'text-ink-3 hover:text-tally'
        } ${className ?? ''}`}
      >
        <Star className={`${box} ${on ? 'fill-current' : ''}`} />
      </button>
    </Tooltip>
  );
}

export { isFav };
