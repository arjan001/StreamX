/**
 * Headshots for the search people rail.
 *
 * TVMaze people search is free and needs no key. A short typed query ("jimm")
 * almost never returns the famous faces the cast index tallied, so every person
 * is looked up under their FULL name. Shared-query hits are only a free bonus.
 */
import { foldText } from '@iptv/core-store';
import type { SearchPerson } from './searchFacets.ts';

interface MazePerson {
  score: number;
  person: {
    id: number;
    name: string;
    image: { medium: string; original: string } | null;
  };
}

const mazeCache = new Map<string, MazePerson[]>();
const mazeInflight = new Map<string, Promise<MazePerson[]>>();
/** Folded person id → portrait URL (misses are not cached — spelling retries). */
const faceCache = new Map<string, string>();

const BATCH = 4;

async function mazePeople(q: string): Promise<MazePerson[]> {
  const key = foldText(q);
  if (key.length < 2) return [];
  const hit = mazeCache.get(key);
  if (hit !== undefined) return hit;
  const pending = mazeInflight.get(key);
  if (pending !== undefined) return pending;
  const work = (async () => {
    try {
      const res = await fetch(
        `https://api.tvmaze.com/search/people?q=${encodeURIComponent(q.trim())}`,
      );
      if (!res.ok) {
        mazeCache.set(key, []);
        return [];
      }
      const rows = (await res.json()) as MazePerson[];
      mazeCache.set(key, rows);
      return rows;
    } catch {
      /* Network blip — do not poison the cache with []. */
      return [];
    }
  })().finally(() => { mazeInflight.delete(key); });
  mazeInflight.set(key, work);
  return work;
}

/**
 * One face belongs to one person.
 *
 * Even with the top-hit fallback reined in, two spellings of the same name can
 * resolve to the same portrait, and a rail showing one face twice reads as the
 * bug it used to be. First claim keeps it; the rest go unillustrated, which the
 * rail already draws as a monogram.
 */
function firstClaimWins(out: Record<string, string>): Record<string, string> {
  const seen = new Set<string>();
  const kept: Record<string, string> = {};
  for (const [id, url] of Object.entries(out)) {
    if (seen.has(url)) continue;
    seen.add(url);
    kept[id] = url;
  }
  return kept;
}

/** Best TVMaze portrait URL for each person, keyed by folded id. */
export async function personPortraits(
  q: string,
  people: readonly SearchPerson[],
): Promise<Record<string, string>> {
  if (people.length === 0) return {};
  const out: Record<string, string> = {};

  /* Free pass: anything the typed query already named. */
  if (foldText(q).length >= 2) {
    const shared = await mazePeople(q);
    for (const p of people) {
      if (faceCache.has(p.id)) continue;
      /*
       * No top-hit fallback on the SHARED query — this is the whole of "in
       * search sometimes it picks one image for all people or actors".
       *
       * One search for "john" returns one top row, and the fallback below
       * accepted it for anyone whose first name merely started the same way:
       * John Mulaney, John Wayne, Johnny Depp and Johnny Hallyday were all
       * handed the same face, photographed. A top hit is only evidence when the
       * query WAS that person's full name, which is the pass below.
       */
      const url = pickPortrait(shared, p.id, false);
      if (url !== null) faceCache.set(p.id, url);
    }
  }

  const need = people.filter((p) => {
    const held = faceCache.get(p.id);
    if (held !== undefined) {
      out[p.id] = held;
      return false;
    }
    return true;
  });

  for (let i = 0; i < need.length; i += BATCH) {
    await Promise.all(need.slice(i, i + BATCH).map(async (p) => {
      /*
       * TVMaze, asked by the device itself. TMDB went first until 2026-10-01,
       * but it could only be reached through our box (the key must not ship in
       * a download), and the box no longer answers anything but logs, updates,
       * config and captions.
       */
      const url = pickPortrait(await mazePeople(p.label), p.id, true);
      if (url !== null && url !== undefined) {
        faceCache.set(p.id, url);
        out[p.id] = url;
      }
    }));
  }
  return firstClaimWins(out);
}

function namesAlign(want: string, name: string): boolean {
  if (want === name) return true;
  const shorter = want.length <= name.length ? want : name;
  const longer = want.length <= name.length ? name : want;
  if (!(longer === shorter || longer.startsWith(`${shorter} `))) return false;
  if (shorter.split(' ').length < 2 && want.split(' ').length !== name.split(' ').length) {
    return false;
  }
  return true;
}

/** "jimmy shergill" ↔ "jimmy sheirgill" — same first name, close last name. */
function namesClose(want: string, name: string): boolean {
  if (namesAlign(want, name)) return true;
  const ww = want.split(' ').filter((w) => w.length > 0);
  const nw = name.split(' ').filter((w) => w.length > 0);
  if (ww.length >= 2 && nw.length >= 2 && ww[0] === nw[0]) {
    return editDistance(ww[ww.length - 1]!, nw[nw.length - 1]!) <= 2;
  }
  if (ww.length === nw.length && ww.length >= 2) {
    return editDistance(want, name) <= 2;
  }
  return false;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function pickPortrait(
  rows: readonly MazePerson[],
  personId: string,
  /** Accept the query's top hit when no name matched. Only safe on a full-name
      lookup: on a shared query every near-namesake gets the same row. */
  allowTopHit: boolean,
): string | null {
  const want = foldText(personId);
  let best: MazePerson | null = null;
  let bestRank = -1;
  for (const row of rows) {
    if (row.person.image === null) continue;
    const name = foldText(row.person.name);
    let rank = 0;
    if (name === want) rank = 3;
    else if (namesAlign(want, name)) rank = 2;
    else if (namesClose(want, name)) rank = 1;
    else continue;
    if (
      best === null
      || rank > bestRank
      || (rank === bestRank && row.score > best.score)
    ) {
      best = row;
      bestRank = rank;
    }
  }
  /* Full-name lookup: TVMaze's top hit is usually right even when spelling drifts. */
  if (best === null && allowTopHit && rows.length > 0) {
    const top = rows[0]!;
    if (top.person.image !== null && top.score >= 0.4) {
      const name = foldText(top.person.name);
      const wantFirst = want.split(' ')[0] ?? '';
      const nameFirst = name.split(' ')[0] ?? '';
      if (wantFirst.length >= 2 && (wantFirst === nameFirst || nameFirst.startsWith(wantFirst) || wantFirst.startsWith(nameFirst))) {
        best = top;
      }
    }
  }
  if (best?.person.image === null || best === null) return null;
  return best.person.image.medium;
}
