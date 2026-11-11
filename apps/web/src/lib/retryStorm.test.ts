import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitOpen, MAX_OPENS, OPEN_WINDOW_MS, serverVerdict } from './playerCore.ts';

/**
 * 114 failed opens of one film in about two and a half minutes, on the TV
 * emulator, from a single press of PLAY.
 *
 * Three causes, each of which reset the budget of another:
 *
 *   - the screen retried on its own, budgeted per LOAD — and every retry is a
 *     new load, so the budget reset on each of its own retries: 0.7s, forever;
 *   - the relay reset the engine ladder's one-escalation budget on every pass,
 *     and a relayed URL always "failed at" our own address, so the door ladder
 *     never ran out of doors;
 *   - our own relay's 429 was not counted as "stop asking".
 *
 * On a one-connection subscription a flood of opens is exactly what locks the
 * account (456) — and the flood then keeps it locked.
 */
test('one stream is opened at most MAX_OPENS times in the window', () => {
  let state = { key: '', at: [] as number[] };
  const admitted: number[] = [];
  for (let i = 0; i < 114; i++) {                  // the storm, one attempt every 1.3s
    const t = i * 1300;
    const v = admitOpen(state, 'film', t);
    if (v.ok) admitted.push(t);
    state = v.state;
  }
  /* The invariant is per window, not per run: never more than MAX_OPENS opens
     inside any OPEN_WINDOW_MS. The first ten go straight through — the honest
     ladder gets its turns — and after that one more only as an old one ages
     out, so 114 attempts become 20 over those 148 seconds instead of 114. */
  for (const start of admitted) {
    const inWindow = admitted.filter((t) => t >= start && t < start + OPEN_WINDOW_MS).length;
    assert.ok(inWindow <= MAX_OPENS, `${inWindow} opens within ${OPEN_WINDOW_MS / 1000}s of ${start}ms`);
  }
  assert.equal(admitted.slice(0, MAX_OPENS).length, MAX_OPENS, 'the honest ladder still gets its turns');
  assert.ok(admitted.length < 114 / 5, `admitted ${admitted.length} of 114`);
});

test('a refused open does not count, so waiting really does help', () => {
  let state = { key: '', at: [] as number[] };
  for (let i = 0; i < MAX_OPENS; i++) state = admitOpen(state, 'film', i).state;
  const refused = admitOpen(state, 'film', 100);
  assert.equal(refused.ok, false);
  const later = admitOpen(refused.state, 'film', OPEN_WINDOW_MS + 10);
  assert.equal(later.ok, true, 'once the window has moved on, Retry works');
});

test('zapping is not a loop: another stream starts its own count', () => {
  let state = { key: '', at: [] as number[] };
  for (let i = 0; i < MAX_OPENS; i++) state = admitOpen(state, 'channel-a', i).state;
  assert.equal(admitOpen(state, 'channel-b', MAX_OPENS).ok, true);
});

test('Too Many Requests means stop asking, like every other refusal', () => {
  assert.equal(serverVerdict(429, 'text/html', false), 'busy');
  assert.equal(serverVerdict(456, 'text/html', false), 'busy');
});

test('the screen budgets its retries per stream, not per load', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../components/VideoPlayer.tsx', import.meta.url), 'utf8');
  assert.ok(!/failedLoad\.current !== s\.loadId/.test(src),
    'keyed on loadId, every retry resets the budget it is spending');
  assert.match(src, /const stream = s\.streamKey \|\| s\.label;/);
});

test('no film is routed through our server', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./playerCore.ts', import.meta.url), 'utf8');
  assert.ok(!/relayUrl\(/.test(src), 'the player builds a relay URL again');
  assert.ok(!/relayLearned\(/.test(src), 'the player consults a learned relay verdict again');
  /* The cap sits in front of every engine: before the first thing `load` asks. */
  const load = src.slice(src.indexOf('const key = opts?.key ?? streamKey(target.url);'));
  assert.match(load.slice(0, 200), /if \(!this\.mayOpen\(key, label, live\)\) return;/);
});

test('nothing stays "opening" for ever, and nothing that started is called stuck', async () => {
  /* Seen once on the emulator: a cold launch reopened the last film and sat on
     "opening" for over a minute with no error — so no report and no way out. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./playerCore.ts', import.meta.url), 'utf8');
  assert.match(src, /const LOAD_GIVE_UP_MS = 45_000;/);
  const armed = src.slice(src.indexOf('this.loadWatch = window.setTimeout('));
  assert.match(armed.slice(0, 600), /this\.playedEpoch === mine/, 'a load that delivered is never given up on');
  assert.match(armed.slice(0, 600), /this\.snap\.phase !== 'loading'/);
  assert.match(armed.slice(0, 1200), /phase: 'error'[\s\S]*permanent: false/, 'and it ends in an error the viewer can retry');
  assert.match(src, /this\.playedEpoch = this\.epoch;/, 'set when the first bytes arrive');
});
