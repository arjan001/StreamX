/**
 * What a viewer should see instead of what the panel wrote.
 *
 * The prefix rules are the interesting part. Panel titles put the group in front
 * of the channel — `ES| #VAMOS HD`, `D+| QUEST HD` — and the group is already the
 * thing you picked in the sidebar, so printing it on every row is the "I still
 * see categories in channels" report. The pattern used to accept only two or
 * three letters, which left 3,959 of 12,341 live titles still showing theirs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cleanTitle, displayName, groupLabel, titleTags } from './displayName.ts';

test('a pipe prefix is a group label, whatever shape it takes', () => {
  // Each of these was measured leaking through the old two-or-three-letter rule.
  assert.equal(displayName('D+| QUEST HD'), 'Quest');
  assert.equal(displayName('PLAY+| AL JAZEERA ENGLISH'), 'Al Jazeera English');
  assert.equal(displayName('UK-BBCI| CBEEBIES'), 'CBeebies');
  assert.equal(displayName('UK-NOWTV| TNT SPORTS 4 FHD'), 'TNT Sports 4');
  assert.equal(displayName('PRIME| XENA WARRIOR PRINCESS'), 'Xena Warrior Princess');
  // Both trailing quality tokens peel, which is why this is 'CNN' and not 'CNN UHD'.
  assert.equal(displayName('4K| CNN UHD 4K'), 'CNN');
  assert.equal(displayName('MXC| IMAGEN HD'), 'Imagen');
  assert.equal(displayName('ES| #VAMOS HD'), '#Vamos');
});

test('a repeated prefix is peeled, because providers write them twice', () => {
  // Verbatim from this catalogue: `UK| UK| BEIN SPORTS ASIA 2`.
  assert.equal(displayName('UK| UK| BEIN SPORTS ASIA 2'), 'beIN Sports Asia 2');
  assert.equal(displayName('ES| ES| M+ CINE'), 'M+ Cine');
});

test('a schedule state is read, not printed: the name is the fixture, the state is the row\'s', () => {
  /* It used to survive whole so a finished match could not read as live. The
     state still is not lost — lib/eventName.ts reads it (and the date, which is
     truer than a word frozen into the name), and the row draws it beside the
     fixture. The NAME is just the fixture now. */
  assert.equal(displayName('ENDED | 2. BUNDESLIGA BRAUNSCHWEIG - HERTHA'), '2. Bundesliga Braunschweig - Hertha');
  assert.equal(displayName('Live | Seahawks @ Chiefs | NFL Game Pass'), 'Seahawks @ Chiefs');
  assert.equal(displayName('Next | Preseason: Falcons vs. Dolphins'), 'Preseason: Falcons vs. Dolphins');
});

test('a dash prefix stays strict, because dashes occur in real titles', () => {
  assert.equal(displayName('EN - The Shawshank Redemption (1994)', { dropYear: true }),
    'The Shawshank Redemption');
  // The widened pipe rule must not leak into the dash rule: a long first word
  // before a dash is part of the title.
  assert.equal(displayName('Mission - Impossible'), 'Mission - Impossible');
  assert.equal(displayName('Law and Order - Special Victims Unit'),
    'Law and Order - Special Victims Unit');
});

test('a title is never reduced to nothing', () => {
  // Measured across all 96,821 catalogue titles: zero come back empty.
  for (const n of ['ES|', 'HD', '4K', '|', 'EN - ']) {
    assert.notEqual(displayName(n).trim(), '', JSON.stringify(n));
  }
});

test('quality and superscript decoration still goes', () => {
  assert.equal(displayName('FR| TF1 FHD ᴿᴬᵂ'), 'TF1');
  assert.equal(displayName('LAT| CDF CHILE HEVC'), 'CDF Chile');
});

/*
 * ── the series grammar, and the two rules it added ──────────────────────────
 *
 * Series titles on this panel are `<quality>-<source> - Title (year) (country)`,
 * and every one of those decorations was being printed on a rail read from three
 * metres: "why am I seeing that 4k shit and country". The cases below are
 * verbatim rows — from `fixtures/catalogue.json` where the fixture has them, and
 * from the live panel for the paired `4K-SC` shape the fixture predates.
 */
test('a dash prefix that is not letters is still a prefix', () => {
  // 229 of 894 series kept theirs under the old letters-only rule.
  assert.equal(displayName('4K - 1883 (2021)'), '1883 (2021)');
  assert.equal(displayName('D+ - Among the Stars'), 'Among the Stars');
  assert.equal(displayName('A+ - Dear Edward (2023)'), 'Dear Edward (2023)');
  // The pair peels in ONE pass. Peeling only the first half is what left
  // `cleanTitle` showing "SC - Fallout".
  assert.equal(displayName('4K-SC - Fallout (2024) (US)', { dropYear: true }), 'Fallout');
  assert.equal(displayName('4K-DK - Carmen Curlers (2022) (DK)'), 'Carmen Curlers (2022)');
});

test('the dash rule is still too short to eat a title', () => {
  // The cap is the safety, so the widened alphabet must not reach past it.
  assert.equal(displayName('Mission - Impossible'), 'Mission - Impossible');
  assert.equal(displayName('Law and Order - Special Victims Unit'),
    'Law and Order - Special Victims Unit');
  // A digit-leading token that is not a named transcode is a TITLE.
  assert.equal(displayName('24 - Legacy'), '24 - Legacy');
  assert.equal(displayName('66-5 - Bandi'), '66-5 - Bandi');
});

test('a country tag goes, and the audio words stay', () => {
  assert.equal(displayName('EN - Fallout (2024) (US)'), 'Fallout (2024)');
  assert.equal(displayName('4K - Alice in Borderland (2020) (JP)'), 'Alice in Borderland (2020)');
  /* The bug this anchoring exists to prevent: these two are DIFFERENT series and
     a bare trailing-country rule makes them the same row twice. */
  /*
    ── and then it was measured, and the protection was protecting nothing ──

    Reported twice, a month apart: "that 4k shit and country ithink" and then
    "you're not filtering the name properly in the similar series, it contains
    4k and shit". So the whole line was counted rather than reasoned about — all
    45,146 series: 645 base titles carry a trailing tag of this shape and exactly
    17 carry two DIFFERENT ones. Every one of those 17 is `DUB` against `SUB`, a
    Turkish drama shipped in two audio versions. Not one title on this line is
    told apart from another by its COUNTRY, so the rule was spending 671 visible
    rows to protect a case that does not occur.

    The tag goes; the audio words stay, because those 17 pairs are real.
  */
  assert.equal(displayName('The Office (US)'), 'The Office');
  /* Without `dropYear` the year stays — it is the country and the transcode that
     are being asked about here. */
  assert.equal(displayName('EN - Dead Boy Detectives 4K (2024) (US)'),
    'Dead Boy Detectives (2024)');
  assert.equal(displayName('NF - Naruto (DUB)'), 'Naruto (DUB)');
  assert.equal(displayName('NF - Naruto (SUB)'), 'Naruto (SUB)');
  assert.equal(displayName('QFR - American Dad! (VFQ)'), 'American Dad! (VFQ)');
  /* A country standing in front of an audio tag: peel the one, keep the other. */
  assert.equal(displayName('EN - Diary Of A Ditched Girl (2025) (SE) (DUB)',
    { dropYear: true }), 'Diary Of A Ditched Girl (DUB)');
  // The panel's language notes, when they are a phrase of file words.
  assert.equal(displayName('EN - The Brutalist (2024) (MULTI SUB)'),
    'The Brutalist (2024)');
  assert.equal(displayName('EN - La coleccionista (MULTI-SUBS) (2025) (ES)',
    { dropYear: true }), 'La coleccionista');
  /* But a note that names a language a viewer cannot get anywhere else stays. */
  assert.equal(displayName('EN - Squid Game (KOREAN ENG-SUB)'),
    'Squid Game (KOREAN ENG-SUB)');
});

test('quality is peeled wherever the panel wrote it, not only off the end', () => {
  /*
    139 rows of the live line print a token in the MIDDLE of the name, and they
    are all one shape: the panel writes it before its own year. Each of these
    reached a television with the "4K" still on it, because the tail rule
    correctly found no tail — the year was in the way — and `dropYear` runs
    afterwards. The tail rules loop until stable now, which is what the fix
    actually is: three of these have their annotations in three different orders.
  */
  assert.equal(displayName('NF - The Serpent 4K (2021)', { dropYear: true }), 'The Serpent');
  assert.equal(displayName('NF - Money Heist (ES) (4K)'), 'Money Heist');
  assert.equal(displayName('EN - At Home With The Furys (2023) (GB) TYSON FURY',
    { dropYear: true }), 'At Home With The Furys');
  assert.equal(displayName('4K-DK - Carmen Curlers (2022) (DK)', { dropYear: true }),
    'Carmen Curlers');
  /* And the titles the rule must never touch: a digit-leading word that is not a
     transcode, a real pipe, a colon-separated name with SD inside it. */
  assert.equal(displayName('EN - The 4400 (2004)', { dropYear: true }), 'The 4400');
  assert.equal(displayName('EN - 24 - Legacy (2017)', { dropYear: true }), '24 - Legacy');
  assert.equal(displayName('D+ - City of Angels | City of Death'),
    'City of Angels | City of Death');
  assert.equal(displayName('EN - NTSF:SD:SUV:: (2011)', { dropYear: true }), 'NTSF:SD:SUV::');
  /* A name that is NOTHING but a token keeps it — never return an empty row. */
  assert.equal(displayName('4K'), '4K');
});

test('a group label is a different grammar from a title', () => {
  /*
    "DK| DANSKE SERIER 4K/UHD" is what sat over the similar-titles rail. A
    category is a region field, then a name that may itself be two words joined
    by a pipe — so it does not go through `displayName` at all. 79 of this line's
    232 series categories reached the screen with a quality token in them.

    Display-time, deliberately: `cleanName` is computed once at ingest and stored
    in the row, so a change there reaches a television only after the next full
    re-ingest, and this has to be right on the copy already on the device.
  */
  assert.equal(groupLabel('DK| DANSKE SERIER 4K/UHD'), 'Danske Serier');
  assert.equal(groupLabel('|MULTI| NETFLIX SERIES 4K'), 'Netflix Series');
  assert.equal(groupLabel('|FR| NETFLIX CRIME | MYSTERE'), 'Netflix Crime · Mystere');
  assert.equal(groupLabel('|EN| 4K SERIES'), 'Series');
  /* Already clean, and a label that is nothing but a token keeps it. */
  assert.equal(groupLabel('DANSKE SERIER'), 'Danske Serier');
  assert.equal(groupLabel('4K'), '4K');
});

test('what the name loses, the tags offer back', () => {
  // The invariant: a chip exists for every decoration `displayName` removes.
  assert.deepEqual(titleTags('4K-SC - Fallout (2024) (US)'),
    { quality: '4K', source: 'SC', country: 'US' });
  assert.deepEqual(titleTags('4K - 1899 (2022) (DE)'),
    { quality: '4K', source: null, country: 'DE' });
  assert.deepEqual(titleTags('A+ - Dear Edward (2023)'),
    { quality: null, source: 'A+', country: null });
  /* The name DROPS a bare country now, so the chip has to carry it — that is the
     invariant this test exists for, read from the other side. */
  assert.deepEqual(titleTags('The Office (US)'),
    { quality: null, source: null, country: 'US' });
  /* An audio tag is not a place, and the name keeps it, so it is not a chip. */
  assert.deepEqual(titleTags('Naruto (DUB)'),
    { quality: null, source: null, country: null });
  assert.deepEqual(titleTags('Mission - Impossible'),
    { quality: null, source: null, country: null });
});

/*
 * ── the spacing report, and the punctuation four rules were leaving behind ───
 *
 * "i noticed after that strip name thing, i see douple space i mean in relavent
 * movies title" — the MORE LIKE THIS rail, which renders
 * `displayName(name, { dropYear: true })` under every poster.
 *
 * Counted before anything was changed, by putting every name in
 * `fixtures/catalogue.json` through both call shapes (5,374 names, 10,748 calls)
 * and looking for a double space, an edge space, a space in front of a comma or
 * a period, an empty result, or a bracket, dash or comma with nothing on the
 * other side of it:
 *
 *     17 names   a trailing comma      `SHOUTED_TAIL` stopping inside a cast list
 *     14 names   a trailing slash      `QUALITY_TAIL` taking half of "4K/UHD"
 *     11 names   a trailing dash       the year or the actor run leaving from
 *                                      behind the dash that introduced it
 *      1 name    an unclosed bracket   `QUALITY_TAIL` eating the ")" of "(UHD/4K)"
 *
 * The double space is not in that list, and that is the interesting half of the
 * measurement: no arrangement of a real name produces one, because the tail loop
 * collapses whitespace at the end of every pass. Finding the one exit that
 * skipped it took 43,008 synthetic names — every decoration in this file, in
 * every order — and every survivor in that search carried an `[X]` tag.
 *
 * Every name below is verbatim from the fixture unless its comment says
 * otherwise, and the ones that are NOT artefacts are here in equal number: this
 * whole class of fix is one bad character class away from eating a real word.
 */
test('a slashed quality pair goes whole, not half', () => {
  /* These reached a television as "LA 1 4K/" and "KINO UHD/" — the tail rule
     matched the last token of the pair and left the slash standing. */
  assert.equal(displayName('ES| LA 1 4K/UHD'), 'La 1');
  assert.equal(displayName('4K| KINO UHD/4K'), 'Kino');
  assert.equal(displayName('UK| SKY SPORTS F1 UHD/4K'), 'Sky Sports F1');
  /* And in a bracket, which was the worse one: the ")" went with the "4K" and
     left "BBC EVENTS 1 (UHD/" with an opening bracket that closes nowhere. */
  assert.equal(displayName('UK-BBCI| BBC EVENTS 1 (UHD/4K)'), 'BBC Events 1');
  /* A slash between things that are NOT both transcodes is punctuation in the
     name and stays — 24/7 is when the channel runs, not what it is encoded as. */
  assert.equal(displayName('NL| VIAPLAY TV 24/7 ᴿᴬᵂ'), 'Viaplay TV 24/7');
  assert.equal(displayName('PLAY+| VERONICA / DISNEY JR ᴴᴰ'), 'Veronica / Disney Jr');
});

test('a dash whose tag was removed goes with it', () => {
  /* The panel writes " - " in front of the year on these five, so taking the
     year off left the rail reading "La gran aventura suiza -". */
  assert.equal(displayName('ES - La gran aventura suiza - (2022)', { dropYear: true }),
    'La gran aventura suiza');
  assert.equal(displayName('ES - Sangre y oro - (2023)', { dropYear: true }), 'Sangre y oro');
  /* Same shape from the other end: the actor run left, the dash that introduced
     IT did not. Note the double space in the source name, which is the panel's. */
  assert.equal(displayName("FR - La vengeance d'une blonde  (1994) - CHRISTIAN CLAVIER"),
    "La vengeance d'une blonde (1994)");
  assert.equal(
    displayName("FR - La vengeance d'une blonde  (1994) - CHRISTIAN CLAVIER", { dropYear: true }),
    "La vengeance d'une blonde",
  );
  /* And the reason this rule wants a SPACE and an end of string: a dash between
     two words is a title, and no row of this catalogue ends in a dash that is
     attached to one. Both of these are verbatim. */
  assert.equal(displayName('GP van Nederland  - Race 2026'), 'GP van Nederland - Race 2026');
  assert.equal(displayName('24 - Legacy'), '24 - Legacy');
  assert.equal(displayName('Mission - Impossible'), 'Mission - Impossible');
  assert.equal(displayName('EN - NTSF:SD:SUV:: (2011)', { dropYear: true }), 'NTSF:SD:SUV::');
});

test('a comma-separated cast list is a cast list', () => {
  /*
    `SHOUTED_TAIL` peels a run of shouted words and its run stops at a comma, so
    a title crediting three people lost the last one and kept the comma:
    "The Godfather MARLON BRANDO, AL PACINO," on a rail read from three metres.
    17 names ended that way.

    Measured before the rule was written: 22 names end in a comma-separated run
    of shouted words and all 22 are credits, which is why the comma is evidence
    and not a risk — it makes this rule NARROWER than the bare run, not wider.
  */
  assert.equal(
    displayName('EN - The Godfather 4K (1972) MARLON BRANDO, AL PACINO, FRANCIS FORD COPPOLA',
      { dropYear: true }),
    'The Godfather',
  );
  assert.equal(
    displayName('EN - The Godfather 4K (1972) MARLON BRANDO, AL PACINO, FRANCIS FORD COPPOLA'),
    'The Godfather (1972)',
  );
  /* Two characters is the floor for a word here, against three in the bare run,
     because these lists are full of "AL PACINO" and "DE NIRO". */
  assert.equal(displayName('EN - Taxi Driver 4K (1976) DE NIRO, HARVEY KEITEL, SCORSESE',
    { dropYear: true }), 'Taxi Driver');
  /* An initial inside a name, and a dash in front of the whole list — the two
     rules of this section meeting on one row. */
  assert.equal(displayName('EN - Smart Money (1931) JAMES CAGNEY, EDWARD G. ROBINSON'),
    'Smart Money (1931)');
  assert.equal(
    displayName('EN - Inglourious Basterds 4K (2009) - TARANTINO, BRAD PITT, HARVEY KEITEL',
      { dropYear: true }),
    'Inglourious Basterds',
  );
  /* A MIXED-CASE name in the list is not touched, because nothing tells it from
     title text — only the dangling comma goes. That is deliberate, and it is why
     this row reads the way it does rather than as "Blonde". */
  assert.equal(displayName('NF - Blonde 4K (2022) Marilyn Monroe, TONY CURTIS UNCREDIT',
    { dropYear: true }), 'Blonde Marilyn Monroe');
  /* Commas that belong to the title. The first two would be gone if the rule
     read commas instead of shouting; the third is what the lowercase-somewhere
     guard is for, an all-caps title that would otherwise read as its own credits. */
  assert.equal(displayName('EN - Iron Eagle 4, Iron Eagle On The Attack  (1995)',
    { dropYear: true }), 'Iron Eagle 4, Iron Eagle On The Attack');
  assert.equal(displayName("EN - Wait, Wait, Don't Kill Me  (2020)", { dropYear: true }),
    "Wait, Wait, Don't Kill Me");
  assert.equal(displayName('NL - PENOZA THE FINAL CHAPTER 4K  (2019)', { dropYear: true }),
    'Penoza the Final Chapter');
});

test('nothing comes back with a run of spaces in it', () => {
  /*
    226 of this catalogue's VOD names carry a run of spaces — the panel writes
    them — and the tail loop has always collapsed them. These are the shapes that
    put the run somewhere awkward: in front of the year, after the prefix dash,
    inside the prefix itself, and in the middle of a real title.
  */
  for (const [name, plain, dropped] of [
    ['NF - 7 Prisoners  (2021)', '7 Prisoners (2021)', '7 Prisoners'],
    ['EN -  Us Kids  (2020)', 'Us Kids (2020)', 'Us Kids'],
    ['EN  - Wake Up Dead Man: A Knives Out Mystery 4K (2025)',
      'Wake Up Dead Man: A Knives Out Mystery (2025)',
      'Wake Up Dead Man: A Knives Out Mystery'],
    ["FR - Au Nord  Petits secrets d'une grande saison (2023)",
      "Au Nord Petits secrets d'une grande saison (2023)",
      "Au Nord Petits secrets d'une grande saison"],
  ] as const) {
    assert.equal(displayName(name), plain);
    assert.equal(displayName(name, { dropYear: true }), dropped);
  }
});

test('a name is still never reduced to nothing, or to a fragment', () => {
  /* The orphan-punctuation rule runs inside the tail loop, where three rules
     already guard against emptying a name, and it has to do the same: these are
     the shapes that are nothing BUT the punctuation it removes. */
  /* The bracket forms are here for the same reason, and they are the head peel's
     own guard: a name that is nothing BUT tags stops rather than emptying. */
  for (const n of ['EN - ', ' - ', '-', ',', 'ES|', '4K', '4K/UHD', '|',
    '[4K]', '[VIP]', '[X]', '[X][4K]', '(MX)', '[MULTI][VIP][4K]']) {
    assert.notEqual(displayName(n).trim(), '', JSON.stringify(n));
    assert.notEqual(displayName(n, { dropYear: true }).trim(), '', JSON.stringify(n));
  }
});

test('what the panel wrote and never took back is left alone', () => {
  /*
    The other half of the measurement, and the half deliberately NOT fixed. These
    four rows are damage on the line itself — a space before a period, a space
    before a comma, a bracket the panel never closed, an empty trailing field —
    and no rule in this file removed anything from them. Cleaning them would mean
    editing title text on a guess, which is the one thing this module does not do,
    and pinning them here says the next reading of the counts is not a regression.
  */
  assert.equal(displayName('EN - Tyler Perry .Finding Joy 4K (2025)', { dropYear: true }),
    'Tyler Perry .Finding Joy');
  assert.equal(displayName('EN - Castillos De Cartón , 3some (2009) (SPANISH ENG-SUB)',
    { dropYear: true }), 'Castillos De Cartón , 3some (SPANISH ENG-SUB)');
  assert.equal(displayName('FR - Super Me (VOSTFRà (2019)', { dropYear: true }),
    'Super Me (VOSTFRà');
  /* The empty trailing field is the one exception now: dropping a field with
     nothing in it edits no title text (see `slotName`). */
  assert.equal(displayName('Vidio EPL 1 |'), 'Vidio EPL 1');
});

/*
 * ── the bracket report ──────────────────────────────────────────────────────
 *
 * "the player shows things in array like [x][4k] and its not stripped everywhere
 * properly, and same as movies and other things" — read off a television.
 *
 * The player half was a call site: `MovieDetail` cleaned the name for
 * `player.opening` and handed `player.load` the raw one, and `load` is the call
 * that wins. The rules below are the module half — what a bracket at the HEAD of
 * a name means, which is where the two grammars in this app used to disagree.
 */
test('a bracket tag at the head does not shelter the prefix behind it', () => {
  /*
   * `QUALITY_ANY` and `FILE_TAG` peel a bracket wherever it stands, but they run
   * at the END of the pass and the prefix rules run at the start — so a name
   * carrying both kept its market, because at `^` there was a bracket rather
   * than a prefix. Constructed from two real halves and said so: the fixture has
   * no row with a leading bracket AND a prefix, so these pair this line's real
   * bracket tags with its real prefixes (`EN - `, `ES| `, `|EN| `).
   */
  assert.equal(displayName('[FHD] EN - Some Film'), 'Some Film');
  assert.equal(displayName('[SD] |EN| Channel 4'), 'Channel 4');
  assert.equal(displayName('[4K] Some Film (2011)', { dropYear: true }), 'Some Film');
  // Several in a row, which is how the panel writes them.
  assert.equal(displayName('[VIP][4K] beIN 1'), 'beIN 1');
  assert.equal(displayName('[4K][HD] Something'), 'Something');
  assert.equal(displayName('[MULTI] Discovery'), 'Discovery');
  assert.equal(displayName('[HD] BBC One'), 'BBC One');
  /* A SHOUTED two-or-three letter bracket is a market — `(MX)` is the only shape
     of it in the fixture, on six rows — and the space after it is the safety.
     `(Un)lucky` has none, which is the whole reason that rule is written this
     way; see the drift test below for what happened without it. */
  assert.equal(displayName('[UK] BBC ONE HD'), 'BBC One');
  assert.equal(displayName('[EN] The Office (US)'), 'The Office');
  assert.equal(displayName('(MX) (VIX 01) |  (2098-12-31 08:00:01)'), 'ViX 01');
});

test('an event tag is about the feed; a session tag is the row itself', () => {
  /*
   * 33 names of `fixtures/catalogue.json` carry a square bracket and 14 of them
   * are this — 11 `[LIVEEVENT]` plus one each of the other three spellings. It
   * says the feed only lights up for a fixture, which is a fact about the feed.
   */
  assert.equal(displayName('ES| M.LALIGA 3 FHD [LIVEEVENT]'), 'M.LaLiga 3');
  assert.equal(displayName('4K| SKY SPORTS UHD [EVENT]'), 'Sky Sports');
  assert.equal(displayName('NL| GLORY & UFC [LIVE EVENT]'), 'Glory & UFC');
  assert.equal(displayName('4K| TNT ULTIMATE 4K+ [LIVE-EVENT]'), 'TNT Ultimate 4K+');
  /*
   * And the rest of that measurement, which is why the word list is spelled out
   * instead of the rule being "take every square bracket". Six rows of this
   * fixture are the same Abu Dhabi weekend and the bracket is the ONLY thing
   * telling them apart; a general rule prints six identical lines.
   */
  assert.equal(displayName('ES - Formula 1 2024 Abu Dhabi [FP1] [SPA]'),
    'Formula 1 2024 Abu Dhabi [FP1]');
  assert.equal(displayName('ES - Formula 1 2024 Abu Dhabi [RACE] [SPA]'),
    'Formula 1 2024 Abu Dhabi [RACE]');
  assert.equal(displayName('ES - Formula 1 2024 Abu Dhabi [QUALY] [SPA]'),
    'Formula 1 2024 Abu Dhabi [QUALY]');
  // A bracket that is part of the title, and a PPV placeholder that is a word.
  assert.equal(displayName('NF - BIGBANG - World Tour [MADE] Final In Seoul (2016)',
    { dropYear: true }), 'BIGBANG - World Tour [MADE] Final In Seoul');
  assert.equal(displayName('NL| F1 OLAV MOL [KWALI + RACE]'), 'F1 Olav Mol [Kwali + Race]');
});

test('every superscript marker this line writes comes off', () => {
  /*
   * All ten distinct runs in `fixtures/catalogue.json`, by frequency: ᴿᴬᵂ 283,
   * ᴴᴰ 148, ᵁᴴᴰ 3, ⁶⁰ 3, ᵖˢ 3, ᴸᴼᵂ 2, ᴳᴼᴸᴰ 2, ᵁᴸᵀᴿᴬ 1, ˢᵘᵖᵉʳ 1, ˢᵘᵖᵉ 1.
   * They are spread over three Unicode blocks, which is why `SUPERSCRIPT` is
   * spelled out by codepoint — a range that looks complete leaves "ⱽ" behind.
   * Verbatim rows, one per marker shape.
   */
  assert.equal(displayName('ES| 1+1 INTERNACIONAL ᴿᴬᵂ'), '1+1 Internacional');
  assert.equal(displayName('ES| M+ SERIES INFO ᴴᴰ'), 'M+ Series Info');
  assert.equal(displayName('ES| DAZN LA LIGA 3 ᵁᴴᴰ'), 'DAZN la Liga 3');
  assert.equal(displayName('ES| M. LIGA DE CAMPEONES 1 ᴸᴼᵂ'), 'M. Liga de Campeones 1');
  // Two markers on one name, one of them lower-case forms from a fourth block.
  assert.equal(displayName('NL| ZIGGO SPORT TOTTAL ᵁᴸᵀᴿᴬ ᴿᴬᵂ'), 'Ziggo Sport Tottal');
  assert.equal(displayName('NL| VIAPLAY PPV ˢᵘᵖᵉʳ'), 'Viaplay PPV');
});

/*
 * ── cleanTitle, which used to be a second grammar in a .tsx ─────────────────
 *
 * It lived in `components/DetailHero.tsx` with its own prefix, bracket and year
 * rules, which meant two implementations of one grammar AND no unit test — the
 * suite only reads `apps/web/src/lib/*.test.ts`, so nothing here could see it.
 *
 * Measured by running all 5,374 names of `fixtures/catalogue.json` through both:
 * 11 came out different on the rail and on the film page. Nine of those are the
 * audio tag, which is a deliberate difference and has its own test below. The
 * other two classes were bugs, and they are the cases pinned here.
 */
test('a heading and a rail label are the same string now', () => {
  /*
   * The corruption: the old bracket rule took any 1-8 characters and did not ask
   * for a separator after the closing bracket, so the first word of a real title
   * went with it. The film page read "lucky Sisters" while the rail six
   * centimetres away read "(Un)lucky Sisters".
   */
  assert.equal(cleanTitle('NF - (Un)lucky Sisters (2024)'), '(Un)lucky Sisters');
  /*
   * And the same rule collapsing two rows into one. These are two halves of one
   * stand-up show; the bracket is all that separates them, which is the same
   * trade `YEAR_THEN_COUNTRY` documents for "The Office (US)".
   */
  assert.equal(cleanTitle('QFR - (partie1) Anthony Kavanagh - Show Man (2020)'),
    '(partie1) Anthony Kavanagh - Show Man');
  assert.equal(cleanTitle('QFR - (partie2) Anthony Kavanagh - Showman (2020)'),
    '(partie2) Anthony Kavanagh - Showman');
  /* The paired prefix, which is what sent `cleanTitle` to `displayName` in the
     first place: peeling only the first half left "SC - Fallout" on the heading. */
  assert.equal(cleanTitle('4K-SC - Fallout (2024) (US)'), 'Fallout');
  assert.equal(cleanTitle('4K-DK - Carmen Curlers (2022) (DK)'), 'Carmen Curlers');
  /* The year is the one thing a heading drops that a rail keeps — it is a badge
     of its own on that screen. */
  assert.equal(cleanTitle('EN - The Shawshank Redemption (1994)'), 'The Shawshank Redemption');
  /* Never an empty h1, whatever the name was made of. */
  for (const n of ['EN - ', '4K', '[X]', '|', ' - ']) {
    assert.notEqual(cleanTitle(n).trim(), '', JSON.stringify(n));
  }
});

test('the audio version is the one thing a heading drops and a rail keeps', () => {
  /*
   * The only remaining difference between the two, and it is deliberate: 9 of
   * the 5,374 fixture names end in one of these. In a LIST the bracket is the
   * only thing telling two rows of the same show apart — 17 titles on this line
   * ship as `(DUB)` and `(SUB)` — so `displayName` keeps it. A heading shows one
   * title with nothing to be told apart from, and the same string is handed to
   * OpenSubtitles, where "American Dad! (VFQ)" matches nothing.
   */
  assert.equal(displayName('QFR - American Dad! (VFQ)'), 'American Dad! (VFQ)');
  assert.equal(cleanTitle('QFR - American Dad! (VFQ)'), 'American Dad!');
  assert.equal(displayName('FR - Alchemy of Souls (KR) (VOSTFR)'), 'Alchemy of Souls (KR) (VOSTFR)');
  assert.equal(cleanTitle('FR - Alchemy of Souls (KR) (VOSTFR)'), 'Alchemy of Souls (KR)');
  assert.equal(cleanTitle('NF - Naruto (DUB)'), 'Naruto');
  /* A note that names a language a viewer cannot get anywhere else is not an
     audio tag and stays on both screens. */
  assert.equal(cleanTitle('EN - Squid Game (KOREAN ENG-SUB)'), 'Squid Game (KOREAN ENG-SUB)');
});

test('an event feed with no event in it reads as the feed, and a fixture keeps its countries', () => {
  /* All from the fixture: empty PPV slots, a 2098 placeholder, a bracketed feed. */
  assert.equal(displayName('UK: NETFLIX PPV 1  - | 8K EXCLUSIVE'), 'Netflix PPV 1');
  assert.equal(displayName('(MX) (VIX 01) |  (2098-12-31 08:00:01)'), 'ViX 01');
  assert.equal(displayName('(Fanatiz 001) | Buffaloes vs Eagles (2026-09-02 13:00:00)'), 'Buffaloes vs Eagles');
  assert.equal(
    displayName('UK: VOLLEY PPV 4 - THAMELA/VICTORIA (BRA) VS [TBC], WOMEN FINAL 3RD PLACE ON CC | OSTRAVA (CZE) | Sun 31 May 11:50 | 8K EXCLUSIVE'),
    'Thamela/Victoria (BRA) vs [TBC], Women Final 3rd Place on CC',
  );
  /* "WWE:" is a brand, not a market, and stays. */
  assert.match(displayName('FR - WWE: WrestleMania 37 (Night 1)  (2021)'), /^WWE: WrestleMania 37/);
});
