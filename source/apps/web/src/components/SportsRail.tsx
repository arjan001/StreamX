import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, Eye, EyeOff, Globe, Heart, Search } from 'lucide-react';
import { SportIcon } from './SportIcon';
import { HoldMenu } from './HoldMenu';
import type { Filters } from './FilterBar';
import { useScope } from '../lib/scope';
import { usePrefs } from '../lib/prefs';
import { localAllItems } from '../lib/localRead';
import { setSportOrder, sportCounts, toggleSportHidden, useSportArrangement } from '../lib/sportsRail';
import { ensureTopicIndex, subscribeTopicIndex, topicSet, topicStreams } from '../lib/topicIndex';
import { arrangeSports, type RailSport } from '../lib/sports';
import { marketName, useCategories } from '../lib/groups';
import { marketFlagUrl } from '../lib/marketFlag';
import { moveTo } from '../lib/ordering';
import { useLongPress } from '../lib/longPress';
import { useOkToType } from '../lib/okToType';
import { isFieldSubmit } from '../lib/keys';
import { focusFirst } from '../lib/spatialNav';
import { typingDelay } from '../lib/typingDelay';
import { useTally } from '../lib/tally';
import { installMarquee } from '../lib/marquee';

/**
 * Sports TV's first column: the sports, where Live TV has its countries.
 *
 * "use the same concept and components and layouts and settings … no grouping by
 * country unless setting is applied, but the first sidebar for sports categories
 * stays". So this is the ONLY part of Sports TV that is its own: the list beside
 * it, the player, the hold menu on a channel and every filter are Live TV's, and
 * behave identically because they are the same code (`routes/Live.tsx`,
 * `sports` mode).
 *
 * The rows mirror `LiveSidebar`'s: a search band that never scrolls, Favourites
 * standing at the top, then the sports — hold one to carry it somewhere else or
 * hide it, and a hidden sport waits at the bottom, dimmed, one OK from coming
 * back. With the countries layout chosen (the same Browse setting Live uses),
 * the sport you are in opens into its countries.
 */
export function SportsRail({
  value, sport, onChange,
}: {
  value: Filters;
  /** The sport the list is showing — `pickSport`'s answer, not just the address. */
  sport: string | null;
  onChange: (patch: Partial<Pick<Filters, 'sport' | 'favs' | 'markets' | 'q'>>) => void;
}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const { scope } = useScope();
  const tree = prefs.browseStyle !== 'list';
  useEffect(() => { installMarquee(); }, []);

  const [tick, setTick] = useState(0);
  useEffect(() => subscribeTopicIndex(() => setTick((n) => n + 1)), []);
  useEffect(() => { void ensureTopicIndex(); }, []);

  const { order, hidden } = useSportArrangement();
  const setOrder = (v: readonly string[]) => setSportOrder(v);
  const toggleHidden = (id: string) => toggleSportHidden(id);

  // `tick` re-reads once the topic index finishes building.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => sportCounts(scope), [tick, scope]);
  const rail = useMemo(() => arrangeSports(counts, order, hidden), [counts, order, hidden]);
  const favCount = useMemo(() => {
    const all = topicSet('sports');
    return all === null ? 0 : prefs.favs.live.filter((id) => all.has(id)).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.favs.live, tick]);

  /* ── the countries under the open sport, in the countries layout only ───── */
  const categories = useCategories('live', scope);
  const countries = useMemo(() => {
    if (!tree || sport === null || value.favs) return [];
    const marketOf = new Map(categories.map((c) => [c.id, (c.path?.[0] ?? c.region) || null] as const));
    const n = new Map<string, number>();
    for (const item of localAllItems('live', { streamIds: topicStreams(sport), ...scope })) {
      const m = item.categoryId === null ? null : marketOf.get(item.categoryId) ?? null;
      if (m !== null) n.set(m, (n.get(m) ?? 0) + 1);
    }
    const home = new Map(prefs.markets.map((m, i) => [m, i] as const));
    return [...n.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => ((home.get(a.code) ?? 999) - (home.get(b.code) ?? 999)) || (b.count - a.count));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, sport, value.favs, categories, scope, prefs.markets, tick]);

  /* ── the search band: Live's, word for word ─────────────────────────────── */
  const [draft, setDraft] = useState(value.q);
  useEffect(() => { setDraft(value.q); }, [value.q]);
  useEffect(() => {
    const t = draft.trim();
    if (t === value.q.trim()) return;
    const id = window.setTimeout(() => onChange({ q: t }), typingDelay());
    return () => window.clearTimeout(id);
    // `onChange` is rebuilt every render; the text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const ok = useOkToType({
    onKeyDown: (e) => {
      if (!isFieldSubmit(e.key, e.nativeEvent.isComposing, e.keyCode)) return;
      e.preventDefault();
      e.currentTarget.blur();
      requestAnimationFrame(() => focusFirst());
    },
  });

  /* ── hold: carry a sport, or hide it ────────────────────────────────────── */
  const [menu, setMenu] = useState<RailSport | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const undo = useRef<readonly string[] | null>(null);
  const held = useRef<RailSport | null>(null);
  const hold = useLongPress(() => { if (held.current !== null) setMenu(held.current); });
  /* The highlight follows the row being carried — rows re-render in their new
     places, and focus would otherwise stay on whatever now sits where it was. */
  useEffect(() => {
    if (moving === null) return;
    const el = document.querySelector<HTMLElement>(`[data-sport-row="${moving}"]`);
    if (el !== null && document.activeElement !== el) el.focus();
  });
  const shownIds = rail.filter((s) => !s.hidden).map((s) => s.id);
  const carry = (id: string, dir: -1 | 1) => {
    const at = shownIds.indexOf(id);
    if (at < 0 || at + dir < 0 || at + dir >= shownIds.length) return;
    setOrder(moveTo(shownIds, at, at + dir));
  };

  /* A pick is a new list: it ends a search, as choosing a country does on Live. */
  const pickSport = (id: string) => onChange({ sport: id, favs: false, markets: [], q: '' });
  const firstHidden = rail.findIndex((s) => s.hidden);
  const row = 'pick pick-row tap w-full border-b border-rule/40 pl-3 text-left';

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-rule bg-panel">
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col" data-nav-group="sports" data-nav-memory>
          <div className="shrink-0">
            <span className="relative block min-w-0">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
              />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="search sport channels…"
                aria-label="Search sport channels"
                enterKeyHint="search"
                inputMode="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                {...ok.props}
                className="block w-full border-0 border-b border-rule/60 bg-ground/50 py-2 pl-9 pr-3
                           text-[length:var(--t-sm)] text-ink outline-none
                           placeholder:text-ink-3 focus:border-focus"
              />
            </span>
          </div>

          <div className="rail-rows min-h-0 flex-1 overflow-y-auto" data-nav-column>
            <button
              type="button"
              onClick={() => onChange({ favs: true, markets: [], q: '' })}
              className={`${row} ${value.favs ? 'is-on' : ''}`}
            >
              <Heart className={`h-4 w-4 shrink-0 ${value.favs ? 'fill-current text-tally' : 'text-ink-3'}`} />
              <span className="pick-title min-w-0 flex-1 truncate">Favourites</span>
              <Count>{tallyOf(favCount)}</Count>
            </button>

            {rail.map((s, i) => {
              const on = !value.favs && s.id === sport;
              const isMoving = moving === s.id;
              return (
                <div key={s.id}>
                  {i === firstHidden && (
                    <div
                      className="flex items-center gap-2 border-b border-rule/40 bg-ground/40 px-3 py-1
                                 font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3"
                    >
                      <EyeOff className="h-3 w-3" />
                      <span>Hidden</span>
                    </div>
                  )}
                  <button
                    type="button"
                    data-sport-row={s.id}
                    {...(on ? { 'data-nav-first': true } : {})}
                    {...hold}
                    onPointerDown={(e) => { held.current = s; hold.onPointerDown(e); }}
                    onKeyDown={(e) => {
                      held.current = s;
                      if (isMoving) {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          e.stopPropagation();
                          carry(s.id, e.key === 'ArrowUp' ? -1 : 1);
                          return;
                        }
                        if (e.key === 'Escape' || e.key === 'Backspace') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (undo.current !== null) setOrder(undo.current);
                          undo.current = null;
                          setMoving(null);
                          return;
                        }
                      }
                      hold.onKeyDown(e);
                    }}
                    onClick={() => {
                      if (isMoving) { setMoving(null); undo.current = null; return; }
                      if (s.hidden) { toggleHidden(s.id); return; }
                      pickSport(s.id);
                    }}
                    className={`${row} ${on ? 'is-on' : ''} ${s.hidden ? 'opacity-45' : ''}
                      ${isMoving ? 'is-on ring-1 ring-inset ring-tally' : ''}`}
                  >
                    <SportIcon sport={s.id} className={`h-4 w-4 shrink-0 ${on ? 'text-tally' : 'text-ink-2'}`} />
                    <span className="pick-title min-w-0 flex-1 truncate"><span data-marquee>{s.label}</span></span>
                    <Count>{tallyOf(s.count)}</Count>
                  </button>
                  {on && tree && countries.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => onChange({ markets: [] })}
                        className={`${row} pick-sub pl-8 ${value.markets.length === 0 ? 'is-on' : ''}`}
                      >
                        <Globe className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                        <span className="pick-title min-w-0 flex-1 truncate">All countries</span>
                      </button>
                      {countries.map((c) => {
                        const flag = marketFlagUrl(c.code, 'live');
                        const here = value.markets.length === 1 && value.markets[0] === c.code;
                        return (
                          <button
                            key={c.code}
                            type="button"
                            onClick={() => onChange({ markets: [c.code] })}
                            className={`${row} pick-sub pl-8 ${here ? 'is-on' : ''}`}
                          >
                            {flag !== null ? (
                              <img src={flag} alt="" className="h-3.5 w-5 shrink-0 object-cover"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                            ) : <Globe className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
                            <span className="pick-title min-w-0 flex-1 truncate">{marketName(c.code)}</span>
                            <Count>{tallyOf(c.count)}</Count>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {menu !== null && (
        <HoldMenu
          title={menu.label}
          actions={[
            ...(menu.hidden ? [] : [{
              id: 'move',
              label: 'Move this',
              hint: 'Up and down carry it · OK puts it down · BACK cancels',
              Icon: ArrowUpDown,
              act: () => { undo.current = [...order]; setMoving(menu.id); setMenu(null); },
            }]),
            {
              id: 'hide',
              label: menu.hidden ? 'Show this sport again' : 'Hide this sport',
              hint: menu.hidden ? 'It goes back where it was' : 'It moves to the bottom of this list, not out of the app',
              Icon: menu.hidden ? Eye : EyeOff,
              act: () => { toggleHidden(menu.id); setMenu(null); },
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}

function Count({ children }: { children?: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <span className="shrink-0 px-1.5 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
      {children}
    </span>
  );
}
