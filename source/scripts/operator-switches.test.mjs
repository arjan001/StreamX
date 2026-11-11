/**
 * Every switch on the admin screen has something on the other end of it.
 *
 * One did not: `localCatalogueDefault` was written to the config document and
 * read by no line of the app, and could not have been otherwise since the
 * server catalogue was removed.
 *
 * A switch that reports its own state back and changes nothing is worse than
 * no switch, because it is indistinguishable from a working one — and that is
 * not something a type checker or a unit test can notice. This reads the admin
 * screen for the keys it writes, and asks whether anything else in the app
 * reads each one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../apps/web/src/', import.meta.url).pathname;
const settings = readFileSync(join(root, 'routes/admin/Settings.tsx'), 'utf8');

/** Every config key the admin screen writes. */
const written = [...settings.matchAll(/set\('([a-zA-Z][\w]*)'/g)].map((m) => m[1]);

/** Everything outside the admin screens, which is where a flag has to land. */
function appFiles(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'admin') continue;
      appFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

const app = appFiles().map((f) => readFileSync(f, 'utf8')).join('\n');

test('the admin screen writes at least the switches we know about', () => {
  assert.ok(written.length >= 2, `only found ${written.length} config keys — has the screen moved?`);
  assert.ok(written.includes('deviceRelayOff'), 'the relay switch is gone');
});

test('every switch an operator can set is read somewhere in the app', () => {
  const dead = [...new Set(written)].filter((key) => !app.includes(key));
  assert.deepEqual(dead, [], `nothing outside admin reads: ${dead.join(', ')}`);
});
