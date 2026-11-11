import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE_CHROME_REM, cueBottomPercent } from './cueBox.ts';

test('a 16:9 desk player keeps a 4.25rem band under the cue', () => {
  const rem = 16;
  const h = 576;
  const line = cueBottomPercent(h, rem);
  const pad = h * (1 - line / 100);
  assert.ok(Math.abs(pad - CUE_CHROME_REM * rem) < 0.01);
  assert.ok(line > 86 && line < 90);
});

test('a short player still leaves room for the cue itself', () => {
  const line = cueBottomPercent(200, 16);
  assert.equal(line, 66);
  assert.ok(line >= 60);
});

test('missing metrics do not pin the cue to the bottom', () => {
  assert.equal(cueBottomPercent(0, 16), 80);
  assert.equal(cueBottomPercent(400, 0), 80);
});
