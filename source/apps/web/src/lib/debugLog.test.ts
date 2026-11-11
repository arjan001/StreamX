import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDevPin, clearDebug, debugEnabled, debugEntries, debugErrorCount, dlog, fieldKeydownLine, redactSecrets,
  setDebugEnabled, shortUrl,
} from './debugLog.ts';
import { kv, setKVBackend } from './kv.ts';

/* Node has no localStorage; the same in-memory backend the other kv tests use. */
const store = new Map<string, string>();
setKVBackend({
  get: (k) => store.get(k) ?? null,
  set: (k, v) => { store.set(k, v); },
  remove: (k) => { store.delete(k); },
});

beforeEach(() => {
  clearDebug();
  kv.remove('iptv.debug');
});

test('entries arrive in order, newest last, and errors are counted', () => {
  dlog.info('player', 'opening Tolo TV');
  dlog.warn('player', 'hls networkError');
  dlog.error('player', 'gave up');
  assert.deepEqual(debugEntries().map((e) => e.level), ['info', 'warn', 'error']);
  assert.equal(debugErrorCount(), 1);
});

test('the buffer is a ring: the oldest lines fall off', () => {
  for (let i = 0; i < 450; i += 1) dlog.info('t', `line ${i}`);
  const all = debugEntries();
  assert.equal(all.length, 400);
  assert.equal(all[0]!.text, 'line 50');
  assert.equal(all[all.length - 1]!.text, 'line 449');
});

test('a provider URL never reaches the log with its credentials', () => {
  dlog.info('player', 'load http://vpn.example/live/alice/s3cret/2116347.m3u8');
  dlog.info('fetch', 'GET http://h/get.php?username=alice&password=s3cret');
  const [a, b] = debugEntries();
  assert.ok(!a!.text.includes('alice'));
  assert.ok(!a!.text.includes('s3cret'));
  assert.ok(!b!.text.includes('s3cret'));
  assert.equal(redactSecrets('http://u:p@h/x'), 'http://<redacted>@h/x');
});

test('credentials survive nothing, including being percent-encoded', () => {
  /*
   * The leak this closes. A provider URL carried inside another address's
   * QUERY PARAMETER is percent-encoded — the credentials arrive with `%2F`
   * between them instead of `/`, and a rule written for slashes matches none of
   * it. The debug panel is what viewers are invited to send to support.
   */
  const user = 'UUUUUUUUUU';
  const pass = 'PPPPPPPPPP';
  const lines = [
    `load file https://localhost/_img?u=http%3A%2F%2Fhost%2Fmovie%2F${user}%2F${pass}%2F21.mp4`,
    `load mpegts http://host/live/${user}/${pass}/812064.ts`,
    `GET http://host/player_api.php?username=${user}&password=${pass}`,
    `wrap?u=http%3A%2F%2Fh%2Fplayer_api.php%3Fusername%3D${user}%26password%3D${pass}`,
  ];
  for (const line of lines) {
    const out = redactSecrets(line);
    assert.ok(!out.includes(user), `username survived: ${out}`);
    assert.ok(!out.includes(pass), `password survived: ${out}`);
  }
});

test('shortUrl keeps host and path tail, drops the credentials', () => {
  const s = shortUrl('https://tgn.bozztv.com/eshgtv-dvrfl05/gin-tolohd/tracks-v1a1/mono.m3u8');
  assert.equal(s, 'tgn.bozztv.com/eshgtv-dvrfl05/gin-tolohd/tracks-v1a1/mono.m3u8');
  assert.ok(!shortUrl('http://vpn.example/live/alice/s3cret/1.m3u8').includes('alice'));
});

test('debug mode is off by default and remembers the switch', () => {
  assert.equal(debugEnabled(), false);
  setDebugEnabled(true);
  assert.equal(debugEnabled(), true);
  setDebugEnabled(false);
  assert.equal(debugEnabled(), false);
});

test('the developer PIN gates enabling diagnostics', () => {
  assert.equal(checkDevPin('0000'), false);
  assert.equal(checkDevPin('4788'), true);
  assert.equal(checkDevPin(' 4788 '), true);
});

/*
 * `fieldKeydownLine` is the evidence for "OK types a character instead of
 * pressing Enter" — everything about a keydown a report from the television
 * needs, except the one thing that could be a password. Built from plain
 * values (see `logFieldKeydown`, which is the only part of this that has to
 * touch a real element) so the redaction rule can be pinned without a DOM.
 */
const base = {
  key: 'a', code: 'KeyA', keyCode: 65, isComposing: false, repeat: false, field: 'Search', sensitive: false,
};

test('an ordinary field logs the key it was pressed with, in full', () => {
  const line = fieldKeydownLine(base);
  assert.match(line, /key=a /);
  assert.match(line, /code=KeyA /);
  assert.match(line, /keyCode=65 /);
  assert.match(line, /field=Search$/);
});

test('a password field hides a printable character, key, code and keyCode alike', () => {
  const line = fieldKeydownLine({ ...base, sensitive: true, field: 'Password' });
  assert.match(line, /key=<char> /);
  assert.match(line, /code=<char> /);
  assert.match(line, /keyCode=<redacted> /);
  assert.match(line, /field=Password$/);
});

test('Enter on a password field is not content, and is not hidden', () => {
  // The exact question this evidence exists to answer: did OK really produce
  // Enter on the sign-in password field, or something else?
  const line = fieldKeydownLine({
    ...base, key: 'Enter', code: 'Enter', keyCode: 13, sensitive: true, field: 'Password',
  });
  assert.match(line, /key=Enter /);
  assert.match(line, /code=Enter /);
  assert.match(line, /keyCode=13 /);
});

test('Backspace and the arrows are never hidden either, on any field', () => {
  for (const key of ['Backspace', 'ArrowLeft', 'Tab', 'Escape']) {
    const line = fieldKeydownLine({ ...base, key, code: key, sensitive: true });
    assert.ok(!line.includes('<char>'), `${key} should not be redacted`);
    assert.ok(!line.includes('<redacted>'), `${key} should not be redacted`);
  }
});

test('composing and repeat pass through even when the key itself is hidden', () => {
  const line = fieldKeydownLine({
    ...base, key: '5', code: 'Digit5', keyCode: 53, sensitive: true, isComposing: true, repeat: true,
  });
  assert.match(line, /composing=true/);
  assert.match(line, /repeat=true/);
  assert.ok(!line.includes('5'), 'the digit itself never appears');
});

test('a literal space is spelled out, not printed as invisible whitespace', () => {
  const line = fieldKeydownLine({ ...base, key: ' ', code: 'Space', keyCode: 32 });
  assert.match(line, /key=Space /);
});

/*
 * A keydown that is not the shape its type promises.
 *
 * `key` is a getter on `KeyboardEvent.prototype`, so anything that copies an
 * event by spreading it arrives here with nothing in it — which is how this
 * threw `undefined.length` on every keypress in every text field, and took the
 * rest of the global key handler down with it. The builder is now total over
 * what can arrive, and total the SAFE way round.
 */
test('a key nobody named never reaches the log as itself', () => {
  const line = fieldKeydownLine({ field: 'Password', sensitive: true });
  assert.match(line, /key=<char>/);
  assert.match(line, /keyCode=<redacted>/);
  assert.doesNotMatch(line, /undefined/);
});

test('and on an ordinary field it says so plainly', () => {
  const line = fieldKeydownLine({ field: 'Username', sensitive: false });
  assert.match(line, /key=<none> code=<none> keyCode=<none>/);
  assert.match(line, /composing=false repeat=false/);
});

test('a real event carries its values through the spread that loses them', () => {
  /* The mistake itself, in miniature: `key` on a prototype, which object
     spread does not take. Anything built by spreading an event is this. */
  const evented = Object.create({
    get key() { return 'Enter'; },
    get code() { return 'NumpadEnter'; },
  }) as { key: string; code: string };
  assert.equal(Object.keys({ ...evented }).length, 0);
  const line = fieldKeydownLine({
    key: evented.key, code: evented.code, field: 'Username', sensitive: false,
  });
  assert.match(line, /key=Enter code=NumpadEnter/);
});
