/**
 * Copy freshly built packages into the website's download folder.
 *
 *   node scripts/collect-downloads.mjs [--dest <dir>] [--debug]
 *
 * Looks for what the build scripts leave behind:
 *
 *   apps/mobile/android/app/build/outputs/apk/release/*.apk   (debug/ with --debug,
 *                                                              or when no release exists)
 *   apps/tizen/dist/*.wgt
 *   apps/webos/dist/*.ipk
 *
 * and copies each as `streamix-<version>[-<abi>].<ext>`, the version coming from
 * version.json. The destination is `--dest`, else `DOWNLOAD_DIR`, else
 * `apps/server/downloads` — the folder the server's /download page reads.
 * Nothing is deleted. A package that is not built is skipped, not an error.
 *
 * This feeds a website page only. The apps never fetch anything from it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };

const { version } = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'));
const dest = resolve(opt('--dest') ?? (process.env.DOWNLOAD_DIR?.trim() || join(ROOT, 'apps/server/downloads')));
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal'];

const list = (dir, ext) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext) && statSync(join(dir, f)).isFile()).map((f) => join(dir, f))
  : []);
const abiOf = (file) => ABIS.find((a) => new RegExp(`(?:^|[-_.])${a}(?=[-_.]|$)`).test(basename(file))) ?? 'universal';

const jobs = [];
const apkDir = join(ROOT, 'apps/mobile/android/app/build/outputs/apk');
const release = list(join(apkDir, 'release'), '.apk');
const debug = list(join(apkDir, 'debug'), '.apk');
const releaseAbis = new Set(release.map(abiOf));
for (const f of release) jobs.push([f, `streamix-${version}-${abiOf(f)}.apk`]);
for (const f of debug) {
  if (flag('--debug') || !releaseAbis.has(abiOf(f))) jobs.push([f, `streamix-${version}-${abiOf(f)}${release.length === 0 || flag('--debug') ? '-debug' : ''}.apk`]);
}
for (const f of list(join(ROOT, 'apps/tizen/dist'), '.wgt')) jobs.push([f, `streamix-${version}.wgt`]);
for (const f of list(join(ROOT, 'apps/webos/dist'), '.ipk')) jobs.push([f, `streamix-${version}.ipk`]);

if (jobs.length === 0) {
  console.log('collect-downloads: no built packages found (build the Android shell, `pnpm tizen` or `pnpm webos` first).');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
const seen = new Set();
for (const [from, name] of jobs) {
  if (seen.has(name)) { console.log(`skip ${basename(from)}: ${name} is already taken`); continue; }
  seen.add(name);
  copyFileSync(from, join(dest, name));
  console.log(`${name}  <-  ${from.slice(ROOT.length)}  (${(statSync(from).size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`collect-downloads: ${seen.size} file(s) in ${dest}`);
