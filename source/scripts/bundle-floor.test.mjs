import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tizenIds, widgetVersion } from '../apps/tizen/manifest.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'bundle-floor.mjs');

function gate(code) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.js'), code);
    return spawnSync(process.execPath, [GATE, dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bundle floor: a chunk that stays inside Chromium 68 passes', () => {
  const r = gate('var a = function (x) { return x + 1; };\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('bundle floor: syntax newer than Chromium 68 fails the build', () => {
  assert.equal(gate('var a = b?.c;\n').status, 1);
  assert.equal(gate('var a = b ?? c;\n').status, 1);
});

test('tizen ids: ten alphanumerics, application id is package.name', () => {
  assert.deepEqual(tizenIds('Streamix'), { pkg: 'StreamixTV', appId: 'StreamixTV.Streamix', name: 'Streamix' });
  const odd = tizenIds('My Player!');
  assert.match(odd.pkg, /^[A-Za-z0-9]{10}$/);
  assert.equal(odd.appId, `${odd.pkg}.MyPlayer`);
  assert.equal(tizenIds('A').pkg.length, 10);
  assert.throws(() => tizenIds('!!!'));
});

test('widget version is three numbers from version.json', () => {
  assert.equal(widgetVersion('1.63.0'), '1.63.0');
  assert.equal(widgetVersion('2.1'), '2.1.0');
  assert.equal(widgetVersion('1.2.3.4'), '1.2.3');
});
