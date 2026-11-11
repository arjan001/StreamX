import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueText, dialogueKey, trackLang } from './filmSubs.ts';

test('a SubRip line keeps its italics and loses its carriage returns', () => {
  /* What the remuxer handed out, measured, for an SRT track in a Matroska. */
  assert.equal(cueText('Hello, this is the <i>first</i> line.'), 'Hello, this is the <i>first</i> line.');
  assert.equal(cueText('Second line\r\non two rows.'), 'Second line\non two rows.');
});

test('markup a cue cannot show is dropped rather than printed', () => {
  assert.equal(cueText('<font color="#ffff00">Yellow</font> words'), 'Yellow words');
});

test('an ASS event loses its fields, override blocks and escapes', () => {
  assert.equal(
    cueText('12,0,Default,,0,0,0,,{\\an8}Up here\\Nand below\\hnow'),
    'Up here\nand below now',
  );
  /* The library may also hand the fields over by name. */
  assert.equal(cueText('ignored', { Text: '{\\i1}Named{\\i0}' }), 'Named');
});

test('an ampersand or a bare angle bracket survives as text', () => {
  assert.equal(cueText('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(cueText('x < y'), 'x &lt; y');
});

test('a line that is nothing but formatting is empty, so no cue is made', () => {
  assert.equal(cueText('{\\an8}'), '');
  assert.equal(cueText('  \r\n '), '');
});

test('the same line arriving twice after a seek has one key', () => {
  const a = { streamIndex: 4, start: 40_000, end: 42_000, content: 'Forty seconds in.' };
  assert.equal(dialogueKey(a), dialogueKey({ ...a }));
  assert.notEqual(dialogueKey(a), dialogueKey({ ...a, start: 40_001 }));
});

test('Matroska language codes pass as srclang; unknown ones are left empty', () => {
  assert.equal(trackLang('fre'), 'fre');
  assert.equal(trackLang('eng'), 'eng');
  assert.equal(trackLang('und'), '');
  assert.equal(trackLang(''), '');
  assert.equal(trackLang('English (SDH)'), '');
});
