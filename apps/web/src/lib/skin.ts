/**
 * Appearance: geometry, palette and light/dark.
 *
 * The same shape as `formFactor.ts` and for the same reason — one module resolves
 * the answer, publishes it on `<html>`, and both CSS and React read it from
 * there, so they cannot drift. Here it is `data-ui`, `data-theme` and `data-mode`,
 * which between them drive every colour token and every corner radius in
 * `index.css`.
 *
 * Why tokens rather than component edits: the app was built squared on purpose
 * ("no rounded cards"), which means roundness lives in ~25 components. Routing it
 * through `--r-*` variables and a small retrofit layer makes it one switch instead
 * of 25 edits, and keeps the squared look available for anyone who preferred it.
 *
 * Device-wide, not per profile, and stored under its own key — the same choice
 * `playerCore` makes for transport and rate. A profile is about WHAT you see;
 * this is about the screen it is on.
 */
import { useEffect, useState } from 'react';
import { kv } from './kv.ts';

/**
 * Corner geometry, as a scale rather than a switch.
 *
 * It was `soft | square`, and "add more layouts like more roundness" is a fair
 * complaint about a two-position control. Every level drives the same `--r-*`
 * variables, so adding one is a set of numbers and nothing else — the rules that
 * spend them are written once against `html[data-ui]:not([data-ui='square'])`.
 */
export type UiShape = 'square' | 'soft' | 'round' | 'pill';

/**
 * The palettes.
 *
 * The first four are the originals. The six after them were specified by the
 * owner as a table of name / style / colours / feel, and the STYLE half is the
 * point: `pop` raises its controls, `neon` makes them glow, `winter` makes its
 * panels translucent, `cinema` flattens everything into the dark. A palette is
 * authored in `index.css`; so is the feel, keyed on the same `data-theme`.
 */
export type ThemeId =
  | 'midnight' | 'carbon' | 'plum' | 'forest'
  | 'gold' | 'neon' | 'pop' | 'cinema' | 'summer' | 'winter';
export type ModePref = 'system' | 'dark' | 'light';
/**
 * Which page the app opens on. Three, and they are three different questions.
 *
 * `showcase` — artwork and rails, for browsing.
 * `classic`  — the big-box launcher, for going straight somewhere.
 * `profiles` — "who's watching" first, for a shared television.
 *
 * All three are real routes (`/home`, `/menu`, `/profiles`) reachable at any time;
 * this only decides where `/` lands.
 */
/**
 * One start page.
 *
 * There were three - the showcase, the classic big-box launcher, and the
 * profile chooser - which meant three landing screens to design, test and keep
 * true, and two of them were alternative navigation for a nav that already
 * exists in the header. Removed on request 2026-09-03.
 */
export type HomeStyle = 'showcase';

/**
 * Which shell the app wears.
 *
 * Two whole layouts rather than a list of toggles, because they are two
 * different opinions about what a television app is and the individual settings
 * that make them up are not independently useful:
 *
 * `classic`  the app as it stands. A header of destinations with the current one
 *            filled in, a settings cog beside the search icon, and a home page
 *            that is a showcase — a spotlight over rails of artwork, for
 *            browsing without a destination in mind.
 *
 * `modern`   a launcher. The same destinations, but the current one is marked by
 *            an accent bar under it rather than a filled pill; no cog in the
 *            header at all; and a home page that is four large tiles and a
 *            clock, for going straight somewhere.
 *
 * Specified by the owner as a table against a mockup — "the one we have right
 * now, should be like classic, and that as modern". `classic` was the default at
 * first, deliberately, so that nobody's television changed appearance merely
 * because a second option had been added.
 *
 * **`modern` is the default now**, asked for once it had been seen on a real
 * television. That reverses the rule above, and the reversal is not free: a set
 * that never chose a shell — including every set from before this setting
 * existed, whose stored skin simply has no `shell` key — comes back looking
 * different after the update. That is the intent, and it is the cost. What is
 * NOT acceptable is overriding somebody who chose: an explicit `'classic'` is
 * still honoured for ever, which is why the parse below tests for classic rather
 * than for modern. Only absence and nonsense fall through to the default.
 *
 * Device-wide like the theme, and for the same reason: a profile is about WHAT
 * you see, and this is about the screen it is on.
 */
export type Shell = 'classic' | 'modern';

/**
 * Colours a viewer has chosen for themselves, on top of whatever theme is on.
 *
 * "allow custom colors and so on and so forth". Five slots, and each one is an
 * EXISTING token rather than a new one, which is the difference between a
 * setting that works everywhere and a setting that works in the four places
 * somebody remembered to wire up:
 *
 *   body    --color-ground    the page behind everything
 *   bars    --color-panel     the header, the panels, every bar
 *   raised  --color-panel-2   sidebars, hovered rows, raised surfaces
 *   accent  --color-tally     the brand colour: titles, chips, LIVE
 *   focus   --color-focus     the highlight ring, and ONLY that
 *
 * Empty means "whatever the theme says", which is why this is a sparse object
 * and not five strings with defaults — a default here would freeze one theme's
 * colour into every other one.
 */
export interface Tint {
  body?: string;
  bars?: string;
  raised?: string;
  accent?: string;
  focus?: string;
}

export const TINT_SLOTS: { key: keyof Tint; label: string; hint: string; token: string }[] = [
  { key: 'body', label: 'Background', hint: 'the page behind everything', token: '--color-ground' },
  { key: 'bars', label: 'Bars & panels', hint: 'the header and every bar', token: '--color-panel' },
  { key: 'raised', label: 'Raised surfaces', hint: 'sidebars and hovered rows', token: '--color-panel-2' },
  { key: 'accent', label: 'Accent', hint: 'titles, chips, LIVE', token: '--color-tally' },
  { key: 'focus', label: 'Highlight', hint: 'the ring that follows the remote', token: '--color-focus' },
];

export interface Skin {
  ui: UiShape;
  theme: ThemeId;
  mode: ModePref;
  /** What `system` resolved to. This is what `data-mode` carries. */
  resolved: 'dark' | 'light';
  home: HomeStyle;
  shell: Shell;
  tint: Tint;
}

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  /** Two swatches: the ground and the accent, enough to recognise a palette. */
  ground: string;
  accent: string;
  /** How it feels, when the swatches cannot say — "Movie theatre", "Glass". */
  note?: string;
}

/**
 * The palettes, named so a picker can show them without importing CSS.
 *
 * The hex values here are the DARK ground and accent of each palette and exist
 * only for the swatches; the palettes themselves are authored in `index.css`,
 * where both modes live side by side and can be read as a pair.
 */
export const THEMES: ThemeMeta[] = [
  { id: 'midnight', label: 'Midnight', ground: '#0b1013', accent: '#e8a34a' },
  { id: 'carbon', label: 'Carbon', ground: '#0c0d10', accent: '#4cc9f0' },
  { id: 'plum', label: 'Plum', ground: '#0e0a14', accent: '#f472b6' },
  { id: 'forest', label: 'Forest', ground: '#08110d', accent: '#d8b44a' },
  /* The six from the owner's table, in its order. `note` is the "feel" column —
     shown in the picker, because a name and two swatches do not tell you that
     `pop` raises its buttons or that `winter` is translucent. */
  { id: 'gold', label: 'Classic Gold', ground: '#000000', accent: '#e8b44a', note: 'Premium, simple' },
  { id: 'neon', label: 'Neon', ground: '#05040a', accent: '#22d3ee', note: 'Young, gaming' },
  { id: 'pop', label: '3D Pop', ground: '#0a1024', accent: '#8b7bfa', note: 'Modern, playful' },
  { id: 'cinema', label: 'Cinema', ground: '#000000', accent: '#c8322f', note: 'Movie theatre' },
  { id: 'summer', label: 'Summer', ground: '#04222b', accent: '#ff7a5c', note: 'Fresh, energetic' },
  { id: 'winter', label: 'Winter', ground: '#050c1c', accent: '#7dd3fc', note: 'Clean, futuristic' },
];

const KEY = 'iptv.skin.v1';

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

/** Parse stored JSON defensively: an unknown value must fall back, never throw. */
export function readSkin(raw: string | null): Omit<Skin, 'resolved'> {
  /* Dark by default rather than `system`. This is a video app: the picture is the
     content, a light chrome around it washes it out, and someone whose laptop is
     in light mode has not asked for a white television. `Auto` is one tap away
     and is honoured properly once chosen. */
  const fallback = {
    ui: 'soft' as UiShape, theme: 'midnight' as ThemeId, mode: 'dark' as ModePref,
    home: 'showcase' as HomeStyle, shell: 'modern' as Shell, tint: {} as Tint,
  };
  if (raw === null) return fallback;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    o = parsed as Record<string, unknown>;
  } catch {
    return fallback;
  }
  return {
    ui: SHAPES.has(String(o['ui'])) ? (o['ui'] as UiShape) : 'soft',
    theme: typeof o['theme'] === 'string' && THEME_IDS.has(o['theme']) ? (o['theme'] as ThemeId) : 'midnight',
    mode: o['mode'] === 'light' ? 'light' : o['mode'] === 'system' ? 'system' : 'dark',
    /* Stored 'classic' and 'profiles' collapse to the only style there is, so a
       viewer who chose one of them still gets a working app. */
    home: 'showcase',
    /*
     * Tested for CLASSIC, not for modern, and the direction is the whole point.
     *
     * Modern is the default, so the fall-through has to land on modern — but a
     * viewer who went into Settings and chose classic must keep it, and a value
     * from a future build or a hand-edited one still must not leave the app in a
     * shell that has no rules written for it. Naming the non-default explicitly
     * is what satisfies both: `'classic'` is honoured, everything else — absent,
     * unknown, rubbish — becomes the default.
     */
    shell: o['shell'] === 'classic' ? 'classic' : 'modern',
    tint: readTint(o['tint']),
  };
}

const SHAPES = new Set<string>(['square', 'soft', 'round', 'pill']);
const TINT_KEYS = new Set<string>(TINT_SLOTS.map((t) => t.key));

/**
 * A stored colour is untrusted text that ends up in a style attribute.
 *
 * `setProperty('--color-ground', value)` with a value of
 * `red;background:url(...)` is a CSS injection, and this value comes back from
 * storage that a viewer — or anything else running on the device — can write. So
 * only `#rgb`, `#rrggbb` and `#rrggbbaa` are accepted, and everything else is
 * dropped rather than sanitised: there is no legitimate reason for a colour
 * picker to produce anything else, so a value that is not one is not a colour
 * with a typo in it.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function readTint(raw: unknown): Tint {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Tint = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!TINT_KEYS.has(k)) continue;
    if (typeof v !== 'string' || !HEX.test(v.trim())) continue;
    out[k as keyof Tint] = v.trim().toLowerCase();
  }
  return out;
}

/** `system` asks the OS; everything else is the explicit answer. */
export function resolveMode(mode: ModePref, prefersDark: boolean): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode;
  return prefersDark ? 'dark' : 'light';
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  // Default to dark when the query is unsupported: this is a TV/media app, and a
  // white flash in a dark room is the worse failure.
  const q = window.matchMedia('(prefers-color-scheme: light)');
  return !q.matches;
}

let stored = readSkin(typeof globalThis.localStorage === 'undefined' ? null : kv.get(KEY));
let skin: Skin = { ...stored, resolved: resolveMode(stored.mode, prefersDark()) };

const subs = new Set<(s: Skin) => void>();

function publish(): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset['ui'] = skin.ui;
    root.dataset['theme'] = skin.theme;
    root.dataset['mode'] = skin.resolved;
    root.dataset['shell'] = skin.shell;
    /*
     * The viewer's own colours, last, so they beat the theme.
     *
     * Written as inline custom properties on `<html>`, which is the highest
     * specificity available without a stylesheet — and removed rather than set
     * to empty when a slot is cleared, so the theme's own value comes back
     * instead of resolving to nothing and painting transparent.
     */
    for (const slot of TINT_SLOTS) {
      const chosen = skin.tint[slot.key];
      if (chosen === undefined) root.style.removeProperty(slot.token);
      else root.style.setProperty(slot.token, chosen);
    }
    /* The browser paints its own scrollbars and form controls from this, and the
       address bar picks it up on mobile — without it a light theme keeps dark
       scrollbars and looks broken at the edges. */
    root.style.colorScheme = skin.resolved;
  }
  for (const fn of subs) fn(skin);
}

function apply(next: Omit<Skin, 'resolved'>, persist: boolean): void {
  stored = next;
  skin = { ...next, resolved: resolveMode(next.mode, prefersDark()) };
  if (persist) kv.set(KEY, JSON.stringify(stored));
  publish();
}

export function getSkin(): Skin {
  return skin;
}

/** Re-read after the durable backend is installed — see `reloadPrefs`. */
export function reloadSkin(): void {
  apply(readSkin(kv.get(KEY)), false);
}

export function setSkin(patch: Partial<Omit<Skin, 'resolved'>>): void {
  apply({ ...stored, ...patch }, true);
}

export function useSkin(): Skin {
  const [s, setS] = useState(skin);
  useEffect(() => {
    subs.add(setS);
    setS(skin);
    return () => {
      subs.delete(setS);
    };
  }, []);
  return s;
}

if (typeof window !== 'undefined') {
  publish();
  const q = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const onChange = () => {
    // Only `system` follows the OS; an explicit choice must not be overridden.
    if (stored.mode !== 'system') return;
    apply(stored, false);
  };
  if (q?.addEventListener) q.addEventListener('change', onChange);
  else q?.addListener?.(onChange);
}
