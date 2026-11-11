/**
 * The paid subscription's credentials never reach a file anybody else can read.
 *
 *     never print them, never print a full stream URL containing them, never
 *     write them into any tracked file
 *
 * That has been a rule from the first day of this work and has been kept by
 * hand. By hand is not a control: one `console.log` of a stream URL in a probe
 * that later gets committed, one fixture pasted from a real session, one
 * source map shipped beside a bundle, and the line is in a file that goes to
 * GitHub. Nothing about the failure is visible — the app keeps working and
 * every other gate stays green.
 *
 * ── what it reads, and what it refuses to print ──
 *
 * The values come from `.env`, which is the only place they exist. This file
 * never prints one, in a passing run or a failing one: a failure names the KEY
 * and the FILE, which is everything needed to act, and the value is already
 * known to whoever can read `.env`. A gate that leaks the secret it guards on
 * failure is a gate that leaks the secret into CI logs.
 *
 * Checked against the tracked files of both repositories — tracked, because an
 * ignored file is the correct place for a credential and `.env` itself is one
 * — and against every build output, which is where a source map would carry a
 * value the bundle itself does not.
 *
 * Skipped, loudly, when `.env` is not there: a machine with no credentials to
 * leak cannot fail this, and silence would let it pass unnoticed on the one
 * machine that does have them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const API = join(ROOT, '..', 'streamix-api');
const ENV = join(API, '.env');

/** The keys whose values must not appear anywhere. Names only, never values. */
const GUARDED = ['IPTV_USERNAME', 'IPTV_PASSWORD', 'ADMIN_PASSWORD'];

/** Short values would match half the dictionary; those are not credentials. */
const MIN_LENGTH = 6;

function secrets() {
  if (!existsSync(ENV)) return null;
  const found = new Map();
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at < 0 || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    if (GUARDED.includes(key) && value.length >= MIN_LENGTH) found.set(key, value);
  }
  return found;
}

/** Every file git tracks in a repository, as absolute paths. */
function tracked(repo) {
  if (!existsSync(join(repo, '.git'))) return [];
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\0').filter(Boolean).map((f) => join(repo, f))
    .filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });
}

/** Files holding `value`, by exact bytes. `grep -l` so nothing is read here. */
function holding(value, paths) {
  if (paths.length === 0) return [];
  const hits = [];
  /* In batches: a repository has thousands of files and an argument list has
     a limit, which a whole tree passed in one call quietly exceeds. */
  for (let i = 0; i < paths.length; i += 800) {
    try {
      const out = execFileSync('grep', ['-lFI', '--', value, ...paths.slice(i, i + 800)], { encoding: 'utf8' });
      hits.push(...out.split('\n').filter(Boolean));
    } catch { /* grep exits 1 when it finds nothing, which is the good case */ }
  }
  return hits;
}

const found = secrets();

test('the credentials this gate guards are actually readable, or it proves nothing', () => {
  if (found === null) {
    console.log('  (skipped: no .env on this machine — nothing to leak, nothing to check)');
    return;
  }
  assert.equal(found.size, GUARDED.length,
    `.env no longer holds all of ${GUARDED.join(', ')} — this gate would pass on an empty set`);
});

test('no credential is in a tracked file of either repository', { skip: found === null }, () => {
  const files = [...tracked(ROOT), ...tracked(API)];
  assert.ok(files.length > 100, `only ${files.length} tracked files found — is this a git checkout?`);
  const bad = [];
  for (const [key, value] of found) {
    for (const f of holding(value, files)) bad.push(`${key} in ${f.replace(ROOT, '.')}`);
  }
  assert.deepEqual(bad, [], `credentials in tracked files:\n  ${bad.join('\n  ')}`);
});

test('and none is in anything we build', { skip: found === null }, () => {
  const outs = [
    join(ROOT, 'apps/web/dist'),
    join(ROOT, 'apps/web/dist-app'),
    join(ROOT, 'apps/mobile/dist'),
    join(ROOT, 'apps/tizen/dist'),
    join(ROOT, 'apps/webos/dist'),
  ].filter((d) => existsSync(d));
  const bad = [];
  for (const [key, value] of found) {
    for (const dir of outs) {
      try {
        /* `-I` skips binaries by content, so an APK is searched as bytes only
           where it is not one — and a source map, which is text, is not. */
        const out = execFileSync('grep', ['-rlF', '--', value, dir], { encoding: 'utf8' });
        for (const f of out.split('\n').filter(Boolean)) bad.push(`${key} in ${f.replace(ROOT, '.')}`);
      } catch { /* nothing found */ }
    }
  }
  assert.deepEqual(bad, [], `credentials in build output:\n  ${bad.join('\n  ')}`);
});
