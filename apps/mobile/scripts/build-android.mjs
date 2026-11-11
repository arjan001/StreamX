/**
 * Build the Android app.
 *
 *   node scripts/build-android.mjs            # release bundle (.aab) + debug APK
 *   node scripts/build-android.mjs bundle     # release bundle only, for Google Play
 *   node scripts/build-android.mjs debug      # debug APK only, for testing
 *   node scripts/build-android.mjs apk        # signed release APKs, for the website's download page
 *
 * Both need the web bundle built and synced first, so this runs `build:web` and
 * `cap sync android` before Gradle. The release bundle is signed with the upload
 * key from keystore.properties when one exists (see README.md) and is left
 * unsigned otherwise. Nothing is copied anywhere: the script prints where Gradle
 * put the files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '..');
const ROOT = resolve(MOBILE, '../..');
const ANDROID = join(MOBILE, 'android');

const what = process.argv[2] ?? 'all';
if (!['all', 'bundle', 'debug', 'apk'].includes(what)) {
  console.error('usage: build-android.mjs [all|bundle|debug|apk]');
  process.exit(2);
}
const tasks = [
  ...(what === 'all' || what === 'debug' ? ['assembleDebug'] : []),
  ...(what === 'all' || what === 'bundle' ? ['bundleRelease'] : []),
  ...(what === 'apk' ? ['assembleRelease'] : []),
];

/** Run through bash so the JDK / SDK environment of scripts/android-env.sh applies. */
function sh(cmd, cwd) {
  console.log(`+ ${cmd}`);
  // Skip android-env.sh in CI since GitHub Actions already provides JDK/SDK
  const envCmd = process.env.GITHUB_ACTIONS ? '' : `. "${join(ROOT, 'scripts/android-env.sh')}" --env && `;
  execFileSync('bash', ['-c', `${envCmd}${cmd}`], {
    cwd,
    stdio: 'inherit',
  });
}

sh('pnpm run build:web', MOBILE);
sh('npx cap sync android', MOBILE);
sh(`./gradlew --no-daemon ${tasks.join(' ')}`, ANDROID);

const out = join(ANDROID, 'app/build/outputs');
console.log('\nBuilt:');
if (tasks.includes('bundleRelease')) {
  console.log(`  release bundle  ${join(out, 'bundle/release/app-release.aab')}`);
}
if (tasks.includes('assembleRelease')) {
  console.log(`  release APKs    ${join(out, 'apk/release')}`);
}
if (tasks.includes('assembleDebug')) {
  const universal = join(out, 'apk/debug/app-universal-debug.apk');
  console.log(`  debug APK       ${existsSync(universal) ? universal : join(out, 'apk/debug')}`);
}
