import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWhen, parseEvent } from './eventName.ts';
import { unshout } from './titleCase.ts';

/* Every name below is a channel from the frozen fixture of the owner's line. */
const NOW = new Date(Date.UTC(2026, 8, 2, 20, 0));

test('the pipe shape: fixture, competition, a zoned date, the feed, and it is over', () => {
  const e = parseEvent('End | Sassuolo - Frosinone | Coppa Italia | 2026-09-02 | 13:00 (GMT) | 8K EXCLUSIVE | BE: DAZN PPV 4', NOW)!;
  assert.equal(e.title, 'Sassuolo - Frosinone');
  assert.equal(e.competition, 'Coppa Italia');
  assert.equal(e.at?.toISOString(), '2026-09-02T13:00:00.000Z');
  assert.equal(e.zoned, true);
  assert.equal(e.feed, 'BE: DAZN PPV 4');
  assert.equal(e.state, 'ended');
});

test('day-month-year, and the "all" filler goes', () => {
  const e = parseEvent('End | Stage 11 | Cartagena - Lorca | all | 02-09-2026 | 14:35 (GMT) | 8K EXCLUSIVE | ES: SOCCER PPV 6', NOW)!;
  assert.equal(e.title, 'Cartagena - Lorca');
  assert.equal(e.competition, 'Stage 11');
  assert.equal(e.at?.toISOString(), '2026-09-02T14:35:00.000Z');
});

test('a weekday date with a zone name, and a shouted title set in title case', () => {
  const e = parseEvent('NEXT | F1 WEEKEND WARM-UP | Thu 03 Sep 14:30 UTC (UK) | 8K EXCLUSIVE | UK: APPLE TV F1 PPV 1', NOW)!;
  assert.equal(e.title, 'F1 Weekend Warm-Up');
  assert.equal(e.at?.toISOString(), '2026-09-03T14:30:00.000Z');
  assert.equal(e.state, 'next');
  assert.equal(e.feed, 'UK: APPLE TV F1 PPV 1');
  const cest = parseEvent('LIVE | DENIS SHAPOVALOV -  LUCA VAN ASSCHE | Wed 02 Sep 20:54 CEST (NL) | 8K EXCLUSIVE | NL: MAX PPV 1', NOW)!;
  assert.equal(cest.title, 'Denis Shapovalov - Luca Van Assche');
  assert.equal(cest.at?.toISOString(), '2026-09-02T18:54:00.000Z');
  assert.equal(cest.state, 'live');
});

test('the "Sport: A vs B @ date :feed" shape', () => {
  const e = parseEvent('Tennis: Alexander Zverev vs Lorenzo Sonego @ Sep 2 02:47 AM :MAX FR  01', NOW)!;
  assert.equal(e.title, 'Alexander Zverev vs Lorenzo Sonego');
  assert.equal(e.feed, 'MAX FR 01');
  assert.equal(e.at?.getHours(), 2);
  assert.equal(e.zoned, false);
  const pm = parseEvent('Rhein Neckar Löwen vs Gummersbach @ Sep 2 7:55 PM :Viaplay NL  01', NOW)!;
  assert.equal(pm.title, 'Rhein Neckar Löwen vs Gummersbach');
  assert.equal(pm.at?.getHours(), 19);
  /* "16:30 PM" — a 24-hour clock with a stray PM — is still half past four. */
  assert.equal(parseEvent('Tennis: Courtside @ Sep 6 16:30 PM :MAX FR 16', NOW)!.at?.getHours(), 16);
});

test('a DAZN numbered feed leading the title, with a country prefix', () => {
  const e = parseEvent('BE| DAZN 1 - RAAL La Louvière - KV Mechelen Jupiler Pro League 2026-08-29 15:35', NOW)!;
  assert.equal(e.title, 'RAAL La Louvière - KV Mechelen Jupiler Pro League');
  assert.equal(e.feed, 'DAZN 1');
  assert.equal(e.state, 'ended');
});

test('two clocks: the first is the one; the fixture is the title, the league its context', () => {
  const e = parseEvent('National League 1 | Final Oldham vs Southend // UK Sun 1 Jun 3:00pm // ET Sun 1 Jun 10:00am', NOW)!;
  assert.equal(e.title, 'Final Oldham vs Southend');
  assert.equal(e.competition, 'National League 1');
  assert.equal(e.at?.getHours(), 15);
});

test('status words with no date, numbered event feeds, and ordinary channels', () => {
  assert.equal(parseEvent('Live | AJAX VS  FC SION', NOW)?.title, 'Ajax vs FC Sion');
  assert.equal(parseEvent('Live | AJAX VS  FC SION', NOW)?.state, 'live');
  const n = parseEvent('LIVE EVENT 21 -  Leeds vs Plymouth', NOW)!;
  assert.equal(n.title, 'Leeds vs Plymouth');
  assert.equal(n.feed, 'LIVE EVENT 21');
  assert.equal(parseEvent('UK| SKY SPORTS MAIN EVENT FHD', NOW), null);
  assert.equal(parseEvent('ES| LA 1 4K/UHD', NOW), null);
  /* A slot dated 2098 is a placeholder, not a fixture: an ordinary channel. */
  assert.equal(parseEvent('(MX) (VIX 01) |  (2098-12-31 08:00:01)', NOW), null);
});

test('unshout leaves mixed case alone and keeps the capitals that are names', () => {
  assert.equal(unshout('Sassuolo - Frosinone'), 'Sassuolo - Frosinone');
  assert.equal(unshout('SAN DIEGO PADRES @ CINCINNATI REDS'), 'San Diego Padres @ Cincinnati Reds');
  assert.equal(unshout('UFC 310 PRELIMS'), 'UFC 310 Prelims');
});

test('eventWhen says today, tomorrow, or the date', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  assert.match(eventWhen(new Date(2026, 8, 2, 20, 0), now, 'en-GB'), /^Today 20:00$/);
  assert.match(eventWhen(new Date(2026, 8, 3, 9, 5), now, 'en-GB'), /^Tomorrow 09:05$/);
  assert.match(eventWhen(new Date(2026, 8, 6, 16, 30), now, 'en-GB'), /Sept? · 16:30$/);
});
