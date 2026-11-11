import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAccount } from './accountCheck.ts';
import type { HostProbe } from './providers/index.ts';

/**
 * The verdict that decides whether somebody is signed out. The asymmetry is the
 * whole design: a wrong "valid" costs a little abuse, a wrong "invalid" throws a
 * paying household off its own television at the moment it sat down to watch.
 */

const NOW = Date.UTC(2026, 8, 15);
const door = (p: Partial<HostProbe>): HostProbe => ({
  host: 'http://a', ok: false, ms: 20, secure: false, verdict: 'unreachable', ...p,
});
const signedIn = (info: Record<string, unknown>): HostProbe => door({
  ok: true, verdict: 'ok',
  info: {
    auth: true, status: 'Active', expDate: new Date(NOW + 30 * 86_400_000), isTrial: false,
    activeCons: 0, maxConnections: 1, allowedOutputFormats: ['ts'], ...info,
  } as HostProbe['info'],
});

test('an active line that authenticates is valid', () => {
  const v = judgeAccount({ chosen: signedIn({}), tried: [] }, NOW);
  assert.deepEqual(v, { kind: 'valid' });
});

test('an expired line still authenticates, and is still invalid', () => {
  /* Gotcha 99: auth:1, status "Expired", the whole catalogue — and every stream
     an empty playlist. auth alone is not a verdict. */
  const v = judgeAccount({ chosen: signedIn({ status: 'Expired' }), tried: [] }, NOW);
  assert.deepEqual(v, { kind: 'invalid', reason: 'expired' });
});

test('an expiry date in the past is invalid even when the status says Active', () => {
  const v = judgeAccount({ chosen: signedIn({ expDate: new Date(NOW - 1000) }), tried: [] }, NOW);
  assert.deepEqual(v, { kind: 'invalid', reason: 'expired' });
});

test('a banned or disabled line is invalid', () => {
  for (const status of ['Banned', 'Disabled', 'disabled']) {
    assert.deepEqual(judgeAccount({ chosen: signedIn({ status }), tried: [] }, NOW),
      { kind: 'invalid', reason: 'disabled' }, status);
  }
});

test('a line with no expiry at all is valid, not expired', () => {
  const v = judgeAccount({ chosen: signedIn({ expDate: null }), tried: [] }, NOW);
  assert.deepEqual(v, { kind: 'valid' });
});

test('a door that refused the credentials is invalid', () => {
  const v = judgeAccount({ chosen: null, tried: [door({ verdict: 'refused' })] }, NOW);
  assert.deepEqual(v, { kind: 'invalid', reason: 'refused' });
});

test('NO network trouble of any kind can sign anybody out', () => {
  /* The one outcome this module must never produce. A box that boots before its
     Wi-Fi, a busy Cloudflare door, a panel answering 513 — all unknown. */
  for (const verdict of ['unreachable', 'busy', 'blocked', 'notHere'] as const) {
    const v = judgeAccount({ chosen: null, tried: [door({ verdict }), door({ verdict })] }, NOW);
    assert.deepEqual(v, { kind: 'unknown' }, verdict);
  }
  assert.deepEqual(judgeAccount({ chosen: null, tried: [] }, NOW), { kind: 'unknown' }, 'nothing tried');
});
