/**
 * Write down which version a build actually is.
 *
 * The version is substituted INTO the bundle at build time, which makes it
 * invisible afterwards: `import.meta.env.VITE_APP_VERSION` becomes a bare string
 * among a hundred thousand other strings, and the first attempt to check it found
 * React's version instead. So the build says so out loud, in a file, next to the
 * thing it describes.
 *
 * This exists because of a real report — "it says I have the old version on the
 * web" — which was `version.json` bumped, the APK rebuilt, and the website still
 * serving a bundle stamped with the previous number. A version that lives in
 * three places has to be checkable in all three.
 *
 * Usage: stamp-build.mjs [dir ...]   (defaults to the web and wrapper outputs)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './brand-kit.mjs';

const { version, build } = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'));
/*
 * The default is the WEBSITE only, and that is the whole of a shipped bug.
 *
 * This used to default to both outputs, so the root `pnpm build` — which builds
 * `apps/web/dist` and nothing else — wrote a fresh, confident stamp onto
 * `apps/web/dist-app` as well. The wrapper's bundle is produced by a different
 * command with a different Vite environment (`VITE_PACKAGED=1`, hash router,
 * its own outDir), and it had not been rebuilt in days.
 *
 * A stamp is evidence. Writing one beside a build that did not happen makes
 * the evidence worthless, and it was: 1.38.2 shipped an APK whose bundle said
 * 1.38.2+172 in `build.json` and was in fact the 1.38.0 code.
 *
 * `apps/mobile`'s own `build:web` passes `../../apps/web/dist-app` explicitly,
 * immediately after building it, which is the only place that claim can
 * honestly be made.
 */
const dirs = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [join(ROOT, 'apps/web/dist')];

let wrote = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  writeFileSync(
    join(dir, 'build.json'),
    `${JSON.stringify({ version, build, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  wrote += 1;
  console.log(`stamped ${dir.replace(ROOT, '.')} ${version}+${build}`);
}
if (wrote === 0) console.log('nothing to stamp — no build output found');
