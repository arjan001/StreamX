import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEEDS_DEVICE_HINT, audioChoices, subtitleChoices, type FilmTrack,
} from './filmTracks.ts';

/*
 * The shapes here came off this catalogue with ffprobe: a film carrying Hindi
 * and Malayalam audio and an English SubRip track, another carrying German and
 * English audio with DVD picture subtitles, and the ordinary case of one
 * soundtrack tagged `und` and nothing else.
 */
const t = (o: Partial<FilmTrack> & { index: number; kind: 'audio' | 'subtitle' }): FilmTrack => ({
  lang: null, title: null, codec: 'aac', isDefault: false, textual: true, ...o,
});

const dualAudio: FilmTrack[] = [
  t({ index: 1, kind: 'audio', lang: 'hin', isDefault: true }),
  t({ index: 2, kind: 'audio', lang: 'mal' }),
  t({ index: 3, kind: 'subtitle', lang: 'eng', codec: 'subrip', isDefault: true }),
];

test('picture subtitles do not count as subtitles here', () => {
  /* DVD and Blu-ray subtitles are images of words; nothing in a browser turns
     them into text, so offering them would be offering a failure. */
  const bitmap = [
    t({ index: 1, kind: 'audio', lang: 'ger', isDefault: true }),
    t({ index: 2, kind: 'subtitle', lang: 'ger', codec: 'dvd_subtitle', textual: false }),
  ];
  assert.deepEqual(subtitleChoices(bitmap, null), []);
});

test('soundtracks are named by language, and the playing one is marked', () => {
  const rows = audioChoices(dualAudio, 2);
  assert.deepEqual(rows.map((r) => r.label), ['Hindi', 'Malayalam']);
  assert.deepEqual(rows.map((r) => r.active), [false, true]);
});

test('subtitles carry an Off row, selected when nothing is on', () => {
  const rows = subtitleChoices(dualAudio, null);
  assert.deepEqual(rows.map((r) => r.label), ['Off', 'English']);
  assert.equal(rows[0]!.id, -1);
  assert.equal(rows[0]!.active, true);
  assert.equal(subtitleChoices(dualAudio, 3)[1]!.active, true);
});

test('an encoder watermark is not a track name', () => {
  /* Most of this catalogue carries `title=Encoder : <site>.tv` on every stream.
     Using it would label both soundtracks with an advertisement. */
  const marked = [
    t({ index: 1, kind: 'audio', lang: 'hin', title: 'Encoder  : example.tv', isDefault: true }),
    t({ index: 2, kind: 'audio', lang: 'mal', title: 'Encoder  : example.tv' }),
  ];
  assert.deepEqual(audioChoices(marked, 1).map((r) => r.label), ['Hindi', 'Malayalam']);
});

test('a real title is kept, because it says more than the language would', () => {
  const rows = audioChoices([
    t({ index: 1, kind: 'audio', lang: 'eng', isDefault: true }),
    t({ index: 2, kind: 'audio', lang: 'eng', title: "Director's commentary" }),
  ], 1);
  assert.deepEqual(rows.map((r) => r.label), ['English', "Director's commentary"]);
});

test('two tracks of one language are told apart', () => {
  const rows = audioChoices([
    t({ index: 1, kind: 'audio', lang: 'fre', isDefault: true }),
    t({ index: 2, kind: 'audio', lang: 'fre' }),
  ], 1);
  assert.deepEqual(rows.map((r) => r.label), ['French 1', 'French 2']);
});

test('an unnamed track keeps a position rather than being guessed at', () => {
  const rows = audioChoices([
    t({ index: 1, kind: 'audio', isDefault: true }),
    t({ index: 2, kind: 'audio' }),
  ], 1);
  assert.deepEqual(rows.map((r) => r.label), ['Track 1', 'Track 2']);
});

test('a viewer who cannot play one is told what will', () => {
  /* Not a codec verdict: "this browser cannot decode E-AC-3" is true and
     useless. The television is the thing they can act on. */
  assert.match(NEEDS_DEVICE_HINT, /television/i);
  assert.doesNotMatch(NEEDS_DEVICE_HINT, /E-AC-3.*cannot decode/i);
});
