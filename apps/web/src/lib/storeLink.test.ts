import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeUrl, STORE_APP_ID } from './storeLink.ts';

test('Android goes to the Play listing', () => {
  assert.equal(
    storeUrl('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'),
    `https://play.google.com/store/apps/details?id=${STORE_APP_ID}`,
  );
});

test('Samsung and LG televisions get a message, not a link', () => {
  assert.equal(storeUrl('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36'), null);
  assert.equal(storeUrl('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36'), null);
});

test('iOS has no button until an App Store address is configured', () => {
  assert.equal(storeUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), null);
});

test('a desktop browser gets no link', () => {
  assert.equal(storeUrl('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), null);
});
