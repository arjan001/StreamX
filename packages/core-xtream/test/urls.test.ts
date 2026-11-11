/**
 * Catch-up URL construction.
 *
 * Everything asserted here is a unit or an encoding rule, which is exactly the
 * class of mistake that produces a stream that plays for four seconds, or a 403,
 * rather than an error anyone can read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveMinutes, archiveStamp, buildArchiveUrl, parseLineCredentials } from '../src/urls.ts';

const ARCHIVE_BASE = { protocol: 'http' as const, host: 'panel.example', port: 8080 };
const ARCHIVE_CRED = { username: 'u@ser', password: 'p%ss' };

test('archive stamps are UTC, zero-padded, and in the panels’ own spelling', () => {
  // 2026-03-04 07:05:00Z
  assert.equal(archiveStamp(Date.UTC(2026, 2, 4, 7, 5) / 1000), '2026-03-04:07-05');
});

test('archive duration is MINUTES, rounded up, with a boundary tail', () => {
  const start = 1_800_000_000;
  // 30 minutes exactly -> 30 + 2 tail
  assert.equal(archiveMinutes({ startTs: start, stopTs: start + 1800 }), 32);
  // 29m01s rounds up to 30, not down to 29
  assert.equal(archiveMinutes({ startTs: start, stopTs: start + 1741 }), 32);
  // Never zero, whatever the schedule says
  assert.equal(archiveMinutes({ startTs: start, stopTs: start, tailMinutes: 0 }), 1);
  assert.equal(archiveMinutes({ startTs: start, stopTs: start - 500, tailMinutes: 0 }), 1);
});

test('the query family keeps credentials RAW, because a query value must not escape @ or %', () => {
  const url = buildArchiveUrl(
    ARCHIVE_BASE, ARCHIVE_CRED, 2116347,
    { startTs: Date.UTC(2026, 2, 4, 7, 5) / 1000, stopTs: Date.UTC(2026, 2, 4, 8, 0) / 1000 },
    'query',
  );
  const u = new URL(url);
  assert.equal(u.pathname, '/streaming/timeshift.php');
  assert.equal(u.searchParams.get('username'), 'u@ser');
  assert.equal(u.searchParams.get('password'), 'p%ss');
  assert.equal(u.searchParams.get('stream'), '2116347');
  assert.equal(u.searchParams.get('start'), '2026-03-04:07-05');
  assert.equal(u.searchParams.get('duration'), '57');
});

test('the path family percent-encodes them, because a path segment must', () => {
  const url = buildArchiveUrl(
    ARCHIVE_BASE, ARCHIVE_CRED, 42,
    { startTs: Date.UTC(2026, 2, 4, 7, 5) / 1000, stopTs: Date.UTC(2026, 2, 4, 7, 35) / 1000 },
    'path',
  );
  assert.equal(url, 'http://panel.example:8080/timeshift/u%40ser/p%25ss/32/2026-03-04:07-05/42.ts');
});

test('a reseller get.php link yields host, user and password', () => {
  const c = parseLineCredentials(
    'http://panel.example.com/get.php?username=demo1234ab&password=secret5678cd&type=m3u_plus&output=ts',
  );
  assert.deepEqual(c, {
    url: 'http://panel.example.com',
    username: 'demo1234ab',
    password: 'secret5678cd',
  });
});

test('a get.php link alone is enough — the password field may be empty', () => {
  const c = parseLineCredentials(
    'http://x.com/get.php?username=a&password=b&type=m3u_plus',
    '',
  );
  assert.equal(c?.username, 'a');
  assert.equal(c?.password, 'b');
  assert.equal(c?.url, 'http://x.com');
});

test('player_api.php and userinfo forms are accepted', () => {
  assert.deepEqual(
    parseLineCredentials('http://h/player_api.php?username=u1&password=p1'),
    { url: 'http://h', username: 'u1', password: 'p1' },
  );
  assert.deepEqual(
    parseLineCredentials('http://u%40x:p%251@panel.example:8080/'),
    { url: 'http://panel.example:8080', username: 'u@x', password: 'p%1' },
  );
});

test('plain username still needs a password field', () => {
  assert.equal(parseLineCredentials('demo1234ab', ''), null);
  assert.deepEqual(parseLineCredentials('demo1234ab', 'secret5678cd'), {
    url: null,
    username: 'demo1234ab',
    password: 'secret5678cd',
  });
});
