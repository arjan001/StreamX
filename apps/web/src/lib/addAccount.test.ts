import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountOpen, closeAddAccount, openAddAccount, subscribeAddAccount } from './addAccount.ts';

/* One module, one switch, and these tests share it — so each one starts from
   shut and hands its subscriptions back before it ends. A listener left
   registered is a listener the next test is told about. */
beforeEach(() => { closeAddAccount(); });

test('the dialog is shut until somebody asks for it, and shut again after', () => {
  assert.equal(addAccountOpen(), false);
  openAddAccount();
  assert.equal(addAccountOpen(), true);
  closeAddAccount();
  assert.equal(addAccountOpen(), false);
});

/**
 * What a subscriber is told is "it changed", not what it changed to — which is
 * why it has to be able to read the answer at the moment it is told. A store
 * that published first and assigned afterwards would hand every subscriber the
 * previous state, and the shell would close its drawer one press late.
 */
test('a subscriber is told, and reads the new answer while being told', () => {
  const seen: boolean[] = [];
  const stop = subscribeAddAccount(() => seen.push(addAccountOpen()));
  try {
    openAddAccount();
    closeAddAccount();
    assert.deepEqual(seen, [true, false]);
  } finally {
    stop();
  }
});

test('unsubscribing stops the telling', () => {
  let heard = 0;
  const stop = subscribeAddAccount(() => { heard += 1; });
  openAddAccount();
  stop();
  closeAddAccount();
  openAddAccount();
  assert.equal(heard, 1);
});

/**
 * The shell and the dialog both listen, so "a subscriber" is never the whole
 * story: `Chrome` closes its accounts drawer on the same publish that mounts the
 * dialog, and if only one of them were told the drawer would stay open behind it
 * — which is the bug this whole module exists to end.
 */
test('two subscribers are both told, and one leaving does not take the other', () => {
  const a: boolean[] = [];
  const b: boolean[] = [];
  const stopA = subscribeAddAccount(() => a.push(addAccountOpen()));
  const stopB = subscribeAddAccount(() => b.push(addAccountOpen()));
  try {
    openAddAccount();
    assert.deepEqual(a, [true]);
    assert.deepEqual(b, [true]);
    stopA();
    closeAddAccount();
    assert.deepEqual(a, [true], 'the one that left hears nothing more');
    assert.deepEqual(b, [true, false]);
  } finally {
    stopA();
    stopB();
  }
});

/**
 * The dialog unsubscribes as it unmounts, which happens while it is being told —
 * React runs the cleanup during the state update that closes it. Iterating the
 * live Set would then skip whoever was registered after it, and on a television
 * that is the accounts drawer never being told to close.
 */
test('a subscriber that leaves while being told does not silence the next one', () => {
  let second = 0;
  const stopFirst = subscribeAddAccount(() => { stopFirst(); });
  const stopSecond = subscribeAddAccount(() => { second += 1; });
  try {
    openAddAccount();
    assert.equal(second, 1);
  } finally {
    stopFirst();
    stopSecond();
  }
});
