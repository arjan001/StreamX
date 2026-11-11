/**
 * Write the repository's version into the Xcode project.
 *
 * `version.json` is the one source (`version` -> MARKETING_VERSION, `build` ->
 * CURRENT_PROJECT_VERSION, which App Store Connect requires to increase on every
 * upload). Run before archiving; CI does. Idempotent.
 *
 * Usage: node apps/mobile/scripts/ios-stamp.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { version, build } = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'version.json'), 'utf8'));
const pbx = join(HERE, '..', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const out = readFileSync(pbx, 'utf8')
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
writeFileSync(pbx, out);
console.log(`ios version ${version} (${build})`);
