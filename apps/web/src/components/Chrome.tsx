import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { RotatePrompt } from './RotatePrompt';
import { setRailOpen } from '../lib/railDrawer';
import { Wordmark } from './Wordmark';
import { BRAND } from '../brand';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  CalendarClock, ChevronRight, Circle, Clapperboard, Cpu, Database,
  DoorOpen, Eye, EyeOff, Film, Heart, History, Home, Lock, Moon, Palette,
  RefreshCw,
  Search, Settings2, Square, SunMedium, Trophy, Tv, Tv2, UserRound, Wand2, X,
} from 'lucide-react';
import { hasSection, useInventory as useInv } from '../lib/sections';
import { api, type Inventory } from '../lib/api';
import { localItem } from '../lib/localRead';
import { displayName } from '../lib/displayName';
import {
  setPrefs, type AutoOpen, type OpenStyle, usePrefs,
} from '../lib/prefs';
import { activeProvider, hostsFor } from '../lib/providers';
import { getScreenPref, setScreenPref, useShape, type ScreenPref } from '../lib/formFactor';
import { setSkin, THEMES, TINT_SLOTS, useSkin } from '../lib/skin';
import { modernPlateStyle, modernSectionOf } from '../lib/modernPlate';
import { EXIT_WINDOW_MS, onExitPrompt, pushBackHandler, setBackNavigator } from '../lib/nativeBack';
import { addAccountOpen, subscribeAddAccount } from '../lib/addAccount';
import { subscribeDoor } from '../lib/firstRun';
import { refreshCapabilities, useCapabilities } from '../lib/capabilityStore';
import { ResumeBanner } from './ResumeBanner';
import { LocalCatalogueBar } from './LocalCatalogueBar';
import { CataloguePrepare } from './CataloguePrepare';
import { forgetLastPlayed } from '../lib/resume';
import { Shortcuts } from './Shortcuts';
import { SourcesSheet } from './SourcesSheet';
import { useKeyLayer, type Binding } from '../lib/keys';
import { focusFirst, focusIsLoose } from '../lib/spatialNav';
import { DebugPanel } from './DebugPanel';
import { RefreshLibrary } from './RefreshLibrary';
import {
  localStatus, refreshLocal, subscribeLocal, type IngestStatus,
} from '../lib/localCatalogue';
import { searchHref } from '../lib/sections';
import { preloadRoute } from '../lib/preloadRoute';
import { isDetailPlayerOpen, isShellHidden, subscribeDetailPlayer, subscribeShellHidden } from '../lib/shellState';
import { useOkToType } from '../lib/okToType';

/**
 * Which sections exist — now answered by `lib/sections.ts`, for everyone.
 *
 * This logic was born here, which meant the shell hid an empty Movies tab while
 * the launcher still offered a large MOVIES tile reading "0 films" and the films
 * page itself offered a sort-and-filter toolbar over nothing. One question with
 * three answers. `hasSection` is now the only answer; re-exported because several
 * files already reach for it through this one.
 */
export { useInventory } from '../lib/sections';

/** Whether a tab has anything behind it. Unknown counts as yes. */
function tabHasContent(to: string, inv: Inventory | null): boolean {
  const id = to.replace(/^\//, '').split('?')[0] ?? '';
  return id === 'live' || id === 'movies' || id === 'series'
    || id === 'guide' || id === 'catchup' || id === 'home'
    || id === 'sports' || id === 'discover' || id === 'adult'
    ? hasSection(id, inv)
    : true;
}

const TABS = [
  { to: '/home', label: 'Home', Icon: Home },
  /*
   * No `/menu` tab.
   *
   * The classic launcher had one, beside Home — and the header's own MENU button,
   * on the right, opened a different thing entirely. Two controls one word apart
   * meaning two destinations, which is exactly the confusion reported. The MENU
   * button now goes to a real page (`routes/More.tsx`), and the launcher is a row
   * inside it. Taken out "for now", by request; if it comes back it comes back as
   * one control, not two.
   */
  { to: '/live', label: 'Live TV', Icon: Tv },
  { to: '/sports', label: 'Sports TV', Icon: Trophy },
  { to: '/movies', label: 'Movies', Icon: Clapperboard },
  { to: '/series', label: 'Series', Icon: Tv2 },
  { to: '/guide', label: 'Guide', Icon: CalendarClock },
  { to: '/catchup', label: 'Catch-up', Icon: History },
] as const;

/**
 * Phone destinations.
 *
 * Five, at 78px each on a 390px screen — enough for a 4.5rem icon and a 10px
 * label, which is what the four-tab rule was really about. Guide earns the fifth
 * slot because "what is on now" is a destination people open dozens of times a
 * day; Catch-up is one tap from inside it, and from the menu page.
 */
const PHONE_TABS = [TABS[0], TABS[1], TABS[5], TABS[3], TABS[4]] as const;

/**
 * Header destinations: everything except the guide.
 *
 * "the guide, we dont need that here, bcs we have it under the player, that way
 * its great" — and that is right. Live already carries the schedule under the
 * picture, which is the place a viewer is actually asking the question from: the
 * channel is playing, and what is on next is a glance down rather than a
 * different screen. A top-bar destination for it duplicated that and spent one
 * of the six slots a ten-foot signpost has.
 *
 * Removed from the SIGNPOST, not from the app. `/guide` is still a route, still
 * what the remote's GUIDE key opens (see `keyActions`), still a row in the menu,
 * and still under the player. Nothing about it became unreachable — see
 * `chrome-probe.mjs`, which walks to it by all three.
 *
 * The phone's bottom bar keeps it (`PHONE_TABS`): a thumb-reachable tab bar is a
 * different instrument from a header, and on a phone the schedule under a
 * portrait-width player is four rows tall.
 */
const HEADER_TABS = TABS.filter((t) => t.to !== '/guide');

/**
 * Modern header destinations — "the logo will become the current home page:
 * when you click on it you will see those five cards … And then we show like
 * live TV like a home — a home icon only … and then we will show live TV and
 * sports TV and then movies then series and then catch-up."
 *
 * So the launcher moved off the strip and onto the mark (see `Wordmark`, which
 * already links to `/home`), and Home is `/discover`: the classical view with
 * the hero and the rails, not the launcher itself — plus the destinations named
 * in that sentence, in that order. It was an icon alone at first; "i think its
 * best to show the home page with text", so it reads like its neighbours.
 *
 * Continue is gone from here — "add that catch up in the header as well" never
 * said the same of it, and `/watching` stays one press away from the launcher's
 * own Continue watching row.
 */
const MODERN_HEADER_TABS = [
  { to: '/discover', label: 'Home', Icon: Home },
  { to: '/live', label: 'Live TV', Icon: Tv },
  { to: '/sports', label: 'Sports TV', Icon: Trophy },
  { to: '/movies', label: 'Movies', Icon: Clapperboard },
  { to: '/series', label: 'Series', Icon: Tv2 },
  { to: '/catchup', label: 'Catch-up', Icon: History },
] as const;

/**
 * Which tab owns a page that is not itself a tab.
 *
 * `NavLink` lights up for its own path and anything under it, which covers
 * `/series/:id` and misses `/movie/:id` entirely — the film detail page hangs
 * off `/movie`, singular, and the tab is `/movies`. So the whole strip went dark
 * the moment a film was opened: "im in movies, even if nasted movies or
 * selected, same everywhere else, keep header icon hightlighted".
 *
 * Listed rather than guessed at from the first path segment. A page missing
 * from this table simply keeps today's behaviour, which is the tab that matches
 * its own path.
 */
const OWNED_BY: Record<string, readonly string[]> = {
  '/movies': ['/movie'],
  '/live': ['/favourites'],
};

function tabOwns(to: string, pathname: string): boolean {
  const nested = OWNED_BY[to];
  if (nested === undefined) return false;
  return nested.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** A red word when the subscription has stopped working, and nothing otherwise. */
function AccountBadge() {
  const { data } = useQuery({ queryKey: ['source'], queryFn: api.source, staleTime: 60_000 });
  /* No subscription attached is the ordinary state of a device watching free
     channels, and a badge about an account that does not exist is noise. */
  if (!data || data.account === null) return null;
  const acc = data.account;

  /*
   * A fault, and nothing else.
   *
   * "Busy" is the ordinary state of a single-connection account while something
   * is playing on it — including on the very device showing the word — so it sat
   * in the header as a grey label all evening, saying nothing a viewer could act
   * on. The player says it directly at the moment it matters, which is when a
   * stream will not open. `offline` stays: a subscription that has expired or
   * stopped answering is why nothing works, and it is worth a red word.
   */
  if ('error' in acc) {
    if (acc.error === 'busy') return null;
    return (
      <>
        <span
          title={acc.message ?? undefined}
          className="font-mono text-[length:var(--t-2xs)] leading-none text-alert"
        >
          offline
        </span>
        <span aria-hidden className="text-ink-3/40">·</span>
      </>
    );
  }

  /*
   * Nothing at all while the subscription is fine.
   *
   * This strip was `0/1 · 25d ·` — a connection count and a countdown, four
   * elements for two facts, in the one header row that cannot wrap
   * (`tv:flex-nowrap`) and measured running into the right edge at 960 CSS px.
   * Both are gone on the owner's word, in two steps: "remove that connection
   * count on top", then "even remove the days of subscription, they can go to
   * account area and see it, just show the clock good".
   *
   * And the account area does show it: the accounts pane prints
   * `active · until 03/10/2026` under the subscription it belongs to, which is
   * where somebody goes when they want to know. A number in permanent view on a
   * television is either an alarm or a decoration, and 25 days is neither.
   */
  return null;
}

/**
 * The time, under the controls.
 *
 * Ticks every 15 seconds rather than every second: the minute is the only part
 * anybody reads, and a repaint a second on a TV box is a repaint a second spent
 * on nothing.
 */
function Clock() {
  const [now, setNow] = useState(() => stamp());
  useEffect(() => {
    const t = setInterval(() => setNow(stamp()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="tabular-nums text-ink-3" title="Local time">
      {now}
    </span>
  );
}

function stamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * The clock, after the person icon — and a fault if there is one.
 *
 * It was connections, days left and the clock. Both numbers are gone (see
 * `AccountBadge`); the rule stays, because it is what stops the time reading as
 * another button in the icon cluster.
 */
function HeaderStatus() {
  return (
    <div
      className="ml-1 flex min-w-0 items-center gap-1.5 border-l border-rule py-0.5 pl-2.5
                 font-mono text-[length:var(--t-2xs)] leading-none tracking-wide"
    >
      <AccountBadge />
      <Clock />
    </div>
  );
}


/** Where the search box sends you: `searchHref` decides which block of results comes first. */
function useSearchTarget(): (q?: string) => string {
  const { pathname } = useLocation();
  return (q?: string) => searchHref(pathname, q);
}

/**
 * Appearance: palette, light/dark, corners, and which home page.
 *
 * All four are device settings rather than profile settings — a profile is about
 * what you can see, this is about the screen you are seeing it on — so they live
 * in `lib/skin.ts` under their own key, next to the player's transport choice.
 *
 * The palette buttons show the actual colours rather than naming them, because
 * "Plum" means nothing until you have seen it, and the two swatches (ground and
 * accent) are the whole of what a palette is here.
 */
export function Appearance() {
  const skin = useSkin();
  const shape = useShape();
  const [screenPref, setScreenPrefState] = useState<ScreenPref>(getScreenPref);
  /* Only where there is a touch screen to be wrong about: every phone and
     tablet, and a box that has been mistaken for one. A television that is
     simply a television never sees this, so its settings screen is unchanged. */
  const offerScreen = shape.touchScreen !== null || screenPref !== 'auto'
    || (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0);

  const MODES = [
    { id: 'system' as const, label: 'Auto', Icon: Wand2 },
    { id: 'dark' as const, label: 'Dark', Icon: Moon },
    { id: 'light' as const, label: 'Light', Icon: SunMedium },
  ];

  return (
    <div className="p-3">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        <Palette className="h-3 w-3" /> Appearance
      </p>

      {/* Two per row rather than four: there are ten palettes now and six of
          them have a FEEL that a swatch cannot show — "raised", "glass",
          "movie theatre" — so the name needs room to be read beside it. */}
      <div className="grid grid-cols-2 gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setSkin({ theme: t.id })}
            title={t.note ?? t.label}
            aria-pressed={skin.theme === t.id}
            className={`tap flex items-center gap-2 border p-1.5 text-left transition-colors
              ${skin.theme === t.id ? 'border-tally' : 'border-rule hover:border-ink-3'}`}
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center"
              style={{ background: t.ground, borderRadius: 'var(--r-xs)' }}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: t.accent }} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[length:var(--t-xs)] ${skin.theme === t.id ? 'text-tally' : 'text-ink'}`}>
                {t.label}
              </span>
              {t.note !== undefined && (
                <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3">{t.note}</span>
              )}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        {MODES.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setSkin({ mode: id })}
            aria-pressed={skin.mode === id}
            className={`tap flex items-center justify-center gap-1.5 border px-2 py-1.5 font-mono text-[length:var(--t-2xs)]
              transition-colors ${skin.mode === id
                ? 'border-tally bg-tally/10 text-tally'
                : 'border-rule text-ink-2 hover:text-ink'}`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      <p className="mt-3 mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Corners</p>
      {/* Four stops, not two. `pill` deliberately rounds CONTROLS fully and
          leaves artwork alone — a poster at a 3rem radius is a lozenge with the
          actor's head cut off; see the scale in index.css. */}
      <div className="grid grid-cols-4 gap-1">
        {[
          { id: 'square' as const, label: 'Square', Icon: Square },
          { id: 'soft' as const, label: 'Soft', Icon: Circle },
          { id: 'round' as const, label: 'Round', Icon: Circle },
          { id: 'pill' as const, label: 'Pill', Icon: Circle },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setSkin({ ui: id })}
            aria-pressed={skin.ui === id}
            className={`tap flex items-center justify-center gap-1.5 border px-2 py-1.5 font-mono text-[length:var(--t-2xs)]
              transition-colors ${skin.ui === id
                ? 'border-tally bg-tally/10 text-tally'
                : 'border-rule text-ink-2 hover:text-ink'}`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {offerScreen && (
        <>
          <p className="mt-3 mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Screen</p>
          {/* Phone and tablet adjustments on top of the television layout — see
              `touchScreenOf`. The way back if a box is ever taken for a tablet,
              and the way in for a touch screen that was not recognised. This
              device only. */}
          <div className="grid grid-cols-3 gap-1">
            {[
              { id: 'auto' as const, label: 'Automatic' },
              { id: 'tv' as const, label: 'TV remote' },
              { id: 'touch' as const, label: 'Touch' },
            ].map(({ id, label }) => (
              <button
                key={id}
                onClick={() => { setScreenPref(id); setScreenPrefState(id); }}
                aria-pressed={screenPref === id}
                className={`tap flex items-center justify-center gap-1.5 border px-2 py-1.5 font-mono text-[length:var(--t-2xs)]
                  transition-colors ${screenPref === id
                    ? 'border-tally bg-tally/10 text-tally'
                    : 'border-rule text-ink-2 hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/*
        The start-page chooser was here: Showcase, Classic and Profiles. Two of
        those landings are gone - the header carries the nav, so a second screen
        of the same destinations was a detour - and a chooser with one option
        left is furniture.
      */}

      <p className="mt-3 mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        Layout
      </p>
      {/*
        Two whole shells rather than a row of toggles — see `Shell` in
        lib/skin.ts for why they are not independently useful settings. The hint
        under each one names the difference a viewer would actually notice,
        because "Modern" on its own says nothing about what will change.
      */}
      <div className="grid grid-cols-2 gap-1.5">
        {[
          { id: 'classic' as const, label: 'Classic', hint: 'Solid panes, filled tabs, dense player' },
          { id: 'modern' as const, label: 'Modern', hint: 'Glass over plates, smaller Live window' },
        ].map(({ id, label, hint }) => (
          <button
            key={id}
            onClick={() => setSkin({ shell: id })}
            aria-pressed={skin.shell === id}
            className={`tap border p-1.5 text-left transition-colors ${skin.shell === id
              ? 'border-tally bg-tally/10'
              : 'border-rule hover:border-ink-3'}`}
          >
            <span className={`block text-[length:var(--t-xs)] ${skin.shell === id ? 'text-tally' : 'text-ink'}`}>
              {label}
            </span>
            <span className="block font-mono text-[length:var(--t-2xs)] leading-snug text-ink-3">
              {hint}
            </span>
          </button>
        ))}
      </div>

      <p className="mt-3 mb-1.5 flex items-center justify-between gap-2 font-mono
                    text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        <span>Your own colours</span>
        {Object.keys(skin.tint).length > 0 && (
          <button
            onClick={() => setSkin({ tint: {} })}
            className="tap border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)]
                       normal-case tracking-normal text-ink-2 hover:border-ink-3 hover:text-ink"
          >
            Reset all
          </button>
        )}
      </p>
      {/*
        Five slots, each one an EXISTING token — see `Tint` in lib/skin.ts. That
        is the difference between a colour setting that works everywhere and one
        that works in the four places somebody remembered to wire up.

        A native `<input type="color">` on purpose: on a television it opens the
        platform's own picker, which is operable by remote, and on a phone it is
        the OS wheel. A hand-rolled swatch grid would have to be a focus scope of
        its own and would still offer fewer colours.
      */}
      <div className="grid gap-1">
        {TINT_SLOTS.map((slot) => {
          const chosen = skin.tint[slot.key];
          return (
            <div key={slot.key} className="flex items-center gap-2 rounded-[var(--r-row)] border border-rule px-2 py-1.5">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="color"
                  value={chosen ?? readToken(slot.token)}
                  onChange={(e) => setSkin({ tint: { ...skin.tint, [slot.key]: e.target.value } })}
                  aria-label={slot.label}
                  className="h-6 w-8 shrink-0 cursor-pointer border border-rule bg-transparent p-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[length:var(--t-xs)] text-ink">{slot.label}</span>
                  <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3">{slot.hint}</span>
                </span>
              </label>
              {chosen !== undefined && (
                <button
                  onClick={() => {
                    const next = { ...skin.tint };
                    delete next[slot.key];
                    setSkin({ tint: next });
                  }}
                  aria-label={`Reset ${slot.label}`}
                  className="tap shrink-0 border border-rule px-1.5 py-0.5 font-mono
                             text-[length:var(--t-2xs)] text-ink-2 hover:border-ink-3 hover:text-ink"
                >
                  Reset
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What a token currently resolves to, as `#rrggbb`.
 *
 * `<input type="color">` accepts nothing else — hand it `rgb(226 242 255 / .07)`
 * from the Winter palette and it silently shows black, so the swatch would lie
 * about the colour it is about to replace. Falls back to mid-grey rather than
 * throwing when the property is unset or unreadable, which is also what happens
 * during the first paint before the theme has been applied.
 */
function readToken(token: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '#808080';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
  }
  /* `rgb(r g b / a)` and `rgb(r,g,b)` both appear here depending on how the
     palette wrote it; the alpha is dropped because the input cannot carry it. */
  const nums = raw.match(/\d+(?:\.\d+)?/g);
  if (nums !== null && nums.length >= 3) {
    const hex = nums.slice(0, 3)
      .map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return '#808080';
}

/**
 * What is on this device, and a way to fetch it again.
 *
 * This was a CHECKBOX: "keep the catalogue on this device", with the trade
 * written beside it — ~19MB once against a few KB per screen for ever. The trade
 * was real while there were two places a list could come from. There is one now:
 * the app reads its own catalogue and there is no server-side copy to fall back
 * to, so the switch offered a choice between working and not working.
 *
 * What was worth keeping is the part underneath it — how much is here, and the
 * once-a-month control to fetch it again. Refresh lives here and only here; it
 * used to be a link in a status strip that appeared on every screen forever.
 */
export function CatalogueSetting() {
  const [status, setStatus] = useState<IngestStatus>(localStatus);
  useEffect(() => subscribeLocal(setStatus), []);

  const rows = status.rows > 0 ? status.rows.toLocaleString() : null;
  const line =
    status.state === 'loading'
      ? `${(status.bytes / 1e6).toFixed(1)}MB · ${status.step}/${status.steps}`
      : status.state === 'error'
        ? status.error
        : rows;
  return (
    <div className="border-t border-rule p-3">
      <div className="flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        <Database className="h-3 w-3" /> Library
        {line !== null && line !== '' && (
          <span className="ml-auto normal-case tracking-normal text-ink-3">{line}</span>
        )}
      </div>
      {status.state !== 'loading' && (
        <button
          type="button"
          onClick={() => { void refreshLocal(); }}
          className="mt-1.5 flex items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      )}
    </div>
  );
}

/**
 * What OK on a film or a series does.
 *
 * Asked for in those words — "in settings add a toggle if they wanna see direct
 * full screen or show page" — after the owner's own verdict on the alternative:
 * "if you think about it, the showpage is entirely useless".
 *
 * Two buttons rather than a checkbox because neither option is the negative of
 * the other, and both need naming: a checkbox called "open fullscreen" leaves a
 * viewer guessing what unchecking it does. Two buttons rather than a `<select>`
 * because a select on Android TV opens a system list that swallows the D-pad.
 */
export function OpenSetting() {
  const [prefs] = usePrefs();
  const choices: { id: OpenStyle; label: string; hint: string }[] = [
    /* The default first, so the list reads in the order somebody meets it. It
       has been both ways round — see `readOpenStyle` in lib/prefs. */
    { id: 'page', label: 'Show details', hint: 'plot, cast and a PLAY button' },
    { id: 'fullscreen', label: 'Play it', hint: 'straight to the picture' },
  ];
  return (
    <div className="border-t border-rule p-3">
      <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        Pressing OK on a title
      </span>
      <div className="mt-2 flex gap-1.5">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={prefs.openStyle === c.id}
            onClick={() => setPrefs({ openStyle: c.id })}
            className={`tap flex-1 border px-2 py-1.5 text-left transition-colors ${
              prefs.openStyle === c.id
                ? 'border-tally text-tally'
                : 'border-rule text-ink-3 hover:border-ink-3 hover:text-ink'}`}
          >
            <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
              {c.label}
            </span>
            <span className="mt-0.5 block text-[length:var(--t-2xs)] text-ink-3">{c.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
        Hold OK on any title for the other one, plus favourites.
      </p>
    </div>
  );
}

/**
 * The light around the picture.
 *
 * "aren't the player always i'm sure there are packages you can like show shades
 * you know what's playing right now like a television" — Ambilight. On by
 * default; a switch because the cost can only be judged on the box it runs on.
 */
export function AmbientSetting() {
  const [prefs] = usePrefs();
  return (
    <div className="border-t border-rule p-3">
      <button
        type="button"
        aria-pressed={prefs.ambient}
        onClick={() => setPrefs({ ambient: !prefs.ambient })}
        className={`tap flex w-full items-center gap-3 border px-2 py-2 text-left transition-colors ${
          prefs.ambient
            ? 'border-tally text-tally'
            : 'border-rule text-ink-3 hover:border-ink-3 hover:text-ink'}`}
      >
        <span
          aria-hidden
          className="h-7 w-7 shrink-0 border border-rule"
          style={{
            background: prefs.ambient
              ? 'radial-gradient(circle at 50% 50%, rgb(120 90 200) 0%, transparent 72%)'
              : 'transparent',
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
            Ambient light {prefs.ambient ? 'on' : 'off'}
          </span>
          <span className="mt-0.5 block text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
            Tints the space around the picture with the colours of what is playing.
            Not available for films the built-in engine plays — there are no pixels
            in the page to read.
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * Whether resting on a channel opens it.
 *
 * "when they scroll to a channel directly open it I mean they should be able to
 * see it instead of them clicking OK and then it opens ... and also for this add
 * a setting so they can change around". Both halves are here: the behaviour, and
 * the switch — because it is the one setting in this app that spends somebody
 * else's connection every time it fires.
 *
 * OFF by default, and the ON default is the SLOW one. The reason is in this
 * account's own debug log: seven doors burned in sixty-five seconds once, each
 * dying ~800ms in, and then the panel API — answering in 60ms all evening — took
 * 38 seconds and failed. A provider watching several opens in a few seconds from
 * one address, on a line that may allow one connection, does not distinguish
 * browsing from abuse. Two seconds of complete stillness is slow enough that
 * walking a list opens nothing.
 */
export function AutoOpenSetting() {
  const [prefs] = usePrefs();
  const choices: { id: AutoOpen; label: string; hint: string }[] = [
    { id: 'off', label: 'Off', hint: 'press OK to open' },
    { id: 'relaxed', label: 'After 2s', hint: 'safe on a busy line' },
    { id: 'quick', label: 'After 1s', hint: 'more like a television' },
  ];
  return (
    <div className="border-t border-rule p-3">
      <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        Resting on a channel
      </span>
      <div className="mt-2 flex gap-1.5">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={prefs.autoOpen === c.id}
            onClick={() => setPrefs({ autoOpen: c.id })}
            className={`tap flex-1 border px-2 py-1.5 text-left transition-colors ${
              prefs.autoOpen === c.id
                ? 'border-tally text-tally'
                : 'border-rule text-ink-3 hover:border-ink-3 hover:text-ink'}`}
          >
            <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
              {c.label}
            </span>
            <span className="mt-0.5 block text-[length:var(--t-2xs)] text-ink-3">{c.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
        The wait restarts on every press, and the channel already playing is never
        reopened. If streams start refusing, put this back to Off — a subscription
        with one connection cannot preview.
      </p>
    </div>
  );
}

/**
 * Which server, and which decoder — the two things that make a stream fail.
 *
 * Asked for as "i think its best if we allow server change, decoder change as
 * well, in the settings area, but name them dont show IP if not, just say server
 * 1 and so on, and add a message".
 *
 * ── the numbering is the point ──
 *
 * These hosts are the reseller's infrastructure. Their names say nothing to a
 * viewer, they change between builds, and printing them puts a piece of the
 * subscription on screen for anybody in the room. A position in a list is
 * something somebody can read back over a phone — "it works on server 3" — which
 * is the entire reason this control exists. The stored value is still the
 * hostname (see `Prefs.server`), because a position would point at a different
 * machine the moment the list changes.
 *
 * ── and neither setting is a fix ──
 *
 * The app already tries every door and already falls back to software decoding
 * on its own. These are for the case where the automatic answer is wrong on ONE
 * box and its owner has worked out which, so each one says what it is for rather
 * than presenting itself as a knob to turn hopefully.
 */
export function PlaybackServers() {
  const [prefs] = usePrefs();
  const active = activeProvider();
  /* Only the other hosts this subscription's own panel published for it. */
  const hosts = active === null || active.kind !== 'xtream' ? [] : hostsFor(active);
  if (hosts.length < 2) return null;
  const pickedKnown = prefs.server !== null && hosts.includes(prefs.server);

  const cell = (on: boolean) =>
    `tap border px-2 py-1.5 text-left transition-colors ${
      on ? 'border-tally text-tally' : 'border-rule text-ink-3 hover:border-ink-3 hover:text-ink'}`;

  return (
    <div className="border-t border-rule p-3">
      <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        Streaming server
      </span>
      <p className="mt-1 text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
        Your subscription is reachable on {hosts.length} servers. The app tries them in
        order and stays on whichever works, so leave this on Automatic unless one
        of them is reliably better for you.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <button
          type="button"
          aria-pressed={!pickedKnown}
          onClick={() => setPrefs({ server: null })}
          className={cell(!pickedKnown)}
        >
          <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
            Automatic
          </span>
        </button>
        {hosts.map((h, i) => (
          <button
            key={h}
            type="button"
            aria-pressed={prefs.server === h}
            onClick={() => setPrefs({ server: h })}
            className={cell(prefs.server === h)}
          >
            <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
              Server {i + 1}
            </span>
          </button>
        ))}
      </div>

      <span className="mt-4 block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        Decoder
      </span>
      <p className="mt-1 text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
        Automatic uses your box&apos;s own video chip and falls back to the processor
        when it cannot manage a file. Choose Software only if titles keep failing to
        open — it plays more of them, and costs more power.
      </p>
      <div className="mt-2 flex gap-1.5">
        {([
          { id: 'auto' as const, label: 'Automatic', hint: 'the chip first' },
          { id: 'software' as const, label: 'Software', hint: 'the processor, always' },
        ]).map((d) => (
          <button
            key={d.id}
            type="button"
            aria-pressed={prefs.decoder === d.id}
            onClick={() => setPrefs({ decoder: d.id })}
            className={`${cell(prefs.decoder === d.id)} flex-1`}
          >
            <span className="block font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">
              {d.label}
            </span>
            <span className="mt-0.5 block text-[length:var(--t-2xs)] text-ink-3">{d.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
        Both take effect on the next title you open.
      </p>
    </div>
  );
}

/**
 * Coming back to what was playing.
 *
 * A property of the SCREEN rather than of the profile — a television in a living
 * room should come back to its channel; a browser tab on a shared desktop may
 * well not.
 */
export function ResumeSetting() {
  const [prefs] = usePrefs();
  return (
    <div className="border-t border-rule p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={prefs.resumeOnOpen}
          onChange={(e) => setPrefs({ resumeOnOpen: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-tally"
        />
        <span className="min-w-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
          Resume last played
          {prefs.lastPlayed !== null && (
            <span className="mt-1 block normal-case tracking-normal text-ink-3">
              {prefs.lastPlayed.label}
            </span>
          )}
        </span>
      </label>
      {prefs.lastPlayed !== null && (
        <button
          type="button"
          onClick={forgetLastPlayed}
          className="tap mt-2 border border-rule px-2 py-1 font-mono text-[length:var(--t-2xs)]
                     tracking-widest text-ink-3 hover:border-alert hover:text-alert"
        >
          FORGET IT
        </button>
      )}
    </div>
  );
}

/**
 * What this device is hiding, and the way back.
 *
 * The trap this closes: a viewer who hides a country from the filter bar has no
 * other way to bring it back, and an app with a filter and no list of what the
 * filter is doing is an app that looks broken by its own settings.
 */
export function HiddenPrefs() {
  const [prefs] = usePrefs();
  const hidden = prefs.hidePaths.length + prefs.hideCats.length;
  const channels = prefs.hideStreams;
  return (
    <div className="border-t border-rule p-3">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        <EyeOff className="h-3 w-3" /> Hidden groups
      </p>
      {hidden === 0 ? (
        <p className="font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
          Nothing hidden. Hide a country or group from the filter bar to keep it
          out of every list, count and search.
        </p>
      ) : (
        <>
          <div className="max-h-40 space-y-px overflow-y-auto">
            {prefs.hidePaths.map((p) => (
              <button
                key={p}
                onClick={() =>
                  setPrefs({ hidePaths: prefs.hidePaths.filter((x) => x !== p) })
                }
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-2 py-1
                           text-left font-mono text-[length:var(--t-2xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">{p.replace(/\//g, ' › ')}</span>
                <Eye className="h-3 w-3 shrink-0" />
              </button>
            ))}
            {prefs.hideCats.map((c) => (
              <button
                key={c}
                onClick={() => setPrefs({ hideCats: prefs.hideCats.filter((x) => x !== c) })}
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-2 py-1
                           text-left font-mono text-[length:var(--t-2xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">category #{c}</span>
                <Eye className="h-3 w-3 shrink-0" />
              </button>
            ))}
          </div>
          <button
            onClick={() => setPrefs({ hidePaths: [], hideCats: [] })}
            className="mt-1.5 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
          >
            unhide all
          </button>
        </>
      )}

      {/*
        Hidden CHANNELS, which had nowhere to be brought back from.

        `hideStreams` is per profile and is honoured everywhere — the store query,
        the group counts, the search, the sync — but the only control anywhere in
        the app added to it. Hiding something with no way to unhide it is the trap
        this whole section exists to close, and it was half closed: a hidden
        country was listed here and a hidden channel was not, so the only way back
        was to clear the profile.

        Named where the device can name them. A hidden channel is one this profile
        no longer lists, so the catalogue is asked for it directly by its stable
        ref; on a device that no longer holds it — a subscription that lapsed, a
        package that was removed — the id is shown instead of a name, because
        "channel 2022584" is at least true and can still be unhidden.
      */}
      {channels.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
            <EyeOff className="h-3 w-3" /> Hidden channels · {channels.length}
          </p>
          <div className="max-h-40 space-y-px overflow-y-auto">
            {channels.map((id) => (
              <button
                key={id}
                onClick={() => setPrefs({ hideStreams: channels.filter((x) => x !== id) })}
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-2 py-1
                           text-left font-mono text-[length:var(--t-2xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">{channelName(id)}</span>
                <Eye className="h-3 w-3 shrink-0" />
              </button>
            ))}
          </div>
          <button
            onClick={() => setPrefs({ hideStreams: [] })}
            className="mt-1.5 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
          >
            show them all again
          </button>
        </div>
      )}
    </div>
  );
}

/** A hidden channel's name, or its id when this device no longer holds it. */
function channelName(streamId: number): string {
  /* Kind 1 is live: `hideStreams` only ever holds channels, because that is the
     only list with a hide control. The ref form is what every by-id read in the
     app takes — see `localItem`. */
  const row = localItem(`1.${streamId}`);
  return row === null ? `channel ${streamId}` : displayName(row.name);
}

/*
 * The display dropdown used to live here: a 19rem panel that dropped from the
 * header and held appearance, layout, resume, the catalogue switch, the backup,
 * codec support and the hidden list — nine sections in a scrolling box the
 * size of a phone, on a television.
 *
 * It is a PAGE now, `/more`, with a list of sections down the left and one of
 * them open on the right. The sections above are the same components; only the
 * frame around them changed. Two things went with the panel and are not coming
 * back: the layout chooser (Auto / Phone / Tablet / Desktop / TV — this is a
 * television app and the other four were a way to break it), and the panel's own
 * cog, since the header cog now opens the page.
 */

/**
 * What this device can decode, stated before anything fails.
 *
 * The list is short because it is the codecs THIS catalogue contains: H.264 and
 * AAC almost everywhere, HEVC on the 4K feeds, and AC-3/E-AC-3/MP2 on European
 * broadcast channels — which are the ones browsers most often lack, and the
 * reason a channel plays with a picture and no sound.
 *
 * Three sources are asked and disagreements are shown rather than resolved
 * quietly: `MediaSource.isTypeSupported` answers from a static list and is known
 * to claim codecs a TV does not have, so a codec it claims and the platform
 * decoder denies is exactly the case that produces a black screen with no error.
 */
export function PlaybackSupport() {
  const report = useCapabilities();
  const [busy, setBusy] = useState(false);

  const dot = (v: string) =>
    v === 'yes' ? 'bg-live'
    : v === 'likely' ? 'bg-live/50'
    : v === 'no' ? 'bg-alert'
    : v === 'unlikely' ? 'bg-alert/50'
    : 'bg-ink-3';

  return (
    <div className="border-t border-rule p-3">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        <Cpu className="h-3 w-3" /> Playback support
      </p>
      {report === null ? (
        <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">Checking…</p>
      ) : (
        <>
          <div className="space-y-px">
            {report.codecs.map((c) => (
              <div
                key={c.id}
                title={`${c.note}`
                  + (c.native === null ? '' : `\nThis app's own decoder: ${c.native}`)
                  + `\nBrowser alone: ${c.browserVerdict}`
                  + `\n  Media Source: ${c.mse === null ? 'unknown' : c.mse}`
                  + `\n  Media Capabilities: ${c.mediaCaps === null ? 'unknown' : c.mediaCaps.supported}`
                  + `\n  Platform decoder: ${c.webCodecs === null ? 'unknown' : c.webCodecs}`}
                className="flex items-center gap-2 rounded-[var(--r-xs)] bg-ground/40 px-2 py-1"
              >
                <span className={`h-1.5 w-1.5 shrink-0 ${dot(c.verdict)}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t-2xs)] text-ink-2">{c.label}</span>
                {c.disputed && (
                  <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-tally" title="The three sources disagree about this one.">
                    disputed
                  </span>
                )}
                {c.native !== null && c.browserVerdict !== 'yes' && c.native !== 'no' && (
                  <span
                    className="shrink-0 font-mono text-[length:var(--t-2xs)] text-live"
                    title={c.native === 'hardware'
                      ? "The browser will not decode this; the app's own player does, on the device's hardware decoder."
                      : "The browser will not decode this; the app's own player does it in software."}
                  >
                    {c.native === 'hardware' ? 'built-in ⚡' : 'built-in'}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">{c.verdict}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              setBusy(true);
              void refreshCapabilities().finally(() => setBusy(false));
            }}
            className="mt-1.5 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
          >
            {busy ? 'checking…' : 're-check'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The shell, in two shapes.
 *
 * Phone gets a slim identity bar and a bottom tab bar, because a thumb reaches the
 * bottom of a 6-inch screen and not the top of it, and because the destinations
 * have to survive losing their labels. Everything else keeps the single header
 * row: it is where a cursor already is, and on TV it reads across a room.
 *
 * The left/right safe-area inset is spent here, once, rather than in every route —
 * that covers a phone held in landscape and a TV's horizontal overscan in the same
 * two properties. Top belongs to the header (so its gradient covers the notch),
 * bottom to whatever is actually last on screen.
 */
/**
 * Every control on the right is the same target — including the corner.
 *
 * The radius is spelled out because two of these are `<a>` and the rest are
 * `<button>`, and the retrofit layer in index.css rounds buttons, inputs and
 * images by element name. So the search and settings icons came out soft and the
 * account icon beside them came out as a hard grey square the moment it was
 * hovered or focused: three identical targets, one of them a different shape.
 * That was the report. A tag is not a design decision, so the shape does not
 * follow it.
 */
/**
 * The ICON_BTN row sits above; status lives beside the person icon.
 */
const ICON_BTN =
  'tap grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-sm)] text-ink-2 '
  + 'transition-colors '
  + 'hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:text-ink '
  + 'focus-visible:outline-none';

const MODERN_ICON =
  'tap modern-icon grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-2 '
  + 'transition-colors '
  + 'hover:text-ink focus-visible:text-ink focus-visible:outline-none';

/**
 * Is `to` — a bare path, or one carrying its own query string the way
 * `searchTo()` does (`/search?from=live`) — the address already on screen?
 *
 * Compared as a URL rather than as a string, because the query string is part
 * of the address here: `/more` and `/more?s=appearance` are different screens,
 * so a same-pathname check alone would treat SETTINGS as a no-op on the MENU
 * screen. `useLocation().search` already carries the leading `?` (or is
 * empty), which is exactly what `URL#search` produces too.
 */
function samePlace(to: string, pathname: string, search: string): boolean {
  const url = new URL(to, 'http://x');
  return url.pathname === pathname && url.search === search;
}

export function Chrome({ children }: { children: React.ReactNode }) {
  /* Prefetch: AccountBadge and others share this key. */
  useQuery({ queryKey: ['source'], queryFn: api.source, staleTime: 60_000 });
  const inventory = useInv();
  const [keysSheet, setKeysSheet] = useState(false);
  const [accountsSheet, setAccountsSheet] = useState(false);
  const nav = useNavigate();
  const shape = useShape();
  const { pathname, search } = useLocation();
  /* A phone's category drawer does not follow the viewer to another screen. */
  useEffect(() => { setRailOpen(false); }, [pathname]);
  const { shell, resolved } = useSkin();
  const modern = shell === 'modern';
  const section = modernSectionOf(pathname);
  /*
   * Which shell this television wears. See `Shell` in lib/skin.ts.
   *
   * Read here rather than from CSS alone because Modern differs structurally —
   * transparent header over a plate, strip without Settings (Settings is an icon).
   */
  /*
   * Pages whose first paint is a full-bleed hero: the shell sits on the picture
   * until the page scrolls, then takes a solid wash. Discover (the showcase),
   * classic Home, and film and series detail — not
   * grids or live, where a solid bar is right.
   *
   * While the detail player stage is mounted the bar returns to normal flow —
   * keyed off the stage itself, not presence, because "opening…" can last
   * seconds with no `notePlaying` yet and an absolute bar covers that black box.
   */
  const heroOverlay = pathname === '/discover'
    || (pathname === '/home' && !modern)
    || /^\/movie\//.test(pathname)
    || /^\/series\//.test(pathname);
  /*
   * `/home` is only a hero in the classic shell; `/discover` is a hero in BOTH.
   *
   * The overlay exists because the showcase opens on a full-bleed still and a
   * solid bar over it looks pasted on. `/home` in the modern shell is the
   * launcher instead — a row of cards, not a picture — so an absolutely
   * positioned header there would simply cover its first row. `/discover` is
   * the showcase itself regardless of shell — the header's Home icon opens it,
   * the logo opens the launcher — so it always gets the hero treatment. A detail page is still a hero in both.
   */
  const detailPlayer = useSyncExternalStore(subscribeDetailPlayer, isDetailPlayerOpen, () => false);
  const shellHidden = useSyncExternalStore(subscribeShellHidden, isShellHidden, () => false);
  const overlayActive = heroOverlay && !detailPlayer && !shellHidden;
  const headRef = useRef<HTMLElement | null>(null);
  const [heroScrolled, setHeroScrolled] = useState(false);
  useEffect(() => {
    if (!overlayActive) {
      setHeroScrolled(false);
      return undefined;
    }
    setHeroScrolled(false);
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || t.dataset.heroScroll === undefined) return;
      setHeroScrolled(t.scrollTop > 48);
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [overlayActive, pathname]);
  /* `/` and GREEN go to the search page — the header is a Link, not a field. */
  const searchTo = useSearchTarget();
  const tabs: readonly { to: string; label: string; Icon: typeof Home }[] =
    modern ? MODERN_HEADER_TABS : HEADER_TABS;

  /*
   * How tall this bar actually is, published for the pages that sit under it.
   *
   * On Home, film detail and series detail the header floats over a full-bleed
   * hero, and those pages reserve room for it with `--shell-overlay-pad`. That
   * was three hand-written guesses — 3.75rem, 4rem, and 3.25rem for
   * `data-ff='tv'`, which `formFactor.classify` returns for every device, so the
   * last one is the only one that ever applied. Measured on the film page at the
   * television's own geometry: the reservation is 42px and the bar is 56, and
   * BACK sits fourteen pixels inside it. One wrong constant, three pages.
   *
   * It cannot be a constant: the height is a wordmark plus a row of
   * destinations plus three circular controls plus the density's padding plus
   * whatever the root font size is at this width — and Modern's bar is taller
   * than Classic's. So it is measured here and the constants stay only as the
   * fallback for the first frame, before this has run.
   */
  useEffect(() => {
    const root = document.documentElement;
    const bar = headRef.current;
    if (bar === null) {
      root.style.removeProperty('--header-h');
      return undefined;
    }
    const publish = () => {
      const h = Math.round(bar.getBoundingClientRect().height);
      /* Zero means it is not laid out yet; publishing it would collapse the
         reservation to nothing for a frame, which is the bug in miniature. */
      if (h > 0) root.style.setProperty('--header-h', `${h}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(publish);
    watch.observe(bar);
    return () => { watch.disconnect(); };
  }, [shellHidden, modern, overlayActive]);

  useEffect(() => {
    const root = document.documentElement;
    if (!modern || section === 'other' || section === 'home') {
      root.removeAttribute('data-section');
      return () => root.removeAttribute('data-section');
    }
    root.setAttribute('data-section', section);
    return () => root.removeAttribute('data-section');
  }, [modern, section]);

  /*
   * The accounts and profile DRAWERS are gone, and with them the request
   * mechanism that opened them.
   *
   * They existed because the full-screen profile chooser had no shell header
   * above it and still needed a way in. There is no chooser: the person icon goes
   * to Accounts, and switching profile is a row in the profile section — both of
   * which are ordinary links, so a page asking the shell to open something on its
   * behalf has nothing left to ask for.
   */
  /*
   * Two ways this drawer has to get out of the way on its own.
   *
   * The photograph that started this showed the centred welcome dialog with the
   * ACCOUNTS drawer still open behind it, each holding a form for adding a
   * subscription. Removing the LAST one signs out and puts the first-run door
   * back (`reopenDoor` in lib/firstRun.ts); the gate above mounts `Welcome` over
   * everything — and nothing ever told the drawer that the screen it belonged to
   * had just been answered. It could not tell itself, either: the drawer is the
   * shell's, not the route's, so `Welcome`'s own `nav('/home')` leaves it exactly
   * where it was.
   *
   * The add-a-subscription dialog gets the same treatment for the same reason.
   * It is opened FROM here, so this drawer is precisely what would be sitting
   * behind it — the duplicate, one layer down, all over again.
   */
  useEffect(() => subscribeDoor(() => setAccountsSheet(false)), []);
  useEffect(() => subscribeAddAccount(() => {
    if (addAccountOpen()) setAccountsSheet(false);
  }), []);

  /**
   * Android back closes whatever the shell has open.
   *
   * Registered as one handler rather than four because these are mutually
   * exclusive — the request effect above already ensures only one is open — and a
   * single handler keeps the order obvious. Declines when nothing is open, so the
   * press falls through to the player, and then to history.
   */
  useEffect(() => pushBackHandler(() => {
    if (keysSheet) { setKeysSheet(false); return true; }
    if (accountsSheet) { setAccountsSheet(false); return true; }
    return false;
  }), [keysSheet, accountsSheet]);

  /**
   * And the shell lends `nativeBack` its router.
   *
   * "Back at a top-level tab goes Home first" is a decision that module makes and
   * could not carry out: it wrote `location.hash`, which navigates under the hash
   * router the APK is built with and does nothing at all under the path router
   * the website runs — leaving a stray `#/home` on the address that the same
   * module then read back as the current route. See `setBackNavigator`.
   */
  useEffect(() => setBackNavigator((to) => nav(to)), [nav]);

  /*
   * "Press BACK twice more to leave" — the visible half of the exit gesture.
   *
   * `nativeBack.countExitPress` consumes the first two presses at Home, and the
   * third either puts "are you sure you want to exit" up (under the wrapper, see
   * `ExitDialog`) or declines so the host's own BACK takes it (a browser). A
   * gesture nobody is told about is just a button that stopped working, so the
   * shell shows what it is waiting for, and `0` means the gesture is complete —
   * the question is on screen or the app is on its way out, and a hint under
   * either would be a second voice saying something else.
   *
   * It clears itself after the count's own window, imported rather than written
   * out again: it used to be a separate 3,200 here, which is the hint and the
   * count holding two opinions about the same three seconds. The 200ms on top
   * keeps the hint up until the count has certainly reset, so there is no instant
   * in which a press would still count and the screen has stopped saying so.
   */
  const [exitLeft, setExitLeft] = useState(0);
  useEffect(() => onExitPrompt(setExitLeft), []);
  useEffect(() => {
    if (exitLeft <= 0) return undefined;
    const t = window.setTimeout(() => setExitLeft(0), EXIT_WINDOW_MS + 200);
    return () => window.clearTimeout(t);
  }, [exitLeft]);

  /**
   * The bottom layer of the keyboard: the buttons that mean the same thing
   * everywhere in the app.
   *
   * Every screen registers above this one, so a screen that wants BLUE for
   * something else simply takes it — and the legend along the bottom follows,
   * because both come from the same registry. The four coloured buttons have no
   * fixed meaning on any TV platform, so what the shell claims here is only a
   * default: GREEN searches and BLUE explains the buttons, on the grounds that
   * those two are useful on every screen there is.
   */
  /**
   * `nav`, guarded against a press that would only push where we already are.
   *
   * Holding GUIDE, LIVE, SEARCH or any other destination button on a remote
   * runs its `act` once per OS auto-repeat tick — every ~40ms — and every one
   * of them below is `nav(...)`, which PUSHES a history entry by default. A
   * couple of seconds of a held button used to leave hundreds of identical
   * entries on the stack, and BACK then had to be pressed just as many times
   * to get anywhere — which is what "the app stopped working" turned out to
   * be here. A press that lands where the viewer already is now does nothing
   * at all: there is nothing to push, and nothing to replace the entry with
   * either, since the address (`samePlace` checks the query string too) is
   * already exactly this one.
   */
  const navOnce = useCallback((to: string) => {
    if (!samePlace(to, pathname, search)) nav(to);
  }, [nav, pathname, search]);

  const bindings = useMemo((): Binding[] => [
    { intent: 'search', label: 'Search', act: () => navOnce(searchTo()) },
    { intent: 'green', label: 'Search', act: () => navOnce(searchTo()) },
    { intent: 'guide', label: 'Guide', act: () => navOnce('/guide') },
    { intent: 'catchup', label: 'Catch-up', act: () => navOnce('/catchup') },
    { intent: 'live', label: 'Live TV', act: () => navOnce('/live') },
    /* Both of these used to lead somewhere that no longer exists: MENU opened
       the classic launcher at /menu, and SETTINGS opened a dropdown panel in the
       header. There is one settings screen now and both keys open it. */
    { intent: 'menu', label: 'Menu', act: () => navOnce('/more') },
    { intent: 'settings', label: 'Settings', act: () => navOnce('/more?s=appearance') },
    { intent: 'shortcuts', label: 'All buttons', act: () => setKeysSheet(true) },
    { intent: 'blue', label: 'All buttons', act: () => setKeysSheet(true) },
    /* `pathname`: SEARCH carries the section it was pressed on, so a binding
       memoised on `nav` alone would keep sending Movies' viewers to Live's
       ordering for the rest of the session. `navOnce` closes over `pathname`
       too, so this list still has to be told the same thing. */
  ], [navOnce, pathname, searchTo]);
  useKeyLayer(bindings);

  /**
   * A new screen on a D-pad device needs focus put somewhere.
   *
   * With focus on `<body>` — which is where a route change leaves it — every arrow
   * press and every OK press does nothing at all, and the app looks frozen. That
   * is the state the app shipped in: "I can't go down with arrows". A cursor or a
   * touchscreen has no such problem, so this is deliberately limited to the case
   * that does, and it never steals focus from something that already has it.
   *
   * One frame late, because the route's own elements do not exist yet on the tick
   * the path changes.
   */
  useEffect(() => {
    if (!shape.remote) return;
    /*
      Retried, because the first attempt usually has nothing to aim at.

      A channel list is empty 60ms after the route mounts — the catalogue request
      has not come back — so `focusFirst` finds no candidates and returns false.
      One attempt therefore left the screen with no focus at all on exactly the
      pages that take longest to fill, which is the state the whole app was in.
      The ladder stops at the first success and gives up after two seconds rather
      than watching forever.
    */
    /*
      And re-aimed, which is the half that was missing.
      
      The ladder above only fired when focus was LOOSE — nothing focused at all.
      But the first rung usually succeeds: 60ms after a route mounts `<main>` is
      still empty, so `focusFirst` falls back to the header and lands on the
      wordmark or Search. Focus is now no longer loose, so every later rung is
      skipped, and the screen opens with its ring on a header icon while the
      content it was meant to aim at arrives underneath.

      Reported twice, from two people: "when you open a movie, instead of
      highlighting the play button it highlights the search button on top", and a
      client counting eight presses before he found PLAY.

      So a rung also fires when focus is still sitting on the exact element WE
      placed and the page has since grown something to aim at. `placed` is the
      guard that makes this safe: if the viewer has moved focus themselves in
      those two seconds, `activeElement` is no longer what we put there and we
      leave it alone. Stealing focus from someone mid-press is worse than the bug.
    */
    /*
      TWO restorers, and until now they did not know about each other.

      `placed` was the guard: re-aim only while focus is still on the element WE
      put there, so a viewer who has moved it themselves is left alone. Correct in
      spirit and wrong in fact, because this is not the only thing that catches
      focus after a route change. `spatialNav` runs a MutationObserver that
      notices the focused element disconnecting and calls `focusFirst` on the next
      animation frame — about 16ms, well before the first rung here at 60ms — and
      at 16ms `<main>` is empty, so it falls back to the header.

      Instrumented on /movie/:id, and every rung reads the same:

        [aim] loose=false stranded=false placed=null active=A:Search mainHas=0
        [aim] loose=false stranded=false placed=null active=A:Search mainHas=26 navFirst=true

      `placed` is null because THIS ladder did not place that focus, so `stranded`
      can never become true; `focusIsLoose` is false because Search genuinely has
      focus. Every rung returns early, and the film opens with its ring on the
      search icon while PLAY sits below, unreached — measured at 12 presses of
      DOWN without arriving. That is the client's "I clicked 8 times and still
      didn't find PLAY", and it survived the fix that was supposed to end it
      because the fix only recognised its own handiwork.

      So the question changes from "did I put it there" to "has the VIEWER put it
      anywhere". Nobody can press a key in the 60ms after a route mounts, so focus
      outside `main` in that window is always a fallback rather than a choice —
      whichever restorer left it there. The first real press ends the ladder for
      good, which is the property `placed` was protecting and this keeps: a
      capture-phase listener on the window, removed with the timers.
    */
    /*
      What counts as the viewer taking over.
      
      Any keydown at all used to end the ladder for good — including the second
      press of an OK that a remote sends while repeating, and the keyup half of
      the press that caused this navigation. So a screen could lose its focus
      ladder before the first rung had run once, and whatever a restorer had left
      on the header stayed there for the whole visit.
      
      A press that MOVES focus is the signal: the arrows, Tab, or a pointer. OK
      does not qualify, because OK activates whatever the ladder has placed —
      treating it as "leave my focus alone" is what leaves the ring on the search
      icon while somebody presses it.
    */
    const MOVES_FOCUS = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End',
    ]);
    let touched = false;
    const noteKey = (e: Event) => {
      if (e instanceof KeyboardEvent && !MOVES_FOCUS.has(e.key)) return;
      touched = true;
    };
    const notePointer = () => { touched = true; };
    window.addEventListener('keydown', noteKey, true);
    window.addEventListener('pointerdown', notePointer, true);

    const aim = () => {
      if (touched) return;
      const page = document.querySelector('main');
      const active = document.activeElement;
      const stranded = page !== null
        && (active === null || !page.contains(active))
        && page.querySelector('button, a[href], input, [data-nav-item]') !== null;
      /*
        And the case where focus landed IN the page, but not where the page says
        to start.
        
        A film detail page fills in two stages: the local row paints the hero and
        the related rail fills from the same catalogue, and whichever wins that
        race gets the ring. Measured on a cold open of /movie/2.2129873: focus on
        a poster in "MORE LIKE THIS" at 700ms and still there at 3.2s, because
        the rungs above only re-aim when focus is OUTSIDE `<main>`. The declared
        entry point is what `data-nav-first` means — PLAY, on this page — so its
        arrival is itself a reason to aim again.
        
        Bounded by the same two guards as everything else here: only while the
        viewer has pressed nothing, and never when the ring is already on it.
      */
      const declared = page?.querySelector<HTMLElement>('[data-nav-first]') ?? null;
      /*
        Focus INSIDE the declared entry point counts as having arrived.
        
        `data-nav-first` is not always the thing that ends up focused: the
        episode list declares a `tabIndex={0}` section whose `onFocus` forwards
        to the first episode, so `active` is never `declared` and a rule that
        compares them directly is never satisfied. Measured on /series/3.5657
        after the rule went in: six re-aims in 2.1 seconds, each one landing on
        the section, being forwarded to the button, and counting as misaimed
        again — with the list twitching as every cycle re-ran the keyline.
      */
      const misaimed = declared !== null && active !== declared
        && !(active !== null && declared.contains(active))
        && (active === null || active === document.body || page?.contains(active) === true);
      if (!focusIsLoose() && !stranded && !misaimed) return;
      focusFirst();
    };
    const timers = [60, 260, 700, 1400, 2100].map((ms) => window.setTimeout(aim, ms));
    /*
      And a rung for every page slower than the ladder.

      The five timers end at 2.1 seconds, which was tuned against a channel list.
      A film detail page waits on `get_vod_info` — a live panel request with
      500/1000/2000/4000ms of backoff behind it — so on this subscription every
      rung fires while `<main>` is still a skeleton, the last one included.
      Measured on /movie/2.735123: focus on `a[Search]` and no `<h1>` in the page
      2.6 seconds after OK, which is the state the owner photographed twice.

      The page filling IS the event to wait for, so watch for it instead of
      guessing when it happens: any node arriving under `<main>` re-runs the same
      aim, under the same two guards — the viewer has not pressed anything, and
      focus is not already inside the page. Ten seconds is the ceiling, because a
      screen that has not filled by then is not going to.

      `aim` itself is what makes this safe to fire often: it returns immediately
      unless focus is loose or stranded outside a `<main>` that now has something
      focusable in it, so a page that grows a rail every second does not keep
      yanking the ring back.
    */
    const main = document.querySelector('main');
    const watcher = main === null || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => aim());
    watcher?.observe(main as Node, { childList: true, subtree: true });
    const stopWatching = window.setTimeout(() => watcher?.disconnect(), 10_000);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(stopWatching);
      watcher?.disconnect();
      window.removeEventListener('keydown', noteKey, true);
      window.removeEventListener('pointerdown', notePointer, true);
    };
  }, [pathname, shape.remote]);

  /**
   * Searching does not leave the page you were on.
   *
   * `/search` matches no tab, so the whole strip went dim the moment it opened —
   * six destinations and none of them current, which reads as the app having
   * lost its place rather than as a page you are still inside. The search
   * address carries the tab it was opened from (`searchHref`), so that tab stays
   * lit for as long as you are in there.
   *
   * Null everywhere else, and a hand-typed `/search?from=nonsense` simply
   * matches no tab — exactly what happened before this existed.
   */
  const searchingFrom = pathname === '/search'
    ? `/${new URLSearchParams(search).get('from') ?? ''}`
    : null;
  const onSearch = pathname === '/search';

  /**
   * Movie detail page opened from the Adult tab keeps the Adult tab lit.
   *
   * `/movie/:id?from=adult` is a detail page hanging off `/movie`, so `tabOwns`
   * would light the Movies tab. The `from=adult` query param says the viewer
   * arrived from the Adult section, so that tab stays highlighted.
   */
  const detailFrom = pathname.startsWith('/movie/')
    ? `/${new URLSearchParams(search).get('from') ?? ''}`
    : null;

  /* Pinned false: the layout is TV-only, so the phone furniture below never
     rendered. Kept as a constant so the JSX reads unchanged. */
  const phone = false;

  const sheets = (
    <>
      {keysSheet && <Shortcuts onClose={() => setKeysSheet(false)} />}
      {accountsSheet && <SourcesSheet onClose={() => setAccountsSheet(false)} />}
    </>
  );

  /*
   * Nothing renders outside the shell any more.
   *
   * Two routes used to: the classic launcher at `/menu`, which drew its own
   * header, and the full-screen profile chooser at `/profiles`, which carried its
   * own way out so it could not be walked past. Both are gone — switching profile
   * is a settings row now, in the profile section where that profile's other
   * settings already are.
   */
  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden pl-[var(--edge-l)] pr-[var(--edge-r)]
                  ${overlayActive ? 'relative' : ''}`}
    >
      {/*
        The room, on its own layer BEHIND the app rather than under it.

        It used to be the background of this very div — the one every route
        renders inside — and that is why it vanished in the app: when libVLC owns
        the picture, `VideoPlayer` walks up from the `<video>` and clears the
        background of every opaque ancestor so the native surface can be seen
        through the page, and this div is an ancestor of every video there is.
        The rule doing it is `background-image: none !important`, so the
        photograph went with the fill. Measured on the emulator against the
        website at the same size: the strip above the panes was flat 29-29 in the
        app and 21-40 on the site. "the background image is gone … that backdrop
        image you know the body image."

        As a sibling it is never walked, so it keeps its picture — and it carries
        the hole itself instead, clipped to the same rectangle the surface uses.
        See `.modern-plate` in `index.css`.
      */}
      {modern && !heroOverlay && (
        <div aria-hidden className="modern-plate" style={modernPlateStyle(resolved)} />
      )}
      {/*
        Ten-foot header: a wordmark you can read across a room, nav that reads as
        a row of destinations rather than text links, and a single accent colour so
        the focused item is unmistakable from a distance.
      */}
      {/*
        The shell paints above the page, always.
        Neither of these was positioned, so any page element with a positive
        z-index — a sticky guide header, a virtualised row, a shimmering skeleton
        — painted straight over the bottom tab bar. An element that is part of the
        frame must not be something content can cover.
      */}
      {!shellHidden && (
      <header
        ref={headRef}
        /*
          On Home / film / series detail the bar sits over a full-bleed hero:
          transparent until the page scrolls, then a solid wash. Elsewhere the
          bar stays in flow with a solid fill so grids and lists stay readable.
        */
        /* A section, not a boundary: the destinations and the three controls belong
           together, and Down out of them has to reach the page. `overlays.test.ts`
           requires every floating element to say which it is — this one lost the
           attribute in a parallel edit and the test caught it, which is the test
           doing exactly its job. */
        data-nav-scope
        className={`app-header z-40 flex flex-wrap items-center gap-2 px-2 pb-2
                   pt-[calc(var(--edge-t)+0.5rem)]
                   sm:gap-3 sm:px-4 sm:pb-2.5 sm:pt-[calc(var(--edge-t)+0.625rem)] xl:gap-4
                   tv:flex-nowrap tv:px-[var(--tv-safe-x)]
                   tv:pb-1.5 tv:pt-[calc(var(--edge-t)+0.375rem)]
                   transition-[background-color,box-shadow,backdrop-filter] duration-200
                   ${modern ? 'rounded-none!' : ''}
                   ${overlayActive
                     ? `absolute inset-x-0 top-0 shrink-0 ${
                         heroScrolled
                           ? (modern
                             ? 'bg-ground/50 backdrop-blur-sm'
                             : 'bg-panel/95 shadow-[0_8px_24px_-12px_rgb(0_0_0/.55)] backdrop-blur-md')
                           : 'bg-transparent'
                       }`
                     : modern
                       ? 'relative shrink-0 bg-transparent shadow-none'
                       : `relative shrink-0 bg-gradient-to-b from-panel-2 to-panel
                        shadow-[0_6px_18px_-14px_rgb(0_0_0/.45)]
                        tv:bg-gradient-to-b tv:from-ground tv:via-ground/85 tv:to-ground/70`
                   }`}
      >
        {/*
          Just the mark. The item count that used to sit here told a viewer how
          many rows the catalogue holds, which is a number about our plumbing
          rather than anything they came to watch — and on a television the top
          bar is a signpost, not a status line.
        */}
        {/*
          Three cells, and the middle one is the subject.

          The mark and the controls both sit in a `grow basis-0 shrink-0` cell, so
          whatever room is left over is split equally between them and the menu
          lands on the screen's actual centre rather than on the centre of the gap
          between them. That distinction is visible: the right-hand cluster is six
          icons and a clock and the left is one 36px mark, so centring the menu in
          the space between them puts it 85px left of centre on the box's own
          960px viewport — measured, and it reads as "nearly centred", which is
          worse than either extreme.

          `basis-0 grow shrink-0` rather than `flex-1`, deliberately: `flex-1` is
          the single `flex` shorthand and `shrink-0` is `flex-shrink`, so which
          one wins depends on Tailwind's emission order at equal specificity —
          the same trap as the position utilities (`positionUtilities.test.ts`).
          Three separate properties cannot fight.
        */}
        <div className="app-mark flex min-w-0 shrink-0 grow basis-0 items-center">
          {/*
            The whole lockup, not the symbol alone.

            "for a header area and like areas that have space please show the
            whole logo with its text and everything" — and the header is the
            widest space in the app. The item count that used to sit here told a
            viewer how many rows the catalogue holds, which is a number about our
            plumbing rather than anything they came to watch.

            It still has to fit without moving the centred menu: the two outer
            cells split the leftover room equally, so the lockup only shifts the
            menu if it grows past that share. Measured on the box's own 960px
            viewport — 143px of lockup against a 250px share.

            It is also the launcher's door: "when you click on it you will see
            those five cards" — `Wordmark`'s own default `to` is `/home`, so no
            prop is needed here, and `a[href]` is already a D-pad stop (see
            `FOCUSABLE` in `spatialNav.ts`) — LEFT out of the first tab lands on
            it the same way it lands on any other control level with the strip.
          */}
          {/* A narrow phone held sideways has no room for the name beside seven
              destinations; the symbol alone is still the way home. */}
          <Wordmark size={modern ? 'lg' : 'md'} full={!(shape.touchScreen === 'phone' && shape.width < 760)} />
        </div>

        {/* On a phone the destinations live in the tab bar, where the thumb is. */}
        {!phone && (
          <nav
            /* One group, and one that remembers: coming back up from the page
               should land on the destination you left from, not on whatever
               happens to be geometrically above the last thing you touched. */
            data-nav-group="tabs"
            data-nav-memory
            /*
              Centred, and spaced.
              Asked for as "top menu centered space between the menu". It was
              hard against the mark on the left with `gap-1` between the pills,
              which from a sofa reads as one wide object rather than as five
              places you can go — the gap has to be big enough to be a gap at
              three metres. `flex-1` centres the row in the space between the
              mark and the controls, and `min-w-0` with the scroller means a
              narrow window shrinks it rather than wrapping the header.

              And then too far the other way: with seven destinations, "there is
              way too much space between menus on top". Each tab already carries
              its own padding, which is most of the gap a sofa needs; the gap
              between them is now a small addition to that, not a second one.
            */
            className="app-tabs flex min-w-0 shrink-0 grow-0 justify-center gap-0.5 overflow-x-auto
                       sm:gap-1 tv:gap-1.5"
          >
            {tabs
              .filter((t) => modern || tabHasContent(t.to, inventory))
              .map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                onFocus={() => preloadRoute(to)}
                onPointerEnter={() => preloadRoute(to)}
                /*
                  Modern: tally colour + underline only. No fill pill / card.
                */
                className={({ isActive }) => {
                  const here = isActive || to === searchingFrom || to === detailFrom || tabOwns(to, pathname);
                  if (modern) {
                    const base = 'dest tap flex items-center gap-1.5 px-2.5 py-2 text-[length:var(--t-sm)]'
                      + ' font-medium tracking-wide transition-colors';
                    return `${base} ${
                      here
                        ? 'dest-here is-on'
                        : 'text-ink hover:text-ink'
                    }`;
                  }
                  const base = 'dest tap flex items-center gap-1.5 font-mono'
                    + ' text-[length:var(--t-sm)] tracking-wide transition-colors';
                  return `${base} px-2.5 py-1.5 sm:px-3 ${
                    here ? 'is-on bg-tally/15 text-tally' : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
                  }`;
                }}
                style={modern ? undefined : { borderRadius: 'var(--r-full)' }}
              >
                <Icon className="h-4 w-4" strokeWidth={modern ? 1.75 : 2} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        )}

        {/*
          Destinations end, controls begin. Neither moves because the other grew:
          the spacer that used to be here is gone, because the mark's cell and this
          one both grow from a zero basis and that is what centres the menu.
        */}

        {/*
          The right-hand side: icons, and in Classic the time.

          It was a wide search field, a refresh button and a MENU pill - a
          toolbar rather than a signpost. Search is an icon that goes to the
          search page, the cog is everything that used to be behind MENU, and
          the avatar is who is watching. Classic's clock sits after the avatar
          because a television is also a clock, and because that is where a
          viewer's eye already goes.

          ── the order, which is one order for both shells ──

            Search · Reload · Settings · Account

          "they are not properly ordered and organized". They were not: Modern ran
          Search, Settings, Notifications, Account, so a system control sat
          between two that were not, and each shell had its own sequence. Now it
          is content first, then system, which is how television launchers lay
          out the same corner: finding something to watch (Search, Reload), then
          looking after the app (Settings), then who is watching (Account).

          ── the bell is gone ──

          It opened a drawer that has never had anything in it — no notification
          has ever been sent to this app — so it was a control that could only
          ever disappoint, sitting in the row a viewer reaches most. "please
          remoev that notification sheet and button, what the hell is that".

          ── Reload is back ──

          It went into the menu behind the cog on the reasoning that rebuilding
          the library is a rare, deliberate act. The owner's answer: "you removed
          the reload button from top, please add that". A subscription's channel
          list changes under the viewer and a rebuild is the fix they reach for,
          which is how `RefreshLibrary` was asked for in the first place: "this
          reload button will be used more than search". It is in both shells now,
          with its progress ring on the button as before — and, as before, only
          where there is an on-device catalogue to rebuild, which on the website
          is a setting (see `RefreshLibrary` and `localEnabled`).
        */}
        <div className={`app-tools flex shrink-0 grow basis-0 items-center justify-end ${modern ? 'gap-2' : 'gap-1'}`}>
          <Link
            to={searchTo()}
            aria-label="Search"
            aria-current={onSearch ? 'page' : undefined}
            className={`${modern ? MODERN_ICON : ICON_BTN}${onSearch ? ' bg-tally/15 text-tally' : ''}`}
          >
            <Search className="h-5 w-5" />
          </Link>
          {/*
            The round shape of MODERN_ICON, and not its colour. `RefreshLibrary`
            colours itself by state — accent while rebuilding, alert when the last
            rebuild failed — and MODERN_ICON's `text-ink-2` is emitted after
            `text-alert` in the built stylesheet, so passing the whole string
            would quietly turn a failed rebuild grey. `.modern-icon` brings the
            outline, the hover and the round focus ring its neighbours have.
          */}
          <RefreshLibrary className={modern ? 'modern-icon rounded-full' : undefined} />
          {/*
            Classic keeps Settings as a strip destination elsewhere; Modern keeps
            it as a circular icon — Settings is not a centred nav tab.
          */}
          {!modern && (
            <Link to="/more" aria-label="Settings and menu" className={ICON_BTN}>
              <Settings2 className="h-5 w-5" />
            </Link>
          )}
          {modern && (
            <Link to="/more" aria-label="Settings" className={MODERN_ICON}>
              <Settings2 className="h-5 w-5" />
            </Link>
          )}
          <Link to="/adult" aria-label="Adult" className={MODERN_ICON}>
            <Heart className="h-5 w-5" />
          </Link>
          {modern ? (
            <button
              type="button"
              aria-label="Sources"
              className={MODERN_ICON}
              onClick={() => setAccountsSheet(true)}
            >
              <UserRound className="h-5 w-5" />
            </button>
          ) : (
            <Link to="/more?s=accounts" aria-label="Sources" className={ICON_BTN}>
              <UserRound className="h-5 w-5" />
            </Link>
          )}
          {!modern && <HeaderStatus />}
        </div>

        {sheets}
      </header>
      )}

      {/* The "N items stored on this device" banner used to sit here. It
          reported our own bookkeeping - how many rows were downloaded and
          when - to someone who came to watch television. */}

      {/* Keyed on the path so a route change is a movement rather than a
          repaint. 0.22s: long enough to read as intentional, short enough that
          nobody waits for it. */}
      {/*
        The page is the navigation scope, and the place focus starts.

        `data-nav-scope` means an arrow press inside the page prefers to stay in
        the page — and `spatialNav.focusFirst` looks in `main` before anywhere
        else, so a screen opening on a television lands on its first CONTENT
        item rather than on the wordmark in the corner.
      */}
      {/* Above the page and in flow, so a rebuild narrates itself wherever you
          are instead of only on the screen you started it from. It draws nothing
          at all unless the catalogue is being built or the build failed — see
          LocalCatalogueBar. */}
      <LocalCatalogueBar />
      {/* Covers everything while a NEW subscription's catalogue is built — see
          CataloguePrepare. The bar above stays for refreshes, where the app is
          perfectly usable and a full screen would be a lie. */}
      <CataloguePrepare />

      <RotatePrompt />
      <main
        key={pathname}
        data-nav-scope
        className="app-main anim-fade min-h-0 min-w-0 flex-1 overflow-hidden bg-transparent"
      >
        {children}
      </main>

      {/* The bottom inset belongs to whatever is genuinely last: the tab bar owns
          it on a phone, and on everything else it is a spacer that is 0px in a
          browser and the overscan band on a TV. */}
      <ResumeBanner />

      {/* Not a focus stop and not a dialog: BACK is already in somebody's hand,
          and a prompt that had to be dismissed would cost a press of its own. The
          one question in the gesture comes at the end of it — see ExitDialog. */}
      {exitLeft > 0 && (
        <div
          data-nav-skip
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--edge-b)+1.25rem)] z-50 flex justify-center"
        >
          <p className="rounded-[var(--r-full)] border border-rule bg-panel/95 px-4 py-2
                        text-[length:var(--t-sm)] text-ink shadow-[0_10px_30px_-12px_rgba(0,0,0,.9)]">
            Press BACK {exitLeft} more {exitLeft === 1 ? 'time' : 'times'} to leave {BRAND.name}
          </p>
        </div>
      )}

      {/*
        No legend strip. There was one here — the broadcast-style row of coloured
        button labels — and it went on the owner's word: "why am I seeing the
        buttons below, I don't need that, that's for older remotes". The
        bindings still exist and BLUE still opens the full button list; the
        strip that advertised them is gone.
      */}
      {phone ? <TabBar /> : <div aria-hidden className="shrink-0 h-[var(--edge-b)]" />}
      {/* The floating DEBUG button and its log, when debug mode is on. */}
      <DebugPanel />
    </div>
  );
}

/**
 * Phone destinations.
 *
 * Four, because five is where a 360px screen starts truncating labels. Adding
 * Home to the nav spent the slot Search used to occupy, so Search moved to the
 * header as an icon — a phone header has room for one control and no room for a
 * 20rem field. The bar sits above the home indicator rather than under it, which
 * is the whole reason `--edge-b` exists.
 */
function TabBar() {
  const inventory = useInv();
  const { pathname, search } = useLocation();
  const detailFrom = pathname.startsWith('/movie/')
    ? `/${new URLSearchParams(search).get('from') ?? ''}`
    : null;
  const items = PHONE_TABS.filter((t) => tabHasContent(t.to, inventory)).map(({ to, label, Icon }) => ({
    to,
    label: label.replace(' TV', ''),
    Icon,
  }));
  return (
    <nav
      className="relative z-40 shrink-0 border-t border-rule bg-panel pb-[var(--edge-b)]"
      aria-label="Sections"
    >
      <div className="flex h-[3.25rem] items-stretch">
        {items.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onFocus={() => preloadRoute(to)}
            onPointerEnter={() => preloadRoute(to)}
            className={({ isActive }) => {
              const here = isActive || to === detailFrom || tabOwns(to, pathname);
              return `flex flex-1 flex-col items-center justify-center gap-1 border-t-2 text-[length:var(--t-2xs)] font-mono
               tracking-wide transition-colors ${
                 here
                   ? 'border-tally bg-tally/8 text-tally'
                   : 'border-transparent text-ink-3 active:bg-panel-2'
               }`;
            }}
          >
            <Icon className="h-4.5 w-4.5" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
