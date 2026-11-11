import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeSports, channelStatus, donorNameKey, guideDonors, guideRequestIds, liveKind, offAir, onNowRank, orderByOnNow,
  pickSport, resolveChannelGuide, sportsNowNext, type GuideAnswer, type SportsNowNext,
} from './sports.ts';
import type { Slot } from './guide.ts';

/* ── the rail ─────────────────────────────────────────────────────────────── */

const counts = (o: Record<string, number>) => new Map(Object.entries(o));

test('arrangeSports keeps the owner\'s order, drops empty sports, puts Other sport last', () => {
  const ids = arrangeSports(counts({ nfl: 1, football: 3, othersport: 2, darts: 1 }), [], []).map((s) => s.id);
  assert.deepEqual(ids, ['football', 'darts', 'nfl', 'othersport']);
});

test('arrangeSports puts what the viewer carried first, the rest behind in the owner\'s order', () => {
  const ids = arrangeSports(counts({ football: 1, rugby: 1, tennis: 1, darts: 1 }), ['darts', 'tennis'], [])
    .map((s) => s.id);
  assert.deepEqual(ids, ['darts', 'tennis', 'football', 'rugby']);
});

test('arrangeSports keeps hidden sports, last and marked, so they can come back', () => {
  const rail = arrangeSports(counts({ football: 1, rugby: 1, tennis: 1 }), [], ['football']);
  assert.deepEqual(rail.map((s) => [s.id, s.hidden]), [['rugby', false], ['tennis', false], ['football', true]]);
});

test('pickSport honours a requested sport that is shown, and never a hidden one', () => {
  const rail = arrangeSports(counts({ football: 1, rugby: 1 }), [], ['rugby']);
  assert.equal(pickSport(rail, 'football'), 'football');
  assert.equal(pickSport(rail, 'rugby'), 'football');
  assert.equal(pickSport(rail, 'golf'), 'football');
  assert.equal(pickSport([], null), null);
});

/* ── borrowing a guide from a sibling feed ───────────────────────────────────── */

test('donorNameKey treats quality/format suffixes as the same channel', () => {
  assert.equal(donorNameKey('UK| SKY SPORTS F1 HD'), donorNameKey('UK| SKY SPORTS F1 FHD'));
  assert.equal(donorNameKey('UK| SKY SPORTS F1 UHD'), donorNameKey('UK| SKY SPORTS F1 4K'));
  assert.equal(donorNameKey('AR| BEIN SPORTS 7 HEVC'), donorNameKey('AR| BEIN SPORTS 7'));
  assert.equal(donorNameKey('DE| SPORT H265'), donorNameKey('DE| SPORT H 265'));
});

test('donorNameKey strips a superscript quality mark via the shared normaliser', () => {
  assert.equal(donorNameKey('ES| DAZN F1® ᴴᴰ'), donorNameKey('ES| DAZN F1'));
});

test('donorNameKey keeps PPV — it usually names a different feed, not a quality one', () => {
  assert.notEqual(donorNameKey('UK| SKY SPORTS BOXING PPV'), donorNameKey('UK| SKY SPORTS BOXING'));
});

test('guideDonors pairs channels sharing a non-empty tvgId', () => {
  const donors = guideDonors([
    { id: 1, name: 'Sky Sports F1 SD', tvgId: 'skysportsf1.uk' },
    { id: 2, name: 'Sky Sports F1 HD', tvgId: 'skysportsf1.uk' },
    { id: 3, name: 'Unrelated', tvgId: 'other.uk' },
  ]);
  assert.deepEqual(donors.get(1), [2]);
  assert.deepEqual(donors.get(2), [1]);
  assert.equal(donors.has(3), false);
});

test('guideDonors falls back to the normalised name when tvgId is absent', () => {
  const donors = guideDonors([
    { id: 1, name: 'UK| Sky Sports Golf SD', tvgId: null },
    { id: 2, name: 'UK| Sky Sports Golf HD', tvgId: '' },
  ]);
  assert.deepEqual(donors.get(1), [2]);
  assert.deepEqual(donors.get(2), [1]);
});

test('guideDonors never lists a channel as its own donor', () => {
  const donors = guideDonors([{ id: 1, name: 'Solo Channel', tvgId: null }]);
  assert.equal(donors.has(1), false);
});

test('guideDonors merges a tvgId match and a name match without duplicates', () => {
  const donors = guideDonors([
    { id: 1, name: 'Sky Sports F1', tvgId: 'skysportsf1.uk' },
    { id: 2, name: 'Sky Sports F1 HD', tvgId: 'skysportsf1.uk' },
    { id: 3, name: 'Sky Sports F1 FHD', tvgId: null },
  ]);
  assert.deepEqual([...(donors.get(1) ?? [])].sort(), [2, 3]);
});

test('guideRequestIds adds every donor of a visible channel, once', () => {
  const donors = new Map([[1, [2, 3]], [4, [3]]]);
  const ids = guideRequestIds([1, 4], donors).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test('guideRequestIds asks for nothing extra when nobody has donors', () => {
  assert.deepEqual(guideRequestIds([1, 2], new Map()), [1, 2]);
});

const known = (slots: readonly Slot[]): GuideAnswer => ({ slots, known: true });
const NOTHING: GuideAnswer = { slots: [], known: false };
const slot = (title: string, startTs: number, stopTs: number | null = startTs + 3600): Slot => ({
  title, description: null, startTs, stopTs,
});

test('resolveChannelGuide prefers the channel\'s own guide when it has one', () => {
  const guide = new Map([[1, known([slot('Own', 0)])], [2, known([slot('Donor', 0)])]]);
  const donors = new Map([[1, [2]]]);
  assert.equal(resolveChannelGuide(1, guide, donors).slots[0]!.title, 'Own');
});

test('resolveChannelGuide borrows the first donor that actually has a guide', () => {
  const guide = new Map([[1, NOTHING], [2, NOTHING], [3, known([slot('Borrowed', 0)])]]);
  const donors = new Map([[1, [2, 3]]]);
  const got = resolveChannelGuide(1, guide, donors);
  assert.equal(got.known, true);
  assert.equal(got.slots[0]!.title, 'Borrowed');
});

test('resolveChannelGuide is honestly empty when nobody in the set has a guide', () => {
  const guide = new Map([[1, NOTHING], [2, NOTHING]]);
  const donors = new Map([[1, [2]]]);
  const got = resolveChannelGuide(1, guide, donors);
  assert.equal(got.known, false);
  assert.deepEqual(got.slots, []);
});

test('resolveChannelGuide with no answer at all yet is unknown, not a crash', () => {
  const got = resolveChannelGuide(1, new Map(), new Map());
  assert.equal(got.known, false);
});

/* ── now / next / progress ───────────────────────────────────────────────────── */

test('sportsNowNext reads the slot on air and the one right after it', () => {
  const slots = [slot('Kick-off', 1_000, 3_000), slot('Post-match', 3_000, 5_000)];
  const got = sportsNowNext(slots, 2_000);
  assert.equal(got.now?.title, 'Kick-off');
  assert.equal(got.next?.title, 'Post-match');
});

test('sportsNowNext reports how far through the live slot the clock is', () => {
  const slots = [slot('Match', 1_000, 2_000)];
  const got = sportsNowNext(slots, 1_500);
  assert.equal(got.progressPct, 50);
});

test('sportsNowNext has no "now" and no progress bar between programmes', () => {
  const slots = [slot('Earlier', 0, 1_000), slot('Later', 2_000, 3_000)];
  const got = sportsNowNext(slots, 1_500);
  assert.equal(got.now, null);
  assert.equal(got.progressPct, null);
  assert.equal(got.next?.title, 'Later');
});

test('sportsNowNext with an empty guide is honestly nothing', () => {
  const got = sportsNowNext([], 1_000);
  assert.equal(got.now, null);
  assert.equal(got.next, null);
  assert.equal(got.progressPct, null);
});

test('sportsNowNext does not require its input pre-sorted', () => {
  const slots = [slot('Second', 2_000, 3_000), slot('First', 1_000, 2_000)];
  const got = sportsNowNext(slots, 1_500);
  assert.equal(got.now?.title, 'First');
  assert.equal(got.next?.title, 'Second');
});

/* ── what's on ────────────────────────────────────────────────────────────── */

test('the guide\'s own titles say which programmes are the event, in their own languages', () => {
  /* Every one of these is a title the owner's guide was showing on 2026-09-29. */
  for (const t of ['Live: NFL Football', 'Live: Fútbol Americano NFL', 'Cal Football Postgame Live', 'Australian Racing Live']) {
    assert.equal(liveKind(t), 'live', t);
  }
  for (const t of [
    'Nogomet (M): Juventus - Atalanta, Serie A 2026/2027', 'Intl Cricket: England v Sri Lanka',
    'Belgium vs France - UEFA Nations League 2026/27 - Match Day 2', 'Rugby: Australia V South Africa',
    'Sale Sharks v Bristol Bears', 'Flamengo x Palmeiras', 'Ποδόσφαιρο: Ρέιντζερς - Σέλτικ',
  ]) assert.equal(liveKind(t), 'match', t);
  for (const t of [
    'Programmes de nuit - TF1', 'ATP Masters 1000 2026 - Στιγμιότυπα', 'Premier League Highlights',
    'Lakers Media Day', 'Snooker: Shenzhen Open', 'Olivier', 'Deliver Me',
  ]) assert.equal(liveKind(t), null, t);
});

test('a closedown card is not a programme', () => {
  for (const t of ['Kanalpause', 'Fin des programmes', 'Sem Emissão', 'Sendeophold', 'Brak źródła. EPG dostarcza…']) {
    assert.ok(offAir(t), t);
  }
  assert.equal(offAir('Formula 1: Race'), false);
});

const NOW = 1_790_600_000;
const nn = (now: string | null, next: string | null, nextIn = 3600): SportsNowNext => ({
  now: now === null ? null : { title: now, startTs: NOW - 1800, stopTs: NOW + 1800 },
  next: next === null ? null : { title: next, startTs: NOW + nextIn, stopTs: NOW + nextIn + 3600 },
  progressPct: now === null ? null : 50,
});

test('live first, then what kicks off soon, then anything on, then nothing', () => {
  assert.equal(onNowRank(nn('Live: NFL Football', null), NOW).tier, 0);
  assert.equal(onNowRank(nn('Golf Magazine', 'Intl Cricket: England v Sri Lanka', 1800), NOW).tier, 1);
  /* A match three hours out is not "soon": the channel is what it is showing. */
  assert.equal(onNowRank(nn('Golf Magazine', 'Intl Cricket: England v Sri Lanka', 3 * 3600), NOW).tier, 2);
  assert.equal(onNowRank(nn('Kanalpause', 'Kanalpause'), NOW).tier, 3);
  assert.equal(onNowRank(nn(null, null), NOW).tier, 3);
  /* An event channel carries no guide; its name is the schedule. */
  assert.equal(onNowRank(nn(null, null), NOW, { state: 'live', at: NOW - 600 }).tier, 0);
  assert.equal(onNowRank(nn(null, null), NOW, { state: 'next', at: NOW + 900 }).tier, 1);
  assert.equal(onNowRank(nn(null, null), NOW, { state: 'ended', at: NOW - 9000 }).tier, 3);
});

test('the order is stable where the guide has nothing to say, and simulcasts sit together', () => {
  const rows = [
    { id: 'a', g: nn('Golf Magazine', null) },
    { id: 'b', g: nn('Live: NFL Football', null) },
    { id: 'c', g: nn(null, null) },
    { id: 'd', g: nn('Tennis Review', null) },
    { id: 'e', g: nn('Live: NFL Football', null) },
    { id: 'f', g: nn('Snooker', 'Sale Sharks v Bristol Bears', 900) },
  ];
  const order = orderByOnNow(rows, (r) => onNowRank(r.g, NOW)).map((r) => r.id);
  assert.deepEqual(order, ['b', 'e', 'f', 'a', 'd', 'c']);
});

test('the guide says what a channel is doing; its name only when there is no guide', () => {
  /* On air per the guide, whatever a stale PPV name claims. */
  assert.equal(channelStatus(nn('Premier League: Arsenal v Chelsea', null), true, { state: 'ended' }), 'live');
  assert.equal(channelStatus(nn(null, 'Tennis: Final'), true, { state: 'ended' }), 'next');
  /* A guide with nothing left in it, or only closedown cards: over. */
  assert.equal(channelStatus(nn(null, null), true, { state: 'live' }), 'ended');
  assert.equal(channelStatus(nn('Kanalpause', 'Kanalpause'), true, null), 'ended');
  /* No guide: the name is all there is. */
  assert.equal(channelStatus(nn(null, null), false, { state: 'ended' }), 'ended');
  assert.equal(channelStatus(nn(null, null), false, { state: 'next' }), 'next');
  assert.equal(channelStatus(nn(null, null), false, null), null);
});
