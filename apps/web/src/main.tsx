/* FIRST, and it has to stay first: ES imports are evaluated in order and all
   of them before any statement below. `crypto.randomUUID` does not exist on a
   plain-HTTP page served from an IP — which is how this app is reached — and a
   dependency that calls it throws on its first line. See lib/randomUuid.ts. */
import './lib/installShims';
import { StrictMode, Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, HashRouter, Navigate, Route, Routes,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { Chrome } from './components/Chrome';
import { Discover, Home } from './routes/Home';
import { channelsOnly } from './lib/sections';
import { getSkin } from './lib/skin.ts';
import { hydrateKV } from './lib/kv';
import { hydrateProviders } from './lib/providers';
import { reloadPrefs } from './lib/prefs';
import { reloadSkin } from './lib/skin';
import { reloadScreenPref, setHostTv } from './lib/formFactor';
import { deviceInfo } from './lib/deviceInfo';
import { primeCapabilities } from './lib/capabilityStore';
import { installKeys } from './lib/keys';
import { installTizenKeys } from './lib/tizenKeys';
import { installWebosKeys } from './lib/webosKeys';
import { installDebugCapture } from './lib/debugLog';
import { installSlowPress } from './lib/slowPress';
import { installSoftKeyboard } from './lib/softKeyboard';
import { resumeRoute } from './lib/resume';
import { initLocal, localEnabled } from './lib/localCatalogue';
import { forgetPagedLists, prefetchAllTabs } from './lib/usePagedItems.ts';
import { hydrateQueries, loadSnapshot, persistQueries, registerWorker } from './lib/warm';
import { closeDoorForExistingInstall, doorOpen, subscribeDoor } from './lib/firstRun';
import { localStatus, refreshLiveList, subscribeLocal } from './lib/localCatalogue';
import { bulkGuideStatus, checkBulkGuide, ensureBulkGuide, subscribeBulkGuide } from './lib/bulkGuide';
import { player } from './lib/playerCore';
import { loadLiveNames, refreshLiveNames, subscribeLiveNames } from './lib/liveNames';
import { syncLogoCache } from './lib/logoCache';
import { ensureTopicIndex } from './lib/topicIndex';
import { reloadSession, subscribeSession } from './lib/session';
import { startAppConfig } from './lib/appConfig';
import { UpdateGate } from './components/UpdateGate';
import { Welcome } from './components/Welcome';
import { AddAccountDialog } from './components/AddAccountDialog';
import { ExpiredDialog } from './components/ExpiredDialog';
import { EmptySource } from './components/EmptySource';
import { ExitDialog } from './components/ExitDialog';
import { addAccountOpen, closeAddAccount, subscribeAddAccount } from './lib/addAccount';
import { onExitAsk } from './lib/nativeBack';
import { isNativeShell } from './lib/direct';
import { startAccountChecks } from './lib/accountCheck';
import { checkForUpdate } from './lib/updateCheck';
import { setUpdateRelease, subscribeUpdateRelease } from './lib/updateState';

/*
 * Routes load after first paint.
 *
 * They used to be static imports in this file — leftover from when the catalogue
 * lived on the server and every page needed to be in the first JS response.
 * Catalogue and streams now arrive after boot on the device, so shipping Live,
 * Guide, Organise, Admin and the player UI with Home was pure weight:
 * ~220 KB gzip of entry that parsed VideoPlayer before anyone pressed play.
 *
 * Home stays eager (common landing). Everything else is a chunk, including the
 * player surfaces — VideoPlayer / playerCore follow those routes, not Chrome.
 */
const More = lazy(() => import('./routes/More.tsx').then((m) => ({ default: m.More })));
const Organise = lazy(() => import('./routes/Organise.tsx').then((m) => ({ default: m.Organise })));
const Guide = lazy(() => import('./routes/Guide').then((m) => ({ default: m.Guide })));
const Catchup = lazy(() => import('./routes/Catchup').then((m) => ({ default: m.Catchup })));
const Watching = lazy(() => import('./routes/Watching'));
const Live = lazy(() => import('./routes/Live').then((m) => ({ default: m.Live })));
const Sports = lazy(() => import('./routes/Sports').then((m) => ({ default: m.Sports })));
const Adult = lazy(() => import('./routes/Adult').then((m) => ({ default: m.Adult })));
const SeriesDetail = lazy(() => import('./routes/SeriesDetail').then((m) => ({ default: m.SeriesDetail })));
const MovieDetail = lazy(() => import('./routes/MovieDetail').then((m) => ({ default: m.MovieDetail })));
const Search = lazy(() => import('./routes/Search').then((m) => ({ default: m.Search })));
const Legal = lazy(() => import('./routes/Legal').then((m) => ({ default: m.Legal })));
const Admin = lazy(() => import('./routes/Admin').then((m) => ({ default: m.Admin })));
const MoviesPage = lazy(() => import('./routes/Grid').then((m) => ({
  default: function MoviesPage() { return <m.Grid section="movies" />; },
})));
const SeriesPage = lazy(() => import('./routes/Grid').then((m) => ({
  default: function SeriesPage() { return <m.Grid section="series" />; },
})));

/** Empty main while a route chunk arrives — Chrome (header/tabs) stays painted. */
function RouteFallback() {
  return <div className="anim-fade min-h-[40vh] flex-1" aria-busy="true" />;
}
/**
 * Cache policy for the whole app.
 *
 * `gcTime` used to be a day so walking Live → Movies → Live did not refetch.
 * With the on-device catalogue, those answers are local and cheap again — keeping
 * every Item[] page in the react-query heap for 24h duplicated the columnar store
 * in a fatter form. Five minutes covers a tab switch without pinning megabytes.
 *
 * `staleTime` stays per-query, because the right answer genuinely differs: the
 * guide goes stale in a minute and a category list does not. What is set here is
 * only the floor for queries that never said.
 */
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      /* Answer from cache first and refresh behind it. The default,
         `refetchOnMount: true` with fresh data, is already a no-op; this makes it
         explicit that a stale answer is still shown rather than replaced by a
         spinner. */
      refetchOnMount: true,
    },
  },
});

/**
 * Path routing on the web, hash routing in a file:// shell.
 *
 * `BrowserRouter` needs a server that answers every path with index.html — which
 * is exactly what the Fastify process does, and why deep links like /movie/123
 * work today. An Electron build packaged as `file://` has no server and no such
 * fallback: the first navigation away from index.html loads nothing and the window
 * goes blank, which is the single most-reported Electron + React Router failure.
 * `HashRouter` keeps the whole route inside the fragment, where no file lookup can
 * happen.
 *
 * Detected rather than configured, so the same bundle behaves correctly in both,
 * with an env override for a shell that serves over a custom protocol.
 */
const fileShell =
  typeof location !== 'undefined' &&
  (location.protocol === 'file:' || import.meta.env?.VITE_ROUTER === 'hash');
const Router = fileShell ? HashRouter : BrowserRouter;

/**
 * Which page the app opens on.
 *
 * Read once, at the redirect, rather than subscribed: changing the start page in
 * settings should decide where the app opens NEXT time, not yank the current
 * navigation out from under whoever changed it.
 */
function startRoute(): string {
  /*
   * A library of nothing but channels opens on the channels.
   *
   * Asked for as "for the free version directly open the live TV area where they
   * can navigate through channels". It is not a free-tier test though: the same
   * question is "does this library have anything but live TV", so a subscription
   * that sells only channels lands here too, and a free device that later
   * downloads films stops landing here without anything being reconfigured.
   *
   * It preempts `/home`, which already redirects to Live in this case — but only
   * after its own inventory request resolves, so the app painted the showcase and
   * jumped a beat later. `channelsOnly` reads the REMEMBERED inventory, which is
   * synchronous and therefore available before the first navigation.
   *
   * The classic launcher and the profile chooser used to be selectable landings.
   * Both are gone: the header carries the nav, so a second screen of the same
   * destinations was a detour, and "who is watching" is a thing you open from
   * the avatar rather than a wall the app puts in front of you.
   */
  return channelsOnly() ? '/live' : '/home';
}

/**
 * Where the app opens: whatever was playing, or the start page.
 *
 * `resumeRoute()` answers once per launch and null afterwards, so a later
 * navigation to `/` goes to the start page instead of dragging someone back into
 * the stream they just left. Every playing surface already restores itself from
 * its own URL, so this really is the whole feature — see `lib/resume.ts`.
 */
function Opening() {
  /* First visit lands on Home so the welcome overlay sits over the real shell. */
  const [to] = useState(() => (doorOpen() ? '/home' : (resumeRoute() ?? startRoute())));
  return <Navigate to={to} replace />;
}

/**
 * Storage is prepared before the first render, not during it.
 *
 * `prefs.ts` builds its store at import time and `playerCore` reads its settings
 * from getters, both synchronously — which is right, because these are microsecond
 * reads and a loading state for them would be absurd. The native store is async
 * though, so it has to be mirrored into memory first. Rendering before that
 * finishes would show defaults and then overwrite real preferences with them.
 *
 * A no-op on the web, where `localStorage` is already synchronous.
 *
 * NOT a top-level await, which is what this used to be, and which produced a
 * permanently blank app in the wrapper build — a black screen with no error in
 * the console and no failed request. Top-level await suspends the ENTRY module
 * mid-evaluation; `hydrateKV()` then dynamically imports the preferences plugin,
 * whose chunk imports back from the entry chunk, and that import can never
 * resolve because the entry is still suspended waiting for it. A textbook
 * deadlock, invisible on the web build because the native branch returns before
 * the import. Keeping the await inside a function lets the entry module finish
 * evaluating, so the cycle resolves.
 */
/**
 * A browser tab that was open across a deploy must not sit there blank.
 *
 * The bundle is content-hashed and split. Hover-prefetch and route clicks both
 * dynamic-import chunks; after a deploy those names 404. The page reloads once to
 * pick up the current files — and not again within a minute, so a chunk that is
 * genuinely missing cannot turn into a reload loop. (An installed app carries its
 * files with it and never gets here.)
 */
function guardStaleChunks(): void {
  if (typeof window === 'undefined') return;
  const recover = (): void => {
    try {
      const last = Number(sessionStorage.getItem('stale-chunk-reload') ?? 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem('stale-chunk-reload', String(Date.now()));
    } catch { return; }
    location.reload();
  };
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();
    recover();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e.reason as { message?: string } | undefined)?.message ?? e.reason ?? '');
    if (/dynamically imported module|Importing a module script failed|Loading chunk/i.test(msg)) {
      recover();
    }
  });
}

async function boot(): Promise<void> {
  guardStaleChunks();
  await hydrateKV();
  /* Saved passwords and links are sealed at rest; open them before anything reads a provider. */
  await hydrateProviders();
  /*
   * Re-read the two stores, because the gate above was not actually gating
   * anything. Static imports are evaluated before this module's body runs, so
   * `prefs.ts` and `skin.ts` had already read their keys — from localStorage —
   * by the time `hydrateKV()` was called. Reading again here is what makes the
   * durable store the one the first render is built from.
   */
  reloadPrefs();
  reloadSkin();
  reloadScreenPref();
  /*
   * In the APK, Android says whether this is a television (LEANBACK) — the one
   * answer that cannot be fooled by a box reporting a touch screen. Asked before
   * the first render so a phone never paints the television chrome first, and
   * raced against a short timer so an APK that is slow to answer (or too old to
   * know the method) boots exactly as before: the television layout.
   */
  await (async () => {
    try {
      const dev = await deviceInfo();
      if (dev?.hardware === undefined) return;
      const hw = await Promise.race([
        dev.hardware(),
        new Promise<null>((r) => { window.setTimeout(() => r(null), 400); }),
      ]);
      if (hw !== null && typeof hw.tv === 'boolean') setHostTv(hw.tv);
    } catch { /* the television layout, as always */ }
  })();
  reloadSession();
  /*
   * In local mode the catalogue is loaded before the first paint if it is already
   * on the device, and downloaded in the background if it is not.
   *
   * Awaited only for the read from IndexedDB, which is 38ms measured — a
   * catalogue that is already here should be there for the first render, and a
   * catalogue that has to be downloaded must not hold up the app while it is.
   * `initLocal` returns as soon as it knows which of those it is doing.
   */
  /*
   * Nothing is downloaded until the viewer adds a source. What the boot does is
   * decide whether the door should be open at all, durably, before anything can
   * falsify the question — see `closeDoorForExistingInstall`.
   */
  closeDoorForExistingInstall();
  if (localEnabled()) await initLocal();
  /*
   * Last session's answers, before the first render.
   *
   * One IndexedDB read (measured in single-digit milliseconds) against a home
   * page that would otherwise mount every rail in its loading state. Everything
   * planted keeps its real age, so it is revalidated immediately — this changes
   * what the first frame looks like, not what the data is. See lib/warm.ts.
   */
  hydrateQueries(qc, await loadSnapshot());
  /*
   * One keydown listener for the whole app, installed before the first render.
   *
   * There were nine of them in eight files and none of them owned the arrow keys,
   * which is why a D-pad could not move focus anywhere. See `lib/keys.ts`.
   */
  installKeys();
  /* Inert everywhere but a real Samsung Tizen device — see lib/tizenKeys.ts for
     why the colour and media buttons need this and the arrows do not. */
  installTizenKeys();
  /* And LG's Back button, which is the one key a webOS remote sends that
     nothing else does — see lib/webosKeys.ts for why it cannot be skipped. */
  installWebosKeys();
  /* The debug log's hooks — console, uncaught errors, failed fetches — before
     anything that could fail has run. See lib/debugLog.ts. */
  installDebugCapture();
  /* And a remote press that took seconds, with what the page was doing.
     See lib/slowPress.ts. */
  installSlowPress();
  /* And the one that keeps a text field above the soft keyboard. */
  installSoftKeyboard();
  render();
  dropSplash();
  /* Both after the first paint: installing a worker competes for the network with
     the requests it exists to eliminate, and the snapshot writer only ever runs
     on tab-hide anyway. */
  registerWorker();
  persistQueries(qc);
  /* The operator's config document: the update popup, error reporting and the
     operator's switches all read it (lib/appConfig.ts). Nothing about this
     screen or what is on it goes the other way. */
  startAppConfig();
  // After the first paint, never before it: the codec report is diagnostics.
  primeCapabilities();
  /*
   * Settings used to be backed up to `PUT /api/state`, filed under a digest of
   * the subscription, so a viewer's favourites and continue-watching followed
   * them to a second device. That is gone with the rest of the server: it is
   * neither configuration nor logging, which is what the box keeps now.
   *
   * The cost is real and worth stating rather than burying — someone with a
   * television and a phone now keeps two sets of favourites. Everything still
   * survives a reinstall on the SAME device, because `prefs.ts` writes through
   * `kv` to app-private storage on native.
   */
}

/**
 * Take the splash away, once there is something behind it.
 *
 * After the first paint of the real app, not on a timer: a splash that leaves
 * early shows a blank screen, and one that leaves late is the thing people
 * remember about a slow app. Two frames is enough for React to have committed and
 * the browser to have painted it.
 */
function dropSplash(): void {
  const el = document.getElementById('splash');
  if (el === null) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add('is-gone');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // A transition that never fires (reduced motion, a background tab) must not
    // leave the splash sitting on top of the app for ever.
    window.setTimeout(() => el.remove(), 800);
  }));
}

/** Something is on screen or starting — no background download may join it. */
function playing(): boolean {
  return player.state.phase !== 'idle' && player.state.phase !== 'error';
}

function Gate({ children }: { children: React.ReactNode }) {
  /*
   * The welcome screen, which is a reversal of the decision above — and the
   * reasoning above is the reason it works the way it does.
   *
   * "when people first time open the app I'll make a really great onboarding I
   * mean they will have two options a free version ... or if they have a
   * subscription or something that they can log in." The old wizard asked three
   * questions that all had defensible defaults; this asks the one thing the app
   * genuinely cannot guess — whether there is a subscription behind this
   * television — because a viewer who has paid for a line has no way to discover
   * that from a channel list.
   *
   * It is deliberately NOT in the boot path: nothing waits for an answer; see
   * components/Welcome.tsx.
   *
   * Decided once, on mount, from the marker — not on every render. Reading it
   * live would hide the sheet the instant `markOnboarded` ran, taking the
   * "personalise or watch" question with it before it could be answered.
   */
  /*
   * Open until answered, and the answer is in storage.
   *
   * `doorOpen()` is durable — see `lib/firstRun.ts`. It used to be a module
   * variable set by the boot, which meant a refresh lost it and the door closed
   * for ever with nobody having chosen anything: reported as "its like an auth
   * screen, and preissted till they select, right now it just disspears", "on
   * refresh".
   *
   * Read once on mount rather than live, because the sheet has a SECOND question
   * after the answer — personalise, or start watching — and reading the marker
   * live would take that question away the instant the first one was answered.
   */
  const [welcome, setWelcome] = useState(doorOpen);

  /*
   * One way only: the door can be put BACK while the shell is on screen, never
   * taken away by this.
   *
   * The comment above is right that reading `doorOpen()` live would remove the
   * sheet the instant the first question was answered, taking the second one
   * ("personalise, or start watching") with it. Subscribing does not have that
   * problem, because the only thing that publishes is `reopenDoor`, and the only
   * thing that calls THAT is somebody removing their last subscription. So this
   * shows the sheet again and can never hide it.
   */
  useEffect(() => subscribeDoor(() => {
    setWelcome(true);
    /* And whatever else was asking for a subscription stops asking. The door is
       put back by removing the LAST one, which is reached from the accounts
       panel — the same panel the add-account dialog is opened from — so both
       can be live at the same moment. The render below already refuses to draw
       the second one; this is so it does not spring back the instant the welcome
       sheet is answered. */
    closeAddAccount();
    /* The exit question goes the same way, and for a new reason: the door can now
       reopen with nobody touching anything, when the account check below finds
       the line dead. A viewer who had just been asked "are you sure you want to
       exit" should not find a sign-in sheet under the answer, nor answer it and
       find the question still there when the door closes. */
    setExiting(false);
  }), []);

  /*
   * Is the subscription still a subscription — asked on every launch, and again
   * whenever the app comes back to the front.
   *
   * "on each visit should check if there are authentication or accounts are
   * correct if not you show the dialog again otherwise they can continue for
   * free". Here, beside the door, because the door is what a dead account ends
   * in: `lib/accountCheck.ts` removes the line and calls `reopenDoor`, and the
   * subscription above turns that into the welcome sheet. It never acts on a
   * network failure — only on the panel saying the line is expired, disabled, or
   * refusing the credentials twice. Once per mount, and the cleanup stops the
   * foreground listener and the timer with it.
   */
  useEffect(() => startAccountChecks(), []);

  /*
   * Adding a subscription, from anywhere in the app, in one dialog.
   *
   * Mounted here and nowhere else for the reason the welcome sheet is: above the
   * shell, so nothing the shell has open — least of all the accounts drawer it is
   * usually opened from — can end up in front of it. `lib/addAccount.ts` is the
   * switch; every panel that used to grow its own copy of the form now presses it.
   */
  const [adding, setAdding] = useState(addAccountOpen);
  useEffect(() => subscribeAddAccount(() => setAdding(addAccountOpen())), []);

  /*
   * "Are you sure you want to exit?" — the end of three presses of BACK.
   *
   * Mounted here for the reason the other two are: above the shell, so nothing the
   * shell has open can be drawn over the question. `lib/nativeBack.ts` counts the
   * presses and tells whoever registered; see `components/ExitDialog.tsx`.
   *
   * ── only under the wrapper, and why a browser gets no dialog at all ──
   *
   * The owner's words were "force to stop the whole app so it's out of the
   * memory". In a browser there is no app to stop. A page may not close a tab it
   * did not open — `window.close()` is refused for exactly that tab, and refused
   * without a word — so an Exit button there would be the button that silently
   * does nothing. Every substitute is a different thing wearing its name: a blank
   * page is a page that looks broken, and stopping the picture is not leaving.
   * The browser already has an honest meaning for the third press, too: with
   * nothing registered it declines, and BACK is the browser's own again.
   *
   * So the question is registered only where its answer can be carried out, and
   * never while the welcome door is open: the door cannot be dismissed, two sheets
   * on one screen is the thing AddAccountDialog was built to stop happening, and
   * on the door the third press declines the way it always has, putting the app in
   * the background.
   */
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!isNativeShell() || welcome) return undefined;
    return onExitAsk(() => setExiting(true));
  }, [welcome]);
  const cancelExit = useCallback(() => setExiting(false), []);

  /*
   * New release check — after the welcome door closes, not before.
   *
   * The banner at the top of the app handles the automatic notification.
   * Results are published to the shared updateState store so the UpdateBanner
   * in Chrome picks them up without prop drilling.
   */
  const checkUpdate = useCallback(() => {
    void checkForUpdate().then((r) => {
      if (r !== null) setUpdateRelease(r);
    });
  }, []);
  useEffect(() => {
    if (welcome) return;
    checkUpdate();
  }, [welcome, checkUpdate]);

  /*
   * Also check after the library becomes ready — a new account download or
   * a catalog rebuild means the user is about to start watching, which is
   * the right moment to show an available update.
   */
  useEffect(() => {
    let seen: string | null = `${localStatus().state}:${localStatus().builtAt ?? 'none'}`;
    return subscribeLocal((st) => {
      if (st.state !== 'ready') return;
      const gen = `${st.state}:${st.builtAt ?? 'none'}`;
      if (gen === seen) return;
      seen = gen;
      // Delay slightly so the catalog-ready invalidations paint first
      window.setTimeout(() => {
        if (!welcome) checkUpdate();
      }, 2000);
    });
  }, [welcome, checkUpdate]);

  /*
   * Periodic check — every hour, re-check for updates so a dismissed banner
   * reappears if the user is still running an old version. Only runs when
   * the app is in the foreground and nothing is playing.
   */
  useEffect(() => {
    if (welcome) return undefined;
    const timer = window.setInterval(() => {
      if (!playing()) checkUpdate();
    }, 3_600_000);
    return () => window.clearInterval(timer);
  }, [welcome, checkUpdate]);

  /*
   * When the library changes, every answer about it is stale.
   *
   * The first visit downloads its channels while the app is already open, so the
   * screens on it were painted from whatever the device had at the time —
   * nothing, or the server's catalogue. Without this they keep showing that
   * until something happens to refetch: measured as a home page still showing
   * films from a subscription seconds after the device had its own channels.
   *
   * Only on a completed build, and only when the generation actually moved, so a
   * progress publish does not invalidate the world sixty times during a download.
   */
  useEffect(() => {
    /*
     * An EMPTIED library is a change too.
     *
     * This used to return on anything but `ready`, which meant the one
     * transition it most needed to see went straight past it: switching to an
     * account this device holds nothing for clears the catalogue and publishes
     * `idle`, so nothing invalidated and every list, rail and sidebar category
     * went on rendering the previous subscription. Reported as "when i switch
     * accounts nothing happens and everything is as old shit" — and the store
     * was already correct by then, which is why a reload fixed it and pressing
     * the button never did.
     *
     * `loading` is still ignored: it fires on every chunk of a 159MB download.
     * The mark carries the state as well as the timestamp so ready→idle is a
     * move even though `builtAt` is null on both sides of a rebuild that failed
     * to find anything.
     */
    let seen: string | null = `${localStatus().state}:${localStatus().builtAt ?? 'none'}`;
    return subscribeLocal((st) => {
      if (st.state !== 'ready' && st.state !== 'idle') return;
      const gen = `${st.state}:${st.builtAt ?? 'none'}`;
      if (gen === seen) return;
      seen = gen;
      /* The paged lists are not react-query and have to be told separately. */
      forgetPagedLists();
      void qc.invalidateQueries();
      /* A FIRST TV guide follows a new account's playlist — see lib/bulkGuide.ts.
         A guide already here is never replaced from here: when it runs out the
         banner asks, so a download never shares the line with a picture. */
      if (st.state === 'ready' || st.builtAt !== null) void (playing() ? checkBulkGuide() : ensureBulkGuide());
      /* And the feeds renamed since this library was built — lib/liveNames.ts. */
      if (st.state === 'ready') void loadLiveNames();
      /* Warm the first page of every major tab so the first navigation paints
         rows instead of a skeleton. Runs after the catalogue is ready, not
         before — a prefetch against an empty store is wasted work. */
      if (st.state === 'ready') void prefetchAllTabs(qc);
    });
  }, []);

  /*
   * And on an ordinary launch, when the library was already on the device and
   * nothing above fires: a few seconds in, then hourly — to notice that the
   * guide has run out, which puts up the banner. One small read; it downloads
   * only when this account has no guide at all and nothing is playing. The
   * hourly REFRESH this used to be is gone: "instead of auto update make it so
   * there is a banner … that way it won't disturb the other connection".
   */
  useEffect(() => {
    const kick = () => {
      const st = localStatus();
      if (st.state !== 'loading' && st.builtAt !== null) void (playing() ? checkBulkGuide() : ensureBulkGuide());
    };
    const first = window.setTimeout(kick, 8_000);
    const hourly = window.setInterval(kick, 3_600_000);
    return () => { window.clearTimeout(first); window.clearInterval(hourly); };
  }, []);

  /*
   * Pre-fetch the first page of every major tab so navigation is instant.
   *
   * This runs well after the first paint (the first seconds belong to the
   * home page and the guide download). It is deliberately delayed so it does
   * not compete with the requests that actually paint the screen. When the
   * library was already ready at boot, the subscribeLocal callback above does
   * not fire, so this is the path that warms the cache.
   */
  useEffect(() => {
    const st = localStatus();
    if (st.state !== 'ready') return;
    const timer = window.setTimeout(() => {
      if (!playing()) void prefetchAllTabs(qc);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * The channel list, between the weekly checks: event and PPV feeds are renamed
   * every day and the device only re-downloaded when the categories changed —
   * see `refreshLiveList`. Tried a little after launch and then hourly; it does
   * nothing until the list is LIVE_REFRESH_MS old, and never while something is
   * playing, because the rebuild holds the page for a moment on a slow
   * television and a hitch in the middle of a film is worse than a stale name.
   */
  useEffect(() => {
    void loadLiveNames();
    const kick = () => {
      /* Names only, nothing rebuilt — but it is the whole channel list off the
         panel, several megabytes, so not while something plays: the same rule
         as the guide ("that way it won't disturb the other connection"). A
         television left on all day catches up the hour after it stops. */
      if (playing()) return;
      void refreshLiveNames(2 * 3600_000).then(() => {
        if (playing()) return;
        void refreshLiveList();
      });
    };
    const first = window.setTimeout(kick, 40_000);
    const hourly = window.setInterval(kick, 3_600_000);
    return () => { window.clearTimeout(first); window.clearInterval(hourly); };
  }, []);

  /*
   * Channel logos kept on the television — lib/logoCache.ts. Well after launch
   * (the first minutes belong to the first picture and the guide download), then
   * checked hourly; it does real work once a day at most, and nothing at all on
   * the website or on an APK without the native store.
   */
  useEffect(() => {
    const kick = () => {
      /* Hundreds of pictures — not while something plays, like the guide. */
      if (localStatus().state !== 'ready' || playing()) return;
      void syncLogoCache();
    };
    const first = window.setTimeout(kick, 90_000);
    const hourly = window.setInterval(kick, 3_600_000);
    return () => { window.clearTimeout(first); window.clearInterval(hourly); };
  }, []);

  /*
   * Renamed feeds: every list shows names, and the sports lists are filed by
   * them, so both are read again — the paged lists told separately, as above.
   */
  useEffect(() => subscribeLiveNames(() => {
    forgetPagedLists();
    void ensureTopicIndex();
    void qc.invalidateQueries();
  }), []);

  /*
   * The moment a guide lands, everything showing one reads it again.
   *
   * "on load it should auto show everywhere … it should be done without
   * reloading or reopening". Lists, the Guide and the line under the player all
   * read guide data through react-query, and a read made while the download was
   * still running answered "not yet" — so they are told, by key, rather than
   * left to their two-minute buckets.
   */
  useEffect(() => {
    let landed = bulkGuideStatus().landed;
    return subscribeBulkGuide((g) => {
      if (g.landed === landed) return;
      landed = g.landed;
      void qc.invalidateQueries({
        predicate: (q) => {
          const [a, b] = q.queryKey as unknown[];
          return a === 'epg' || a === 'epg-search-index' || a === 'sports'
            || (a === 'live' && (b === 'listGuide' || b === 'orderGuide')) || (a === 'guide' && b === 'grid');
        },
      });
    });
  }, []);

  return (
    <>
      {/* Shell stays mounted; welcome is a blocking overlay over it.
          `h-full min-h-0` is required — a bare wrapper broke the #root → Chrome
          height chain and the body no longer filled the viewport. */}
      <div
        aria-hidden={welcome || adding || exiting || undefined}
        className={`flex h-full min-h-0 flex-col ${welcome || adding || exiting ? 'pointer-events-none select-none' : ''}`}
      >
        {children}
      </div>
      {welcome && <Welcome onDone={() => setWelcome(false)} />}
      {/*
        Never both. The welcome sheet wins, always: it is the door, it cannot be
        dismissed, and the whole point of moving the add-a-subscription form into
        a dialog of its own was that the television had ended up showing two of
        them at once. `closeAddAccount` above is what stops this one reappearing
        underneath once the door is answered.
      */}
      {adding && !welcome && <AddAccountDialog onClose={closeAddAccount} />}
      {/* No source saved: one screen, one thing to do. */}
      {!welcome && !adding && <EmptySource />}
      {/* A subscription that stopped working — forced, above the shell, and
          out of the way while the door or the add-account form is open, since
          both are answers to it. */}
      {!welcome && !adding && <ExpiredDialog />}
      {/* Never over the door either — see `exiting` above. The registration already
          refuses while the door is open; this covers the frame in between. */}
      {exiting && !welcome && <ExitDialog onCancel={cancelExit} />}
      {/* New release — the banner in Chrome handles the automatic notification
          at the top of the app. The UpdateModal is no longer shown on the
          landing page; it is kept only in Settings → About (More.tsx) where
          the user can manually check for updates and view the changelog. */}
    </>
  );
}

/*
 * The setup flow used to be a destination here, at `/setup`.
 *
 * It was the first-run wizard with an address: countries, then packages. Removed on request — "remove library in this device and setup
 * again and its pages, we no longer need that, we have profiles" — and every
 * question it asked now lives somewhere better than a wizard:
 *
 *   countries  a property of a PROFILE, edited in Settings › Profile
 *   packages   `/packages`, per profile, with order and search
 *
 * Nothing is stranded by its removal: a new device still gets the channels for
 * the country it is in (see lib/firstRun.ts, which asks nothing), and the two
 * screens that offered "Sign in" now point at Settings › Accounts.
 */

const render = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <Router>
        {/* Before the gate, before the shell: a build the operator has retired
            must not reach a sign-in screen, let alone the app. See UpdateGate. */}
        <UpdateGate>
        {/*
          Admin is not part of the app.

          Outside the viewer gate — an operator has no subscription session and
          should not need one — and outside `Chrome`, because the shell's header,
          tab bar and hint bar are for watching television. It is deliberately
          unlinked: an operator types the address.
        */}
        <Routes>
          <Route path="/admin" element={<Suspense fallback={<RouteFallback />}><Admin /></Suspense>} />
          {/* The legal texts sit outside the gate: the first-run screen links to
              them, and must not be covered by itself. Bundled, so they open
              offline. */}
          <Route
            path="/legal/:doc"
            element={(
              <Chrome>
                <Suspense fallback={<RouteFallback />}><Legal /></Suspense>
              </Chrome>
            )}
          />
          <Route
            path="*"
            element={(
        <Gate>
        <Chrome>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Where the app opens is a preference, not a hard-coded route. */}
            <Route path="/" element={<Opening />} />
            <Route path="/home" element={<Home />} />
            {/* The classical view — hero plus rails — at its own address, so the
                logo's launcher tile and the modern header's icon-only Home tab
                can both open it without smuggling the classic shell back in.
                See `Discover()` in routes/Home.tsx. */}
            <Route path="/discover" element={<Discover />} />
            {/* Settings: the sections down the left, the open one on the right.
                `?s=<id>` says which, so the header cog, the SETTINGS key and a
                bookmark can all open the same one. */}
            <Route path="/more" element={<More />} />
            {/* Two retired addresses, kept as signposts rather than dead ends —
                a route the shell does not know renders a BLANK page inside the
                header, which is indistinguishable from a broken app. `/setup`
                was the wizard: whoever still holds that link wanted to sign in
                or pick packages, and Accounts is where both start. `/menu` was
                the classic launcher, whose job the settings page now has. */}
            <Route path="/setup" element={<Navigate to="/more?s=accounts" replace />} />
            <Route path="/menu" element={<Navigate to="/more" replace />} />
            {/* What the active profile can see, package by package. A route rather
                than a sheet: it is a screen someone works in, and on a television a
                sheet over a sheet is where focus goes to die. */}
            {/* One screen for what this television is allowed to show:
                countries, packages, channels, and what is hidden. */}
            <Route path="/organise" element={<Organise />} />
            {/* Two addresses that were the same subject split in half — the
                profile chooser and the package editor. Kept as signposts because
                a route the shell does not know renders a blank page inside the
                header, which is indistinguishable from a broken app. */}
            <Route path="/packages" element={<Navigate to="/organise?s=live" replace />} />
            <Route path="/profiles" element={<Navigate to="/organise" replace />} />
            <Route path="/live" element={<Live />} />
            {/* Sports TV — a filter over the same live channels, not a second
                catalogue. Placeholder still being built; see routes/Sports.tsx. */}
            <Route path="/sports" element={<Sports />} />
            {/* Adult content section — bypasses adult filter, shows VOD with tags and cast. */}
            <Route path="/adult" element={<Adult />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/catchup" element={<Catchup />} />
            <Route path="/watching" element={<Watching />} />
            <Route path="/favourites" element={<Navigate to="/live?favs=1" replace />} />
            <Route path="/movies" element={<MoviesPage />} />
            <Route path="/series" element={<SeriesPage />} />
            <Route path="/series/:id" element={<SeriesDetail />} />
            <Route path="/movie/:id" element={<MovieDetail />} />
            <Route path="/search" element={<Search />} />
          </Routes>
          </Suspense>
        </Chrome>
        </Gate>
            )}
          />
        </Routes>
        </UpdateGate>
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);

void boot();
