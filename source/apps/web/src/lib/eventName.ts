import { unshout } from './titleCase.ts';

/**
 * A channel whose NAME is the programme.
 *
 * Event channels carry the fixture in their own name, because that is the only
 * field a panel has for it: "i think most of the channels already have what's
 * playing in title … they are all really bad, and should be formatted properly".
 * Six shapes, all from the frozen fixture of the owner's own line:
 *
 *   End | Sassuolo - Frosinone | Coppa Italia | 2026-09-02 | 13:00 (GMT) | 8K EXCLUSIVE | BE: DAZN PPV 4
 *   End | Stage 11 | Cartagena - Lorca | all | 02-09-2026 | 14:35 (GMT) | 8K EXCLUSIVE | ES: SOCCER PPV 6
 *   NEXT | F1 WEEKEND WARM-UP | Thu 03 Sep 14:30 UTC (UK) | 8K EXCLUSIVE | UK: APPLE TV F1 PPV 1
 *   Tennis: Alexander Zverev vs Lorenzo Sonego @ Sep 2 02:47 AM :MAX FR  01
 *   BE| DAZN 1 - RAAL La Louvière - KV Mechelen Jupiler Pro League 2026-08-29 15:35
 *   National League 1 | Final Oldham vs Southend // UK Sun 1 Jun 3:00pm // ET Sun 1 Jun 10:00am
 *
 * Read into the parts a row can lay out: the fixture, the competition, when it
 * is (in the viewer's own clock when the name says which zone it was written
 * in), which feed, and whether it is on, next or over. A name with no date and
 * no status word is an ordinary channel and comes back null.
 *
 * Pure: `now` is passed in, so every rule here is a line in eventName.test.ts.
 */
export type EventState = 'live' | 'next' | 'ended';

export interface ChannelEvent {
  title: string;
  competition: string | null;
  /** The instant, when a date was found. */
  at: Date | null;
  /** True when `at` came with a zone and so is a real instant, not a wall clock. */
  zoned: boolean;
  feed: string | null;
  state: EventState | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
/* Offsets in minutes east of UTC. ET is written year-round and meant as "US
   Eastern"; four hours off in the season these listings are from. */
const ZONES: Record<string, number> = {
  GMT: 0, UTC: 0, WET: 0, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  ET: -240, EST: -300, EDT: -240, CT: -300, PT: -420,
};

const STATUS = /^(end(?:ed)?|finished|live|next|upcoming)$/i;
const FILLER = /^(all|\d+k(?: exclusive)?|exclusive|hd|fhd|uhd)$/i;
const FEED = /^[A-Z]{2,4}\s*:\s*\S.*$/;

interface Found { at: Date; zoned: boolean }

/** Every date shape the fixture uses, tried against one string. */
function findDate(text: string, now: Date): { found: Found; rest: string } | null {
  const year = now.getUTCFullYear();
  const make = (y: number, mo: number, d: number, h: number, mi: number, zone: string | undefined): Found => {
    const off = zone === undefined ? undefined : ZONES[zone.toUpperCase()];
    if (off === undefined) return { at: new Date(y, mo, d, h, mi), zoned: false };
    return { at: new Date(Date.UTC(y, mo, d, h, mi) - off * 60_000), zoned: true };
  };
  const hour = (h: string, ap: string | undefined) => {
    let n = Number(h);
    if (ap !== undefined) {
      const pm = ap.toLowerCase() === 'pm';
      if (pm && n < 12) n += 12;
      if (!pm && n === 12) n = 0;
    }
    return n;
  };
  /* A day and month with no year: the nearest one — a listing from last
     December read in January is last year's, not eleven months ahead. */
  const nearestYear = (mo: number, d: number) => {
    const guess = new Date(year, mo, d).getTime();
    const half = 183 * 86_400_000;
    if (guess - now.getTime() > half) return year - 1;
    if (now.getTime() - guess > half) return year + 1;
    return year;
  };
  let m: RegExpExecArray | null;
  // 2026-09-02 | 13:00 (GMT)   ·   2026-08-29 15:35
  if ((m = /(\d{4})-(\d{2})-(\d{2})(?:[ |]+(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*\(?\s*([A-Z]{2,4})\s*\)?)?)?/.exec(text))) {
    return {
      found: make(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), m[6]),
      rest: text.replace(m[0], ' '),
    };
  }
  // 02-09-2026 | 14:35 (GMT)
  if ((m = /(\d{2})-(\d{2})-(\d{4})(?:[ |]+(\d{1,2}):(\d{2})(?:\s*\(?\s*([A-Z]{2,4})\s*\)?)?)?/.exec(text))) {
    return {
      found: make(+m[3]!, +m[2]! - 1, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), m[6]),
      rest: text.replace(m[0], ' '),
    };
  }
  // Thu 03 Sep 14:30 UTC (UK)   ·   UK Sun 1 Jun 3:00pm
  if ((m = new RegExp(`(?:${DAY}\\s+)?(\\d{1,2})\\s+${MON}\\s+(\\d{1,2}):(\\d{2})(?:\\s*(am|pm))?(?:\\s+([A-Z]{2,4}))?(?:\\s*\\([A-Z]{2}\\))?`, 'i').exec(text))) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const d = +m[1]!;
    return {
      found: make(nearestYear(mo, d), mo, d, hour(m[3]!, m[5]), +m[4]!, m[6]),
      rest: text.replace(m[0], ' '),
    };
  }
  // Sep 2 02:47 AM   ·   Sep 6 16:30 PM (a 24-hour clock with a stray PM)
  if ((m = new RegExp(`${MON}\\s+(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?`, 'i').exec(text))) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    const d = +m[2]!;
    const h = +m[3]! > 12 ? +m[3]! : hour(m[3]!, m[5]);
    return {
      found: make(nearestYear(mo, d), mo, d, h, +m[4]!, undefined),
      rest: text.replace(m[0], ' '),
    };
  }
  return null;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s\-–:|/@]+|[\s\-–:|/@]+$/g, '').trim();

/** A sport's name as a lead-in — `Tennis:`, `Ciclismo:` — which the screen already
    says. Only sport words: "Preseason: Falcons vs. Dolphins" keeps its word. */
const SPORT_LEAD = /^(tennis|tenis|ciclismo|cycling|football|soccer|futbol|fútbol|voetbal|basketball|baloncesto|golf|rugby|cricket|boxing|boxeo|darts|snooker|hockey|volleyball|voleibol|handball|balonmano|motogp|f1|formula 1|nfl|nba|mlb|nhl|ufc|mma|wwe|athletics|atletismo)\s*:\s+/i;
/** Two sides of a fixture: "A vs B", "A v B", "A - B", "A @ B". */
const FIXTURE = /\s(?:vs\.?|v)\s|\s[-–]\s|\s@\s/i;
/** Numbered event feeds: "LIVE EVENT 21 - Leeds vs Plymouth". */
const NUMBERED = /^((?:live\s+)?event\s*\d+|ppv\s*\d+)\s*[-:|]\s*(.+)$/i;

export function parseEvent(name: string, now: Date = new Date()): ChannelEvent | null {
  let text = name.trim();
  let state: EventState | null = null;
  let feed: string | null = null;

  /* ":MAX FR  01" after an "@ date" is the feed. */
  const colonFeed = /\s:\s*([A-Za-z][^:@|]*?\s*\d{1,3})\s*$/.exec(text);
  if (colonFeed !== null && /@/.test(text)) {
    feed = tidy(colonFeed[1]!);
    text = text.slice(0, colonFeed.index);
  }
  /* "… // UK Sun 1 Jun 3:00pm // ET Sun 1 Jun 10:00am": the first clock is the
     one the name leads with; the second is the same instant written again. */
  const clocks = text.split(/\s\/\/\s/);
  if (clocks.length > 1) text = `${clocks[0]} | ${clocks[1]}`;

  const dated = findDate(text, now);
  if (dated !== null) text = dated.rest;
  let at = dated?.found.at ?? null;
  /* A date far in the future is an empty slot's placeholder, not a fixture. */
  if (at !== null && at.getTime() - now.getTime() > 400 * 86_400_000) at = null;

  /* A date cut out of "(… 13:00:00)" leaves its brackets behind. */
  text = text.replace(/\(\s*\)/g, ' ');
  let parts = text.split('|').map(tidy).filter((p) => p !== '');
  /* "(Fanatiz 001) | Buffaloes vs Eagles": a bracketed lead part is the feed. */
  if (parts.length > 1 && /^\([^()]+\)$/.test(parts[0]!)) {
    feed ??= parts[0]!.slice(1, -1).trim();
    parts = parts.slice(1);
  }
  while (parts.length > 0 && STATUS.test(parts[0]!)) {
    const w = parts[0]!.toLowerCase();
    /* "ENDED | LIVE | …" — the earlier word is the newer one. */
    state ??= w.startsWith('end') || w === 'finished' ? 'ended' : w === 'live' ? 'live' : 'next';
    parts = parts.slice(1);
  }
  const numbered = parts.length === 1 ? NUMBERED.exec(parts[0]!) : null;
  if (numbered !== null) {
    feed ??= tidy(numbered[1]!);
    parts = [numbered[2]!];
  }
  if (at === null && state === null && numbered === null) return null;

  parts = parts.filter((p) => !FILLER.test(p) && !/^[A-Z]{2,3}$/.test(p));
  if (feed === null && parts.length > 1 && FEED.test(parts[parts.length - 1]!)) feed = tidy(parts.pop()!);

  /* The fixture is the title — whichever part has two sides — and the rest
     is what it is part of. "National League 1 | Final Oldham vs Southend". */
  const fixtureAt = parts.findIndex((p) => FIXTURE.test(` ${p} `));
  const t = fixtureAt > 0 ? fixtureAt : 0;
  let title = parts[t] ?? '';
  const others = parts.filter((_, k) => k !== t);
  let competition: string | null = others.length > 0 ? others.join(' · ') : null;

  const lead = SPORT_LEAD.exec(title);
  if (lead !== null) title = title.slice(lead[0].length);
  /* "DAZN 1 - Team A - Team B …", "UK: VOLLEY PPV 4 - A vs B, …": the feed
     leads the title. */
  const dash = /^((?:[A-Z]{2,3}:\s*)?(?:DAZN|ESPN|SKY|BEIN|TNT|VIX|MAX|[\p{L} ]*PPV)[^-]*?\d+)\s+-\s+(.+)$/iu.exec(title);
  if (dash !== null) {
    feed ??= tidy(dash[1]!);
    title = dash[2]!;
  }
  title = unshout(tidy(title));
  if (competition !== null) competition = unshout(tidy(competition)) || null;
  if (title === '') return null;

  /* The date is the truth when there is one: a name frozen into a catalogue
     keeps saying LIVE long after the match. */
  if (at !== null) {
    const age = now.getTime() - at.getTime();
    state = age > 3 * 3_600_000 ? 'ended' : age >= 0 ? 'live' : 'next';
  }
  return { title, competition, at, zoned: at !== null && (dated?.found.zoned ?? false), feed, state };
}

/**
 * "Today 20:00", "Tomorrow 14:30", "Sat 6 Sep · 16:30" — how a row says when.
 * `locale` and `now` passed in for the tests; the app passes neither.
 */
export function eventWhen(at: Date, now: Date = new Date(), locale?: string): string {
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  const date = at.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${date} · ${time}`;
}
