import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Play, Trash2, X } from 'lucide-react';
import { linkId, type Item } from '../lib/api';
import type { WatchRecord } from '../lib/prefs';
import { watchFraction } from '../lib/watch';
import { displayName } from '../lib/displayName';
import { useLongPress } from '../lib/longPress';
import { HoldMenu, type HoldAction } from './HoldMenu';

/**
 * One thing somebody is watching: its picture, where they are in it, and — on a
 * hold — a way to take it off the list.
 *
 * ── one card, not a card and a box ──
 *
 * The remove button used to be a second, full-height box beside every tile, so
 * the row read card, ×, card, ×: "ugly as fuck, and wtf is that close icon with
 * that big shit, make it clean and proper grid and slider". It existed because a
 * badge inside a link is not something a remote can land on. The app has had
 * the answer to that everywhere else for a while — HOLD the thing, and its menu
 * says what can be done to it (lib/longPress.ts) — so remove lives there, beside
 * Resume. A mouse still gets a small × in the corner on hover, which no D-pad
 * ever stops on.
 *
 * `small` is the launcher's: exactly as wide as one of its five cards, so the
 * row under them is the same grid (see ContinueRow). `large` is /watching's.
 */
export function WatchTile({
  item, section, rec, onRemove, size = 'small',
}: {
  item: Item;
  section: 'movies' | 'series' | 'live';
  /** A film's or series' place; absent for a channel. */
  rec?: WatchRecord;
  onRemove: () => void;
  size?: 'small' | 'large';
}) {
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const hold = useLongPress(() => setMenu(true));
  const to = section === 'live'
    ? `/live?ch=${encodeURIComponent(linkId(item))}`
    : section === 'series'
      ? `/series/${linkId(item)}${rec?.episodeId == null ? '' : `?ep=${rec.episodeId}`}`
      : `/movie/${linkId(item)}?play=1`;
  const fraction = rec ? watchFraction(rec) : null;
  const left = rec && rec.durationS > 0 ? Math.max(0, Math.round((rec.durationS - rec.positionS) / 60)) : null;
  const where = rec && section === 'series' && rec.season != null && rec.episode != null
    ? `S${rec.season} · E${rec.episode}`
    : null;
  const subtitle = [where, left !== null ? `${left} min left` : null, section === 'live' ? 'Live' : null]
    .filter(Boolean).join(' · ');
  /* "NF - Arcane 4K (2021)" is how the panel files it; "Arcane" is its name. */
  const label = displayName(item.name, { dropYear: true });
  const picture = item.logo ?? null;
  const live = section === 'live';
  const actions: HoldAction[] = [
    { id: 'play', label: live ? 'Watch' : 'Resume', Icon: Play, primary: true, act: () => nav(to) },
    { id: 'remove', label: 'Remove from Continue watching', Icon: Trash2, act: onRemove },
  ];

  return (
    <div
      className={`group relative shrink-0 snap-start ${
        size === 'large'
          ? 'w-72'
          : 'w-[min(9rem,15vw)] tv:w-[min(10.5rem,14vw)]'
      }`}
    >
      <Link
        to={to}
        {...hold}
        title={label}
        className="glass-float tally-glow tap card-hover flex h-full min-w-0 flex-col overflow-hidden border border-rule"
      >
        <span className="flex min-w-0 items-stretch gap-2 p-1.5">
          <span
            className={`relative shrink-0 overflow-hidden rounded-[var(--r-md)] bg-panel-2 ${
              live ? 'h-10 w-10 self-center' : size === 'large' ? 'h-20 w-14' : 'h-14 w-10'
            }`}
          >
            {picture !== null && (
              <img
                src={picture}
                alt=""
                loading="lazy"
                decoding="async"
                /* A picture that will not load leaves the tile's own panel,
                   not a broken-image glyph. */
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                className={`h-full w-full ${live ? 'object-contain p-0.5' : 'object-cover'}`}
              />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="line-clamp-2 text-[length:var(--t-sm)] font-medium leading-snug text-ink">
              {label}
            </span>
            {subtitle !== '' && (
              <span className="mt-0.5 truncate font-mono text-[length:var(--t-2xs)] text-ink-3">{subtitle}</span>
            )}
          </span>
        </span>
        {/* Along the card's own bottom edge, the whole width — where a progress
            bar is on every other player's shelf. */}
        {fraction !== null && (
          <span className="meter mt-auto block h-[3px] w-full overflow-hidden bg-rule/60" aria-hidden>
            <span className="block h-full bg-tally" style={{ width: `${Math.max(3, Math.round(fraction * 100))}%` }} />
          </span>
        )}
      </Link>
      {/* Mouse only: never a focus stop, so a D-pad walks card to card. */}
      <button
        type="button"
        tabIndex={-1}
        data-nav-skip
        onClick={onRemove}
        aria-label={`Remove ${label} from Continue watching`}
        title="Remove"
        className="pill absolute right-1 top-1 hidden h-5 w-5 place-items-center bg-ground/85 text-ink-3
                   hover:text-alert group-hover:grid"
      >
        <X className="h-3 w-3" />
      </button>
      {menu && <HoldMenu title={label} actions={actions} onClose={() => setMenu(false)} />}
    </div>
  );
}
