import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Loader2, RefreshCw, X } from 'lucide-react';
import {
  PHASE_LABELS, localEnabled, localStatus, refreshLocal, requestPersistence, subscribeLocal,
  type IngestStatus,
} from '../lib/localCatalogue';
import {
  bulkGuideStatus, canHaveGuide, checkBulkGuide, subscribeBulkGuide, updateBulkGuide, type BulkGuideStatus,
} from '../lib/bulkGuide';
import { clockOf } from '../lib/guide';
import { activeProvider } from '../lib/providers';

/** The screens a guide is read on — the banner is not put in front of a film grid. */
const GUIDE_SCREENS = /^\/(home|live|sports|guide|catchup)(\/|$)/;

/**
 * A banner the viewer closed stays closed for this session — until the guide
 * gets worse (running out → run out) or a new one lands. Module scope, so a
 * route change does not bring it back.
 */
let closedFor: string | null = null;

/**
 * "Your TV guide has run out — Update".
 *
 * The guide no longer refreshes itself (lib/bulkGuide.ts): a 17 MB download on
 * the same line as the picture, every hour, is what the owner asked to be rid
 * of — "a banner … your EPG is expired and they update, that way it won't
 * disturb the other connection". So it says when the guide needs updating and
 * waits to be asked; while it downloads, the progress line above takes over.
 */
function GuideBanner({ g }: { g: BulkGuideStatus }) {
  const [, redraw] = useState(0);
  const failed = g.state === 'error' && g.error !== null;
  const key = `${g.freshness}:${g.fetchedAt ?? 'none'}:${failed ? 'failed' : ''}`;
  if (closedFor === key) return null;
  const until = g.until === null ? null : clockOf(g.until);
  const days = g.fetchedAt === null ? 0 : Math.floor((Date.now() - g.fetchedAt) / 86_400_000);
  const line = failed
    ? `The TV guide could not be updated — ${g.error}.`
    : g.freshness === 'missing' ? 'There is no TV guide on this device yet.'
      : g.freshness === 'expired' ? 'Your TV guide has run out.'
        : g.freshness === 'soon' ? `Your TV guide runs out at ${until ?? 'soon'}.`
          : `Your TV guide is ${days} days old.`;
  const action = failed ? 'Try again' : g.freshness === 'missing' ? 'Get the guide' : 'Update guide';
  return (
    /* Centred under the menu, so DOWN from any destination lands on Update —
       the one press this is for. */
    <div
      role="status"
      className="catalogue-bar flex shrink-0 items-center justify-center gap-2.5 border-b border-rule bg-panel-2 px-3 py-1.5
                 font-mono text-[length:var(--t-2xs)] text-ink-2"
    >
      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-tally" />
      <span className="min-w-0 truncate">{line}</span>
      <button
        type="button"
        onClick={() => void updateBulkGuide()}
        className="tap flex shrink-0 items-center gap-1 border border-tally px-2 py-0.5 text-tally hover:bg-tally/10"
      >
        <RefreshCw className="h-3 w-3" />
        {action}
      </button>
      {/* For a mouse or a finger. Not a stop for the remote: a second target
          beside Update is where DOWN from the right half of the menu would land,
          and the banner leaves by itself once the guide is updated. */}
      <button
        type="button"
        tabIndex={-1}
        data-nav-skip
        aria-label="Hide until the guide changes"
        title="Hide"
        onClick={() => { closedFor = key; redraw((n) => n + 1); }}
        className="tap flex shrink-0 items-center p-1 text-ink-3 hover:text-ink"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}


/**
 * What the device is doing with the catalogue.
 *
 * Only ever visible when it is doing something: downloading, failed, or freshly
 * finished IN THIS SESSION. A first run cannot be silent — ~19MB and several
 * seconds, longer on a phone — because an app that looks empty for thirty seconds
 * reads as broken. Once the catalogue is on the device this disappears entirely
 * rather than becoming another permanent strip, which is what it had in fact
 * become: `builtAt` outlives the session and `dismissed` did not, so every
 * navigation brought back a status line and two more buttons.
 *
 * The byte count has no percentage because the panel sends no `content-length`
 * on the big payloads. Six steps and a megabyte count is what is actually known.
 */
export function LocalCatalogueBar() {
  const [s, setS] = useState<IngestStatus>(localStatus);

  useEffect(() => subscribeLocal(setS), []);
  const [g, setG] = useState<BulkGuideStatus>(bulkGuideStatus);
  useEffect(() => subscribeBulkGuide(setG), []);
  const { pathname } = useLocation();
  const guideScreen = GUIDE_SCREENS.test(pathname);
  /* Arriving on a guide screen is when "has it run out?" is worth one small
     read — the hourly check alone could leave a banner an hour late. */
  useEffect(() => {
    if (guideScreen && localEnabled()) void checkBulkGuide();
  }, [guideScreen, pathname]);
  useEffect(() => {
    if (!localEnabled()) return;
    /* Ask once. It is refused more often than granted — it was DENIED in headless
       testing — and the honest response to a refusal is to detect eviction and
       rebuild, which `initLocal` already does. */
    void requestPersistence();
  }, []);

  /*
   * Visible while the catalogue is being built, and if the build failed. Never
   * otherwise.
   *
   * This strip used to stay after a successful build, carrying a `rebuild` and a
   * `hide` button onto every screen in the app — reported as "so many buttons
   * everywhere", and it was taken out of the shell entirely for it. Which went
   * too far the other way: the component was left rendered by nobody, so a
   * rebuild had no progress ANYWHERE, and pressing refresh made the app look
   * broken while it worked. "On reload liberary or refresh, presist progress,
   * otherwise everything breaks, i mean on navigatting and so on."
   *
   * So it is back in the shell (`Chrome.tsx`) and it is only ever a progress
   * line: nothing to dismiss, nothing to press, and no trace of it once the
   * build is done. A finished catalogue's size and age live in Settings, where
   * somebody who wants them can look.
   */
  if (!localEnabled()) return null;
  /* The TV guide follows the playlist, on the same strip: "download it for the
     first time when downloading the whole playlist, show loadings". Only while
     it downloads — a guide that failed is not the viewer's problem, the
     per-channel guide carries on underneath it. */
  if (s.state !== 'loading' && s.state !== 'error' && g.state === 'loading') {
    const pct = g.expected !== null && g.expected > 0 ? Math.min(99, Math.round((g.bytes / g.expected) * 100)) : null;
    return (
      <div className="catalogue-bar flex shrink-0 items-center gap-2.5 border-b border-rule bg-panel-2 px-3 py-1.5
                      font-mono text-[length:var(--t-2xs)] text-ink-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1 truncate">
          TV guide{pct !== null ? ` ${pct}%` : ''} · {(g.bytes / 1e6).toFixed(0)} MB
          {g.programmes > 0 ? ` · ${g.programmes.toLocaleString()} programmes` : ''}
        </span>
        <span className="meter h-1 w-24 shrink-0 overflow-hidden bg-rule sm:w-40">
          <span
            className={`block h-full bg-tally transition-all duration-500 ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </span>
      </div>
    );
  }
  if (s.state !== 'loading' && s.state !== 'error') {
    const wants = g.state === 'error' || (g.freshness !== 'fresh' && g.freshness !== 'unknown');
    return guideScreen && s.builtAt !== null && wants && canHaveGuide(activeProvider()) ? <GuideBanner g={g} /> : null;
  }

  const loading = s.state === 'loading';
  const mb = (s.bytes / 1e6).toFixed(1);

  return (
    <div
      className={`flex shrink-0 items-center gap-2.5 border-b px-3 py-1.5 font-mono text-[length:var(--t-2xs)]
        ${s.state === 'error'
          ? 'border-alert/40 bg-alert/10 text-alert'
          /* `catalogue-bar` is what the Modern shell reaches for to make this strip
             glass instead of an opaque slab across a photographic room. Only on
             the healthy state: an error keeps its solid red tint, because a
             warning that is see-through is a warning nobody reads. */
          : 'catalogue-bar border-rule bg-panel-2 text-ink-2'}`}
    >
      {loading
        ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}

      <span className="min-w-0 flex-1 truncate">
        {loading && (
          <>
            Catalogue {s.phase ? PHASE_LABELS[s.phase] : '…'}
            {' '}({s.step}/{s.steps}) · {mb} MB
          </>
        )}
        {s.state === 'error' && <>Catalogue failed: {s.error}</>}
      </span>

      {loading && (
        <span className="meter h-1 w-24 shrink-0 bg-rule sm:w-40">
          <span
            className="block h-full bg-tally transition-all duration-500"
            style={{ width: `${(s.step / s.steps) * 100}%` }}
          />
        </span>
      )}
      {/* The one press worth offering, and only when there is something to
          retry. A successful build shows no buttons at all. */}
      {s.state === 'error' && (
        <button
          type="button"
          onClick={() => void refreshLocal()}
          aria-label="Try the rebuild again"
          className="dest flex shrink-0 items-center gap-1 hover:text-tally"
        >
          <RefreshCw className="h-3 w-3" />
          <span className="dest-label">try again</span>
        </button>
      )}
    </div>
  );
}
