import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * "some people cannot go backwards and forwards — it just starts from the
 * beginning", "if you pause a show and then try to restart it goes back to the
 * beginning".
 *
 * Eight recovery paths in the player reloaded the stream without a start
 * position: the frozen-picture retry in software, the door switch, the relay
 * fallback, two URL rewrites, two stall retries, and an escalation that took
 * the position only while the phase happened to read `playing`. On a channel
 * none of that matters. On a film, any hiccup the player recovered from sent the
 * viewer back to 0:00.
 *
 * A source guard, because the failure is a call site that FORGETS an argument —
 * nothing errors, the film simply starts again — and the next recovery path
 * somebody writes is the one most likely to forget it.
 */
test('every reload inside the player says where to begin', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./playerCore.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/this\.load\(/g)].map((m) => m.index!);
  assert.ok(calls.length >= 10, `expected the player's reload sites, found ${calls.length}`);
  for (const at of calls) {
    /* The call's own argument list: up to the matching close paren. */
    let depth = 0, end = at + 'this.load'.length;
    for (let i = end; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const args = src.slice(at, end);
    const line = src.slice(0, at).split('\n').length;
    assert.ok(/startAt/.test(args), `playerCore.ts:${line} reloads without a start position:\n${args}`);
  }
});

test('the position a reload uses survives the teardown before it', async () => {
  /* The snapshot reads zero once `teardown` has run, which is exactly when
     every one of these reloads is scheduled. So the position has to come from
     somewhere teardown does not touch. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./playerCore.ts', import.meta.url), 'utf8');
  assert.match(src, /private filmAt: \{ key: string; at: number \}/);
  assert.match(src, /private resumePoint\(key: string, live: boolean\): number/);
  const escalate = src.slice(src.indexOf("this.note(`escalate → native: ${reason}`, 'warn');"));
  assert.match(escalate.slice(0, 900), /const startAt = this\.resumePoint\(last\.key, last\.live\);/,
    'escalating mid-stall used to read the phase and start from zero');
  /* Zero is never recorded: it is what a torn-down playhead reads. */
  const note = src.slice(src.indexOf('private noteFilmPosition(): void {'));
  assert.match(note.slice(0, 700), /currentTime > 0/);
});

test('leaving a film keeps its place: a shutdown reading 0:00 is not the viewer going back', async () => {
  /*
   * Measured on the TV emulator: film at 12s, one press of BACK, saved place
   * gone. `teardown` zeroes the native clock with the phase still `playing`,
   * the saver took that as the position, and the flush on the way out deleted
   * anything under MIN_SAVE. After the guard: 19s saved while playing, 20s
   * after BACK, and CONTINUE resumed from it.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./watch.ts', import.meta.url), 'utf8');
  const hook = src.slice(src.indexOf('export function useWatchProgress'));
  const guard = hook.indexOf('if (s.currentTime < MIN_SAVE && pos.current.t >= MIN_SAVE) return;');
  const record = hook.indexOf('pos.current = { t: s.currentTime');
  assert.ok(guard > 0, 'the saver ignores a drop to the start from somewhere past it');
  assert.ok(guard < record, 'and it does so before recording the position');
});
