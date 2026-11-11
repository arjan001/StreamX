/**
 * Back on an LG remote, which is the only button webOS does not share.
 *
 * It is worth its own test because of what sits behind it: `appinfo.json` sets
 * `disableBackHistoryAPI`, so webOS stops closing the app itself and this
 * listener becomes the ONLY way out of a screen. If this mapping is wrong, Back
 * does nothing on a real television and a viewer is stuck.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentForTizenCode, intentForWebosCode } from './remoteKeys.ts';

test('LG sends 461 for Back where Samsung sends 10009', () => {
  assert.equal(intentForWebosCode(461), 'exit');
  assert.equal(intentForTizenCode(10009), 'exit');
  /* And neither number means anything on the other platform's remote, which is
     why they can share one table without colliding. */
  assert.equal(intentForTizenCode(461), null);
});

test('the media buttons are the standard numbers, shared with Tizen', () => {
  /* 415/19/413/412/417 are the standard media keycodes rather than anybody's
     extension, so an LG remote and a Samsung one send the same ones. */
  for (const [code, want] of [[415, 'play'], [19, 'pause'], [413, 'stop'],
    [412, 'back'], [417, 'forward']]) {
    assert.equal(intentForWebosCode(code), want, String(code));
  }
});

test('the digits work the same as everywhere else', () => {
  assert.equal(intentForWebosCode(48), 'digit0');
  assert.equal(intentForWebosCode(53), 'digit5');
});

test('a key that means nothing here stays nothing', () => {
  assert.equal(intentForWebosCode(1), null);
  assert.equal(intentForWebosCode(999), null);
});
