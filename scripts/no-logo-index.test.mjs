/**
 * Channel logos come only from what the viewer's own source supplies.
 * The bundled, iptv-org-derived name-to-logo index is gone, and nothing may
 * fetch it, build it or cache it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps', 'web');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('the logo index, its builder and its loader are gone', () => {
  for (const f of [
    'scripts/logo-index.mts', 'apps/web/src/lib/logoIndex.ts', 'apps/web/src/lib/channelLogos.ts',
    'apps/web/public/logo-index.json',
  ]) assert.equal(existsSync(join(ROOT, f)), false, f);
});

test('the build does not make one and nothing refers to one', () => {
  assert.ok(!readFileSync(join(WEB, 'package.json'), 'utf8').includes('logo-index'));
  assert.ok(!readFileSync(join(WEB, 'public', 'sw.js'), 'utf8').includes('logo-index'));
  const offenders = [...walk(join(WEB, 'src')), ...walk(join(ROOT, 'scripts'))]
    .filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.endsWith('no-logo-index.test.mjs'))
    .filter((f) => /logo-index|logoIndex|channelLogos|primeChannelLogos/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
