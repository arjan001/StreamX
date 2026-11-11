import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR } from './guide.ts';
import {
  RESULT_CAP, admitCandidate, dayLabel, matchTier, programmeState, rankProgrammes, whenLabel,
  type EpgSearchChannel, type ProgrammeCandidate,
} from './epgSearch.ts';

/* Aug 20 2026, 15:00 UTC — the same "safely mid-afternoon" choice `guide.test.ts`
   makes for `dayChips`, so a day boundary in this box's own timezone is never
   close enough to bite. */
const NOW = Date.UTC(2026, 7, 20, 15) / 1000;

function ch(overrides: Partial<EpgSearchChannel> & { streamId: number }): EpgSearchChannel {
  return {
    id: overrides.streamId,
    ref: `1.${overrides.streamId}`,
    name: `Channel ${overrides.streamId}`,
    logo: null,
    archive: false,
    archiveDays: 0,
    ...overrides,
  };
}

function slot(title: string | null, startTs: number, stopTs: number | null): {
  title: string | null; description: string | null; startTs: number; stopTs: number | null;
} {
  return { title, description: null, startTs, stopTs };
}

/* ── matchTier ─────────────────────────────────────────────────────────────── */

test('an exact fold beats a prefix beats a scattered substring beats nothing', () => {
  assert.equal(matchTier('De Verraders', 'de verraders'), 3);
  assert.equal(matchTier('De Verraders', 'de verr'), 2);
  assert.equal(matchTier('De Verraders Extra', 'verraders de'), 1); // both words, either order
  assert.equal(matchTier('De Verraders', 'huizenjagers'), 0);
});

test('accents and case fold the same way the channel-name search does', () => {
  // searchKey NFD-strips combining marks, so "Florentína" and "florentina" fold identically.
  assert.equal(matchTier('Florentína', 'florentina'), 3);
  assert.equal(matchTier('NIEUWS 18U30', 'nieuws 18u30'), 3);
});

test('no title, no query, or a missing word all fail to match', () => {
  assert.equal(matchTier(null, 'show'), 0);
  assert.equal(matchTier('De Verraders', ''), 0);
  assert.equal(matchTier('De Verraders', 'de verraders extra'), 0); // "extra" is not in the title
});

/* ── admitCandidate ────────────────────────────────────────────────────────── */

test('a programme on air right now is always admitted', () => {
  const s = slot('Live Now', NOW - 10 * 60, NOW + 20 * 60);
  assert.equal(admitCandidate(s, { archive: false, archiveDays: 0 }, NOW), true);
});

test('a later programme is admitted up to the guide\'s own ceiling, and not past it', () => {
  const soon = slot('Soon', NOW + 19 * HOUR, NOW + 20 * HOUR); // safely "tomorrow" in any zone
  assert.equal(admitCandidate(soon, { archive: false, archiveDays: 0 }, NOW), true);
  const farOut = slot('Far out', NOW + 3 * DAY, NOW + 3 * DAY + HOUR); // well past "end of tomorrow"
  assert.equal(admitCandidate(farOut, { archive: false, archiveDays: 0 }, NOW), false);
});

test('a finished programme is admitted only when the channel\'s own catch-up window still reaches it', () => {
  const finished = slot('Finished', NOW - 2 * HOUR, NOW - HOUR);
  assert.equal(admitCandidate(finished, { archive: false, archiveDays: 0 }, NOW), false, 'no archive at all');
  assert.equal(admitCandidate(finished, { archive: true, archiveDays: 3 }, NOW), true, 'well inside 3 days');
  const longAgo = slot('Long ago', NOW - 5 * DAY, NOW - 5 * DAY + HOUR);
  assert.equal(admitCandidate(longAgo, { archive: true, archiveDays: 1 }, NOW), false, 'outside a 1-day window');
});

test('a programme with no title, or only whitespace, is never a candidate', () => {
  assert.equal(admitCandidate(slot(null, NOW, NOW + HOUR), { archive: true, archiveDays: 3 }, NOW), false);
  assert.equal(admitCandidate(slot('   ', NOW, NOW + HOUR), { archive: true, archiveDays: 3 }, NOW), false);
});

/* ── programmeState ────────────────────────────────────────────────────────── */

test('the state mark matches on-air, covered-by-catch-up, and neither', () => {
  const chan = { archive: true, archiveDays: 2 };
  assert.equal(programmeState(slot('Now', NOW - 60, NOW + 60), chan, NOW), 'live');
  assert.equal(programmeState(slot('Was on', NOW - HOUR, NOW - 30 * 60), chan, NOW), 'catchup');
  assert.equal(programmeState(slot('Later', NOW + HOUR, NOW + 2 * HOUR), chan, NOW), null);
  assert.equal(
    programmeState(slot('Was on', NOW - HOUR, NOW - 30 * 60), { archive: false, archiveDays: 0 }, NOW),
    null,
    'finished, but this channel keeps nothing',
  );
});

/* ── day/time label ────────────────────────────────────────────────────────── */

test('the day label matches dayChips\' own wording, for one timestamp instead of a strip', () => {
  assert.equal(dayLabel(NOW, NOW), 'Today');
  assert.equal(dayLabel(NOW + DAY, NOW), 'Tomorrow');
  assert.equal(dayLabel(NOW - DAY, NOW), 'Yesterday');
  const further = dayLabel(NOW + 5 * DAY, NOW);
  assert.equal(['Today', 'Yesterday', 'Tomorrow'].includes(further), false);
  assert.notEqual(further, '');
});

test('whenLabel joins the day word to a wall clock', () => {
  const w = whenLabel(NOW + DAY, NOW);
  // Loosely matched, like `guide.test.ts`'s own `clockOf` check: the wall-clock
  // half is locale-formatted and may carry a trailing AM/PM marker.
  assert.match(w, /^Tomorrow \d{1,2}[:.]\d{2}/);
});

/* ── rankProgrammes ────────────────────────────────────────────────────────── */

const A = ch({ streamId: 1, ref: '1.1', name: 'Alpha', archive: true, archiveDays: 3 });
const B = ch({ streamId: 2, ref: '1.2', name: 'Bravo', archive: false, archiveDays: 0 });
const C = ch({ streamId: 3, ref: null, id: 30, name: 'Charlie', archive: true, archiveDays: 1 });

/** Six candidates: two favourite (one live, one later), three non-favourite (one
 *  live, one catch-up, one later), and one that matches the query but must never
 *  appear because its channel keeps no archive at all. */
function scenario(): ProgrammeCandidate[] {
  return [
    { channel: A, slot: slot('Show One', NOW - 5 * 60, NOW + 25 * 60) }, // favourite, live
    { channel: A, slot: slot('Late Show', NOW + 19 * HOUR, NOW + 20 * HOUR) }, // favourite, later
    { channel: B, slot: slot('Show Time', NOW - 5 * 60, NOW + 25 * 60) }, // not fav, live
    { channel: C, slot: slot('Show Rerun', NOW - 2 * HOUR, NOW - HOUR) }, // not fav, catch-up, 2h away
    { channel: B, slot: slot('Old Show', NOW - 3 * HOUR, NOW - 2 * HOUR) }, // matches, but B has no archive
    { channel: C, slot: slot('Show Later', NOW + 5 * HOUR, NOW + 6 * HOUR) }, // not fav, later, 5h away
  ];
}

test('favourite channels first, then whatever is live, then whichever is closest to now', () => {
  const favs = new Set([A.streamId]);
  const hits = rankProgrammes(scenario(), 'show', NOW, favs);
  assert.deepEqual(hits.map((h) => `${h.channelName}:${h.title}`), [
    'Alpha:Show One', // favourite + live
    'Alpha:Late Show', // favourite, not live
    'Bravo:Show Time', // not favourite, but live
    'Charlie:Show Rerun', // not favourite, not live, 2h from now
    'Charlie:Show Later', // not favourite, not live, 5h from now
  ]);
  // "Old Show" matched the text but Bravo keeps no archive at all.
  assert.equal(hits.some((h) => h.title === 'Old Show'), false);
});

test('the state mark and favourite flag on each row are the ones the scenario set up', () => {
  const favs = new Set([A.streamId]);
  const hits = rankProgrammes(scenario(), 'show', NOW, favs);
  const byTitle = new Map(hits.map((h) => [h.title, h]));
  assert.equal(byTitle.get('Show One')?.state, 'live');
  assert.equal(byTitle.get('Show One')?.favourite, true);
  assert.equal(byTitle.get('Late Show')?.state, null);
  assert.equal(byTitle.get('Late Show')?.favourite, true);
  assert.equal(byTitle.get('Show Time')?.state, 'live');
  assert.equal(byTitle.get('Show Time')?.favourite, false);
  assert.equal(byTitle.get('Show Rerun')?.state, 'catchup');
  assert.equal(byTitle.get('Show Later')?.state, null);
});

test('href: live opens the channel, catch-up opens exactly that recording, later opens the guide', () => {
  const favs = new Set([A.streamId]);
  const hits = rankProgrammes(scenario(), 'show', NOW, favs);
  const byTitle = new Map(hits.map((h) => [h.title, h]));
  assert.equal(byTitle.get('Show One')?.href, '/live?ch=1.1');
  const rerun = byTitle.get('Show Rerun')!;
  // Charlie has no `ref` (id 30 is the fallback) — the same fallback `linkId` uses.
  assert.equal(rerun.href, `/catchup?ch=30&start=${NOW - 2 * HOUR}&stop=${NOW - HOUR}`);
  assert.equal(byTitle.get('Show Later')?.href, '/guide?ch=30');
});

test('two matches with identical favourite/live/soonest status fall back to match strength', () => {
  const x = ch({ streamId: 10, ref: '1.10', name: 'X' });
  const y = ch({ streamId: 11, ref: '1.11', name: 'Y' });
  const at = NOW + 3 * HOUR;
  const candidates: ProgrammeCandidate[] = [
    { channel: y, slot: slot('Big Show', at, at + HOUR) }, // substring only
    { channel: x, slot: slot('Show Case', at, at + HOUR) }, // prefix
  ];
  const hits = rankProgrammes(candidates, 'show', NOW, new Set());
  assert.deepEqual(hits.map((h) => h.title), ['Show Case', 'Big Show']);
});

test('an empty query, or one that matches nothing admitted, answers with nothing', () => {
  assert.deepEqual(rankProgrammes(scenario(), '', NOW, new Set()), []);
  assert.deepEqual(rankProgrammes(scenario(), 'zzz not a title', NOW, new Set()), []);
});

test('the list is capped, keeping the best-ranked rows rather than an arbitrary slice', () => {
  const many: ProgrammeCandidate[] = [];
  for (let i = 0; i < RESULT_CAP + 10; i += 1) {
    many.push({
      channel: ch({ streamId: 100 + i, ref: `1.${100 + i}`, name: `Ch ${i}` }),
      // Ascending distance from NOW, so the first RESULT_CAP by rank are exactly
      // the first RESULT_CAP built here.
      slot: slot(`Show ${i}`, NOW + i * 60, NOW + i * 60 + 30 * 60),
    });
  }
  const hits = rankProgrammes(many, 'show', NOW, new Set());
  assert.equal(hits.length, RESULT_CAP);
  assert.equal(hits[0]!.title, 'Show 0');
  assert.equal(hits[RESULT_CAP - 1]!.title, `Show ${RESULT_CAP - 1}`);
});
