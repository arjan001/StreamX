/**
 * Group-path fixtures.
 *
 * Every name here is a real category from the reference provider's 1,043
 * categories, so a change in the parser that would reshuffle a live catalogue
 * fails here first.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { derivePath, freeMarketCode, labelFor, MARKET_LABELS } from '../src/grouping.ts';

const LIVE = 1;
const MOVIE = 2;
const SERIES = 3;

describe('market prefix', () => {
  test('the three real prefix forms', () => {
    // VOD writes "|XX|", live writes "XX|", and the Asia block spaces the bar.
    assert.deepEqual(derivePath('|EN| DRAMA', MOVIE), ['EN', 'DRAMA']);
    assert.deepEqual(derivePath('US| NCAAF PACKAGE', LIVE), ['US', 'NCAAF PACKAGE']);
    assert.deepEqual(derivePath('ASIA | INDIA NEWS', LIVE), ['ASIA', 'INDIA NEWS']);
  });

  test('multi-character and numeric codes', () => {
    assert.deepEqual(derivePath('|MULTI| NETFLIX ASIA', SERIES), ['MULTI', 'NETFLIX', 'ASIA']);
    assert.deepEqual(derivePath('EXYU| PINK MEDIA', LIVE), ['EXYU', 'PINK MEDIA']);
    assert.deepEqual(derivePath('18| FOR ADULTS', LIVE), ['18', 'FOR ADULTS']);
  });

  test('a spelled-out Nordic market is a market, but only in live', () => {
    // "SWEDEN VIAPLAY PPV" is the same shape with the bar missing; the VOD lists
    // never do this, so a movie group opening with a place name is left alone.
    assert.deepEqual(derivePath('SWEDEN VIAPLAY PPV VIP', LIVE), ['SWEDEN', 'VIAPLAY', 'PPV VIP']);
    assert.deepEqual(derivePath('DENMARK HD & HEVC', LIVE), ['DENMARK', 'HD', 'HEVC']);
    assert.deepEqual(derivePath('NORWAY FILMS', MOVIE), ['OTHER', 'NORWAY FILMS']);
  });

  test('"FI| FINLAND" and "FINLAND HD & HEVC" are one market', () => {
    assert.deepEqual(derivePath('FI| FINLAND', LIVE), ['FINLAND']);
    assert.deepEqual(derivePath('FINLAND MTV LIIGA', LIVE), ['FINLAND', 'MTV LIIGA']);
  });

  test('no prefix means OTHER, never a guess', () => {
    assert.deepEqual(derivePath('WORLD LIVE SPORTS', LIVE), ['OTHER', 'WORLD LIVE SPORTS']);
    assert.deepEqual(derivePath('4K RELAX 1920P', LIVE), ['OTHER', '4K RELAX 1920P']);
    assert.deepEqual(derivePath('TOP IMDB/OSCAR MOVIES', MOVIE), ['OTHER', 'TOP IMDB', 'OSCAR MOVIES']);
  });

  test('a nested bar is never mistaken for a prefix', () => {
    // "CRIME" is short enough to look like a code; only the FIRST bar counts.
    assert.deepEqual(derivePath('|FR| CRIME | POLICIER', SERIES), ['FR', 'CRIME', 'POLICIER']);
  });
});

describe('nested separators', () => {
  test('spaced bar, slash, ampersand and dash all nest', () => {
    assert.deepEqual(derivePath('|FR| SF | FANTASTIQUE', SERIES), ['FR', 'SF', 'FANTASTIQUE']);
    assert.deepEqual(derivePath('|EN| HORROR/THRILLER', MOVIE), ['EN', 'HORROR', 'THRILLER']);
    assert.deepEqual(derivePath('UK| CUP GAMES & INTERNATIONAL', LIVE), ['UK', 'CUP GAMES', 'INTERNATIONAL']);
    assert.deepEqual(derivePath('|BE| VTMGO - STREAMZ', SERIES), ['BE', 'VTMGO', 'STREAMZ']);
    assert.deepEqual(derivePath('|EN| FRENCH MOVIES / ENG SUB', MOVIE), ['EN', 'FRENCH MOVIES', 'ENG SUB']);
  });

  test('chevrons nest too, though this provider never uses them', () => {
    assert.deepEqual(derivePath('|EN| SPORT>>BOXING', LIVE), ['EN', 'SPORT', 'BOXING']);
    assert.deepEqual(derivePath('|EN| SPORT>BOXING', LIVE), ['EN', 'SPORT', 'BOXING']);
  });

  test('never more than three segments', () => {
    // "HULU/FX/FOX/ABC" and "SCIENCE/FICTION/FANTASTIQUE" run past the depth cap.
    assert.deepEqual(derivePath('|EN| HULU/FX/FOX/ABC', SERIES), ['EN', 'HULU', 'FX']);
    assert.deepEqual(derivePath('|FR| SCIENCE/FICTION/FANTASTIQUE', MOVIE), ['FR', 'SCIENCE', 'FICTION']);
  });
});

describe('slash exceptions', () => {
  test('a slash inside a known token does not split', () => {
    assert.deepEqual(derivePath('24/7 SHOWS VIP', LIVE), ['OTHER', '24-7 SHOWS VIP']);
    assert.deepEqual(derivePath('|FR| FILMS 4K/3D', MOVIE), ['FR', 'FILMS 4K-3D']);
    assert.deepEqual(derivePath('|FR| 4K/UHD SERIES', SERIES), ['FR', '4K-UHD SERIES']);
    assert.deepEqual(derivePath('IT| ITALY FHD/HEVC', LIVE), ['IT', 'ITALY FHD-HEVC']);
    assert.deepEqual(derivePath('US| B/R MAX SPORTS PPV', LIVE), ['US', 'B-R MAX SPORTS PPV']);
    assert.deepEqual(derivePath('IT| SERIE A/B/C', LIVE), ['IT', 'SERIE A-B-C']);
  });

  test('a retained slash becomes a dash, because the path id is slash-joined', () => {
    for (const name of ['FR| 24/7 BEIN CINEMA', '|FR| FILMS 4K/3D', 'IT| SERIE A/B/C']) {
      for (const seg of derivePath(name, LIVE)) assert.ok(!seg.includes('/'), seg);
    }
  });

  test('one quality token is not a glued pair, and a digit is a word', () => {
    assert.deepEqual(derivePath('|EN| PRE-RELEASES/SD CAM', MOVIE), ['EN', 'PRE-RELEASES', 'SD CAM']);
    assert.deepEqual(derivePath('IT| FORMULA 1 / MOTOGP', LIVE), ['IT', 'FORMULA 1', 'MOTOGP']);
  });
});

describe('superscript noise', () => {
  test('decorative VIP/RAW markers are dropped', () => {
    assert.deepEqual(derivePath('MK| MACEDONIA ⱽᴵᴾ ᴿᴬᵂ', LIVE), ['MK', 'MACEDONIA']);
    assert.deepEqual(derivePath('US| DIREC TV GO ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', LIVE), ['US', 'DIREC TV', 'GO']);
    assert.deepEqual(derivePath('AR| NOOR PLAY ²⁴/⁷ ᴿᴬᵂ', LIVE), ['AR', 'NOOR PLAY']);
    assert.deepEqual(derivePath('DE| WOW SPORT ᴴᴰ ᴰᴼᴸᴮʸ ᴬᵁᴰᴵᴼ', LIVE), ['DE', 'WOW', 'SPORT']);
  });

  test('the two spellings of one group land on one node', () => {
    assert.deepEqual(
      derivePath('SL| SLOVENIA ⱽᴵᴾ ᴿᴬᵂ', LIVE),
      derivePath('SL| SLOVENIA', LIVE),
    );
    assert.deepEqual(
      derivePath('AR| STC EXCLUSIVE ʰᵉᵛᶜ', LIVE),
      derivePath('AR| STC EXCLUSIVE ᴴᴰ', LIVE),
    );
  });

  test('ASCII packaging words are kept — they name real channel sets', () => {
    assert.deepEqual(derivePath('LAT| MEXICO VIP', LIVE), ['LAT', 'MEXICO VIP']);
    assert.deepEqual(derivePath('US| NBA PACKAGE', LIVE), ['US', 'NBA PACKAGE']);
    assert.deepEqual(derivePath('DE| BUNDESLIGA REPLAY', LIVE), ['DE', 'BUNDESLIGA REPLAY']);
    assert.deepEqual(derivePath('AR| AL-MAJD GROUP', LIVE), ['AR', 'AL-MAJD GROUP']);
    assert.deepEqual(derivePath('BEE| LIGUE 1+ PPV', LIVE), ['BEE', 'LIGUE 1+ PPV']);
  });

  test('a name that is only a market and noise keeps a single segment', () => {
    assert.deepEqual(derivePath('DENMARK ᴳᴼᴸᴰ ᴿᴬᵂ', LIVE), ['DENMARK']);
  });
});

describe('family collapse', () => {
  test('"DISNEY +", "DISNEY+" and "DISNEY PLUS" are one node', () => {
    assert.deepEqual(derivePath('|NL| DISNEY +', MOVIE), ['NL', 'DISNEY+']);
    assert.deepEqual(derivePath('|NL| DISNEY+', SERIES), ['NL', 'DISNEY+']);
    assert.deepEqual(derivePath('|NL| DISCOVERY PLUS', SERIES), ['NL', 'DISCOVERY+']);
    assert.deepEqual(derivePath('UK| DISCOVERY +', LIVE), ['UK', 'DISCOVERY+']);
  });

  test('a sub-collection nests under its brand', () => {
    assert.deepEqual(derivePath('NETFLIX KIDS', MOVIE), ['OTHER', 'NETFLIX', 'KIDS']);
    assert.deepEqual(derivePath('|FR| NETFLIX KIDS', SERIES), ['FR', 'NETFLIX', 'KIDS']);
    assert.deepEqual(derivePath('|EN| DISNEY+ ANIMATION', SERIES), ['EN', 'DISNEY+', 'ANIMATION']);
  });

  test('AMAZON PRIME, PRIME, PRIME VIDEO and PRIME+ are one node', () => {
    const want = 'AMAZON PRIME';
    assert.equal(derivePath('|NL| AMAZON PRIME', MOVIE)[1], want);
    assert.equal(derivePath('US| PRIME', LIVE)[1], want);
    assert.equal(derivePath('ES| PRIME VIDEO', LIVE)[1], want);
    assert.equal(derivePath('|EN| PRIME+', MOVIE)[1], want);
    assert.equal(derivePath('|FR| PRIME +', MOVIE)[1], want);
    assert.equal(derivePath('UK| AMAZON PRIME +', LIVE)[1], want);
    assert.deepEqual(derivePath('|DE| PRIME 4K', SERIES), ['DE', 'AMAZON PRIME', '4K']);
  });

  test('other families found in the catalogue', () => {
    assert.deepEqual(derivePath('|MULTI| APPLE+ SERIES', SERIES), ['MULTI', 'APPLE TV+', 'SERIES']);
    assert.deepEqual(derivePath('UK| APPLE TV F1 PPV', LIVE), ['UK', 'APPLE TV+', 'F1 PPV']);
    assert.deepEqual(derivePath('|FR| MyCANAL', MOVIE), ['FR', 'CANAL+']);
    assert.deepEqual(derivePath('FR| CANAL PLAY', LIVE), ['FR', 'CANAL+']);
    assert.deepEqual(derivePath('|FR| STARZ PLAY', SERIES), ['FR', 'STARZPLAY']);
    assert.deepEqual(derivePath('ES| MOVISTAR PLUS+', LIVE), ['ES', 'MOVISTAR+']);
    assert.deepEqual(derivePath('US| ESPN PLUS', LIVE), ['US', 'ESPN']);
    assert.deepEqual(derivePath('US| ESPN+ PPV VIP', LIVE), ['US', 'ESPN', 'PPV VIP']);
  });

  test('the longest alias wins, so HBO MAX is not MAX', () => {
    assert.deepEqual(derivePath('NL| HBO MAX PPV', LIVE), ['NL', 'HBO', 'MAX PPV']);
    assert.deepEqual(derivePath('UK| MAX PPV VIP', LIVE), ['UK', 'MAX', 'PPV VIP']);
    assert.deepEqual(derivePath('DE| SKY MAX PPV 4K', LIVE), ['DE', 'SKY', 'MAX PPV 4K']);
  });

  test('a brand only collapses at the head of the group', () => {
    // "4K NETFLIX MOVIES" is a 4K collection, not a Netflix sub-collection.
    assert.deepEqual(derivePath('4K NETFLIX MOVIES', MOVIE), ['OTHER', '4K NETFLIX MOVIES']);
    assert.deepEqual(derivePath('US| NFL NETWORK HULU', LIVE), ['US', 'NFL NETWORK HULU']);
    assert.deepEqual(derivePath('UK| SKYMIX SERIES', LIVE), ['UK', 'SKYMIX SERIES']);
    assert.deepEqual(derivePath('CZ| PRIMA', LIVE), ['CZ', 'PRIMA']);
  });

  test('a detached "+" mid-name means "and", not a brand', () => {
    assert.deepEqual(derivePath('FORMULA 1 + MOTO GP', LIVE), ['OTHER', 'FORMULA 1 + MOTO GP']);
  });
});

describe('purity', () => {
  test('same input, same output', () => {
    const name = 'AR| BEIN SPORTS NX 4K';
    assert.deepEqual(derivePath(name, LIVE), derivePath(name, LIVE));
    assert.deepEqual(derivePath(name, LIVE), ['AR', 'BEIN SPORTS', 'NX 4K']);
  });

  test('every segment is uppercase and trimmed', () => {
    for (const name of ['|FR| MyCANAL/TF1+', 'ASIA | 24/7 BANGAL/BANGAL', '|EN| 4K DOCUMENTARY/MUSIC/ STAND-UP']) {
      for (const seg of derivePath(name, LIVE)) {
        assert.equal(seg, seg.toUpperCase());
        assert.equal(seg, seg.trim());
        assert.notEqual(seg, '');
      }
    }
  });
});

describe('labels', () => {
  test('market codes expand at depth 1 only', () => {
    assert.equal(labelFor('NL', 1), 'Netherlands');
    assert.equal(labelFor('FR', 1), 'France');
    assert.equal(labelFor('DE', 1), 'Germany');
    assert.equal(labelFor('TR', 1), 'Turkey');
    assert.equal(labelFor('BEE', 1), 'beIN');
    assert.equal(labelFor('LAT', 1), 'Latin America');
    assert.equal(labelFor('QC', 1), 'Québec');
    assert.equal(labelFor('OTHER', 1), 'Other');
    // At depth 2 a segment is a group name that happens to look like a code.
    assert.equal(labelFor('SPORTS HD', 2), 'Sports HD');
  });

  test('a code the provider reuses for two markets keeps the code', () => {
    // CH is Switzerland and China/Hong Kong; IR is Ireland and Iran.
    assert.equal(labelFor('CH', 1), 'CH');
    assert.equal(labelFor('IR', 1), 'IR');
    assert.equal(labelFor('HR', 1), 'HR');
    for (const code of ['CH', 'IR', 'HR']) assert.equal(MARKET_LABELS[code], undefined);
  });

  test('acronyms, digits and brands survive title-casing', () => {
    assert.equal(labelFor('NCAAF PACKAGE', 2), 'NCAAF Package');
    assert.equal(labelFor('BEIN SPORTS', 2), 'BEIN Sports');
    assert.equal(labelFor('24-7 SHOWS VIP', 2), '24-7 Shows VIP');
    assert.equal(labelFor('DISNEY+', 2), 'Disney+');
    assert.equal(labelFor('UK MOVIES', 2), 'UK Movies');
    assert.equal(labelFor('TÉLÉ-RÉALITÉ', 3), 'Télé-Réalité');
  });
});

test('a free list\'s country is its own namespace, not a provider code', () => {
  /* The provider means Israel by IS and South Korea by SK; ISO means Iceland and
     Slovakia. Both kinds of channel share one catalogue now, so the free ones
     carry an F and cannot be confused with the panel's. */
  assert.equal(freeMarketCode('nl'), 'NLF');
  assert.equal(labelFor('NLF', 1), 'Netherlands (free)');
  assert.equal(labelFor('ISF', 1), 'Iceland (free)');
  assert.equal(labelFor('IS', 1), 'Israel');
  assert.equal(labelFor('SKF', 1), 'Slovakia (free)');
  assert.equal(labelFor('SK', 1), 'South Korea');
  // And the prefix parses as a market, so free channels group by country.
  assert.deepEqual(derivePath('NLF| News', 1), ['NLF', 'NEWS']);
});
