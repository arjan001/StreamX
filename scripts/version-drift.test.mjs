/**
 * The number on the tin is the number inside it.
 *
 *     i think you didnt update the version number or what?
 *
 * They were right. `version.json` had been edited to 1.38.1+171 by hand, the
 * changelog said 1.38.1+171 — and the APK people actually
 * downloaded declared `versionName "1.38.0"` / `versionCode 170`, because those
 * live in `apps/mobile/android/app/build.gradle` and are written there by
 * `pnpm version:apply`, which nothing had run.
 *
 * ── why this is worse than a cosmetic slip ──
 *
 * Stores compare BUILD NUMBERS. An upload that still says build 170 is refused
 * (Google Play) or looks like the same release, so the number inside the package
 * must be the one the release was cut as.
 *
 * `pnpm version:check` already detects this exactly. It simply was not part of
 * anything that runs on its own, so it only ever spoke when somebody already
 * suspected the answer. Now the suite asks it, every run, for nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);

test('nothing that gets PACKAGED disagrees about the release', () => {
  let out = '';
  try {
    out = execFileSync('node', ['scripts/version.mjs', '--check'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  /*
   * A STALE `dist/` is not this bug and must not fail the suite.
   *
   * `version.mjs --check` also compares the built web bundle, which is right
   * for a release gate and wrong for a test: between `version:bump` and the
   * next `pnpm build` the working tree legitimately disagrees with the last
   * build, and a suite that goes red there teaches people to ignore it —
   * which is precisely how the android drift got out.
   *
   * What ships inside a package is `build.gradle`, and that is asserted here
   * and again, independently, below.
   */
  const android = /android says/.test(out);
  assert.equal(android, false, `${out.trim()}\n\nRun: pnpm version:apply`);
});

/**
 * And the gradle numbers are the ones a build would actually stamp.
 *
 * Read directly rather than through the script above, so that a future change
 * to `version.mjs` cannot make this pass by agreeing with itself.
 */
test('the Android project carries version.json’s own numbers', () => {
  const v = JSON.parse(readFileSync(new URL('version.json', ROOT), 'utf8'));
  const g = readFileSync(new URL('apps/mobile/android/app/build.gradle', ROOT), 'utf8');
  const name = /versionName\s+"([^"]+)"/.exec(g)?.[1] ?? null;
  const code = Number(/versionCode\s+(\d+)/.exec(g)?.[1] ?? 0);
  assert.equal(name, v.version, 'versionName in build.gradle');
  assert.equal(code, v.build, 'versionCode in build.gradle');
});
