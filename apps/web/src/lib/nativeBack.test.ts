import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleBack, resolveBack, setBackNavigator, countExitPress, forgetExitPresses, onExitAsk, onExitPrompt,
  pushBackHandler, parentOf,
} from './nativeBack.ts';

/**
 * A page at `path`, with nothing in the fragment.
 *
 * `handleBack` reads the address to decide what leaving means, so a test of the
 * decision has to stand somewhere. Node has no `location`; this puts one there
 * and hands back the object so a test can see what was written to it, which is
 * the whole point of the two below.
 */
function standAt(path: string): { pathname: string; hash: string } {
  const here = { pathname: path, hash: '' };
  (globalThis as unknown as { location: unknown }).location = here;
  return here;
}
function leave(): void {
  delete (globalThis as unknown as { location?: unknown }).location;
}

test('back at home or live exits the app', () => {
  assert.equal(resolveBack('/'), 'exit');
  assert.equal(resolveBack('/home'), 'exit');
  assert.equal(resolveBack('/live'), 'exit');
});

test('back at a top-level tab returns to home first', () => {
  for (const tab of ['/movies', '/series', '/guide', '/catchup']) {
    assert.equal(resolveBack(tab), 'home');
  }
});

test('back at a deep screen walks one page back', () => {
  assert.equal(resolveBack('/movies/123'), 'back');
  assert.equal(resolveBack('/more'), 'back');
});

/**
 * Home is reached by navigating, not by writing a fragment.
 *
 * `location.hash = '#/home'` is a real navigation under the hash router the APK
 * is built with and a no-op under the path router the website runs. Measured on
 * `/live` with `scripts/back-probe.mjs`: BACK left the address at
 * `/live?markets=USF#/home`, the page did not move, and `currentPath()` then read
 * that stray fragment as the route — so the next BACK resolved to "at home,
 * leave" and the app backgrounded itself from a screen it had never left.
 */
test('back at a tab navigates home, and leaves the fragment alone', () => {
  const here = standAt('/movies');
  const went: string[] = [];
  const unregister = setBackNavigator((to) => went.push(to));
  try {
    assert.equal(handleBack(), true, 'the press is claimed');
    assert.deepEqual(went, ['/home']);
    assert.equal(here.hash, '', 'no stray #/home for currentPath to misread');
  } finally {
    unregister();
    leave();
  }
});

test('with no shell to navigate with, the fragment is the fallback', () => {
  // The splash, or a page that failed to render. Nothing else is available
  // without a router, and the builds that have none are the hash-router ones.
  const here = standAt('/movies');
  try {
    assert.equal(handleBack(), true);
    assert.equal(here.hash, '#/home');
  } finally {
    leave();
  }
});

test('back at live counts toward exit, and does not navigate home', () => {
  /* Nothing has registered to ask — a browser, or no shell mounted — so the
     third press declines, which the native side reads as "background me". */
  forgetExitPresses();
  const here = standAt('/live');
  const went: string[] = [];
  const unregister = setBackNavigator((to) => went.push(to));
  try {
    assert.equal(handleBack(), true);
    assert.equal(handleBack(), true);
    assert.equal(handleBack(), false, 'third press with nobody to ask declines');
    assert.deepEqual(went, []);
    assert.equal(here.hash, '');
  } finally {
    unregister();
    leave();
    forgetExitPresses();
  }
});

test('leaving takes three presses inside three seconds', () => {
  /* One stray BACK at the top level used to background the app and throw away a
     catalogue it had just built — an easy press to make by accident on a remote.
     The first two are consumed and announced; with nothing able to ask, the third
     declines exactly as it always did. */
  forgetExitPresses();
  const said: number[] = [];
  const off = onExitPrompt((left) => said.push(left));
  assert.equal(countExitPress(1_000), 'counted');
  assert.equal(countExitPress(1_400), 'counted');
  assert.equal(countExitPress(1_900), 'leave');
  assert.deepEqual(said, [2, 1, 0]);
  off();
});

test('the third press asks rather than leaves, when something can ask', () => {
  /* "when they go back like three times it should show a dialog Are you sure you
     want to exit". The dialog's Exit is what ends the app now, so the press that
     opens it must be consumed — declining it would background the app from
     underneath the question. */
  forgetExitPresses();
  const said: number[] = [];
  let asked = 0;
  const offPrompt = onExitPrompt((left) => said.push(left));
  const offAsk = onExitAsk(() => { asked += 1; });
  try {
    assert.equal(countExitPress(1_000), 'counted');
    assert.equal(asked, 0, 'nothing is asked on the first press');
    assert.equal(countExitPress(1_400), 'counted');
    assert.equal(asked, 0, 'nor on the second');
    assert.equal(countExitPress(1_900), 'ask');
    assert.equal(asked, 1, 'the question is put once');
    /* The hint is told the gesture is complete, so it is gone before the dialog
       is up — the two never say different things on one screen. */
    assert.deepEqual(said, [2, 1, 0]);
  } finally {
    offPrompt();
    offAsk();
    forgetExitPresses();
  }
});

test('after the question, the gesture starts again from three', () => {
  /* Cancel must hand back the app as it was, and "as it was" is not one press away
     from the same dialog. */
  forgetExitPresses();
  let asked = 0;
  const off = onExitAsk(() => { asked += 1; });
  try {
    countExitPress(0);
    countExitPress(300);
    assert.equal(countExitPress(600), 'ask');
    assert.equal(countExitPress(900), 'counted', 'a fresh first press, still inside the window');
    assert.equal(countExitPress(1_200), 'counted');
    assert.equal(countExitPress(1_500), 'ask');
    assert.equal(asked, 2);
  } finally {
    off();
    forgetExitPresses();
  }
});

test('at home, with the question registered, every press is consumed', () => {
  forgetExitPresses();
  const here = standAt('/home');
  let asked = 0;
  const went: string[] = [];
  const unNav = setBackNavigator((to) => went.push(to));
  const offAsk = onExitAsk(() => { asked += 1; });
  try {
    assert.equal(handleBack(), true);
    assert.equal(handleBack(), true);
    assert.equal(handleBack(), true, 'third press opens the question instead of declining');
    assert.equal(asked, 1);
    assert.deepEqual(went, []);
    assert.equal(here.hash, '');
  } finally {
    offAsk();
    unNav();
    leave();
    forgetExitPresses();
  }
});

test('a question nobody can put never traps BACK', () => {
  /* The dialog unmounting, or a watcher that throws: either way the third press
     has to leave the way it did before there was a question at all. */
  forgetExitPresses();
  const offThrows = onExitAsk(() => { throw new Error('no dialog'); });
  try {
    countExitPress(0);
    countExitPress(100);
    assert.equal(countExitPress(200), 'leave', 'a watcher that throws is not an answer');
  } finally {
    offThrows();
  }
  const offGone = onExitAsk(() => {});
  offGone();
  countExitPress(1_000);
  countExitPress(1_100);
  assert.equal(countExitPress(1_200), 'leave', 'an unregistered watcher is nobody');
  forgetExitPresses();
});

test('a pause resets the gesture, so it is never a tally', () => {
  forgetExitPresses();
  assert.equal(countExitPress(0), 'counted');
  assert.equal(countExitPress(2_000), 'counted');
  /* Past the window: this is a first press again, not the third. */
  assert.equal(countExitPress(9_000), 'counted');
  assert.equal(countExitPress(9_200), 'counted');
  assert.equal(countExitPress(9_400), 'leave');
});

test('a held BACK is one press, however long it is held', () => {
  /* Android repeats a held key every 50ms after the first half second. Counted,
     one hold would open the question and the next repeat would close it again. */
  forgetExitPresses();
  const here = standAt('/home');
  const said: number[] = [];
  let asked = 0;
  const offPrompt = onExitPrompt((left) => said.push(left));
  const offAsk = onExitAsk(() => { asked += 1; });
  try {
    assert.equal(handleBack(false), true, 'the press itself counts');
    for (let i = 0; i < 12; i++) {
      assert.equal(handleBack(true), true, 'a repeat is consumed, never declined');
    }
    assert.deepEqual(said, [2], 'and only the press was counted');
    assert.equal(asked, 0);
    assert.equal(handleBack(false), true);
    assert.equal(handleBack(false), true);
    assert.equal(asked, 1, 'three fresh presses still ask');
    assert.equal(here.hash, '');
  } finally {
    offPrompt();
    offAsk();
    leave();
    forgetExitPresses();
  }
});

test('handlers are told whether the press is a repeat', () => {
  /* The exit dialog closes on a fresh BACK and ignores the repeats of the hold
     that opened it; every other handler keeps closing on either. */
  const seen: boolean[] = [];
  const off = pushBackHandler((repeat) => { seen.push(repeat); return true; });
  try {
    handleBack();
    handleBack(true);
    handleBack(false);
    assert.deepEqual(seen, [false, true, false]);
  } finally {
    off();
  }
});

test('the prompt stops being told once nobody is listening', () => {
  forgetExitPresses();
  let calls = 0;
  const off = onExitPrompt(() => { calls += 1; });
  countExitPress(0);
  off();
  countExitPress(200);
  assert.equal(calls, 1);
});

/**
 * BACK on a legal page, the first screen of the session, used to decline — and the
 * native side answered a decline by putting the whole app on the launcher.
 */
test('back on a deep screen with no page behind it goes to its parent, never leaves', () => {
  assert.equal(parentOf('/legal/terms'), '/more?s=legal');
  assert.equal(parentOf('/movie/5'), '/movies');
  assert.equal(parentOf('/series/5'), '/series');
  assert.equal(parentOf('/more'), '/home');
  const here = standAt('/legal/terms');
  (globalThis as unknown as { history: unknown }).history = { state: { idx: 0 }, length: 1, back() { throw new Error('nothing to go back to'); } };
  const went: string[] = [];
  const off = setBackNavigator((to) => went.push(to));
  try {
    assert.equal(handleBack(), true, 'claimed, so the app stays');
    assert.deepEqual(went, ['/more?s=legal']);
    assert.equal(here.hash, '');
  } finally {
    off();
    leave();
    delete (globalThis as unknown as { history?: unknown }).history;
  }
});

test('back on a deep screen with a page behind it walks back', () => {
  standAt('/legal/privacy');
  let backs = 0;
  (globalThis as unknown as { history: unknown }).history = { state: { idx: 2 }, length: 3, back() { backs += 1; } };
  try {
    assert.equal(handleBack(), true);
    assert.equal(backs, 1);
  } finally {
    leave();
    delete (globalThis as unknown as { history?: unknown }).history;
  }
});

test('a player handler is asked before the route is', () => {
  standAt('/live');
  let closed = 0;
  const off = pushBackHandler(() => { closed += 1; return true; });
  try {
    assert.equal(handleBack(), true);
    assert.equal(closed, 1);
  } finally {
    off();
    leave();
    forgetExitPresses();
  }
});
