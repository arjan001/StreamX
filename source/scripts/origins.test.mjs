/**
 * No operator address or domain in the packaged shells, and one application id.
 *
 * The app is a neutral player: nothing in the Android, Tizen or webOS sources
 * may name a server IP, a panel range or the operator's domain, and the
 * application id is written by `scripts/brand-apply.mjs` alone, so the places
 * that carry it cannot disagree.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');

const SCANNED = [
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'brand.config.json',
  'apps/mobile/package.json',
  'apps/mobile/capacitor.config.ts',
  'apps/mobile/README.md',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/android/app/src/main/AndroidManifest.xml',
  'apps/mobile/android/app/src/main/java/com/easyred/streamix/MainActivity.java',
  'apps/mobile/android/app/src/main/java/com/easyred/streamix/PosterImageCache.java',
  'apps/tizen/build.mjs',
  'apps/tizen/config.xml',
  'apps/tizen/README.md',
  'apps/webos/build.mjs',
  'apps/webos/README.md',
];


/** The first IPv4 literal outside private, loopback and documentation ranges, or null. */
function publicIpv4(text) {
  for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const [a, b, c] = m.slice(1, 4).map(Number);
    const reserved = a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || (a === 169 && b === 254) || a >= 224;
    if (!reserved) return m[0];
  }
  return null;
}

test('no owner address, panel range or domain in the packaged shells', () => {
  for (const file of SCANNED) {
    /* The publisher block is the one place the owner's details may be written;
       it is checked separately below. */
    const text = file === 'brand.config.json'
      ? JSON.stringify({ ...JSON.parse(read(file)), publisher: undefined })
      : read(file);
    assert.equal(publicIpv4(text), null, `${file} names an address`);
  }
});

test('the publisher block of brand.config.json is the only config that carries contact details', () => {
  const brand = JSON.parse(read('brand.config.json'));
  assert.equal(brand.site, '');
  const { publisher, ...rest } = brand;
  const text = JSON.stringify(rest);
  assert.equal(publicIpv4(text), null);
  for (const v of Object.values(publisher)) {
    if (typeof v === 'string' && v.trim() !== '' && v !== brand.name) assert.equal(text.includes(v), false);
  }
  assert.equal(typeof publisher.email, 'string');
});

test('the application id is the same everywhere it is written', () => {
  const brand = JSON.parse(read('brand.config.json'));
  const id = brand.android.applicationId;
  assert.equal(id, 'com.easyred.streamix');
  assert.equal(brand.ios.bundleId, id);
  assert.equal(brand.site, '');
  assert.match(read('apps/mobile/android/app/build.gradle'), new RegExp(`applicationId "${id}"`));
  assert.match(read('apps/mobile/android/app/build.gradle'), new RegExp(`namespace "${id}"`));
  assert.match(read('apps/mobile/capacitor.config.ts'), new RegExp(`appId: '${id}'`));
});

test('the manifest asks for nothing Play forbids or the app no longer uses', () => {
  const m = read('apps/mobile/android/app/src/main/AndroidManifest.xml');
  for (const gone of ['REQUEST_INSTALL_PACKAGES', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'FileProvider']) {
    assert.equal(m.includes(gone), false, `manifest still mentions ${gone}`);
  }
  assert.match(m, /android:allowBackup="false"/);
  assert.match(m, /foregroundServiceType="mediaProjection"/);
});
