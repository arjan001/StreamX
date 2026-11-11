import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XtreamAuthError, XtreamHttpError } from '@iptv/core-xtream';
import { verdictFor, type HostProbe } from './hosts.ts';
import { signInVerdict } from './panel.ts';

/**
 * The sign-in message is chosen from verdicts, never from error TEXT.
 *
 * `client.ts` builds every HTTP failure on the authentication call as
 * `${label}: HTTP ${status} from ${path}` with the label `'auth'`, so a regex
 * like `/rejected|auth/i` over the message would match the label, not anything
 * the panel said, and a host answering 404 would tell the viewer their password
 * was wrong. An account can live on one host only, so at least one 404 is what
 * a SUCCESSFUL sign-in looks like too.
 */

const host = (url: string, p: Partial<HostProbe>): HostProbe => ({
  host: url, ok: false, ms: 12, secure: url.startsWith('https'), verdict: 'unreachable', ...p,
});

test('a host that answered 404 is not a verdict on the password', () => {
  const e = new XtreamHttpError('auth: HTTP 404 from /player_api.php', 404);
  assert.equal(verdictFor(e).verdict, 'notHere');
  /* The message begins with the label, which is why text must not decide. */
  assert.match(e.message, /auth/i);
});

test('only a parsed auth:0 is the panel refusing the credentials', () => {
  const e = new XtreamAuthError('panel returned auth:0 — bad credentials or connection limit reached');
  assert.equal(verdictFor(e).verdict, 'refused');
});

test('flood protection is the account being told "not now", not a wrong password', () => {
  for (const status of [456, 509, 511, 513]) {
    const v = verdictFor(new XtreamHttpError(`auth: HTTP ${status} from /player_api.php`, status));
    assert.equal(v.verdict, 'busy', `HTTP ${status}`);
    assert.equal(v.status, status);
  }
});

test('a host that answers with something that is not an answer is blocked, not refused', () => {
  /* A 200 carrying an HTML challenge or an nginx welcome page — the status is
     fine and the body is not JSON. Trusting the status here is how a dead line
     gets picked and then shows an empty catalogue. */
  assert.equal(verdictFor(new XtreamHttpError('auth: expected JSON, got <html>…', 200)).verdict, 'blocked');
  assert.equal(verdictFor(new XtreamHttpError('auth: HTTP 502 from /player_api.php', 502)).verdict, 'blocked');
});

test('a transport failure is a verdict on the network, never on the account', () => {
  assert.equal(verdictFor(new TypeError('Failed to fetch')).verdict, 'unreachable');
  assert.equal(verdictFor(new Error('The user aborted a request.')).verdict, 'unreachable');
  assert.equal(verdictFor('not an error at all').verdict, 'unreachable');
});

test('hosts that all answer but do not have the line are notHere', () => {
  /* Every host answers, none of them has this line. */
  const tried = [
    host('http://a', { verdict: 'notHere', status: 404 }),
    host('http://b', { verdict: 'notHere', status: 404 }),
    host('https://a', { verdict: 'notHere', status: 404 }),
    host('https://b', { verdict: 'notHere', status: 404 }),
  ];
  const { reason, message } = signInVerdict(tried);
  assert.equal(reason, 'notHere');
  assert.doesNotMatch(message, /password/i, 'must not blame the password');
  assert.match(message, /address/i, 'must name the thing that fixes it');
});

test('one host refusing outranks every other host failing', () => {
  /* The strength order is the point: a host that PARSED the credentials and said
     no knows something the others do not. */
  const tried = [
    host('http://a', { verdict: 'notHere', status: 404 }),
    host('http://b', { verdict: 'refused' }),
    host('https://a', { verdict: 'unreachable' }),
  ];
  assert.equal(signInVerdict(tried).reason, 'refused');
});

test('busy outranks not-here, and not-here outranks silence', () => {
  assert.equal(signInVerdict([
    host('http://a', { verdict: 'notHere', status: 404 }),
    host('http://b', { verdict: 'busy', status: 513 }),
  ]).reason, 'busy');
  assert.equal(signInVerdict([
    host('http://a', { verdict: 'unreachable' }),
    host('http://b', { verdict: 'notHere', status: 403 }),
  ]).reason, 'notHere');
});

test('nothing answering at all is the only thing called "no server answered"', () => {
  const tried = [
    host('http://a', { verdict: 'unreachable' }),
    host('https://a', { verdict: 'unreachable' }),
  ];
  const { reason, message } = signInVerdict(tried);
  assert.equal(reason, 'noAnswer');
  assert.match(message, /No server answered/i);
});

test('a refusal still says the connection limit out loud', () => {
  /* The panel answers `auth: 0` for a wrong password AND for a line whose
     connections are all in use, and this one is `max_connections: 1`. Claiming
     it is the password sends somebody to change a password that is fine. */
  const { message } = signInVerdict([host('http://a', { verdict: 'refused' })]);
  assert.match(message, /another device/i);
});

test('a server that answered but does not have the account points at the address', () => {
  const tried = [host('http://theirs', { verdict: 'notHere', status: 404 })];
  const { reason, message } = signInVerdict(tried);
  assert.equal(reason, 'notHere');
  assert.doesNotMatch(message, /add the address/i, 'the viewer already typed one');
  assert.match(message, /check the address/i);
});
