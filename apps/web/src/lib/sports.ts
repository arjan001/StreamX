/**
 * Pure logic for Sports TV: the order and hiding of the sports rail, borrowing a
 * guide from a sibling feed, and the now/next/progress maths for a row.
 *
 * Sports TV is Live TV's screen in `sports` mode (routes/Live.tsx), and this is
 * the part of it that is only sport. Nothing here touches the DOM, the catalogue
 * or storage, so every rule is a table in `sports.test.ts` rather than something
 * only provable by looking at a television.
 */
import { normalise, SPORTS, type Topic } from './topics.ts';
import { progress, slotAt, type Slot } from './guide.ts';

/* ── the rail: which sports, in which order, and which are hidden ───────────── */

/** Sport that is none of the fifteen; see `OTHER_SPORT` in lib/topicIndex.ts. */
export const OTHER_SPORT_TOPIC: Topic = { id: 'othersport', label: 'Other sport' };

/** Every row the rail can show, in the owner's order, "Other sport" last. */
export const RAIL_SPORTS: readonly Topic[] = [...SPORTS, OTHER_SPORT_TOPIC];

export interface RailSport extends Topic {
  count: number;
  hidden: boolean;
}

/**
 * The rail as the viewer arranged it.
 *
 * Same contract as a package order (`lib/ordering.ts`): `order` is partial —
 * whatever was carried somewhere comes first, in that order, and everything
 * else keeps the owner's order behind it. Empty sports are not drawn. Hidden
 * ones are still drawn, last and dimmed, so the way back is where they went.
 */
export function arrangeSports(
  counts: ReadonlyMap<string, number>,
  order: readonly string[],
  hidden: readonly string[],
): RailSport[] {
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const hide = new Set(hidden);
  const rows = RAIL_SPORTS
    .map((t, natural) => ({ ...t, count: counts.get(t.id) ?? 0, hidden: hide.has(t.id), natural }))
    .filter((t) => t.count > 0);
  rows.sort((a, b) => (Number(a.hidden) - Number(b.hidden))
    || ((rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    || (a.natural - b.natural));
  return rows.map(({ natural: _n, ...t }) => t);
}

/**
 * Which sport the list shows.
 *
 * The requested one while it has channels and is not hidden — a profile that
 * hid every football package must not have its own link silently switch sport.
 * Otherwise the first visible sport, or null when nothing on this line is sport.
 */
export function pickSport(rail: readonly RailSport[], requested: string | null): string | null {
  const shown = rail.filter((s) => !s.hidden);
  if (requested !== null && shown.some((s) => s.id === requested)) return requested;
  return shown[0]?.id ?? null;
}

/* ── borrowing a guide from a sibling feed ───────────────────────────────────── */

/**
 * Quality/format words a panel appends to an otherwise identical channel name —
 * stripped before two names are compared, so "SKY SPORTS F1 HD" and
 * "SKY SPORTS F1 FHD" read as the same channel. "PPV" is deliberately NOT here:
 * it usually marks a genuinely different (paid) feed, not a quality variant.
 */
const QUALITY_WORDS = new Set(['HD', 'FHD', 'UHD', 'SD', '4K', 'HEVC', '50FPS', '60FPS', 'RAW']);

/**
 * A donor-matching key for a channel name.
 *
 * Built on `topics.ts`'s own `normalise` — which already uppercases, strips
 * accents, drops a leading country prefix (`UK|`, `ES:`, `[BR]`) and, as a side
 * effect of keeping only `[A-Z0-9+]`, strips the superscript quality marks some
 * panels use (`ᴴᴰ`, `ᴿᴬᵂ`) since they fall outside that set. This only adds the
 * ASCII quality words on top, plus the "H265"/"H 265" pair the punctuation-strip
 * in `normalise` splits in two.
 */
export function donorNameKey(name: string): string {
  const n = normalise(name).replace(/\bH ?265\b/g, ' ');
  const words = n.split(' ').filter((w) => w !== '' && !QUALITY_WORDS.has(w));
  return words.join(' ');
}

export interface DonorInput {
  id: number;
  name: string;
  /** Empty string and null are both "no id". */
  tvgId: string | null;
}

/**
 * Which channels a channel with no guide may borrow one from: a sibling with the
 * same non-empty `tvgId`, or (also, and regardless) a sibling with the same name
 * once quality words, superscripts and a country prefix are stripped.
 *
 * Only ever called with the channels of ONE sport — "sibling in the same sport
 * set" — so no cross-sport filtering happens here.
 */
export function guideDonors(items: readonly DonorInput[]): Map<number, number[]> {
  const byTvgId = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  for (const it of items) {
    if (it.tvgId !== null && it.tvgId !== '') {
      let list = byTvgId.get(it.tvgId);
      if (list === undefined) byTvgId.set(it.tvgId, (list = []));
      list.push(it.id);
    }
    const key = donorNameKey(it.name);
    if (key !== '') {
      let list = byName.get(key);
      if (list === undefined) byName.set(key, (list = []));
      list.push(it.id);
    }
  }
  const out = new Map<number, number[]>();
  for (const it of items) {
    const seen = new Set<number>([it.id]);
    const donors: number[] = [];
    if (it.tvgId !== null && it.tvgId !== '') {
      for (const id of byTvgId.get(it.tvgId) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        donors.push(id);
      }
    }
    const key = donorNameKey(it.name);
    if (key !== '') {
      for (const id of byName.get(key) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        donors.push(id);
      }
    }
    if (donors.length > 0) out.set(it.id, donors);
  }
  return out;
}

/** The ids to ask `epgGrid`/`epgTopup` for: the visible channels, plus every
    donor a visible channel might borrow from. */
export function guideRequestIds(
  visibleIds: readonly number[],
  donors: ReadonlyMap<number, readonly number[]>,
): number[] {
  const set = new Set(visibleIds);
  for (const id of visibleIds) for (const donorId of donors.get(id) ?? []) set.add(donorId);
  return [...set];
}

export interface GuideAnswer {
  slots: readonly Slot[];
  known: boolean;
}

/**
 * A channel's guide: its own, or the first donor's that actually has one.
 *
 * "Known" here means the ROW has something to show — a donor's slots count as
 * known even though this channel's own listings never arrived.
 */
export function resolveChannelGuide(
  channelId: number,
  guide: ReadonlyMap<number, GuideAnswer>,
  donors: ReadonlyMap<number, readonly number[]>,
): GuideAnswer {
  const own = guide.get(channelId);
  if (own !== undefined && own.slots.length > 0) return own;
  for (const donorId of donors.get(channelId) ?? []) {
    const d = guide.get(donorId);
    if (d !== undefined && d.slots.length > 0) return { slots: d.slots, known: true };
  }
  return own ?? { slots: [], known: false };
}

/* ── now / next / progress ───────────────────────────────────────────────────── */

export interface SportsSlot {
  title: string;
  startTs: number;
  stopTs: number | null;
}

export interface SportsNowNext {
  now: SportsSlot | null;
  next: SportsSlot | null;
  /** 0-100, only while `now` is on air with a known end. */
  progressPct: number | null;
}

/** What the row's two guide lines show: NOW (with how far through it is) and
    NEXT. Built on `lib/guide.ts`'s own `slotAt`/`progress` rather than a second
    copy of that arithmetic. */
export function sportsNowNext(slots: readonly Slot[], nowS: number): SportsNowNext {
  const sorted = [...slots].sort((a, b) => a.startTs - b.startTs);
  const now = slotAt(sorted, nowS);
  const floor = now === null ? nowS : (now.stopTs ?? nowS);
  const next = sorted.find((s) => s !== now && s.startTs >= floor) ?? null;
  const frac = now === null ? null : progress(now, nowS);
  return {
    now: now === null ? null : { title: now.title ?? 'Unnamed programme', startTs: now.startTs, stopTs: now.stopTs },
    next: next === null ? null : { title: next.title ?? 'Unnamed programme', startTs: next.startTs, stopTs: next.stopTs },
    progressPct: frac === null ? null : Math.max(0, Math.min(100, Math.round(frac * 100))),
  };
}

/* ── what's on: the order a sport's channels are listed in ──────────────────── */

/*
 * "the sports area should mostly be sorted based on EPG because it has data".
 *
 * Counted on the owner's line before a word of this was written: of 722 sport
 * channels with a programme on air, 109 were showing a match or something the
 * guide itself called live — "Live: NFL Football", "Nogomet (M): Juventus -
 * Atalanta", "Intl Cricket: England v Sri Lanka" — and 43 were a closedown card
 * ("Kanalpause", "Fin des programmes", "Sem Emissão"). The rest were magazine
 * shows, documentaries and replays. So a sport's list leads with the first
 * group, then what kicks off soon, then everything else on air, and ends with
 * the channels showing nothing at all — which is the order somebody holding a
 * remote would sort it in by hand.
 */

/** The guide's own word for live, in the languages the measured guide uses. */
const LIVE_WORD = /(?:^|[\s:(\[|-])(?:live|en vivo|en directo|directo|en direct|ao vivo|in diretta|diretta|canl[ıi]|na [żz]ywo)(?=$|[\s:)\]!|,.-])/iu;
/** Two sides: "A v B", "A vs. B", "Flamengo x Palmeiras", "Football: A - B". */
const MATCHUP = /\p{L}\s+[vV](?:[sS]\.?|\.)?\s+\p{L}|\p{Lu}\p{L}+\s+x\s+\p{Lu}|:\s*[^:]{2,40}?\s[-–]\s\p{Lu}/u;
/** Said on the tin: this is not the match itself. */
const NOT_LIVE = /\b(?:highlights?|replay|rerun|re-run|repeat|classics?|best of|review|magazine|preview|wiederholung|resumen|r[ée]sum[ée]|samenvatting|skr[óo]t)\b|\((?:r|wh)\)/iu;
/** A closedown card rather than a programme. */
const OFF_AIR = /^(?:sendeophold|sendepause|kanalpause|kanalen sender|fin des programmes|pas de programme|programmes de nuit|sem emiss|off ?air|closedown|end of transmission|brak źródła|kein programm|no information|to be announced|tb[ac]\b)/iu;

export type LiveKind = 'live' | 'match' | null;

/** Is this programme the event itself, as far as its title says? `live` only
    when the guide used the word — a match at 3 a.m. may well be a replay, so
    it is `match`, and the row never calls it live. */
export function liveKind(title: string): LiveKind {
  if (NOT_LIVE.test(title)) return null;
  if (LIVE_WORD.test(title)) return 'live';
  if (MATCHUP.test(title)) return 'match';
  return null;
}

export function offAir(title: string): boolean {
  return OFF_AIR.test(title.trim());
}

export interface OnNowRank {
  /** 0 on now and live · 1 starting soon · 2 something else on · 3 nothing. */
  tier: 0 | 1 | 2 | 3;
  /** Kick-off within the tier, so the same match on five channels sits together. */
  at: number;
  title: string;
}

/** How far ahead "starting soon" looks. */
export const SOON_S = 2 * 3600;

/**
 * Where one channel goes. `event` is what an event channel's own name says (see
 * lib/eventName.ts): those carry no guide, and their name is the schedule.
 */
export function onNowRank(
  nn: SportsNowNext,
  nowS: number,
  event: { state: 'live' | 'next' | 'ended' | null; at: number | null } | null = null,
): OnNowRank {
  const now = nn.now;
  if (now !== null && !offAir(now.title) && liveKind(now.title) !== null) {
    return { tier: 0, at: now.startTs, title: now.title };
  }
  const next = nn.next;
  if (next !== null && next.startTs - nowS <= SOON_S && liveKind(next.title) !== null) {
    return { tier: 1, at: next.startTs, title: next.title };
  }
  if (now !== null && !offAir(now.title)) return { tier: 2, at: 0, title: '' };
  if (event !== null) {
    if (event.state === 'live') return { tier: 0, at: event.at ?? nowS, title: '' };
    if (event.state === 'next' && event.at !== null && event.at - nowS <= SOON_S) {
      return { tier: 1, at: event.at, title: '' };
    }
    if (event.state === 'next') return { tier: 2, at: 0, title: '' };
  }
  return { tier: 3, at: 0, title: '' };
}

/**
 * The list in what's-on order. Stable: inside "something else on" and "nothing"
 * the channels keep the order they came in, which is the provider's (or the
 * viewer's own, when they arranged it).
 */
export function orderByOnNow<T>(items: readonly T[], rankOf: (item: T) => OnNowRank): T[] {
  return items
    .map((item, i) => ({ item, i, r: rankOf(item) }))
    .sort((a, b) => (a.r.tier - b.r.tier)
      || (a.r.tier <= 1 ? (a.r.at - b.r.at) || a.r.title.localeCompare(b.r.title) : 0)
      || (a.i - b.i))
    .map((x) => x.item);
}

/* ── live, next, ended: what a channel is doing ─────────────────────────────── */

export type ChannelStatus = 'live' | 'next' | 'ended';

/**
 * What a sport channel is doing, for the list's Show menu.
 *
 * The GUIDE decides whenever there is one — "real things must come from EPG":
 * the guide is refreshed twice a day, and the playlist a PPV channel's name
 * lives in is often days old (the owner's Football list carried "Shenzhen Open"
 * and "Medvedev vs. Rublev" on `FR: SOCCER PPV` feeds, all ended the day
 * before). Only a channel with no guide at all falls back to what its name
 * says (lib/eventName.ts). An ordinary channel with neither says nothing, and
 * is shown under All only.
 */
export function channelStatus(
  nn: SportsNowNext,
  hasGuide: boolean,
  event: { state: 'live' | 'next' | 'ended' | null } | null,
): ChannelStatus | null {
  if (hasGuide) {
    if (nn.now !== null && !offAir(nn.now.title)) return 'live';
    if (nn.next !== null && !offAir(nn.next.title)) return 'next';
    return 'ended';
  }
  return event?.state ?? null;
}

/* ── today / tomorrow: time-based filtering ───────────────────────────────────── */

/**
 * Check if a programme slot falls within today's date (midnight to midnight).
 */
export function isToday(slot: SportsSlot, nowS: number): boolean {
  const nowDate = new Date(nowS * 1000);
  const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  return slot.startTs >= Math.floor(startOfDay.getTime() / 1000) &&
         slot.startTs < Math.floor(endOfDay.getTime() / 1000);
}

/**
 * Check if a programme slot falls within tomorrow's date.
 */
export function isTomorrow(slot: SportsSlot, nowS: number): boolean {
  const nowDate = new Date(nowS * 1000);
  const startOfTomorrow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  const endOfTomorrow = new Date(startOfTomorrow.getTime() + 24 * 60 * 60 * 1000);
  return slot.startTs >= Math.floor(startOfTomorrow.getTime() / 1000) &&
         slot.startTs < Math.floor(endOfTomorrow.getTime() / 1000);
}

/**
 * Check if a channel has any programme today or tomorrow.
 */
export function hasProgrammeInWindow(
  slots: readonly Slot[],
  nowS: number,
  window: 'today' | 'tomorrow',
): boolean {
  for (const slot of slots) {
    const s: SportsSlot = {
      title: slot.title ?? '',
      startTs: slot.startTs ?? 0,
      stopTs: slot.stopTs,
    };
    if (window === 'today' && isToday(s, nowS)) return true;
    if (window === 'tomorrow' && isTomorrow(s, nowS)) return true;
  }
  return false;
}
