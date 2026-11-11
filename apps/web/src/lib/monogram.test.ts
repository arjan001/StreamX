import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashName, initialsOf, monogram } from './monogram.ts';

test('the same name is always the same tile', () => {
  // People learn "the green one". They cannot if it moves.
  assert.equal(monogram('BRIGHTLY').hue, monogram('BRIGHTLY').hue);
  assert.equal(hashName('a'), hashName('a'));
});

test('names that differ by one character land far apart', () => {
  // The reason for an avalanching hash rather than a sum of char codes: an
  // alphabetical list of "BRIGHTLY 1..9" must not render as a gradient.
  const hues = Array.from({ length: 9 }, (_, i) => monogram(`EN - BRIGHTLY ${i + 1}`).hue);
  const near = hues.filter((h, i) => i > 0 && Math.abs(h - hues[i - 1]!) < 20).length;
  assert.ok(near <= 1, `${near} of 8 consecutive pairs were within 20 degrees: ${hues.join(',')}`);
});

test('hues spread across the wheel rather than clustering', () => {
  const names = Array.from({ length: 174 }, (_, i) => `EN - CHANNEL ${i}`);
  const buckets = new Set(names.map((n) => Math.floor(monogram(n).hue / 30)));
  assert.equal(buckets.size, 12, 'every 30-degree segment of the wheel should be used');
});

test('initials read as a brand, not as a placeholder', () => {
  assert.equal(initialsOf('Brightly'), 'BR');
  assert.equal(initialsOf('Fake Taxi'), 'FT');
  assert.equal(initialsOf('BRIGHTLY 2'), 'BR', 'a trailing number is not a word');
  assert.equal(initialsOf('Stars Exclusive: Mia'), 'SE');
  assert.equal(initialsOf('4K'), '4K');
  assert.equal(initialsOf(''), '··');
  assert.equal(initialsOf('   '), '··');
  assert.equal(initialsOf('123 456'), '··', 'digits alone say nothing');
});

test('non-Latin names still produce initials', () => {
  // 79 countries in this catalogue; an Arabic or Cyrillic name must not fall
  // through to the placeholder.
  assert.equal(initialsOf('قناة الأولى'), 'قا');
  assert.equal(initialsOf('Первый канал'), 'ПК');
});

test('the tile is renderable CSS with a readable foreground', () => {
  const m = monogram('EN - NEWS TIME');
  assert.match(m.background, /^linear-gradient\(135deg, hsl\(\d+ \d+% \d+%\), hsl\(\d+ \d+% \d+%\)\)$/);
  assert.match(m.colour, /^hsl\(\d+ 30% 88%\)$/);
  // The ground stays dark enough for that foreground at every input.
  for (let i = 0; i < 500; i += 1) {
    const light = Number(/hsl\(\d+ \d+% (\d+)%\)/.exec(monogram(`n${i}`).background)![1]);
    assert.ok(light >= 26 && light <= 38, `lightness ${light} at n${i}`);
  }
});
