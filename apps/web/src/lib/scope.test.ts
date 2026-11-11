import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrefs, scopeParams } from './prefs.ts';
import { scopeKey } from './scope.ts';

test('a preference that is not scope leaves the scope key alone', () => {
  const p = getPrefs();
  /* The playhead, a volume, a remembered focus: a fresh prefs object with the
     same scope — which used to recount the whole library on every one. */
  const moved = { ...p, browseStyle: p.browseStyle === 'list' ? 'groups' as const : 'list' as const, markets: [...p.markets] };
  assert.notEqual(moved, p);
  assert.equal(scopeKey(scopeParams(moved)), scopeKey(scopeParams(p)));
});

test('a preference that IS scope changes it', () => {
  const p = getPrefs();
  const narrowed = { ...p, markets: [...p.markets, 'zz'] };
  assert.notEqual(scopeKey(scopeParams(narrowed)), scopeKey(scopeParams(p)));
  const hidden = { ...p, hideStreams: [...p.hideStreams, 424242] };
  assert.notEqual(scopeKey(scopeParams(hidden)), scopeKey(scopeParams(p)));
});
