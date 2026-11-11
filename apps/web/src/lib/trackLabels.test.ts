import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDisableTrack, nameTracks, trackName } from './trackLabels.ts';

/*
 * The shapes here are not invented: they are what ffprobe found inside this
 * catalogue (`fre`/`eng`, `spa`/`eng`, `ger`/`eng` dubs, three `fre` ASS
 * subtitle tracks on one film, `und` on every single-audio film) and what
 * libVLC 3 wraps them in before the page sees them.
 */

test('a three-letter Matroska code becomes a language name', () => {
  assert.equal(trackName('Track 1 - [fre]'), 'French');
  assert.equal(trackName('Track 2 - [ger]'), 'German');
  assert.equal(trackName('Audio - [dut]'), 'Dutch');
});

test('the terminological spellings mean the same language', () => {
  // A file may carry either; both are the language, not two languages.
  assert.equal(trackName('[fra]'), 'French');
  assert.equal(trackName('[deu]'), 'German');
  assert.equal(trackName('[nld]'), 'Dutch');
});

test('a two-letter code works too, and a separate lang field wins', () => {
  assert.equal(trackName('Audio 1', 'nl'), 'Dutch');
  assert.equal(trackName('[es]'), 'Spanish');
});

test('"und" is not a language and never becomes one', () => {
  /* Every single-audio film in the sample carried `und`. Labelling most of the
     catalogue "Undetermined" tells a viewer less than "Track 1" does. */
  assert.equal(trackName('Track 1 - [und]'), 'Track 1 - [und]');
  assert.equal(trackName('Track 1', 'und'), 'Track 1');
});

test('a language spelled out in full is recognised as well', () => {
  assert.equal(trackName('English'), 'English');
  assert.equal(trackName('Commentary (English)'), 'English (commentary)');
});

test('"Track" is not read as Turkish, nor "Stereo" as Estonian', () => {
  /* The trap this function has to survive: a substring search for two-letter
     codes finds a language in almost any English word. */
  assert.equal(trackName('Track'), 'Track');
  assert.equal(trackName('Stereo'), 'Stereo');
  assert.equal(trackName('Audio'), 'Audio');
});

test('what makes two tracks of one language different is kept', () => {
  assert.equal(trackName('[eng] SDH'), 'English (SDH)');
  assert.equal(trackName('Subtitle - [fre] forced'), 'French (forced)');
});

test('libVLC’s Disable pseudo-track is recognised, by id or by name', () => {
  assert.equal(isDisableTrack(-1, 'Track -1'), true);
  assert.equal(isDisableTrack(3, 'Disable'), true);
  assert.equal(isDisableTrack(3, 'English'), false);
});

test('only colliding names are numbered', () => {
  const named = nameTracks([
    { id: 1, label: 'Track 1 - [fre]' },
    { id: 2, label: 'Track 2 - [eng]' },
  ]);
  assert.deepEqual(named.map((t) => t.name), ['French', 'English']);
});

test('two tracks of the same language are told apart', () => {
  /* Measured: one film carried two `fre` ASS subtitle tracks. Two rows both
     reading "French" is a choice with no information in it. */
  const named = nameTracks([
    { id: 1, label: 'Track 1 - [fre]' },
    { id: 2, label: 'Track 2 - [fre]' },
    { id: 3, label: 'Track 3 - [eng]' },
  ]);
  assert.deepEqual(named.map((t) => t.name), ['French 1', 'French 2', 'English']);
});

test('the off row is named Off rather than given a language', () => {
  const named = nameTracks([
    { id: -1, label: 'Disable' },
    { id: 4, label: 'Track 1 - [spa]' },
  ]);
  assert.deepEqual(named.map((t) => t.name), ['Off', 'Spanish']);
});

test('an empty label still produces something to press', () => {
  assert.equal(trackName(''), 'Track');
});
