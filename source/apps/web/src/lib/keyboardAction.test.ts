import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActionKey } from './okToType.ts';

/**
 * "the person is trying to close the keyboard — they cannot submit or close
 * the keyboard" — a photograph of a Fire TV keyboard over the sign-in form.
 *
 * Measured on the Google TV emulator with DevTools on the real WebView:
 *
 *   - the keyboard's Next / Go / Done key reaches the page as an Enter keydown
 *     on the field. Chromium only moves focus itself when it believes there is
 *     a next field, and in this WebView it never does — not for our form and
 *     not for a bare two-input form injected beside it;
 *   - that Enter arrives with `isComposing: true`, because Gboard is still
 *     composing the word — and a username is one long word;
 *   - a key the keyboard keeps for itself arrives as keyCode 229 instead.
 */
const press = (key: string, keyCode: number) => ({ key, nativeEvent: { keyCode } });

test('the keyboard action key counts even mid-word — the case that was dropped', () => {
  /* The measured press: key Enter, keyCode 13, isComposing true. The old guard
     tested isComposing and skipped exactly this. */
  assert.equal(isActionKey(press('Enter', 13)), true);
});

test('a key the keyboard is keeping for itself is not the action', () => {
  assert.equal(isActionKey(press('Enter', 229)), false);
  assert.equal(isActionKey(press('Process', 229)), false);
});

test('nothing but Enter is an action', () => {
  for (const k of ['a', 'Tab', 'Escape', 'ArrowDown', ' ']) {
    assert.equal(isActionKey(press(k, 0)), false, k);
  }
});

test('every TV text field has somewhere for the action key to go', async () => {
  /* The hook parks a typing field on an unclaimed action key, and the sign-in
     form claims it to move on or submit. Either half missing is the report. */
  const { readFileSync } = await import('node:fs');
  const hook = readFileSync(new URL('./okToType.ts', import.meta.url), 'utf8');
  assert.match(hook, /if \(isActionKey\(e\)\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*setTyping\(false\);/,
    'an unclaimed action key parks the field, which closes the keyboard');
  assert.ok(!/isComposing\)/.test(hook.slice(hook.indexOf('if (isActionKey(e))') - 200, hook.indexOf('if (isActionKey(e))'))),
    'no composing guard in front of it');

  const form = readFileSync(new URL('../components/SignInFields.tsx', import.meta.url), 'utf8');
  for (const f of ["onAction(e, 'user')", "onAction(e, 'pass')", "onAction(e, 'host')"]) {
    assert.ok(form.includes(f), `sign-in field without an action handler: ${f}`);
  }
  assert.ok(form.includes('okPass.begin(passRef.current)'),
    'Next on the username lands IN the password field with the keyboard up');
});
