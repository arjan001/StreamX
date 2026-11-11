/**
 * The secure-context-only apis, and the probes that would otherwise never
 * notice one was missing.
 *
 * `crypto.randomUUID` and `crypto.subtle` exist on `https://` and on
 * `localhost`, and NOT on a plain-HTTP page served from an IP address — which
 * is how this app is actually reached. A dependency that calls one unguarded
 * throws on its first line, and a whole day of green probes missed exactly
 * that once because every probe drove `127.0.0.1`, which IS a secure context.
 *
 * The page fills `randomUUID` in (`lib/randomUuid.ts`). A WORKER inherits
 * nothing from the page, so a worker that needed it would need its own copy —
 * which is why the files libav.js runs in its worker are checked here for ever
 * asking: libav.js does not, and an upgrade that starts to must fail this test
 * rather than a viewer's first film.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dist = new URL('../apps/web/libav/dist/', import.meta.url).pathname;

test('the libav.js files do not touch secure-context-only apis', () => {
  const files = readdirSync(dist).filter((f) => /\.(mjs|js)$/.test(f));
  assert.ok(files.length >= 2, 'the libav.js front end and worker are missing from libav/dist');
  for (const f of files) {
    const src = readFileSync(`${dist}${f}`, 'utf8');
    assert.ok(!/randomUUID/.test(src), `${f} calls crypto.randomUUID`);
    assert.ok(!/crypto\.subtle|subtle\.digest/.test(src), `${f} calls crypto.subtle`);
  }
});

test('the page still fills randomUUID in for anything that asks', () => {
  const src = readFileSync(new URL('../apps/web/src/lib/randomUuid.ts', import.meta.url), 'utf8');
  assert.match(src, /export function installRandomUuid/);
});
