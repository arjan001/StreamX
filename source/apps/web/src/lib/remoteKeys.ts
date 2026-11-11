/**
 * One keymap for a keyboard, a TV remote and an Android box handset.
 *
 * The player already had a keyboard map, and on a television it covered almost
 * nothing. A remote does not send `k` or `f`; it sends `MediaPlayPause`,
 * `ChannelUp`, `Info`, and — the one that matters most for this app — a dedicated
 * subtitle key. Some handsets send nothing a browser recognises at all, which is
 * why `MainActivity` forwards raw Android keycodes and they are named here too.
 *
 * Pure on purpose: an intent table is exactly the thing that rots silently (a
 * remote nobody here owns sends `MediaTrackNext` where another sends
 * `MediaNextTrack`), and a pure function is the thing a test can pin.
 *
 * Names are INTENTS, not keys. `subtitles` is what the viewer wants; whether that
 * arrives as a labelled remote button, a `c`, or Android keycode 175 is this
 * table's problem and nobody else's.
 */

export type RemoteIntent =
  | 'playPause' | 'play' | 'pause' | 'stop'
  | 'forward' | 'back' | 'nextTrack' | 'prevTrack'
  | 'volumeUp' | 'volumeDown' | 'mute'
  | 'channelUp' | 'channelDown'
  | 'subtitles' | 'audioTrack' | 'info' | 'guide'
  | 'fullscreen' | 'aspect' | 'pip' | 'live'
  | 'faster' | 'slower'
  | 'select' | 'exit'
  | 'up' | 'down' | 'left' | 'right'
  /* The buttons a remote has and a keyboard mostly does not. `favourite` is the
     BOOKMARK key, `catchup` is DVR, `lastChannel` is the "back to the previous
     channel" button every broadcast remote has had for thirty years. */
  | 'search' | 'menu' | 'settings' | 'favourite' | 'catchup' | 'lastChannel'
  | 'skipForward' | 'skipBackward'
  /* The four coloured buttons. These are the one part of a remote with NO fixed
     meaning: the platform convention (Samsung, LG, Sony, DVB red-button) is that
     each screen says what they do right now, and a colour with no legend does
     nothing. So they are intents with no built-in action — `lib/keys.ts` binds
     them per screen, and the same binding draws the legend. */
  | 'red' | 'green' | 'yellow' | 'blue'
  | 'shortcuts'
  | `digit${number}`;

/**
 * `KeyboardEvent.key` → intent.
 *
 * Lower-cased before lookup, so `K` and `k` are one entry. Both spellings of the
 * media-track keys are present because the two are genuinely both in the wild:
 * Chromium emits `MediaTrackNext`, some Android TV builds emit `MediaNextTrack`.
 */
const BY_KEY: Record<string, RemoteIntent> = {
  // ── playback ──
  ' ': 'playPause',
  k: 'playPause',
  mediaplaypause: 'playPause',
  mediaplay: 'play',
  mediapause: 'pause',
  mediastop: 'stop',
  mediafastforward: 'forward',
  mediarewind: 'back',
  /* A keyboard has no transport keys, and these two intents mean "later" and
     "earlier" on every screen that binds them — thirty seconds in the player, two
     hours on the guide. Bracket keys because they are unclaimed and they read as
     direction. Without them the guide's time travel was reachable by remote and by
     mouse but not by keyboard, which is the odd one out. */
  ']': 'forward',
  '[': 'back',
  mediatracknext: 'nextTrack',
  medianexttrack: 'nextTrack',
  mediatrackprevious: 'prevTrack',
  mediaprevioustrack: 'prevTrack',

  // ── sound ──
  m: 'mute',
  audiovolumemute: 'mute',
  volumemute: 'mute',
  audiovolumeup: 'volumeUp',
  volumeup: 'volumeUp',
  audiovolumedown: 'volumeDown',
  volumedown: 'volumeDown',

  // ── channels ──
  channelup: 'channelUp',
  channeldown: 'channelDown',
  pageup: 'channelUp',
  pagedown: 'channelDown',

  // ── the tracks, which is what this was asked for ──
  c: 'subtitles',
  s: 'subtitles',
  subtitle: 'subtitles',
  captions: 'subtitles',
  closedcaptiontoggle: 'subtitles',
  a: 'audioTrack',
  audiotrack: 'audioTrack',

  // ── information ──
  i: 'info',
  info: 'info',
  g: 'guide',
  guide: 'guide',
  tvguide: 'guide',
  programguide: 'guide',

  // ── picture ──
  f: 'fullscreen',
  z: 'aspect',
  p: 'pip',
  l: 'live',

  // ── speed ──
  '>': 'faster',
  '.': 'faster',
  '<': 'slower',
  ',': 'slower',

  // ── destinations ──
  '/': 'search',
  browsersearch: 'search',
  search: 'search',
  contextmenu: 'menu',
  b: 'favourite',
  r: 'catchup',
  '?': 'shortcuts',

  // ── navigation ──
  enter: 'select',
  select: 'select',
  escape: 'exit',
  browserback: 'exit',
  backspace: 'exit',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

/**
 * Android keycodes → intent, for the buttons the WebView does not translate.
 *
 * A WebView turns most of a remote into DOM keys, but not all of it: the caption
 * and audio-track buttons on a set-top handset usually arrive as nothing at all.
 * `MainActivity.onKeyDown` forwards the raw code and this is where it lands.
 *
 * Numbers are the Android `KeyEvent.KEYCODE_*` constants, and THREE of them were
 * wrong — read from memory rather than from the SDK, with a correct-looking name
 * in the comment beside each. Verified against
 * `javap -constants android.view.KeyEvent` in the installed android-35 platform:
 *
 *   172 is GUIDE, not TV_ZOOM_MODE  — so the guide button changed aspect ratio
 *   174 is BOOKMARK, not GUIDE      — so the star button opened the guide
 *   222 is MEDIA_AUDIO_TRACK, not TV — so the audio button jumped to live
 *
 * The Java side forwards by symbolic name and was always right; the numbers only
 * exist on this side, which is exactly why nothing caught it. TV_ZOOM_MODE is
 * 255, TV is 170, and both were unreachable. `remoteKeys.test.ts` now pins every
 * number in this table against a comment naming the constant.
 */
const BY_ANDROID_CODE: Record<number, RemoteIntent> = {
  // ── transport ──
  85: 'playPause',      // MEDIA_PLAY_PAUSE
  126: 'play',          // MEDIA_PLAY
  127: 'pause',         // MEDIA_PAUSE
  86: 'stop',           // MEDIA_STOP
  90: 'forward',        // MEDIA_FAST_FORWARD
  89: 'back',           // MEDIA_REWIND
  87: 'nextTrack',      // MEDIA_NEXT
  88: 'prevTrack',      // MEDIA_PREVIOUS
  272: 'skipForward',   // MEDIA_SKIP_FORWARD
  273: 'skipBackward',  // MEDIA_SKIP_BACKWARD

  // ── channels ──
  166: 'channelUp',     // CHANNEL_UP
  167: 'channelDown',   // CHANNEL_DOWN
  229: 'lastChannel',   // LAST_CHANNEL — "back to what I was watching"

  // ── tracks ──
  175: 'subtitles',     // CAPTIONS
  233: 'subtitles',     // TV_TELETEXT — the subtitle button on European handsets
  222: 'audioTrack',    // MEDIA_AUDIO_TRACK

  // ── destinations ──
  172: 'guide',         // GUIDE
  165: 'info',          // INFO
  84: 'search',         // SEARCH
  82: 'menu',           // MENU
  226: 'menu',          // MEDIA_TOP_MENU
  256: 'menu',          // TV_CONTENTS_MENU
  176: 'settings',      // SETTINGS
  174: 'favourite',     // BOOKMARK — every handset's star/heart button
  173: 'catchup',       // DVR
  170: 'live',          // TV — the "live TV" button

  // ── picture ──
  255: 'aspect',        // TV_ZOOM_MODE — "picture size"
  168: 'aspect',        // ZOOM_IN
  169: 'aspect',        // ZOOM_OUT
  171: 'pip',           // WINDOW — PIP on Android TV handsets

  // ── the coloured buttons ──
  183: 'red',           // PROG_RED
  184: 'green',         // PROG_GREEN
  185: 'yellow',        // PROG_YELLOW
  186: 'blue',          // PROG_BLUE

  // ── sound and navigation ──
  164: 'mute',          // VOLUME_MUTE
  24: 'volumeUp',       // VOLUME_UP
  25: 'volumeDown',     // VOLUME_DOWN
  4: 'exit',            // BACK
  23: 'select',         // DPAD_CENTER
  66: 'select',         // ENTER
  19: 'up',
  20: 'down',
  21: 'left',
  22: 'right',
};

/**
 * Samsung Tizen keyCodes → intent, for the numbers a Tizen TV's own remote
 * delivers on `keydown`. They do NOT follow any standard DOM UI Events keyCode
 * list, and — unlike the Android bridge above — nothing forwards them by hand;
 * a Tizen WebView (Chromium since Tizen 2.4) fires a real `keydown` with these
 * numbers in `KeyboardEvent.keyCode` for the buttons that are not one of the
 * "detected automatically" ones (the arrows, Enter, and Back/Return — Samsung's
 * own phrase — which arrive through `BY_KEY` above like any other keyboard key
 * and are deliberately NOT duplicated here; see `tizenKeys.ts`'s double-dispatch
 * guard).
 *
 * Cross-checked against two independent sources that agree on every value below:
 * Samsung's own Remote Control guide —
 * https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
 * — and the community-maintained table at
 * https://github.com/maikudou/SmartTV/blob/master/keycodes.md, which lists the
 * same numbers independently. Agreement between two sources is not the same
 * thing as a press on a real remote: NEITHER has been run on a Samsung TV by
 * anyone who has touched this file, so treat this table as researched, not
 * measured — `tizenKeys.test.ts` is the only place these numbers are pinned,
 * and it says so again there.
 *
 * Most of these buttons never reach the app at all unless something first calls
 * `tizen.tvinputdevice.registerKey` with the matching NAME (`'ColorF0Red'`,
 * `'MediaPlayPause'`, …) — see `registerTizenKeys` in `tizenKeys.ts`, which is
 * the list this table has to stay in step with.
 */
const BY_TIZEN_CODE: Record<number, RemoteIntent> = {
  // ── leaving — the one every Tizen remote has, and needs no registerKey call ──
  10009: 'exit',        // Return (called "Back" in Samsung's own docs)

  // ── transport ──
  10252: 'playPause',   // MediaPlayPause
  415: 'play',          // MediaPlay
  19: 'pause',          // MediaPause
  413: 'stop',          // MediaStop
  417: 'forward',       // MediaFastForward
  412: 'back',          // MediaRewind
  10233: 'nextTrack',   // MediaTrackNext
  10232: 'prevTrack',   // MediaTrackPrevious

  // ── channels ──
  427: 'channelUp',     // ChannelUp
  428: 'channelDown',   // ChannelDown

  // ── sound ──
  447: 'volumeUp',       // VolumeUp
  448: 'volumeDown',     // VolumeDown
  449: 'mute',            // VolumeMute

  // ── information ──
  457: 'info',           // Info

  // ── the coloured buttons — the Tizen names are literally "F0..F3" ──
  403: 'red',            // ColorF0Red
  404: 'green',          // ColorF1Green
  405: 'yellow',         // ColorF2Yellow
  406: 'blue',           // ColorF3Blue
};

/**
 * The intent a Tizen keyCode means, or null if it means nothing here.
 *
 * Digits 0-9 are handled here too (standard ASCII 48-57, the same numbers a
 * keyboard's own `keyCode` has always used) purely as a defence: they almost
 * certainly already arrive through `intentFor(e.key)` like on any browser, but
 * unlike the buttons above there is no Samsung documentation stating that they
 * are "detected automatically", and getting a channel number wrong is a worse
 * failure than a redundant table entry. `tizenKeys.ts` is what stops this from
 * double-dispatching a digit that `BY_KEY` already caught.
 */
export function intentForTizenCode(code: number): RemoteIntent | null {
  if (code >= 48 && code <= 57) return `digit${code - 48}` as RemoteIntent;
  return BY_TIZEN_CODE[code] ?? null;
}

/**
 * LG's Back button, which is the one key webOS does not share with anyone.
 *
 * The rest of an LG remote arrives as the same numbers a Samsung one sends —
 * 415 play, 19 pause, 413 stop, 412/417 rewind and fast-forward — because those
 * are the standard media keycodes rather than anybody's extension. Back is not:
 * Samsung sends 10009, LG sends **461**, and nothing else in either table
 * collides with it.
 *
 * It matters more here than the number suggests. `appinfo.json` sets
 * `disableBackHistoryAPI`, which stops webOS closing the app the instant Back
 * is pressed — the right choice, because this app has screens to go back
 * through — but it means that if the page does not handle 461 itself, Back does
 * nothing at all and a viewer is stuck on whatever screen they opened. The
 * setting and this entry only make sense together.
 *
 * Researched, not measured: nobody who has touched this file has pressed Back
 * on a webOS television. Same caveat as the Tizen table above.
 */
const BY_WEBOS_CODE: Record<number, RemoteIntent> = {
  461: 'exit',
};

export function intentForWebosCode(code: number): RemoteIntent | null {
  if (code >= 48 && code <= 57) return `digit${code - 48}` as RemoteIntent;
  /* The shared media and channel numbers first, then LG's own. */
  return BY_WEBOS_CODE[code] ?? BY_TIZEN_CODE[code] ?? null;
}

/** The intent a key press means, or null if it means nothing here. */
export function intentFor(key: string): RemoteIntent | null {
  const k = key.toLowerCase();
  if (/^[0-9]$/.test(k)) return `digit${Number(k)}` as RemoteIntent;
  return BY_KEY[k] ?? null;
}

/** The intent a forwarded Android keycode means. */
export function intentForAndroidCode(code: number): RemoteIntent | null {
  // 7..16 are KEYCODE_0..KEYCODE_9; 144..153 are the numeric keypad.
  if (code >= 7 && code <= 16) return `digit${code - 7}` as RemoteIntent;
  if (code >= 144 && code <= 153) return `digit${code - 144}` as RemoteIntent;
  return BY_ANDROID_CODE[code] ?? null;
}

/** Digits are a channel number being typed, and the caller needs the value. */
export function digitOf(intent: RemoteIntent): number | null {
  const m = /^digit([0-9])$/.exec(intent);
  return m ? Number(m[1]) : null;
}

/**
 * Does this key belong to a text field that has focus?
 *
 * The question is about the KEY, not the intent — which is the distinction the
 * first version of this got wrong. `c` means "subtitles" to the player and means
 * the letter c to a search box, so the answer has to look at what was pressed. A
 * single printable character, an arrow, Enter or Escape belongs to the field; a
 * dedicated media or TV button on a remote never does, so pressing pause while
 * the search box has focus still pauses.
 */
export function keyIsTextInput(key: string): boolean {
  if (key.length === 1) return true;
  const k = key.toLowerCase();
  return k === 'enter' || k === 'escape' || k === 'backspace' || k === 'tab'
    || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright'
    || k === 'home' || k === 'end' || k === 'delete';
}

/* ── naming the buttons ─────────────────────────────────────────────────────
   Everything below is display, and it lives here for one reason: a legend that
   is written out separately from the keymap will eventually advertise a button
   that does nothing. The hint bar, the tooltips and the shortcuts sheet all read
   these tables, and `keysFor` is DERIVED from `BY_KEY` above — so a key that is
   not wired cannot be shown, and a key that is wired cannot be forgotten. */

/** What the intent does, in the words the viewer would use. */
export const ACTION_LABEL: Record<string, string> = {
  playPause: 'Play / pause',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  forward: 'Forward',
  back: 'Rewind',
  nextTrack: 'Next channel',
  prevTrack: 'Previous channel',
  channelUp: 'Next channel',
  channelDown: 'Previous channel',
  lastChannel: 'Last channel',
  volumeUp: 'Louder',
  volumeDown: 'Quieter',
  mute: 'Mute',
  subtitles: 'Subtitles',
  audioTrack: 'Audio track',
  info: 'What is on',
  guide: 'TV guide',
  fullscreen: 'Fullscreen',
  aspect: 'Picture size',
  pip: 'Picture in picture',
  live: 'Back to live',
  faster: 'Faster',
  slower: 'Slower',
  search: 'Search',
  menu: 'Menu',
  settings: 'Settings',
  favourite: 'Favourite',
  catchup: 'Catch-up',
  skipForward: 'Skip forward',
  skipBackward: 'Skip back',
  shortcuts: 'All shortcuts',
  select: 'Select',
  exit: 'Back',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

/**
 * The name printed on the physical button, where there is one.
 *
 * Used instead of a keyboard key whenever the screen is being driven by a remote:
 * "SUBTITLE" is what someone looking down at their hand is trying to find, and
 * telling them to press `c` on a television is useless.
 */
export const REMOTE_BUTTON: Record<string, string> = {
  playPause: 'PLAY/PAUSE',
  play: 'PLAY',
  pause: 'PAUSE',
  stop: 'STOP',
  forward: 'FWD',
  back: 'REW',
  nextTrack: 'NEXT',
  prevTrack: 'PREV',
  channelUp: 'CH+',
  channelDown: 'CH−',
  lastChannel: 'LAST',
  volumeUp: 'VOL+',
  volumeDown: 'VOL−',
  mute: 'MUTE',
  subtitles: 'SUBTITLE',
  audioTrack: 'AUDIO',
  info: 'INFO',
  guide: 'GUIDE',
  aspect: 'ZOOM',
  live: 'TV',
  search: 'SEARCH',
  menu: 'MENU',
  settings: 'SETTINGS',
  favourite: 'STAR',
  catchup: 'DVR',
  skipForward: 'SKIP+',
  skipBackward: 'SKIP−',
  select: 'OK',
  exit: 'BACK',
  up: '▲',
  down: '▼',
  left: '◀',
  right: '▶',
  red: 'RED',
  green: 'GREEN',
  yellow: 'YELLOW',
  blue: 'BLUE',
};

/** The four context buttons, in the order every remote prints them. */
export const COLOUR_INTENTS = ['red', 'green', 'yellow', 'blue'] as const;
export type ColourIntent = (typeof COLOUR_INTENTS)[number];

/** The colour a coloured button is, for drawing its chip. */
export const COLOUR_HEX: Record<ColourIntent, string> = {
  red: '#e0454f',
  green: '#3fae5a',
  yellow: '#e3b23c',
  blue: '#3f7fe0',
};

/** How a `KeyboardEvent.key` is written on a key cap. */
const KEY_CAP: Record<string, string> = {
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
};

/**
 * Keys that exist on a keyboard, as opposed to names only a remote sends.
 *
 * `mediaplaypause` is a real `KeyboardEvent.key` and a real thing to handle, but
 * printing it in a legend would be nonsense — nobody has a key labelled that.
 */
function isTypeable(key: string): boolean {
  if (key.length === 1) return true;
  return key in KEY_CAP;
}

/** The keyboard keys, as key caps, that reach this intent. Derived, not written. */
export function keysFor(intent: RemoteIntent): string[] {
  const out: string[] = [];
  for (const [key, target] of Object.entries(BY_KEY)) {
    if (target !== intent || !isTypeable(key)) continue;
    out.push(KEY_CAP[key] ?? key.toUpperCase());
  }
  return out;
}

/**
 * The full catalogue, grouped the way the sheet shows it.
 *
 * Order is by how often a person reaches for the thing, not alphabetically, and
 * the groups match the parts of the remote people think in — transport, channels,
 * what-is-on, picture.
 */
export const SHORTCUT_GROUPS: { title: string; intents: RemoteIntent[] }[] = [
  {
    title: 'Watching',
    intents: ['playPause', 'stop', 'back', 'forward', 'slower', 'faster', 'mute', 'volumeDown', 'volumeUp'],
  },
  {
    title: 'Channels',
    intents: ['channelUp', 'channelDown', 'lastChannel', 'live', 'favourite'],
  },
  {
    title: 'Sound and subtitles',
    intents: ['subtitles', 'audioTrack'],
  },
  {
    title: 'Picture',
    intents: ['fullscreen', 'aspect', 'pip'],
  },
  {
    title: 'Getting around',
    intents: ['up', 'down', 'left', 'right', 'select', 'exit', 'search', 'guide', 'catchup', 'info', 'menu', 'settings', 'shortcuts'],
  },
];
