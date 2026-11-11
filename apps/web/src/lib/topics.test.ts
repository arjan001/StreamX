import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPORTS, SPORTS_TOPIC, eventCore, normalise, topicsOf } from './topics.ts';

/**
 * Real names, from the frozen fixture of the owner's own panel.
 *
 * Browsing "by categories like this or by country" only works if a channel lands
 * in the right sport whatever language or brand its provider used. These are the
 * cases that decide it — including the ones the first draft got wrong.
 */
const topic = (channel: string, category: string) => topicsOf(channel, category)[0] ?? null;

test('the sport is read from the channel when the package only says "sports"', () => {
  assert.equal(topic('UK| SKY SPORTS CRICKET HD', 'UK| SPORTS'), 'cricket');
  assert.equal(topic('4K| SKY SPORTS DARTS UHD', '4K UHD 3840P'), 'darts');
  assert.equal(topic('BE| PLAY SPORTS GOLF HD', 'BE| SPORTS'), 'golf');
  assert.equal(topic('ES| DAZN F1® ᴴᴰ', 'ES| DAZN EXCLUSIVE ᴴᴰ/ᴿᴬᵂ'), 'motorsport');
  assert.equal(topic('ES| DAZN MOTOGP', 'ES| DAZN ESPAÑA'), 'motorsport');
  assert.ok(topicsOf('UK| SKY SPORTS MAIN EVENT', 'UK| SPORTS').includes('sports'), 'and plain sport is still Sports');
});

test('football under its brands and languages', () => {
  assert.equal(topic('ES| M+ LALIGA TV 2 FHD ᴿᴬᵂ', 'ES| SPAIN VIP ᴿᴬᵂ'), 'football');
  assert.equal(topic('ES| R. MADRID TV FHD', 'ES| TDT ESPAÑA VIP'), 'football');
  assert.equal(topic('EPL 1', 'UK| EPL PREMIER LEAGUE'), 'football');
  assert.equal(topic('Match 3', 'NL| SOCCER PPV'), 'football');
  assert.equal(topic('Jogo 1', 'BR| DESPORTO'), 'sports');
});

test('one sport is not mistaken for another', () => {
  /* NFL before football, basketball's league before football's "liga", and an
     event named on the channel beats the package it sits in. */
  assert.equal(topic('Good Morning Football | NFL Game Pass', 'ES| DAZN PPV'), 'nfl');
  assert.equal(topic('Real Madrid vs Baskonia', 'ES| LIGA ACB'), 'basketball');
  assert.equal(topic('Vuelta a Gran Bretaña | Etapa 1', 'ES| SOCCER PPV'), 'cycling');
  assert.equal(topic('Snooker: Long Zehuang vs Ashley Carty', 'ES| MAX PPV'), 'snooker');
  assert.equal(topic('LFC TV', 'UK| GENERAL'), 'football');
  assert.equal(topic('Rugby 1: Hull KR vs Warrington', 'UK| RUGBY PPV'), 'rugby');
  assert.equal(topic('Main card', 'UK| UFC/BOXING PPV'), 'boxing');
  assert.equal(topic('Race day', 'NL| CLIPMYHORSE PPV'), 'horseracing');
});

test('the false friends the first draft fell for', () => {
  assert.notEqual(topic('EN| CHRISTMAS GREAT LIGHT FIGHT', ''), 'boxing', 'a lights show');
  assert.notEqual(topic('ES| TVG TV GALICIA ᴿᴬᵂ', 'ES| SPAIN VIP ᴿᴬᵂ'), 'horseracing', 'TV Galicia');
  assert.notEqual(topic('LIVERPOOL FC', ''), 'snooker', 'POOL is a word, not a substring');
});

test('a channel that is not sport stays under Countries', () => {
  assert.equal(topic('LA 1', 'ES| TDT ESPAÑA VIP'), null);
});

test('every sport asked for is there, in the order asked for', () => {
  assert.deepEqual(SPORTS.map((t) => t.label), [
    'Football', 'Rugby', 'Tennis', 'Cricket', 'Formula 1 & Motorsport', 'Boxing & Fighting', 'Darts', 'Golf',
    'Horse Racing', 'Snooker', 'Basketball', 'Athletics', 'Cycling', 'Ice Hockey', 'American Football',
  ]);
  assert.ok(SPORTS.every((t) => t.parent === 'sports'));
  assert.equal(SPORTS_TOPIC.id, 'sports');
});

test('the country prefix is the other tab\'s business', () => {
  assert.equal(normalise('|ES| PELÍCULAS 2025'), 'PELICULAS 2025');
  assert.equal(normalise('NL| SPORT'), 'SPORT');
  assert.equal(normalise('[BR] DESPORTO'), 'DESPORTO');
});

/*
 * A PPV feed keeps its package and changes its name to the day's event. The
 * owner's Football list, 2026-09-29: baseball and the NFL on `FR: SOCCER PPV`.
 */
test('an event on a soccer PPV feed is filed by the event, not the feed', () => {
  assert.deepEqual(topicsOf('U15 Baseball World Cup 2026 - Day 4 - Beto Avila', 'FR: SOCCER PPV 14'), ['sports']);
  assert.deepEqual(topicsOf('Eagles vs. Bears', 'FR: SOCCER PPV 20'), ['nfl', 'sports']);
  assert.deepEqual(topicsOf('Lakers vs Celtics', 'US| PPV EVENTS'), ['basketball', 'sports']);
  /* Two leagues' teams, or one team alone: the name has not said, the package does. */
  assert.deepEqual(topicsOf('Giants vs Cardinals', 'FR: SOCCER PPV 3'), ['football', 'sports']);
  assert.deepEqual(topicsOf('Crystal Palace Eagles', 'UK| SOCCER PPV'), ['football', 'sports']);
  /* A named sport still wins over everything. */
  assert.deepEqual(topicsOf('NFL: Eagles vs. Bears', 'FR: SOCCER PPV 20'), ['nfl', 'sports']);
  assert.deepEqual(topicsOf('Canada vs. Zambia', 'FR: SOCCER PPV 2'), ['football', 'sports']);
});

test('an event listing is read for its event, not for the PPV feed it is on', () => {
  /* The shape of the fixture's own event channels, frozen from the owner's panel. */
  const snooker = 'End | Lei Peifan - Mark Selby British Open | 2ª ronda | all | 02-09-2026 | 00:00 (GMT) | 8K EXCLUSIVE | ES: SOCCER PPV 2';
  assert.ok(!/SOCCER/.test(eventCore(snooker)));
  assert.notEqual(topicsOf(eventCore(snooker), 'ES| PPV EVENTS')[0], 'football');
  const baseball = 'U15 Baseball World Cup 2026 - Day 4 - Beto Avila | FR: SOCCER PPV 14';
  assert.deepEqual(topicsOf(eventCore(baseball), 'FR| PPV'), ['sports']);
  /* A channel whose PPV segment is all it says keeps it. */
  assert.equal(eventCore('UK| UFC/BOXING PPV'), 'UK| UFC/BOXING PPV');
  assert.equal(topicsOf(eventCore('UK| UFC/BOXING PPV'), 'UK| PPV')[0], 'boxing');
  /* No PPV, nothing changes. */
  assert.equal(eventCore('UK| SKY SPORTS FOOTBALL'), 'UK| SKY SPORTS FOOTBALL');
});
