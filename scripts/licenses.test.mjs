import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('THIRD_PARTY_NOTICES.md and legal/licenses.md match the dependency tree', () => {
  /* Fails when a dependency changed and `node scripts/licenses.mjs` was not run. */
  execFileSync('node', [join(root, 'scripts/licenses.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
  assert.ok(true);
});
