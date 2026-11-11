import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unthenable } from './nativePlayer.ts';

/* Capacitor's registerPlugin proxy, reduced to the property that matters: every
   read is a native call, and a method named `then` does not exist natively. */
function capacitorLikeProxy() {
  return new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      if (prop === 'then') {
        /* In the app this rejection is unhandled and resolve is never called;
           here it is caught so the test runner does not count the symptom. */
        const rejected = Promise.reject(new Error(`NativePlayer.${String(prop)}() is not implemented on android`));
        rejected.catch(() => {});
        return rejected;
      }
      return Promise.resolve({ called: String(prop), args });
    },
  });
}

test('the raw proxy hangs an async return; the wrapper does not', async () => {
  const proxy = capacitorLikeProxy();
  const raw = (async () => proxy as never)();
  const settled = await Promise.race([raw.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 50))]);
  assert.equal(settled, 'hung');

  const wrapped = unthenable(proxy as never, ['play', 'seek']);
  const back = await (async () => wrapped)();
  assert.equal(back, wrapped);
  assert.deepEqual(await back.play(), { called: 'play', args: [] });
  assert.deepEqual(await back.seek({ timeMs: 5 }), { called: 'seek', args: [{ timeMs: 5 }] });
  assert.ok(!('then' in back));
});

/*
 * And EVERY plugin proxy is wrapped, not just the one that was found last time.
 *
 * This test used to check one file alone — it was
 * written where the bug was found rather than around the class of bug. So when
 * `nativeListen.ts` registered a fourth plugin the obvious way, nothing
 * objected, and live captions "kept loading" on every television from 1.34.0
 * until a viewer's log named it:
 *
 *     page: unhandled rejection:
 *     Error: "StreamixListen.then()" is not implemented on android
 *
 * That is features lost to one mistake — the player, the captions — each found in the field, each after the helper existed. The
 * helper was never the problem; nothing made using it the only way through.
 *
 * So the scan is over the SOURCE TREE. Any `registerPlugin(` anywhere must have
 * `unthenable(` wrapping it, and a new plugin cannot be written the obvious way
 * without this failing first.
 */
test('every registerPlugin proxy in the app is wrapped before it can be awaited', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../', import.meta.url).pathname;

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(root);

  const bare = [];
  let sites = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/registerPlugin\s*(?:<[^>]*>)?\s*\(/g)) {
      /* The helper's own documentation talks ABOUT the call; only real code
         counts. A line inside a block comment is prose. */
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const line = src.slice(lineStart, src.indexOf('\n', m.index));
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue;
      sites += 1;
      /* Wrapped on the spot, or a few lines later — `deviceInfo.ts` probes the
         plugin with a real call first and explains why in eight lines of
         comment, so the window forward has to clear a paragraph. Generous
         window, exact requirement. */
      const around = src.slice(Math.max(0, m.index - 400), m.index + 1400);
      if (!/unthenable\s*\(/.test(around)) {
        bare.push(`${f.slice(f.indexOf('apps/'))}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }

  assert.ok(sites >= 3, `expected the known plugin sites, found ${sites}`);
  assert.deepEqual(bare, [],
    'a Capacitor proxy that nothing wraps — await it and it rejects with '
    + '"<Plugin>.then() is not implemented on android". See lib/unthenable.ts');
});
