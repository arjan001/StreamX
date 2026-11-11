import { useSyncExternalStore } from 'react';
import { kv } from './kv.ts';
import { localItems } from './localRead.ts';
import { topicStreams } from './topicIndex.ts';
import { RAIL_SPORTS } from './sports.ts';
import type { ItemQuery } from './api.ts';

/**
 * How the viewer arranged the Sports TV rail — which sports come first, which
 * are hidden — and how many channels each one has.
 *
 * One store rather than state in the rail, because two things read it: the rail
 * draws it, and the Live screen in sports mode uses it to decide which sport the
 * list is showing (a sport hidden while it is open must hand the list to the next
 * one at once, not on the next visit). The pure rules are `arrangeSports` and
 * `pickSport` in lib/sports.ts.
 *
 * Device-wide, in the key-value store: the package order and hidden packages it
 * mirrors are about what this television shows, and there is one television.
 */
const ORDER_KEY = 'iptv.sports.order';
const HIDDEN_KEY = 'iptv.sports.hidden';

export interface SportArrangement {
  order: readonly string[];
  hidden: readonly string[];
}

function readList(key: string): string[] {
  try {
    const raw = kv.get(key);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function writeList(key: string, v: readonly string[]): void {
  try { kv.set(key, JSON.stringify(v)); } catch { /* private mode */ }
}

let state: SportArrangement | null = null;
const subs = new Set<() => void>();

export function sportArrangement(): SportArrangement {
  if (state === null) state = { order: readList(ORDER_KEY), hidden: readList(HIDDEN_KEY) };
  return state;
}

function publish(next: SportArrangement): void {
  state = next;
  for (const fn of subs) { try { fn(); } catch { /* a subscriber's problem */ } }
}

export function setSportOrder(order: readonly string[]): void {
  writeList(ORDER_KEY, order);
  publish({ ...sportArrangement(), order: [...order] });
}

export function toggleSportHidden(id: string): void {
  const now = sportArrangement().hidden;
  const hidden = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
  writeList(HIDDEN_KEY, hidden);
  publish({ ...sportArrangement(), hidden });
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function useSportArrangement(): SportArrangement {
  return useSyncExternalStore(subscribe, sportArrangement, sportArrangement);
}

/**
 * Channels per rail row, inside the profile's own scope — a package it hides or
 * a country it cannot see never inflates a sport's number. Zero until the topic
 * index is built.
 */
export function sportCounts(scope: ItemQuery): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of RAIL_SPORTS) {
    const ids = topicStreams(t.id);
    m.set(t.id, ids.length === 0 ? 0 : localItems('live', { ...scope, streamIds: ids, limit: 1 })?.total ?? 0);
  }
  return m;
}

/**
 * How a sport's channels are listed: by what is on (the default — "sorted based
 * on EPG because it has data") or in the provider's channel order.
 *
 * Device-wide, like the rail's own arrangement, and for the same reason.
 */
export type SportsListOrder = 'onnow' | 'channel';
const LIST_ORDER_KEY = 'iptv.sports.listOrder';
let listOrder: SportsListOrder | null = null;
const orderSubs = new Set<() => void>();

export function sportsListOrder(): SportsListOrder {
  if (listOrder === null) {
    let raw: string | null = null;
    try { raw = kv.get(LIST_ORDER_KEY); } catch { /* private mode */ }
    listOrder = raw === 'channel' ? 'channel' : 'onnow';
  }
  return listOrder;
}

export function setSportsListOrder(next: SportsListOrder): void {
  listOrder = next;
  try { kv.set(LIST_ORDER_KEY, next); } catch { /* the choice still applies this visit */ }
  for (const fn of orderSubs) { try { fn(); } catch { /* a subscriber's problem */ } }
}

function subscribeOrder(fn: () => void): () => void {
  orderSubs.add(fn);
  return () => { orderSubs.delete(fn); };
}

export function useSportsListOrder(): SportsListOrder {
  return useSyncExternalStore(subscribeOrder, sportsListOrder, sportsListOrder);
}

/**
 * Which of a sport's channels the list shows: all of them (the default), or
 * only those live now, coming up next, or ended. One choice for every sport —
 * "when filtering they can persist the change, and it applies to all of the
 * sports area".
 */
export type SportsShow = 'all' | 'live' | 'next' | 'ended' | 'today' | 'tomorrow';
const SHOW_KEY = 'iptv.sports.show';
let show: SportsShow | null = null;

export function sportsShow(): SportsShow {
  if (show === null) {
    let raw: string | null = null;
    try { raw = kv.get(SHOW_KEY); } catch { /* private mode */ }
    show = raw === 'live' || raw === 'next' || raw === 'ended' || raw === 'today' || raw === 'tomorrow' ? raw : 'all';
  }
  return show;
}

export function setSportsShow(next: SportsShow): void {
  show = next;
  try { kv.set(SHOW_KEY, next); } catch { /* the choice still applies this visit */ }
  for (const fn of orderSubs) { try { fn(); } catch { /* a subscriber's problem */ } }
}

export function useSportsShow(): SportsShow {
  return useSyncExternalStore(subscribeOrder, sportsShow, sportsShow);
}

/**
 * Which countries' channels the sports lists show — none chosen means all.
 * Kept like the Show choice, one for every sport.
 */
const MARKETS_KEY = 'iptv.sports.markets';
let markets: readonly string[] | null = null;
const NO_MARKETS: readonly string[] = [];

export function sportsMarkets(): readonly string[] {
  if (markets === null) {
    const got = readList(MARKETS_KEY);
    markets = got.length === 0 ? NO_MARKETS : got;
  }
  return markets;
}

export function setSportsMarkets(next: readonly string[]): void {
  markets = next.length === 0 ? NO_MARKETS : [...next];
  writeList(MARKETS_KEY, markets);
  for (const fn of orderSubs) { try { fn(); } catch { /* a subscriber's problem */ } }
}

export function useSportsMarkets(): readonly string[] {
  return useSyncExternalStore(subscribeOrder, sportsMarkets, sportsMarkets);
}
