import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XmltvReader, xmlText, xmltvTime, type XmltvProgramme } from './xmltv.ts';

/* The head of the owner's own `xmltv.php`, shape for shape. */
const SAMPLE = `<?xml version="1.0" encoding="utf-8" ?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv generator-info-name="HIGHEND">`
  + `<channel id="M.LaLiga3.es"><display-name>ES| M.LALIGA 3 HD [LIVEEVENT]</display-name><icon src="http://x/a.png" /></channel>`
  + `<programme start="20260928190000 +0000" stop="20260928210000 +0000" channel="M.LaLiga3.es">`
  + `<title lang="es">Real Madrid &amp; Barça</title><desc lang="es">La Liga, jornada 7.</desc></programme>`
  + `<programme start="20260928210000 +0200" stop="20260928223000 +0200" channel="BBCOne.uk">`
  + `<title>News at Ten</title><desc/></programme>`
  + `</tv>`;

function readAll(text: string, chunk: number): XmltvProgramme[] {
  const got: XmltvProgramme[] = [];
  const r = new XmltvReader((p) => got.push(p));
  for (let i = 0; i < text.length; i += chunk) r.push(text.slice(i, i + chunk));
  r.finish();
  return got;
}

test('times carry their offset, and a missing one reads as UTC', () => {
  assert.equal(xmltvTime('20260928190000 +0000'), Date.UTC(2026, 8, 28, 19) / 1000);
  assert.equal(xmltvTime('20260928210000 +0200'), Date.UTC(2026, 8, 28, 19) / 1000);
  assert.equal(xmltvTime('20260928190000'), Date.UTC(2026, 8, 28, 19) / 1000);
  assert.equal(xmltvTime('202609281900 -0130'), Date.UTC(2026, 8, 28, 20, 30) / 1000);
  assert.equal(xmltvTime('tomorrow'), null);
});

test('text loses its entities and CDATA, and folds its whitespace', () => {
  assert.equal(xmlText('Real Madrid &amp; Barça'), 'Real Madrid & Barça');
  assert.equal(xmlText('&#233;t&#xE9; &quot;live&quot;'), 'été "live"');
  assert.equal(xmlText('<![CDATA[Tom & Jerry <3>]]>'), 'Tom & Jerry <3>');
  assert.equal(xmlText('  two\n  lines  '), 'two lines');
});

test('a whole guide reads the same however the network cuts it up', () => {
  const whole = readAll(SAMPLE, SAMPLE.length);
  assert.equal(whole.length, 2);
  assert.deepEqual(whole[0], {
    channel: 'M.LaLiga3.es',
    start: Date.UTC(2026, 8, 28, 19) / 1000,
    stop: Date.UTC(2026, 8, 28, 21) / 1000,
    title: 'Real Madrid & Barça',
    desc: 'La Liga, jornada 7.',
  });
  /* An empty `<desc/>` is no description, not the next field's text. */
  assert.equal(whole[1]!.desc, null);
  for (const size of [1, 3, 7, 16, 64, 333]) {
    assert.deepEqual(readAll(SAMPLE, size), whole, `chunks of ${size}`);
  }
});

test('a broken programme is skipped, and the ones around it survive', () => {
  const bad = SAMPLE.replace('start="20260928210000 +0200" ', '');
  const got = readAll(bad, 50);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.channel, 'M.LaLiga3.es');
});

test('the reader keeps only an unfinished programme between pushes, not the channel list', () => {
  const r = new XmltvReader(() => {});
  const channels = '<channel id="a"><display-name>A</display-name></channel>'.repeat(5000);
  r.push(`<tv>${channels}`);
  /* A tail this small means 300 KB of channel list was not carried forward. */
  assert.ok((r as unknown as { tail: string }).tail.length <= 16);
});

test('the channel list is read too, names and all, when asked for', () => {
  const chans: [string, string[]][] = [];
  const progs: XmltvProgramme[] = [];
  for (const size of [5, 40, SAMPLE.length]) {
    chans.length = 0; progs.length = 0;
    const r = new XmltvReader((p) => progs.push(p), (id, names) => chans.push([id, names]));
    for (let i = 0; i < SAMPLE.length; i += size) r.push(SAMPLE.slice(i, i + size));
    r.finish();
    assert.deepEqual(chans, [['M.LaLiga3.es', ['ES| M.LALIGA 3 HD [LIVEEVENT]']]], `chunks of ${size}`);
    assert.equal(progs.length, 2);
  }
});

test('channels interleaved with their programmes are all read', () => {
  const doc = '<tv>' + [1, 2, 3].map((n) => `<channel id="c${n}"><display-name>C ${n}</display-name></channel>`
    + `<programme start="20260928190000 +0000" stop="20260928200000 +0000" channel="c${n}"><title>T${n}</title></programme>`).join('') + '</tv>';
  for (const size of [7, 50, doc.length]) {
    const ids: string[] = []; const titles: string[] = [];
    const r = new XmltvReader((p) => titles.push(p.title), (id) => ids.push(id));
    for (let i = 0; i < doc.length; i += size) r.push(doc.slice(i, i + size));
    r.finish();
    assert.deepEqual(ids, ['c1', 'c2', 'c3'], `chunks of ${size}`);
    assert.deepEqual(titles, ['T1', 'T2', 'T3']);
  }
});
