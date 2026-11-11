import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Clapperboard, Film, Heart, History, Trophy, Tv,
} from 'lucide-react';
import type { Inventory } from '../lib/api';
import { hasSection } from '../lib/sections';
import { BRAND } from '../brand';
import { assetUrl } from '../lib/assetUrl';
import { useSkin } from '../lib/skin';
import { ContinueRow } from '../components/ContinueRow';

/**
 * Modern launcher home — "when you click on it you will see those five
 * cards, and in those five cards below it or somewhere add like continue
 * watching or so on."
 *
 * Five glass cards (Live → Sports → Movies → Series → Replay), a compact
 * Continue watching row, and clock in one line beneath — all of it
 * inside `<main>`, which is `overflow-hidden` on every page (see Chrome.tsx),
 * so this has to fit the viewport rather than scroll it. The two-line tagline
 * and the WATCH/EXPLORE/ENJOY row that used to fill this space are gone: the
 * owner's own ask was cards plus Continue watching, and five cards left no
 * room for four lines of decoration on a 540px-tall television.
 */

function tiles(inv: Inventory | null) {
  const n = (v: number | undefined) => (v ?? 0).toLocaleString();
  return [
    {
      id: 'live',
      to: '/live',
      label: 'Live TV',
      Icon: Tv,
      note: inv === null || (inv.live ?? 0) === 0 ? '1000+ Channels' : `${n(inv.live)}+ Channels`,
    },
    {
      /* Same channels as Live TV — a filter over them, not a second
         catalogue — so it shows whenever Live does. See lib/sections.ts. */
      id: 'sports',
      to: '/sports',
      label: 'Sports TV',
      Icon: Trophy,
      note: 'Live Sport Now',
    },
    {
      id: 'movies',
      to: '/movies',
      label: 'Movies',
      Icon: Clapperboard,
      note: 'Latest & Classics',
    },
    {
      id: 'series',
      to: '/series',
      label: 'Series',
      Icon: Film,
      note: 'Binge Favourites',
    },
    {
      id: 'adult',
      to: '/adult',
      label: 'Adult',
      Icon: Heart,
      note: '18+ Content',
    },
    {
      id: 'catchup',
      to: '/catchup',
      label: 'Replay',
      Icon: History,
      note: 'Catch Up Anytime',
    },
  ] as const;
}

function ClockStrip() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const day = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /*
   * One line, not a corner block.
   *
   * The tagline, the WATCH/EXPLORE/ENJOY row and the stacked date/time/weather
   * panel this replaced were together the tallest thing on the launcher after
   * the cards — decoration the owner named directly: "the tagline is
   * decoration". What is worth keeping is the fact, not the layout: day and
   * time, said once.
   */
  return (
    <p className="flex flex-wrap items-center justify-center gap-2 font-mono
                  text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
      <span>{day}</span>
      <span aria-hidden className="text-ink-3/50">·</span>
      <span className="tabular-nums normal-case text-ink">{time}</span>
    </p>
  );
}

export function ModernHome({ inv }: { inv: Inventory | null }) {
  const { resolved } = useSkin();
  const shown = tiles(inv).filter((t) => hasSection(t.id, inv));
  const plate = resolved === 'light' ? 'modern-bg-light.jpg' : 'modern-bg-dark.jpg';

  return (
    <div
      style={{ '--shot': `url(${assetUrl(`${plate}?v=${BRAND.rev}`)})` } as React.CSSProperties}
      className="launcher backdrop anim-fade flex min-h-full flex-col px-6 py-4 tv:px-12 tv:py-5"
    >
      <div className="flex flex-1 flex-col items-center justify-center">
        {/* One column exactly as wide as the cards, so Continue watching starts
            and ends where they do. The row sits in a zero-width cell stretched
            to the column: it scrolls inside the cards' width instead of
            widening the column to fit every tile. */}
        <div className="grid w-fit max-w-full gap-4 tv:gap-5">
          {/*
            Five cards, not four — one column narrower each so the row still
            fits the television's own 960px: five 134px cards plus four 24px
            gaps is 766px, inside the ~832px left once the launcher's own side
            padding is taken out. `aspect-[4/5]` (was 3/4) is the other half of
            the saving — shorter cards were the difference between the row and
            Continue watching both fitting under the header, and only one of
            them fitting.
          */}
          <div
            data-nav-group="launcher"
            /* A wrapping row rather than a five-column grid: a line with no
               series has four cards, and a fixed grid would leave the fifth
               column empty and the row off-centre. */
            className="mx-auto flex max-w-full flex-wrap justify-center gap-3 sm:gap-4 tv:gap-6"
          >
            {shown.map(({ id, to, label, Icon, note }, i) => (
              <Link
                key={id}
                to={to}
                {...(i === 0 ? { 'data-nav-first': true } : {})}
                className="launch-tile glass-float tally-glow tap flex aspect-[4/5] w-[min(9rem,15vw)]
                           max-h-[13rem] flex-col items-center justify-center gap-1.5 px-3 py-4 text-center
                           tv:w-[min(10.5rem,14vw)] tv:max-h-[15rem] tv:gap-2 tv:px-4"
              >
                <Icon className="h-8 w-8 shrink-0 text-ink tv:h-9 tv:w-9" strokeWidth={1.25} aria-hidden />
                <span className="text-[length:var(--t-md)] font-semibold leading-tight text-ink tv:text-[length:var(--t-lg)]">
                  {label}
                </span>
                <span className="text-[length:var(--t-2xs)] leading-snug text-ink-2 tv:text-[length:var(--t-xs)]">
                  {note}
                </span>
                <span className="launch-bar mt-1 w-10 tv:mt-1.5 tv:w-12" aria-hidden />
              </Link>
            ))}
          </div>

          <div className="w-0 min-w-full">
            <ContinueRow />
          </div>
        </div>
      </div>

      <div className="mt-2 tv:mt-3">
        <ClockStrip />
      </div>
    </div>
  );
}
