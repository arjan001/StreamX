/**
 * Profiles and viewing preferences.
 *
 * A subscription carries 79 countries and 55,000 live channels, which is not a
 * catalogue anyone browses — it is a catalogue you carve down. So the unit here is
 * a PROFILE: a named scope of countries plus the groups it never wants to see. One
 * household can have "Netherlands + France", "Arabic", "Kids", and switching
 * between them changes every list, tree and count in the app.
 *
 * A profile's country list is an ALLOW-list applied server-side to items, groups,
 * markets and facet counts alike, because a genre chip reading 2,895 that yields
 * 1,931 rows reads as a bug. Its hidden list is subtractive on top, and exclusion
 * always wins.
 *
 * Stored client-side. There are no accounts yet, and moving this server-side later
 * is a straight lift: the shape is already what the API takes.
 */
import { useCallback, useEffect, useState } from 'react';
import { kv } from './kv.ts';
import { setLayoutPref, type LayoutPref } from './formFactor.ts';
/*
 * `browseStyle`'s vocabulary lives with the lists it describes.
 *
 * Every other enum in this file is declared here beside its field, and this one
 * is the exception on purpose: `groups` vs `list` is a statement about how the
 * two lists on Live are DRAWN, and the code that flattens a tree into one list
 * and the code that reads the setting have to agree about the words. Keeping it
 * in `lib/liveRows` puts the words next to the flattening and lets both be
 * tested without a browser. The wiring below is the same six places `openStyle`
 * occupies; only the reader is imported rather than local.
 */
import { readBrowseStyle, type BrowseStyle } from './liveRows.ts';

/**
 * Favourites, keyed by PROVIDER id.
 *
 * `stream_id` for channels and films, `series_id` for series — never the catalogue
 * row id, which is per-generation and changes on every re-ingest. A favourite keyed
 * on a row id would quietly start pointing at a different title after a refresh.
 */
export interface Favourites {
  live: number[];
  movies: number[];
  series: number[];
}

export type FavSection = 'live' | 'movies' | 'series';

export interface WatchRecord {
  section: 'movies' | 'series';
  streamId: number;
  positionS: number;
  durationS: number;
  episodeId: number | null;
  season: number | null;
  episode: number | null;
  updatedAt: number;
}

/**
 * The one thing that was playing when the app last closed.
 *
 * A television remembers its channel. A streaming app remembers the film you were
 * ten minutes into. This app remembered neither: every launch started at the home
 * page with nothing playing, which is the difference between a product and a
 * demo.
 *
 * Stored as a ROUTE rather than as an id plus a section, because every playing
 * surface in this app is already reachable by URL and already resumes itself from
 * that URL — `/live?ch=<ref>`, `/movie/<ref>?play=1`, `/series/<ref>?ep=<id>`,
 * `/catchup?ch=…&start=…&stop=…`. So "carry on where they left off" is one
 * redirect and no new playback machinery at all, and anything that becomes
 * link-addressable later is resumable for free.
 */
export interface LastPlayed {
  /** Where to send the app. Carries the parameters that make it play. */
  route: string;
  /** What was playing, for the banner and the Home strip. */
  label: string;
  logo: string | null;
  kind: 'live' | 'movie' | 'episode' | 'archive';
  /** The player's own key for this stream, so `watch.ts` can retire the mark. */
  key: string;
  /** Playhead. Always 0 for live, which has no meaningful one. */
  positionS: number;
  durationS: number;
  at: number;
}

/**
 * How often something has been opened, per stream.
 *
 * The one signal the app was not collecting and the only one that describes LIVE
 * viewing at all. Films and series have a playhead — how far through something got
 * is strong evidence about it — but a channel has no end, so "watched" can only
 * mean "opened, often". Without this, `lib/taste.ts` is blind to 55,430 of the
 * catalogue's items and the home page can only offer channels somebody has
 * explicitly starred.
 *
 * `k` is the player's own key (`<kind>.<provider id>`), so it survives a re-ingest
 * for the same reason favourites do.
 *
 * Counts merge across devices by MAX rather than by sum: a sum is the truthful
 * aggregate exactly once, and then every subsequent merge inflates it again. Max is
 * idempotent, which is the property a value that gets merged repeatedly needs.
 */
export interface PlayCount {
  k: string;
  n: number;
  at: number;
}

export interface CaptionPrefs {
  source: string;
  target: string;
  showOriginal: boolean;
  /** Plate behind the lines. */
  bg: boolean;
  /** Plate opacity 10–100. */
  bgOpacity: number;
  bgColor: 'black' | 'navy' | 'green' | 'white';
  size: 'sm' | 'md' | 'lg';
  /** Vertical place over the picture. */
  position: 'low' | 'mid' | 'high';
  /** How many caption rows stay on screen (1–5). */
  lines: number;
}

export interface Profile {
  id: string;
  name: string;
  /** Country/market codes this profile may see. Empty means every country. */
  markets: string[];
  /** Group paths never to show, e.g. ["EN/KIDS"]. */
  hidePaths: string[];
  /**
   * Category ids never to show. LEGACY — see `hideCatRefs`.
   *
   * Kept only so an existing profile is not thrown away: these are per-generation
   * Postgres row ids, which every re-ingest reassigns, so the list silently starts
   * hiding different packages after a catalogue refresh. `migrateHiddenCats`
   * converts them the first time a category list is in hand, which is exact while
   * the generation that wrote them is still live.
   */
  hideCats: number[];
  /** Packages never to show, named `<kind>.<provider id>` so a refresh cannot move them. */
  hideCatRefs: string[];
  /**
   * Individual channels and titles never to show, by PROVIDER id.
   *
   * Provider ids for the same reason favourites use them. Capped by the API at 500
   * per request, which is the honest limit of this control: past a few dozen the
   * thing being hidden is a package, and `hideCatRefs` says that in one value.
   */
  hideStreams: number[];
  /**
   * The viewer's own package order, per section, as refs.
   *
   * Anything not listed keeps the provider's order, after everything that is —
   * which is what makes "drag these four to the top" a complete instruction rather
   * than a demand to rank 829 categories.
   */
  catOrder: { live: string[]; movies: string[]; series: string[] };
  /**
   * The viewer's own channel order, as PROVIDER stream ids.
   *
   * The same partial order `catOrder` is, one level down: "That hard thing and
   * move it up and down should be for both channels as well as categories". A
   * channel nobody has moved keeps the provider's position, behind everything
   * somebody has.
   *
   * Stream ids rather than row ids for the reason favourites use them: a row id
   * is reassigned by every re-ingest, so an order stored as row ids would
   * silently start ranking different channels after a refresh.
   */
  streamOrder: number[];
  /**
   * The viewer's own country order, as market ids.
   *
   * Same partial-order idea as `catOrder`: what is listed comes first, in this
   * sequence, and everything else keeps the default order after it. Asked for
   * directly — "keep in mind the ordering of countries and channels and stuff" —
   * and it is the setting that makes a 178-country list feel like somebody's own
   * television rather than a directory.
   */
  marketOrder: string[];
  /** Starred items, per section. Each profile keeps its own. */
  favs: Favourites;
  /** Continue-watching for films and series. */
  history: WatchRecord[];
  /** The last thing that played under this profile. */
  lastPlayed: LastPlayed | null;
  /** How often each stream has been opened. See `PlayCount`. */
  plays: PlayCount[];
}

export interface Prefs {
  /** Flattened from the active profile, so consumers need not know about profiles. */
  hidePaths: string[];
  hideCats: number[];
  hideCatRefs: string[];
  hideStreams: number[];
  catOrder: { live: string[]; movies: string[]; series: string[] };
  streamOrder: number[];
  markets: string[];
  marketOrder: string[];
  favs: Favourites;
  history: WatchRecord[];
  lastPlayed: LastPlayed | null;
  plays: PlayCount[];
  /** Open on whatever was playing last, rather than on the start page. */
  resumeOnOpen: boolean;
  /**
   * What OK on a film or a series does: play it, or describe it.
   *
   * `fullscreen` goes straight to the picture — which is what a
   * television is for, and what every set-top box does. The owner's case for it:
   * "if you think about it, the showpage is entirely useless". A show page costs
   * a `get_vod_info` round trip measured at over four seconds on this
   * subscription, decodes a rail of twenty posters, and asks a viewer who has
   * already chosen to choose again.
   *
   * `page` is the DEFAULT, and reading the plot and the cast before committing an
   * evening turned out to be what people actually wanted — see `readOpenStyle`
   * for how it went both ways and why the reversal is not a retraction.
   *
   * Either way the other route stays reachable: hold OK on any tile for the
   * menu, which offers whichever of the two this setting did not do.
   *
   * Device-wide rather than per profile: it is a statement about how this screen
   * is used, like `showCounts`, not about who is watching.
   */
  openStyle: OpenStyle;
  /**
   * Whether a section is browsed as a tree of groups, or as one flat list.
   *
   * Asked for in these words: "i want you to add a seeetings where if they wanna
   * see it as groups or if they wanna see it as list all of it", beside
   * photographs of a competitor whose channel sidebar has no country level at
   * all — just `VM | SPORTS 73`, `UK | FREE TO AIR 111`, one after another.
   *
   * `groups` is a rail of countries, each of which opens to show its packages.
   * It is the right shape for somebody who knows they want Belgian television
   * and is a poor one for somebody who knows they want SPORTS and does not care
   * which country files it — and on a line with 79 markets, that second person
   * has to guess which of 79 rows to open.
   *
   * `list` is the provider's own category list under the names the panel gave
   * it — "no need to filter the names at all, i mean if country is nl | category
   * | movie just show it like that" — so every category is one press away and
   * the search field over the rail reaches all of them at once. Nothing is
   * hidden in either shape: the list writes `category` into the address where
   * the tree writes a path, and every list that filters reads both.
   *
   * `list` is the DEFAULT: Live opens on the plain list of every category the
   * source offers, never filtered or grouped by country unless somebody asks.
   * Every device that saved `groups` before revision 4 saved it without
   * choosing it — see `DEFAULTS_REV` and `adoptedBrowseStyle` for how that
   * reaches them once.
   *
   * Device-wide rather than per profile — like `openStyle` and `showCounts`, it
   * is a statement about how this screen is used, not about who is watching.
   */
  browseStyle: BrowseStyle;
  /**
   * Which door to open streams on, or `null` for whichever answers.
   *
   * Stored as the hostname, shown as "Server 2". The name is deliberate: the
   * hostnames are the reseller's infrastructure and mean nothing to a viewer —
   * "name them dont show IP if not, just say server 1 and so on" — and a
   * position in a list is something somebody can read back to you over a phone.
   *
   * A hostname rather than an index, because the list changes between builds:
   * an index would silently point at a different machine after a mirror is
   * added or dropped, which is the worst kind of setting. An unknown hostname
   * falls back to automatic.
   */
  server: string | null;
  /** How to decode, in the app's own engine. See `Decoder`. */
  decoder: Decoder;
  /** Open a channel when the highlight rests on it. See `AutoOpen`. */
  autoOpen: AutoOpen;
  /**
   * Light the space around the picture with the colour of what is playing.
   *
   * "aren't the player always i'm sure there are packages you can like show
   * shades you know what's playing right now like a television" — Ambilight, and
   * it lands in the letterbox bars where there is nothing else to look at.
   *
   * ON by default and a setting anyway, because it can only be measured on the
   * box: it costs one 32x18 canvas draw every 600ms, which is nothing next to a
   * video decode, but "nothing" on a weak TV box is worth being able to switch
   * off without a new build. See `lib/ambient.ts` for why it is 600ms and not
   * per frame, and for the half of the catalogue it cannot work on at all.
   */
  ambient: boolean;
  /**
   * Print the tallies beside rows and chips. OFF by default — see `lib/tally`.
   *
   * Device-wide rather than per profile: it is a statement about how this screen
   * is read, not about who is watching.
   */
  showCounts: boolean;
  /**
   * Layout override. `auto` lets formFactor.ts decide from size and input; the
   * explicit values exist because detection cannot see intent — a tablet propped
   * on a stand across the kitchen is a TV, and only its owner knows that.
   */
  layout: LayoutPref;
  captions: CaptionPrefs;
  /** OpenSubtitles search language. */
  subLang: string;
  /** Live feed: `auto` or a quality label from `api.variants` (FHD, HEVC, …). */
  liveQuality: string;
  profiles: Profile[];
  activeId: string;
}

const NO_FAVS: Favourites = { live: [], movies: [], series: [] };

const KEY = 'iptv.prefs.v2';
const KEY_V1 = 'iptv.prefs.v1';

interface Stored {
  profiles: Profile[];
  activeId: string;
  /* Device-wide, not per profile: it is a statement about this screen — a TV in a
     living room should come back to its channel, a shared desktop browser maybe
     not — and not about who is watching. */
  resumeOnOpen: boolean;
  showCounts: boolean;
  openStyle: OpenStyle;
  /** See `Prefs.browseStyle`. Absent on every record written before it existed. */
  browseStyle: BrowseStyle;
  /** See `DEFAULTS_REV`. Absent on any record written before it existed. */
  defaultsRev?: number;
  server: string | null;
  decoder: Decoder;
  autoOpen: AutoOpen;
  ambient: boolean;
  layout: LayoutPref;
  captions: CaptionPrefs;
  subLang: string;
  liveQuality: string;
}

const LAYOUTS: LayoutPref[] = ['auto', 'phone', 'tablet', 'desktop', 'tv'];

/** See `Prefs.openStyle`. */
export type OpenStyle = 'fullscreen' | 'page';

const OPEN_STYLES: OpenStyle[] = ['fullscreen', 'page'];

/* Re-exported so a settings screen imports every viewing preference's type from
   the same place, whatever module happens to declare it. See the import. */
export type { BrowseStyle };

/**
 * How to decode video in the app's own engine.
 *
 * `auto` is right for almost everyone: libVLC asks MediaCodec first and falls
 * back to the CPU by itself. `software` exists because that fallback is not
 * always offered — a decoder can accept a stream and then produce nothing,
 * which looks like a broken file rather than a broken decoder — and because
 * somebody who has learned that about their own box should not have to
 * rediscover it once per title.
 */
export type Decoder = 'auto' | 'software';

/**
 * Whether resting the highlight on a channel opens it, and how patiently.
 *
 * Asked for in these words: "when they scroll to a channel directly open it I
 * mean they should be able to see it instead of them clicking OK and then it
 * opens" — which is how a television behaves and is plainly better for
 * browsing. It is also the single most dangerous thing in this app to get wrong,
 * so it is a setting with a slow default rather than a behaviour.
 *
 * The danger is the line, not the app. This account's debug log has already
 * recorded what a burst of opens does: seven doors burned between 02:36:23 and
 * 02:37:28, each dying ~800ms in, and then `player_api.php` — which had been
 * answering in 60ms all evening — took 38 seconds and failed. A provider
 * watching several stream opens in a few seconds from one address, on a line
 * that may allow ONE connection, does not distinguish browsing from abuse.
 *
 * So the delay is how long the highlight must be COMPLETELY STILL, every press
 * restarts it, and the previous stream is torn down before the next is asked
 * for. `relaxed` is the default because a viewer walking down a list at one row
 * per second must not open anything at all.
 *
 *   off       OK opens the channel, as before
 *   relaxed   2 seconds of stillness  (default)
 *   quick     1 second of stillness
 */
export type AutoOpen = 'off' | 'relaxed' | 'quick';

/** Milliseconds of complete stillness before a rested highlight opens a channel. */
export const AUTO_OPEN_MS: Record<Exclude<AutoOpen, 'off'>, number> = {
  relaxed: 2000,
  quick: 1000,
};

export function readAutoOpen(raw: unknown): AutoOpen {
  return raw === 'quick' ? 'quick' : raw === 'relaxed' ? 'relaxed' : 'off';
}

const DECODERS: Decoder[] = ['auto', 'software'];

function readDecoder(v: unknown): Decoder {
  return typeof v === 'string' && (DECODERS as string[]).includes(v) ? (v as Decoder) : 'auto';
}

/**
 * The default is the show page, and it has been both.
 *
 * 1.9.0 shipped `fullscreen` as the default on the owner's own argument — "if
 * you think about it, the showpage is entirely useless" — and it came back the
 * other way after other people used it: "i think its fine if they go to details
 * page first so that by default". Both settings still exist and both are one
 * press from the other via the hold menu; only which one arrives unasked has
 * changed.
 *
 * Worth recording that the reversal is not a retraction of the reasoning. The
 * show page was slow and cluttered, and that got fixed rather than avoided: the
 * `get_vod_info` wait is covered by `movieDetailSeed` so the page is right
 * immediately, and MORE LIKE THIS — twenty posters decoded below the fold — is
 * gone. Defaulting to it now costs what it should have cost all along.
 */
function readOpenStyle(v: unknown): OpenStyle {
  return typeof v === 'string' && (OPEN_STYLES as string[]).includes(v)
    ? (v as OpenStyle)
    : 'page';
}

/**
 * How many times the DEFAULTS have been revised, so a reversal can reach a
 * device that already saved the old one.
 *
 * `persist()` runs from every setter, so a box that has favourited anything has
 * `openStyle: 'fullscreen'` written into its record — and a device carrying the
 * old default explicitly is indistinguishable from one that chose it. Changing
 * `readOpenStyle` alone would therefore have changed nothing for exactly the
 * people who reported it.
 *
 * So: a record written before revision 1 has its `fullscreen` treated as the
 * default it was rather than a decision, once. Anything chosen after that
 * persists the revision alongside it and is never touched again.
 *
 * Revision 2 is the same move for `browseStyle`. The setting shipped in 1.17.0
 * with `groups` as its default, and because `persist()` writes the WHOLE record
 * on every setter, nearly every device had `groups` stored within the hour
 * without anybody having chosen it. A record below revision 2 therefore gives its
 * `groups` up for the new default, `list`, exactly once. Each revision keeps its
 * own threshold: revision 1's `fullscreen` rule still reads `< 1`, so a device
 * that chose the picture after 1.9.0 is not undone by a revision about sidebars.
 *
 * Revision 3 made the tree the default; revision 4 makes the plain list the
 * default again, and nothing is filtered by country by default. A `groups`
 * written before revision 4 — the old default, which `persist()` stored on
 * nearly every device — becomes `list` once, and a `groups` chosen in Settings
 * after it is kept.
 */
const DEFAULTS_REV = 4;

/* Exported for its test: the once-only rule below is easy to get wrong in a
   way nothing else would notice. */
export function adoptedOpenStyle(stored: unknown, rev: unknown): OpenStyle {
  if (Number(rev ?? 0) < 1 && stored === 'fullscreen') return 'page';
  return readOpenStyle(stored);
}

/* Revision 4, and exported for the same reason. `groups` written before it is
   the old default rather than a choice; `groups` written at or after it is
   somebody who went into Settings and asked for the tree. */
export function adoptedBrowseStyle(stored: unknown, rev: unknown): BrowseStyle {
  if (Number(rev ?? 0) < 4 && stored === 'groups') return 'list';
  return readBrowseStyle(stored);
}

/**
 * Read the layout override, carrying the old two-state density switch across.
 *
 * v2 stored `density: 'desk' | 'tv'`, where `desk` meant "not TV" rather than
 * "desktop layout" — so it maps to `auto`, not to `desktop`, or every phone
 * belonging to someone who had used the app before would come back as a desktop.
 */
function readLayout(v: unknown, legacyDensity?: unknown): LayoutPref {
  if (typeof v === 'string' && (LAYOUTS as string[]).includes(v)) return v as LayoutPref;
  return legacyDensity === 'tv' ? 'tv' : 'auto';
}

const CAPTION_TARGETS = new Set([
  'en', 'ar', 'es', 'fr', 'de', 'nl', 'pt', 'it', 'tr', 'ru', 'hi', 'ur', 'zh', 'ja', 'ko',
]);

function captionTargetFromLocale(): string {
  const tag = typeof navigator === 'undefined' ? 'en' : navigator.language;
  const id = tag.split('-')[0]?.toLowerCase() ?? 'en';
  return CAPTION_TARGETS.has(id) ? id : 'en';
}

function defaultCaptions(): CaptionPrefs {
  return {
    source: 'auto',
    target: captionTargetFromLocale(),
    showOriginal: false,
    bg: false,
    bgOpacity: 75,
    bgColor: 'black',
    size: 'sm',
    position: 'low',
    lines: 2,
  };
}

const CAPTION_BG = new Set(['black', 'navy', 'green', 'white']);
const CAPTION_SIZE = new Set(['sm', 'md', 'lg']);
const CAPTION_POS = new Set(['low', 'mid', 'high']);

/**
 * Read the caption look back, and KEEP it.
 *
 * This used to spread the defaults over everything but the languages, under the
 * comment "Look is fixed (small, no plate, low, two lines). Only language prefs
 * persist." That was true when it was written: the owner had asked for "the CC
 * that we have … with least settings like small no background and like really
 * below area and two lines by default", and the controls that could change the
 * look were taken out, so there was nothing to persist.
 *
 * Then "subtitles settings are gone i mean i awas able to change size and bg and
 * so on", and the controls came back in the CC popover. They wrote to storage
 * and applied at once — and this reader then threw size, plate, position and
 * lines away on the next start, so every choice silently reverted to the default
 * the moment the box was switched off. A setting that does not survive a restart
 * is worse than no setting: somebody chooses, sees it work, and concludes the
 * app forgot.
 *
 * So the validation that stood here before `daff49f` is back, value by value,
 * with one deliberate change: `bg` is `=== true` rather than `!== false`, so a
 * record saved while the look was fixed — which never carried the field — keeps
 * its plate OFF rather than growing one on upgrade.
 */
function readCaptions(v: unknown): CaptionPrefs {
  const fallback = defaultCaptions();
  if (typeof v !== 'object' || v === null) return fallback;
  const o = v as Record<string, unknown>;
  const opacity = typeof o['bgOpacity'] === 'number' && Number.isFinite(o['bgOpacity'])
    ? Math.min(100, Math.max(10, Math.round(o['bgOpacity'])))
    : fallback.bgOpacity;
  const lines = typeof o['lines'] === 'number' && Number.isFinite(o['lines'])
    ? Math.min(5, Math.max(1, Math.round(o['lines'])))
    : fallback.lines;
  const bgColor = typeof o['bgColor'] === 'string' && CAPTION_BG.has(o['bgColor'])
    ? o['bgColor'] as CaptionPrefs['bgColor']
    : fallback.bgColor;
  const size = typeof o['size'] === 'string' && CAPTION_SIZE.has(o['size'])
    ? o['size'] as CaptionPrefs['size']
    : fallback.size;
  const position = typeof o['position'] === 'string' && CAPTION_POS.has(o['position'])
    ? o['position'] as CaptionPrefs['position']
    : fallback.position;
  return {
    source: typeof o['source'] === 'string' && o['source'] !== '' ? o['source'] : 'auto',
    target: typeof o['target'] === 'string' && o['target'] !== '' ? o['target'] : fallback.target,
    showOriginal: o['showOriginal'] === true,
    bg: o['bg'] === true,
    bgOpacity: opacity,
    bgColor,
    size,
    position,
    lines,
  };
}

function readHistory(v: unknown): WatchRecord[] {
  if (!Array.isArray(v)) return [];
  const out: WatchRecord[] = [];
  for (const row of v) {
    if (typeof row !== 'object' || row === null) continue;
    const o = row as Record<string, unknown>;
    if (o['section'] !== 'movies' && o['section'] !== 'series') continue;
    if (!Number.isInteger(o['streamId']) || !Number.isFinite(o['positionS'])) continue;
    out.push({
      section: o['section'],
      streamId: o['streamId'] as number,
      positionS: o['positionS'] as number,
      durationS: typeof o['durationS'] === 'number' ? o['durationS'] : 0,
      episodeId: typeof o['episodeId'] === 'number' ? o['episodeId'] : null,
      season: typeof o['season'] === 'number' ? o['season'] : null,
      episode: typeof o['episode'] === 'number' ? o['episode'] : null,
      updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : 0,
    });
  }
  return out.slice(0, 80);
}

/**
 * Is this a route inside this app?
 *
 * The stored value ends up in `Navigate to=`, so it is checked rather than
 * trusted: `//evil.example` is a protocol-relative URL that a router will happily
 * treat as a destination, which turns a convenience feature into an open redirect
 * out of the app. Anything that is not a single-slash absolute path is not a route
 * this app wrote.
 */
export function safeRoute(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  // A backslash is normalised to a forward slash by several URL parsers, so
  // `/\evil.example` is the same trick wearing a different hat.
  if (v.startsWith('/\\')) return null;
  return v.slice(0, 300);
}

/**
 * A stored mark, or nothing.
 *
 * Route-shape checked rather than trusted: this value ends up in `Navigate to=`,
 * and an absolute URL there would be an open redirect out of the app.
 */
function readLastPlayed(v: unknown): LastPlayed | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const route = safeRoute(o['route']);
  if (route === null) return null;
  const kind = o['kind'];
  if (kind !== 'live' && kind !== 'movie' && kind !== 'episode' && kind !== 'archive') return null;
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    route,
    label: typeof o['label'] === 'string' ? o['label'].slice(0, 160) : '',
    logo: typeof o['logo'] === 'string' ? o['logo'] : null,
    kind,
    key: typeof o['key'] === 'string' ? o['key'] : '',
    positionS: Math.max(0, Math.floor(num(o['positionS']))),
    durationS: Math.max(0, Math.floor(num(o['durationS']))),
    at: num(o['at']),
  };
}

/**
 * How many stream keys to keep.
 *
 * A viewer's real rotation is a few dozen channels; the cap is there so a
 * household that zaps through a thousand does not grow the store without bound.
 * Eviction is by count then age, so the habit survives and the accidents do not.
 */
const PLAYS_MAX = 300;

/** `<kind>.<provider id>`; anything else is not a package name we wrote. */
/** Market ids: short, alphanumeric, and capped — a stored order is not a place
    to accept 10,000 strings from disk. */
function readCodes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x !== '' && x.length <= 32).slice(0, 400);
}

function readRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && /^\d+\./.test(x)).slice(0, 1200);
}

/** Provider stream ids, bounded the way every other stored list here is. */
function readStreamIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(0, 2000);
}

function readPlays(v: unknown): PlayCount[] {
  if (!Array.isArray(v)) return [];
  const out: PlayCount[] = [];
  for (const row of v) {
    if (typeof row !== 'object' || row === null) continue;
    const o = row as Record<string, unknown>;
    if (typeof o['k'] !== 'string' || o['k'] === '') continue;
    const n = typeof o['n'] === 'number' && Number.isFinite(o['n']) ? Math.floor(o['n']) : 0;
    if (n <= 0) continue;
    out.push({
      k: o['k'].slice(0, 40),
      n: Math.min(n, 100_000),
      at: typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : 0,
    });
  }
  return out.slice(0, PLAYS_MAX);
}

function newId(): string {
  // Enough for a local list of profiles, and no dependency.
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function blankProfile(name = 'Everything'): Profile {
  return {
    id: newId(), name, markets: [], hidePaths: [], hideCats: [], hideCatRefs: [], hideStreams: [],
    catOrder: { live: [], movies: [], series: [] }, streamOrder: [], marketOrder: [],
    favs: { ...NO_FAVS }, history: [], lastPlayed: null, plays: [],
  };
}

function sanitise(p: unknown): Profile | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || o['id'] === '') return null;
  return {
    id: o['id'],
    name: typeof o['name'] === 'string' && o['name'].trim() !== '' ? o['name'].slice(0, 40) : 'Profile',
    markets: Array.isArray(o['markets']) ? o['markets'].filter((x): x is string => typeof x === 'string') : [],
    hidePaths: Array.isArray(o['hidePaths'])
      ? o['hidePaths'].filter((x): x is string => typeof x === 'string')
      : [],
    hideCats: Array.isArray(o['hideCats'])
      ? o['hideCats'].filter((x): x is number => typeof x === 'number')
      : [],
    hideCatRefs: readRefs(o['hideCatRefs']),
    hideStreams: Array.isArray(o['hideStreams'])
      ? o['hideStreams'].filter((x): x is number => Number.isInteger(x)).slice(0, 500)
      : [],
    marketOrder: readCodes(o['marketOrder']),
    catOrder: {
      live: readRefs((o['catOrder'] as Record<string, unknown> | undefined)?.['live']),
      movies: readRefs((o['catOrder'] as Record<string, unknown> | undefined)?.['movies']),
      series: readRefs((o['catOrder'] as Record<string, unknown> | undefined)?.['series']),
    },
    streamOrder: readStreamIds(o['streamOrder']),
    favs: readFavs(o['favs']),
    history: readHistory(o['history']),
    lastPlayed: readLastPlayed(o['lastPlayed']),
    plays: readPlays(o['plays']),
  };
}

function readFavs(v: unknown): Favourites {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const nums = (x: unknown): number[] =>
    Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : [];
  return {
    live: nums(o['live']), movies: nums(o['movies']), series: nums(o['series']),
  };
}

function read(): Stored {
  try {
    const raw = kv.get(KEY);
    if (raw !== null) {
      const s = JSON.parse(raw) as Partial<Stored>;
      const profiles = Array.isArray(s.profiles)
        ? s.profiles.map(sanitise).filter((p): p is Profile => p !== null)
        : [];
      if (profiles.length > 0) {
        const activeId = profiles.some((p) => p.id === s.activeId) ? s.activeId! : profiles[0]!.id;
        return {
          profiles,
          activeId,
          resumeOnOpen: s.resumeOnOpen !== false,
          /* Absent in every stored record written before this existed, and the
             default is off — so `=== true` rather than `!== false`. */
          showCounts: s.showCounts === true,
          openStyle: adoptedOpenStyle(s.openStyle, s.defaultsRev),
          /* Absent in every record written before this existed, and absent or
             unrecognised is the default, `list`. A `groups` saved before
             revision 4 is the OLD default, persisted by an unrelated setter, and
             is read as the new one once — see `adoptedBrowseStyle`. */
          browseStyle: adoptedBrowseStyle(s.browseStyle, s.defaultsRev),
          defaultsRev: DEFAULTS_REV,
          server: typeof s.server === 'string' && s.server !== '' ? s.server : null,
          decoder: readDecoder(s.decoder),
          autoOpen: readAutoOpen(s.autoOpen),
          /* Absent in every record written before this existed, and the default
             is ON — so `!== false` rather than `=== true`. */
          ambient: s.ambient !== false,
          layout: readLayout(s.layout, (s as { density?: unknown }).density),
          captions: readCaptions(s.captions),
          subLang: typeof s.subLang === 'string' && s.subLang !== '' ? s.subLang : 'en',
          liveQuality: typeof s.liveQuality === 'string' && s.liveQuality !== '' ? s.liveQuality : 'auto',
        };
      }
    }
    // Carry across whatever the single-profile version had, so a hidden list
    // someone curated is not silently thrown away by the upgrade.
    const old = kv.get(KEY_V1);
    if (old !== null) {
      const v1 = JSON.parse(old) as Record<string, unknown>;
      const first = blankProfile();
      first.hidePaths = Array.isArray(v1['hidePaths'])
        ? (v1['hidePaths'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      first.hideCats = Array.isArray(v1['hideCats'])
        ? (v1['hideCats'] as unknown[]).filter((x): x is number => typeof x === 'number')
        : [];
      return {
        profiles: [first],
        activeId: first.id,
        resumeOnOpen: true,
        showCounts: false,
        openStyle: 'page',
        browseStyle: 'list',
        defaultsRev: DEFAULTS_REV,
        server: null,
        decoder: 'auto',
        /* Off by default: opening a stream is a request to the provider, and a
           viewer must opt into making one every time the highlight settles. */
        autoOpen: 'off',
        ambient: true,
        layout: readLayout(undefined, v1['density']),
        captions: defaultCaptions(),
        subLang: 'en',
        liveQuality: 'auto',
      };
    }
  } catch {
    /* corrupt or unavailable storage falls through to a fresh default */
  }
  const p = blankProfile();
  return {
    profiles: [p], activeId: p.id, resumeOnOpen: true, showCounts: false, openStyle: 'page',
    browseStyle: 'list', defaultsRev: DEFAULTS_REV,
    server: null, decoder: 'auto', autoOpen: 'off', ambient: true, layout: 'auto',
    captions: defaultCaptions(), subLang: 'en', liveQuality: 'auto',
  };
}

/**
 * A single source of truth across routes.
 *
 * React state alone would leave two mounted routes disagreeing about what is
 * hidden, so writes go through one module-level value and every hook re-reads it.
 */
let store: Stored = typeof globalThis.localStorage === 'undefined'
  ? {
      profiles: [blankProfile()], activeId: 'seed', resumeOnOpen: true, showCounts: false, openStyle: 'page',
      browseStyle: 'list', defaultsRev: DEFAULTS_REV,
      server: null, decoder: 'auto', autoOpen: 'off', ambient: true, layout: 'auto',
      captions: defaultCaptions(), subLang: 'en', liveQuality: 'auto',
    }
  : read();
if (store.activeId === 'seed') store.activeId = store.profiles[0]!.id;

const subs = new Set<(p: Prefs) => void>();

function activeProfile(): Profile {
  return store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0]!;
}

function view(): Prefs {
  const a = activeProfile();
  return {
    hidePaths: a.hidePaths,
    hideCats: a.hideCats,
    hideCatRefs: a.hideCatRefs ?? [],
    hideStreams: a.hideStreams ?? [],
    catOrder: a.catOrder ?? { live: [], movies: [], series: [] },
    streamOrder: a.streamOrder ?? [],
    marketOrder: a.marketOrder ?? [],
    markets: a.markets,
    favs: a.favs ?? NO_FAVS,
    history: a.history ?? [],
    lastPlayed: a.lastPlayed ?? null,
    plays: a.plays ?? [],
    resumeOnOpen: store.resumeOnOpen,
    showCounts: store.showCounts === true,
    openStyle: readOpenStyle(store.openStyle),
    browseStyle: readBrowseStyle(store.browseStyle),
    server: typeof store.server === 'string' && store.server !== '' ? store.server : null,
    decoder: readDecoder(store.decoder),
    autoOpen: readAutoOpen(store.autoOpen),
    ambient: store.ambient !== false,
    layout: store.layout,
    captions: store.captions,
    subLang: store.subLang,
    liveQuality: store.liveQuality,
    profiles: store.profiles,
    activeId: a.id,
  };
}

/**
 * Told after every write, so the backup can follow the store.
 *
 * A callback rather than an import, because `lib/sync.ts` reads this module and an
 * import in the other direction would be a cycle. One listener, registered once at
 * boot; there is no second thing that needs this.
 */
let onWrite: (() => void) | null = null;

export function onPrefsWrite(fn: () => void): void {
  onWrite = fn;
}

function persist(): void {
  try {
    kv.set(KEY, JSON.stringify(store));
  } catch {
    /* private mode */
  }
  onWrite?.();
  setLayoutPref(store.layout);
  const v = view();
  for (const fn of subs) fn(v);
}

export function getPrefs(): Prefs {
  return view();
}

/**
 * Write the store out even though nothing has changed.
 *
 * Preferences are created lazily, so a device that has only ever watched — never
 * hidden a package, never made a profile — has NOTHING in storage, and the first
 * profile the setup screen promises exists only as a default in memory. That is
 * fine until something else looks for it: a settings backup with nothing to send,
 * a probe reading `iptv.prefs.v2` and finding null, a viewer wondering where the
 * profile went. Called once when the first run finishes, which is the moment the
 * app claims the profile exists.
 */
export function persistPrefs(): void {
  persist();
}

/**
 * Re-read storage once the durable backend is in place.
 *
 * The hydration gate in `main.tsx` could not work without this, and had not been
 * working: ES modules evaluate every static import before the importing module's
 * body, so `main.tsx` -> `Chrome` -> `prefs.ts` all finished — including the
 * `read()` at this module's top level — before `boot()` ever called
 * `hydrateKV()`. On a native build that meant profiles, favourites and history
 * were read from `localStorage` and the durable store was consulted only for
 * writes, which is precisely the silent data loss the gate exists to prevent.
 *
 * Cheap and safe to call: it is one JSON parse, it happens before the first
 * render, and it notifies subscribers, of which there are none yet.
 */
export function reloadPrefs(): void {
  store = read();
  if (!store.profiles.some((p) => p.id === store.activeId)) {
    store.activeId = store.profiles[0]!.id;
  }
  setLayoutPref(store.layout);
  const v = view();
  for (const fn of subs) fn(v);
}

/**
 * Update the active profile (or the layout, which is device-wide).
 *
 * Deliberately the same signature the single-profile version had, so every caller
 * that just wants to hide something keeps working without knowing profiles exist.
 */
export function setPrefs(
  patch: Partial<Pick<Prefs, 'hidePaths' | 'hideCats' | 'hideCatRefs' | 'hideStreams' | 'catOrder' | 'streamOrder' | 'marketOrder' | 'markets' | 'favs' | 'layout' | 'captions' | 'subLang' | 'liveQuality' | 'resumeOnOpen' | 'showCounts' | 'openStyle' | 'browseStyle' | 'server' | 'decoder' | 'autoOpen' | 'ambient'>>,
): void {
  if (patch.layout !== undefined) store.layout = patch.layout;
  if (patch.resumeOnOpen !== undefined) store.resumeOnOpen = patch.resumeOnOpen;
  if (patch.showCounts !== undefined) store.showCounts = patch.showCounts;
  if (patch.openStyle !== undefined) store.openStyle = patch.openStyle;
  if (patch.browseStyle !== undefined) store.browseStyle = patch.browseStyle;
  if (patch.server !== undefined) store.server = patch.server;
  if (patch.decoder !== undefined) store.decoder = patch.decoder;
  if (patch.autoOpen !== undefined) store.autoOpen = patch.autoOpen;
  if (patch.ambient !== undefined) store.ambient = patch.ambient;
  if (patch.captions !== undefined) store.captions = patch.captions;
  if (patch.subLang !== undefined) store.subLang = patch.subLang;
  if (patch.liveQuality !== undefined) store.liveQuality = patch.liveQuality;
  const a = activeProfile();
  store.profiles = store.profiles.map((p) =>
    p.id !== a.id
      ? p
      : {
          ...p,
          ...(patch.hidePaths !== undefined ? { hidePaths: patch.hidePaths } : {}),
          ...(patch.hideCats !== undefined ? { hideCats: patch.hideCats } : {}),
          ...(patch.hideCatRefs !== undefined ? { hideCatRefs: patch.hideCatRefs } : {}),
          ...(patch.hideStreams !== undefined ? { hideStreams: patch.hideStreams } : {}),
          ...(patch.catOrder !== undefined ? { catOrder: patch.catOrder } : {}),
          ...(patch.streamOrder !== undefined ? { streamOrder: patch.streamOrder } : {}),
          ...(patch.marketOrder !== undefined ? { marketOrder: patch.marketOrder } : {}),
          ...(patch.markets !== undefined ? { markets: patch.markets } : {}),
          ...(patch.favs !== undefined ? { favs: patch.favs } : {}),
        },
  );
  persist();
}

export function usePrefs(): [Prefs, (p: Parameters<typeof setPrefs>[0]) => void] {
  const [p, setP] = useState(view);
  useEffect(() => {
    subs.add(setP);
    setP(view());
    return () => {
      subs.delete(setP);
    };
  }, []);
  const set = useCallback((patch: Parameters<typeof setPrefs>[0]) => setPrefs(patch), []);
  return [p, set];
}

/** Replace the play log for the active profile. See `lib/watching.ts`. */
export function setPlays(plays: PlayCount[]): void {
  const a = activeProfile();
  store.profiles = store.profiles.map((p) => (p.id === a.id ? { ...p, plays } : p));
  persist();
}

export function setWatchHistory(history: WatchRecord[]): void {
  const a = activeProfile();
  store.profiles = store.profiles.map((p) => (p.id === a.id ? { ...p, history } : p));
  persist();
}

/**
 * Remember, or forget, what is playing.
 *
 * Per profile, because it is a statement about content and profiles are content
 * scopes — resuming a channel the active profile has hidden would be a scope leak
 * dressed up as a convenience.
 */
export function setLastPlayed(mark: LastPlayed | null): void {
  const a = activeProfile();
  store.profiles = store.profiles.map((p) => (p.id === a.id ? { ...p, lastPlayed: mark } : p));
  persist();
}

export function getLastPlayed(): LastPlayed | null {
  return activeProfile().lastPlayed ?? null;
}

/** Record that something was opened. Called once per open, from `resume.ts`. */
export function notePlay(key: string): void {
  if (key === '') return;
  const a = activeProfile();
  const rows = a.plays ?? [];
  const at = Date.now();
  const found = rows.find((r) => r.k === key);
  const next = found === undefined
    ? [{ k: key, n: 1, at }, ...rows]
    : rows.map((r) => (r.k === key ? { k: r.k, n: r.n + 1, at } : r));
  const trimmed = next.length <= PLAYS_MAX
    ? next
    : [...next].sort((x, y) => y.n - x.n || y.at - x.at).slice(0, PLAYS_MAX);
  store.profiles = store.profiles.map((p) => (p.id === a.id ? { ...p, plays: trimmed } : p));
  persist();
}

/**
 * The most-opened streams of one kind, most-watched first.
 *
 * Returns provider ids, which is what the items endpoint takes — the same shape
 * favourites are already queried with, so a rail built from this is one request.
 */
export function topPlayed(kind: number, limit = 24): number[] {
  const prefix = `${kind}.`;
  return (activeProfile().plays ?? [])
    .filter((r) => r.k.startsWith(prefix))
    .sort((x, y) => y.n - x.n || y.at - x.at)
    .slice(0, limit)
    .map((r) => Number(r.k.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function toggleHiddenPath(path: string): void {
  const a = activeProfile();
  setPrefs({
    hidePaths: a.hidePaths.includes(path)
      ? a.hidePaths.filter((p) => p !== path)
      : [...a.hidePaths, path],
  });
}

/**
 * Show or hide a package.
 *
 * Takes the REF, not the row id. The id version hid whatever happened to occupy
 * that row after the next re-ingest.
 */
export function toggleHiddenCat(ref: string): void {
  const a = activeProfile();
  const have = a.hideCatRefs ?? [];
  setPrefs({
    hideCatRefs: have.includes(ref) ? have.filter((c) => c !== ref) : [...have, ref],
  });
}

/** Show or hide one channel or title, by provider id. */
export function toggleHiddenStream(streamId: number | null): void {
  if (streamId === null) return;
  const have = activeProfile().hideStreams ?? [];
  setPrefs({
    hideStreams: have.includes(streamId)
      ? have.filter((x) => x !== streamId)
      : [...have, streamId].slice(0, 500),
  });
}

export function isHiddenCat(ref: string): boolean {
  return (activeProfile().hideCatRefs ?? []).includes(ref);
}

/** The viewer's order for one section, as refs. */
export function setCatOrder(section: 'live' | 'movies' | 'series', refs: string[]): void {
  const a = activeProfile();
  setPrefs({
    catOrder: { ...(a.catOrder ?? { live: [], movies: [], series: [] }), [section]: refs },
  });
}

/** The viewer's own channel order, as provider stream ids. */
export function setStreamOrder(ids: number[]): void {
  setPrefs({ streamOrder: ids });
}

/**
 * Convert a legacy hidden list of row ids into refs, once.
 *
 * Exact only while the generation that wrote those ids is still the live one, which
 * is why it runs at the first opportunity — the moment any category list is in
 * hand — rather than being deferred. Ids that no longer resolve are dropped: they
 * are already meaningless, and keeping them would hide a stranger's package.
 */
export function migrateHiddenCats(byId: Map<number, string>): void {
  const a = activeProfile();
  if (a.hideCats.length === 0) return;
  const gained = a.hideCats.map((id) => byId.get(id)).filter((r): r is string => r !== undefined);
  const merged = [...new Set([...(a.hideCatRefs ?? []), ...gained])];
  /* The ids are cleared whether or not they resolved. An id that does not appear
     in the current catalogue cannot be converted later either — the mapping it
     needed is gone. */
  setPrefs({ hideCats: [], hideCatRefs: merged });
}

/**
 * Star or unstar something for the active profile.
 *
 * @param streamId the PROVIDER id — `item.streamId`, not `item.id`
 */
export function toggleFav(section: FavSection, streamId: number | null): void {
  if (streamId === null) return;
  const favs = activeProfile().favs ?? NO_FAVS;
  const list = favs[section];
  setPrefs({
    favs: {
      ...favs,
      [section]: list.includes(streamId)
        ? list.filter((x) => x !== streamId)
        : [streamId, ...list],
    },
  });
}

export function isFav(section: FavSection, streamId: number | null): boolean {
  if (streamId === null) return false;
  return (activeProfile().favs ?? NO_FAVS)[section].includes(streamId);
}

/**
 * Move one item to a new position within a full list, clamped in range.
 *
 * The generic twin of `lib/ordering.ts`'s `moveTo` — that one works on refs
 * (`<kind>.<provider id>` strings) over a PARTIAL order, because a subscription
 * carries hundreds of packages and nobody ranks all of them. Favourites are the
 * opposite shape: the whole list IS the order, there is no unranked tail to
 * leave alone, and it is keyed by provider id (a number) rather than a ref. Kept
 * local rather than generalising `moveTo` itself, since `lib/ordering.ts` is not
 * this feature's to change.
 */
function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const clamped = Math.max(0, Math.min(out.length - 1, to));
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return [...list];
  out.splice(clamped, 0, moved);
  return out;
}

/**
 * Reorder the bouquet.
 *
 * `toggleFav` UNSHIFTS a new star to the front — that stays exactly as it is,
 * this is the other half: once something is starred, moving it is the only way
 * to say "but I want this one first", which a remote with no drag gesture can
 * only do a step at a time. `routes/Organise.tsx`'s "My channels" calls this
 * with `toIndex = current index ± 1`, the same one-row-at-a-time move
 * `components/Organiser.tsx` already uses for a country or a package
 * (`moveCat`/`moveTarget` there, `moveIndex` here — same idea, numbers instead
 * of refs).
 *
 * A no-op, not a throw, when `streamId` is not actually a favourite — a stale
 * button press (the list changed under it) should do nothing rather than corrupt
 * the order.
 *
 * `/live`'s Favourites view and the Guide's bouquet both read `favs.live` and
 * lay themselves out in this order — see `routes/Live.tsx` and the bouquet
 * branch in `routes/Guide.tsx`.
 */
export function moveFav(section: FavSection, streamId: number, toIndex: number): void {
  const favs = activeProfile().favs ?? NO_FAVS;
  const list = favs[section];
  const from = list.indexOf(streamId);
  if (from < 0) return;
  setPrefs({ favs: { ...favs, [section]: moveIndex(list, from, toIndex) } });
}

/**
 * Replace one section's favourite order wholesale.
 *
 * `moveFav` is the one-step move and stays the way anything moves; this is for
 * putting a list back exactly as it was, which is what BACK means while a row is
 * being carried. Ids not already starred are dropped rather than added — an undo
 * restores an ORDER, it does not resurrect a favourite somebody removed.
 */
export function setFavOrder(section: FavSection, ids: readonly number[]): void {
  const favs = activeProfile().favs ?? NO_FAVS;
  const held = new Set(favs[section]);
  const kept = ids.filter((id) => held.has(id));
  const rest = favs[section].filter((id) => !kept.includes(id));
  setPrefs({ favs: { ...favs, [section]: [...kept, ...rest] } });
}

/** Add or remove a country from the active profile's allow-list. */
export function toggleMarket(code: string): void {
  const a = activeProfile();
  setPrefs({
    markets: a.markets.includes(code) ? a.markets.filter((m) => m !== code) : [...a.markets, code],
  });
}

// ── profile management ─────────────────────────────────────────────────────

export function switchProfile(id: string): void {
  if (!store.profiles.some((p) => p.id === id)) return;
  store.activeId = id;
  persist();
}

export function createProfile(name: string, from?: Profile): Profile {
  const p: Profile = from
    ? { ...from, id: newId(), name: name.slice(0, 40) || 'Profile' }
    : blankProfile(name.slice(0, 40) || 'Profile');
  store.profiles = [...store.profiles, p];
  store.activeId = p.id;
  persist();
  return p;
}

export function renameProfile(id: string, name: string): void {
  store.profiles = store.profiles.map((p) =>
    p.id === id ? { ...p, name: name.slice(0, 40) || p.name } : p,
  );
  persist();
}

export function updateProfile(id: string, patch: Partial<Omit<Profile, 'id'>>): void {
  store.profiles = store.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
  persist();
}

/** Never leave zero profiles: the app would have no scope to render. */
export function deleteProfile(id: string): void {
  if (store.profiles.length <= 1) return;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeId === id) store.activeId = store.profiles[0]!.id;
  persist();
}

/**
 * What every listing call must send.
 *
 * The profile scope, and NOT the user's transient selection — sending a picked
 * country to `/markets` would collapse the country list to the one already picked.
 */
export function scopeParams(p: Prefs): {
  markets?: string[];
  hidePaths?: string[];
  hideCats?: number[];
  hideCatRefs?: string[];
  hideStreams?: number[];
} {
  return {
    ...(p.markets.length > 0 ? { markets: p.markets } : {}),
    ...(p.hidePaths.length > 0 ? { hidePaths: p.hidePaths } : {}),
    ...(p.hideCats.length > 0 ? { hideCats: p.hideCats } : {}),
    ...(p.hideCatRefs.length > 0 ? { hideCatRefs: p.hideCatRefs } : {}),
    ...(p.hideStreams.length > 0 ? { hideStreams: p.hideStreams } : {}),
  };
}

/**
 * Narrow a user's country selection to what the profile allows.
 *
 * With no selection the profile's own list is the scope; with one, the intersection
 * is — so a profile can never be widened from the filter bar.
 */
export function effectiveMarkets(selected: string[], p: Prefs): string[] {
  if (p.markets.length === 0) return selected;
  if (selected.length === 0) return p.markets;
  return selected.filter((m) => p.markets.includes(m));
}

if (typeof document !== 'undefined') setLayoutPref(store.layout);
