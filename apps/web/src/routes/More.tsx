import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bug, ChevronRight, Cpu, Database, Download, Info, Palette, RefreshCw, Scale, SlidersHorizontal, Star, Tv, Users, X,
} from 'lucide-react';
import { BRAND } from '../brand';
import {
  Appearance, AmbientSetting, AutoOpenSetting, CatalogueSetting, OpenSetting,
  PlaybackServers, PlaybackSupport, ResumeSetting,
} from '../components/Chrome';
import { LiveBufferSetting } from '../components/LiveBufferControls';
import { AccountsPanel } from '../components/SourcesSheet';
import { setPrefs, usePrefs, type BrowseStyle } from '../lib/prefs';
import { DEV_TAPS, checkDevPin, requestDebugPanel, setDebugEnabled, useDebugEnabled } from '../lib/debugLog';
import { useSkin } from '../lib/skin';
import { columnArrow } from '../lib/columns';
import { isTypingTarget, useKeyLayer, type Binding } from '../lib/keys';
import { useOkToType } from '../lib/okToType';
import { LEGAL_PAGES, LEGAL_TITLES, appVersion, getChangelogForVersion } from '../legal';
import { dismissVersion, forceCheckForUpdate } from '../lib/updateCheck';
import type { ReleaseInfo } from '../lib/updateCheck';
import { UpdateModal } from '../components/UpdateModal';
import { setUpdateRelease } from '../lib/updateState';

/**
 * Settings, as a screen with two halves.
 *
 * Asked for plainly: "the menu should be like sidebar on the left and right the
 * content area so see active one".
 *
 * ── what this replaces ──
 *
 * A list of rows, each of which opened something else. Three of them opened
 * drawers that slid in from the right over the list you had just come from, one
 * opened a 19rem dropdown anchored to a cog in the header, and the rest were
 * pages. Six controls, four different kinds of surface, and no way to see where
 * you were: every one of them covered the thing that told you.
 *
 * A television has one shape of settings screen, and this is it — the sections
 * down the left, the open one on the right, and the open one visibly open. Sky,
 * Netflix, every set-top box and the Android TV settings app all do this, and
 * they do it because on a D-pad the left column IS the state: you can see what
 * you are in, what else there is, and Left always takes you back to the list.
 *
 * ── how "active" is held ──
 *
 * In the URL, as `?s=<id>`, so a section is a place: the back button leaves the
 * screen rather than walking back through every section you looked at (the query
 * is REPLACED, never pushed), a link can point at one — the header cog opens
 * `?s=appearance`, and the SETTINGS key on a remote does the same — and a reload
 * comes back where you were.
 *
 * ── why the sections are these sections ──
 *
 * Each is one subject a person arrives with: who is watching, what they are
 * subscribed to, how it looks, whether the picture will work, what this device
 * keeps. `Get the app` is the one row that is not a section,
 * because it is a page that has to work for somebody who has never opened the
 * app — see routes/Get.tsx — so it reads as a way out rather than as a pane.
 */

/**
 * Every pane's frame — and it draws no heading.
 *
 * `scripts/density-probe.mjs` measured this screen at 79 words of prose in the
 * first screenful and 279px of it on a 720px television, second only to
 * /organise. 17 of those words were this frame: an `<h2>` repeating the sidebar
 * row that is lit, in tally, at the same height, and a one-sentence note under
 * it explaining what the controls below say themselves.
 *
 * A title that is already on screen is a title read twice, and the note is the
 * "there is too many text and too many information" in the report. So the pane
 * starts with its first control, and the heading stays for the one audience that
 * cannot see the lit row — `sr-only` keeps the document outline honest for a
 * screen reader and costs no pixels.
 *
 * The other words belonged to `AccountsPanel` and `CatalogueSetting`, which
 * this file only mounts — those panes carry their own density cuts.
 */
function Pane({ title, children }: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0">
      <h2 className="sr-only">{title}</h2>
      {/* The sections were written for a dropdown, so each one draws its own top
          rule. The first is the one at the very top of the pane, and a rule there
          reads as a stray line — so the group hides it and every rule that
          remains is genuinely between two sections. */}
      <div className="[&>*:first-child]:border-t-0">{children}</div>
    </div>
  );
}

/**
 * The switch for the floating DEBUG button (`components/DebugPanel.tsx`).
 *
 * On by default in the installed app while playback on real boxes is still
 * being chased; a browser has devtools and starts with it off. Persisted, so a
 * device can be left in debug mode across the restart it takes to reproduce
 * something.
 */
/**
 * The tallies beside rows and chips, off by default.
 *
 * "I said don't show numbers at all — in settings add a setting I can enable and
 * disable, by default disabled." It lives beside Resume rather than under a
 * Catalogue or Playback heading because it is a statement about how this SCREEN
 * is read, which is what Appearance means; and it is device-wide for the same
 * reason, rather than per profile.
 *
 * Why off is the right default is argued in `lib/tally`, next to the code that
 * honours it. Short version: on a television a second column of grey digits down
 * a rail competes with the words for the only thing that matters at three
 * metres, which is knowing what is highlighted.
 */
function CountsSetting() {
  const [prefs] = usePrefs();
  return (
    <div className="border-t border-rule p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={prefs.showCounts}
          onChange={(e) => setPrefs({ showCounts: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-tally"
        />
        <span className="min-w-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
          Show counts
          <span className="mt-1 block normal-case tracking-normal text-ink-3">
            How many titles are behind each country, package and genre. Useful
            while curating a library; noise while watching one.
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * Countries and packages as a tree, or every category in one list.
 *
 * Asked for as "i want you to add a seeetings where if they wanna see it as
 * groups or if they wanna see it as list all of it", with photographs of a
 * competitor whose channel sidebar has no country level at all — a search field,
 * then ALL / FAVOURITES, then `VM | SPORTS 73`, `UK | FREE TO AIR 111` straight
 * down the rail with their counts.
 *
 * Two buttons rather than a checkbox, for the same reason `OpenSetting` gives:
 * neither option is the negative of the other and both need naming. Two buttons
 * rather than a `<select>` because a select on Android TV opens a system list
 * that swallows the D-pad.
 *
 * It sits under Appearance beside Show counts and Pressing OK, because it is the
 * same kind of statement they are — how this screen is READ, not who is
 * watching — which is also why it is device-wide rather than per profile.
 */
function BrowseSetting() {
  const [prefs] = usePrefs();
  const choices: { id: BrowseStyle; label: string; hint: string }[] = [
    /* The default first, so the list reads in the order somebody meets it —
       and the default is the countries again ("instead countries its showing
       categories"). */
    { id: 'groups', label: 'Countries', hint: 'countries, opening to their packages' },
    { id: 'list', label: 'One list', hint: 'every category, named as your provider names it' },
  ];
  return (
    <div className="border-t border-rule p-3">
      <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
        The sidebar on Live, Movies and Series
      </span>
      <div className="mt-2 flex gap-1.5">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={prefs.browseStyle === c.id}
            onClick={() => setPrefs({ browseStyle: c.id })}
            className={`tap flex-1 border px-2 py-1.5 text-left transition-colors ${
              prefs.browseStyle === c.id
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
        Nothing is hidden either way. One list is quicker when you know the
        package and not the country.
      </p>
    </div>
  );
}

function DebugSetting() {
  const on = useDebugEnabled();
  /* Taps on the build line, the way Android reveals its developer options. Below
     the threshold nothing shows, so an ordinary viewer never meets any of this. */
  const [taps, setTaps] = useState(0);
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const revealed = taps >= DEV_TAPS;

  const version = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';
  const build = (import.meta.env?.VITE_APP_BUILD as string | undefined) ?? '';
  const stamp = build === '' ? 'development build' : `build ${build}`;
  /* Focus parks, OK types — one rule for every field, see `lib/okToType.ts`. */
  const ok = useOkToType({ onKeyDown: (e) => { if (e.key === 'Enter') submit(); } });

  const submit = () => {
    if (checkDevPin(pin)) {
      setDebugEnabled(true);
      setPin('');
      setWrong(false);
    } else {
      setWrong(true);
    }
  };

  return (
    <div className="mt-4 border-t border-rule pt-3">
      {/* The secret door: the build line. Tap it DEV_TAPS times to reveal the PIN
          box. On a remote this is the SELECT button pressed a few times; the
          `tap` class makes it a focus stop. */}
      <button
        type="button"
        onClick={() => { if (!on) setTaps((n) => n + 1); }}
        className="tap font-mono text-[length:var(--t-2xs)] text-ink-3"
        aria-label="Build"
      >
        {stamp}
        {!on && taps > 0 && taps < DEV_TAPS && (
          <span className="ml-2 text-ink-3">· {DEV_TAPS - taps} more</span>
        )}
      </button>

      {on ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="pill inline-flex items-center gap-1.5 border border-tally bg-tally/15 px-2.5 py-1
                           font-mono text-[length:var(--t-2xs)] text-tally">
            <Bug className="h-3.5 w-3.5" /> DIAGNOSTICS ON
          </span>
          {/* The sentence that was here — "The floating DEBUG button shows what
              the player tried and can send the log to support" — is 15 words
              describing a button that is on screen while it is true. */}
          {/* Reachable, which the floating button is not.
              It sits in the bottom-right corner over everything, and a corner is
              where D-pad geometry runs out: nothing shares its row or its column,
              so no arrow from the middle of a page points at it. "i cannot select
              debug mode bcs of it". Diagnostics are switched on here, so opening
              the log belongs here too. */}
          <button
            type="button"
            onClick={() => requestDebugPanel()}
            className="tap border border-tally bg-tally/15 px-2.5 py-1 font-mono
                       text-[length:var(--t-2xs)] text-tally hover:bg-tally/25"
          >
            OPEN LOG
          </button>
          <button
            type="button"
            onClick={() => setDebugEnabled(false)}
            className="tap border border-rule px-2.5 py-1 font-mono text-[length:var(--t-2xs)]
                       text-ink-2 hover:border-tally hover:text-tally"
          >
            TURN OFF
          </button>
        </div>
      ) : revealed ? (
        <div className="mt-3">
          {/* The instruction is the placeholder and the button beside it: a field
              marked SUPPORT PIN next to ENABLE has said the whole sentence. */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={pin}
              onChange={(e) => { setPin(e.target.value); setWrong(false); }}
              inputMode="numeric"
              autoComplete="off"
              aria-label="Support PIN"
              {...ok.props}
              placeholder="SUPPORT PIN"
              className="w-40 border border-rule bg-ground px-2 py-1.5 text-center font-mono
                         text-[length:var(--t-sm)] tracking-[0.15em] text-ink focus-visible:border-focus"
            />
            <button
              type="button"
              onClick={submit}
              className="tap border border-tally bg-tally/15 px-2.5 py-1.5 font-mono
                         text-[length:var(--t-2xs)] text-tally hover:bg-tally/25"
            >
              ENABLE
            </button>
            {wrong && <span className="font-mono text-[length:var(--t-2xs)] text-alert">Wrong PIN.</span>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings, About and legal: the texts a store and a viewer both expect to find.
 *
 * Each row opens a screen of its own (`routes/Legal.tsx`) rather than a sheet, so
 * it works the same with a remote. The texts are bundled, so none of this needs a
 * network.
 */
function LegalPane() {
  const { version, build } = appVersion();
  return (
    <Pane title="About & legal">
      <div className="[&>*]:border-t [&>*]:border-rule">
        {LEGAL_PAGES.map((id) => (
          <Link key={id} to={`/legal/${id}`} className="pick tap gap-3 px-3 py-2.5 tv:px-5 tv:py-3.5">
            <span className="pick-title min-w-0 flex-1 text-[length:var(--t-md)] tv:text-[length:var(--t-lg)]">
              {LEGAL_TITLES[id]}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-3" />
          </Link>
        ))}
        <div className="px-3 py-2.5 font-mono text-[length:var(--t-xs)] text-ink-2 tv:px-5">
          Version {version === '' ? 'development build' : version}
          {build === '' ? '' : ` (${build})`}
        </div>
      </div>
    </Pane>
  );
}

export function More() {
  const [params, setParams] = useSearchParams();
  const [prefs] = usePrefs();
  const skin = useSkin();

  const hidden = prefs.hidePaths.length + prefs.hideCats.length;

  /*
   * Update check — triggered manually from the About section.
   *
   * Not automatic: the user presses "Check for updates" and, if a newer release
   * exists, the modal appears. The banner shows inline when an update is found.
   */
  const [aboutChecking, setAboutChecking] = useState(false);
  const checkAboutUpdate = async () => {
    setAboutChecking(true);
    // Force check ignores dismiss state — user explicitly requested this
    const r = await forceCheckForUpdate();
    setAboutChecking(false);
    if (r !== null) {
      // Publish to shared store so the banner shows, and keep local copy for the modal
      setUpdateRelease(r);
      setAboutRelease(r);
    }
  };
  const [aboutRelease, setAboutRelease] = useState<ReleaseInfo | null>(null);
  const dismissAboutUpdate = () => {
    if (aboutRelease !== null) dismissVersion(aboutRelease.version);
    setAboutRelease(null);
  };

  // "What's new" modal state
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  const version = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';
  const build = (import.meta.env?.VITE_APP_BUILD as string | undefined) ?? '';
  const packaged = (import.meta.env?.VITE_PLATFORM as string | undefined) === 'capacitor';
  /* Which engine is DRAWING this, which an installed build cannot be assumed to
     know: a Capacitor app carries its own copy of the interface and is rendered
     by the system WebView, which on a television is often years behind. */
  const engine = typeof navigator === 'undefined'
    ? null
    : (/Chrome\/(\d+)/.exec(navigator.userAgent) ?? [])[1] ?? null;

  interface SectionDef {
    id: string;
    label: string;
    hint: string;
    Icon: typeof Users;
    pane: () => React.ReactNode;
  }

  const sections: SectionDef[] = [
    /*
     * Profiles were the first section here and are gone entirely.
     *
     * "replace the whole current profile with single profile and that area" —
     * so there is one set of choices, it belongs to the device, and the screen
     * where it is made is `/organise`: countries, packages, channels, and what
     * is hidden. It is a SCREEN rather than a section because it is worked in
     * for minutes at a time, and a two-column editor inside a two-column
     * settings page is four columns on a television.
     *
     * It is the first row in the sidebar below, drawn as a way out rather than
     * as a pane, next to the other one.
     */
    {
      id: 'accounts',
      label: 'Sources',
      hint: 'servers and playlists on this device',
      Icon: Users,
      pane: () => (
        <Pane title="Sources">
          <AccountsPanel />
          <CatalogueSetting />
        </Pane>
      ),
    },
    {
      id: 'appearance',
      label: 'Appearance',
      hint: `${skin.theme} · ${skin.resolved} · ${skin.ui} corners`,
      Icon: Palette,
      pane: () => (
        <Pane title="Appearance">
          <Appearance />
          <CountsSetting />
          <BrowseSetting />
          <OpenSetting />
        <AutoOpenSetting />
        <AmbientSetting />
          <ResumeSetting />
        </Pane>
      ),
    },
    {
      id: 'playback',
      label: 'Playback',
      hint: 'decoder report · live buffer',
      Icon: Cpu,
      pane: () => (
        <Pane title="Playback">
          <LiveBufferSetting />
          <PlaybackSupport />
          <PlaybackServers />
        </Pane>
      ),
    },
    /*
      "This device" is gone, and the question that removed it was the right one:
      "why do we need that, bcs this for sure goes in the device".

      It held three things. A switch for keeping the catalogue on this device,
      which is no longer a choice — the app reads its own catalogue and there is
      no server-side copy to fall back to, so the switch chose between working and
      not working. A panel explaining that settings are backed up to our server,
      which they are not any more. And the hidden-packages list, which is not
      about this device at all: it is a property of a PROFILE, and it has moved to
      the profile section where the rest of that profile's filters already live.

      What was worth keeping — how much is here, and a way to fetch it again —
      is one paragraph, and it sits under Sources beside the source it
      describes.
    */
    {
      id: 'legal',
      label: 'About & legal',
      hint: 'terms · privacy · licences',
      Icon: Scale,
      pane: () => <LegalPane />,
    },
    {
      id: 'about',
      label: 'About',
      hint: version === '' ? 'development build' : `v${version}`,
      Icon: Tv,
      pane: () => (
        <Pane title="About">
          <dl className="space-y-2 font-mono text-[length:var(--t-xs)]">
            {[
              ['App', BRAND.name],
              ['Version', version === '' ? 'development build' : `v${version}`],
              ['Running as', packaged ? 'installed app' : 'this browser'],
              ...(engine === null ? [] : [['Web engine', `Chromium ${engine}`]]),
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-rule pb-1.5">
                <dt className="text-ink-3">{k}</dt>
                <dd className="text-right text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
          {/* TODO: Update banner hidden — redirects to GitHub on TV devices. */}
          {/* What's new in this version */}
          {version && (
            <div className="mt-3 border-t border-rule pt-3">
              <button
                type="button"
                onClick={() => setWhatsNewOpen(true)}
                className="card-hover tap flex w-full items-center justify-between gap-3 px-1 py-2"
              >
                <div className="flex items-center gap-3">
                  <Info className="h-4 w-4 shrink-0 text-ink-3" />
                  <span className="font-mono text-[length:var(--t-xs)] text-ink-2">
                    What's new in v{version}
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-3" />
              </button>
            </div>
          )}
          {/* TODO: Check for updates button hidden — update system redirects to GitHub. */}
          <DebugSetting />
        </Pane>
      ),
    },
  ];

  /* An unknown or absent `?s=` falls back to the first section rather than to an
     empty right-hand side: a settings screen with nothing open looks broken. */
  const wanted = params.get('s');
  const current = sections.find((x) => x.id === wanted) ?? sections[0]!;

  /* Put the real answer in the URL when it was missing or stale, so what is on
     screen and what the address says never disagree. Replaced, so this does not
     become a history entry of its own. */
  useEffect(() => {
    if (wanted !== current.id) {
      setParams({ s: current.id }, { replace: true });
    }
  }, [wanted, current.id, setParams]);

  const navEl = useRef<HTMLElement | null>(null);
  const paneEl = useRef<HTMLDivElement | null>(null);
  const openEl = useRef<HTMLButtonElement | null>(null);

  /*
   * The arrows, on a screen made of two columns.
   *
   * Left to itself the navigation layer gets both halves of this wrong, and for
   * one reason in each direction:
   *
   *   RIGHT does nothing. A sideways move must stay in its row — without that
   *   rule Right at the end of a channel row lands on whatever is diagonally
   *   beyond it — and a pane's first control is almost never level with the row
   *   that opened it. Playback's is a re-check button five hundred pixels lower.
   *
   *   DOWN leaves the column. `move` escalates outwards when a container has
   *   nothing below, which is what carries focus from the end of one rail to the
   *   next; here it walks out of the pane and into the middle of the section
   *   list. That is the "it suddenly goes from one menu to another, there is no
   *   ordering properly" report, on one screen.
   *
   * So this screen owns its arrows. Each one is answered inside the column that
   * has focus, and only the two moves that JOIN the columns cross between them:
   * Right enters the pane, Left comes back to the open section. Up is the single
   * deliberate exception — from the top of either column it is allowed to
   * escalate, because that is how the header above is reached, and a dead key at
   * the top of a settings screen is worse than a long way round.
   *
   * A text field keeps its own arrows: the caret and the word before it matter
   * more than the columns, and Up/Down still leave the field.
   */
  const bindings = useMemo((): Binding[] => [], []);
  useKeyLayer(bindings, (intent) => {
    if (intent !== 'up' && intent !== 'down' && intent !== 'left' && intent !== 'right') return false;
    /* A text field keeps its own left and right: the caret and the word being
       typed matter more than the columns. Up and Down still leave the field —
       see the exception in `lib/keys.ts`. */
    if (isTypingTarget(document.activeElement) && (intent === 'left' || intent === 'right')) return false;
    return columnArrow(intent, [
      { el: navEl.current, entry: openEl.current },
      { el: paneEl.current },
    ], { entryFromAbove: true });
  });

  return (
    <>
    <div className="flex h-full min-h-0">
      {/*
        The sidebar.

        One navigation group with memory, so coming back up from the pane lands
        on the section you left rather than on whatever is geometrically nearest.
        It scrolls on its own — with eight sections it will not need to, and with
        a ninth it must.
      */}
      <nav
        ref={navEl}
        /* A section as well as a group: the group gives it memory, and the
           section is what stops UP out of its first row crossing into the pane
           beside it instead of climbing to the header. */
        data-nav-scope
        data-nav-group="settings"
        data-nav-memory
        /* Bounded height + inner scroll: `mt-auto` on the Organise door used to
           grow the flex column past the viewport so overflow-y-auto never fired
           and the last sections were unreachable. */
        className="no-round flex h-full min-h-0 w-[13rem] shrink-0 flex-col overflow-hidden border-r border-rule
                   bg-panel/40 tv:w-[20rem]"
      >
        <p className="mb-2 shrink-0 px-4 pt-4 font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3 tv:px-6 tv:pt-6">
          Settings
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {sections.map(({ id, label, hint, Icon }) => {
          const on = id === current.id;
          return (
            <button
              key={id}
              /* The open section is where Left from the pane comes back to. */
              ref={on ? openEl : undefined}
              type="button"
              /* Replaced rather than pushed: walking the sections is looking
                 around one screen, not a journey, and BACK should leave. */
              onClick={() => setParams({ s: id }, { replace: true })}
              aria-current={on ? 'page' : undefined}
              /*
                Where this screen starts, declared rather than inferred.

                `focusFirst` picks by reading order (topmost, then leftmost). After
                densify the Accounts pane opens on its first control with no
                heading above it, so Username sits above the section list and
                wins — then `columnArrow` keeps ArrowDown inside the pane and the
                remote never meets the sidebar. Same declaration DetailHero uses
                for PLAY.
              */
              {...(on ? { 'data-nav-first': true } : {})}
              className={`pick tap gap-3 px-4 py-2.5 tv:gap-4 tv:px-6 tv:py-3.5 ${on ? 'is-on' : ''}`}
            >
              <Icon className={`h-4 w-4 shrink-0 tv:h-5 tv:w-5 ${on ? 'text-tally' : 'text-ink-3'}`} />
              <span className="min-w-0 flex-1">
                <span className="pick-title block text-[length:var(--t-md)] tv:text-[length:var(--t-lg)]">{label}</span>
                <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
                  {hint}
                </span>
              </span>
            </button>
          );
        })}
        </div>

        {/*
          The rows that LEAVE this screen, kept apart from the sections by a
          rule. Shrink-0 so they stay reachable while the list above scrolls.
        */}
        <div className="shrink-0 border-t border-rule py-2">
          {/*
            One press from Settings to the bouquet, rather than Settings →
            Organise → find My channels among its sections. "reachable from
            More" was asked for by name — Organise's own sidebar has the full
            stop (`/organise?s=mychannels`), this is the shortcut to it.
          */}
          <Link
            to="/organise?s=mychannels"
            className="pick tap gap-3 px-4 py-2.5 tv:gap-4 tv:px-6 tv:py-3.5"
          >
            <Star className="h-4 w-4 shrink-0 text-ink-3 tv:h-5 tv:w-5" />
            <span className="min-w-0 flex-1">
              <span className="block text-[length:var(--t-md)] tv:text-[length:var(--t-lg)]">My channels</span>
              <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
                {prefs.favs.live.length === 0
                  ? 'order your favourite channels'
                  : `${prefs.favs.live.length} starred, in order`}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-3" />
          </Link>
          <Link
            to="/organise"
            className="pick tap gap-3 px-4 py-2.5 tv:gap-4 tv:px-6 tv:py-3.5"
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-ink-3 tv:h-5 tv:w-5" />
            <span className="min-w-0 flex-1">
              <span className="block text-[length:var(--t-md)] tv:text-[length:var(--t-lg)]">Organise</span>
              <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
                countries, packages, channels
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-3" />
          </Link>
        </div>
      </nav>

      {/*
        The content area.

        Keyed on the section so switching is a movement rather than a repaint —
        the same 0.22s fade a route change gets, for the same reason. Its own
        scroll container, so the sidebar never moves while a long pane scrolls.
      */}
      <div
        key={current.id}
        ref={paneEl}
        data-nav-scope
        className="anim-fade min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 tv:px-10 tv:py-7"
      >
        {/* Comfortable to read across a room and no wider: a settings pane
            stretched across a 1920 screen is a line of text a metre long. */}
        <div className="mx-auto w-full max-w-2xl tv:max-w-3xl">{current.pane()}</div>
      </div>
    </div>
    {aboutRelease !== null && (
      <UpdateModal release={aboutRelease} onDismiss={dismissAboutUpdate} />
    )}
    {/* "What's new" changelog modal */}
    {whatsNewOpen && (
      <div data-nav-contain className="fixed inset-0 z-[71] flex items-center justify-center bg-black/60 anim-fade"
        onClick={() => setWhatsNewOpen(false)}>
        <div className="relative mx-4 w-full max-w-[28rem] rounded-xl border border-rule bg-panel shadow-2xl
          tv:max-w-[36rem]" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-rule px-4 py-3 tv:px-6">
            <h3 className="text-[length:var(--t-md)] font-semibold text-ink tv:text-[length:var(--t-lg)]">
              What's new in v{version}
            </h3>
            <button type="button" onClick={() => setWhatsNewOpen(false)}
              className="text-ink-3 hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto px-4 py-4 tv:px-6 tv:py-5">
            {getChangelogForVersion(version) ? (
              <div className="space-y-3 font-mono text-[length:var(--t-xs)] text-ink-2 tv:text-[length:var(--t-sm)]">
                {getChangelogForVersion(version)!.split('\n').map((line, i) => {
                  // Skip empty lines
                  if (line.trim() === '') return <div key={i} className="h-2" />;
                  // Section headers
                  if (line.startsWith('###')) {
                    return <h4 key={i} className="mt-3 text-[length:var(--t-sm)] font-semibold text-ink tv:text-[length:var(--t-md)]">
                      {line.replace(/^#+\s*/, '')}
                    </h4>;
                  }
                  // Bullet items
                  if (line.startsWith('- ')) {
                    return <p key={i} className="pl-2">{line.replace(/^- /, '• ')}</p>;
                  }
                  return <p key={i}>{line}</p>;
                })}
              </div>
            ) : (
              <p className="font-mono text-[length:var(--t-xs)] text-ink-3 tv:text-[length:var(--t-sm)]">
                No changelog available for this version.
              </p>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
