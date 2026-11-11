/**
 * Regenerate THIRD_PARTY_NOTICES.md and legal/licenses.md.
 *
 * Two copies of one text: the root file is what a reader of the repository (and
 * a store reviewer) opens, `legal/licenses.md` is what the app bundles for its
 * offline licences screen and the server renders at /licenses.
 *
 * Sources:
 *   - the production dependency tree of the app (`pnpm licenses list --prod`),
 *     with each package's own licence text read from its install directory;
 *   - the components that tree cannot see, written out below: libVLC (native,
 *     Android), libav.js and the FFmpeg inside it (apps/web/libav), icon sets, the Sports
 *     photographs (from apps/web/public/sports/CREDITS.md), and the demo films.
 *
 * Usage: node scripts/licenses.mjs [--check]   (--check fails if the files are stale)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './brand-kit.mjs';

const check = process.argv.includes('--check');

/* ── the dependency tree ─────────────────────────────────────────────────── */

const raw = execFileSync(
  'pnpm',
  ['--filter', '@iptv/web', '--filter', './apps/mobile', 'licenses', 'list', '--prod', '--json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const byLicence = JSON.parse(raw);

function licenceFile(dir) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f === undefined ? null : readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim();
}

const pkgs = [];
for (const [licence, list] of Object.entries(byLicence)) {
  for (const p of list) {
    pkgs.push({
      name: p.name,
      version: [...new Set(p.versions)].sort().join(', '),
      licence,
      homepage: p.homepage ?? '',
      text: licenceFile(p.paths?.[0] ?? ''),
    });
  }
}
pkgs.sort((a, b) => a.name.localeCompare(b.name));

/* Identical texts are printed once, with the packages that carry them. */
const texts = new Map();
for (const p of pkgs) {
  const key = createHash('sha256').update(p.text ?? `none:${p.licence}`).digest('hex');
  if (!texts.has(key)) texts.set(key, { licence: p.licence, text: p.text, users: [] });
  texts.get(key).users.push(p.name);
}

/* ── facts read from the repository ──────────────────────────────────────── */

const gradle = readFileSync(join(ROOT, 'apps/mobile/android/variables.gradle'), 'utf8');
const vlc = /libvlcVersion\s*=\s*'([^']+)'/.exec(gradle)?.[1];
if (vlc === undefined) throw new Error('libvlcVersion not found in apps/mobile/android/variables.gradle');

/* libav.js is not in the dependency tree: the variant the app ships is built
   from a recipe in apps/web/libav, and that recipe is the one place that says
   which release and which FFmpeg it is. */
const libavBuild = readFileSync(join(ROOT, 'apps/web/libav/build.sh'), 'utf8');
const libavVersion = /^VER=(\S+)$/m.exec(libavBuild)?.[1];
const ffmpegVersion = /^FFVER=(\S+)$/m.exec(libavBuild)?.[1];
if (libavVersion === undefined || ffmpegVersion === undefined) {
  throw new Error('VER / FFVER not found in apps/web/libav/build.sh');
}
const libavConfigure = readFileSync(join(ROOT, 'apps/web/libav/dist/ffmpeg-configuration.txt'), 'utf8')
  .split('\n').find((l) => l.startsWith('#define FFMPEG_CONFIGURATION'))
  ?.replace(/^#define FFMPEG_CONFIGURATION "/, '').replace(/"$/, '').replace(/\s+/g, ' ').trim();
if (libavConfigure === undefined) throw new Error('apps/web/libav/dist/ffmpeg-configuration.txt has no configure line');
const libavFragments = JSON.parse(readFileSync(join(ROOT, 'apps/web/libav/config.json'), 'utf8')).length;

const creditsPath = join(ROOT, 'apps/web/public/sports/CREDITS.md');
const credits = existsSync(creditsPath) ? readFileSync(creditsPath, 'utf8') : '';
const photoRows = [...credits.matchAll(/^\|\s*([a-z]+)\s*\|\s*([^|]+?)\s*\|\s*(\S+)\s*\|$/gm)]
  .filter((m) => m[1] !== 'Sport');

/* ── the document ────────────────────────────────────────────────────────── */

const out = [];
const w = (s = '') => out.push(s);

w('# Open-source licences');
w();
w('Streamix is built on open-source software. This page lists what it contains, who made it and under which licence.');
w();
w('## Components under the LGPL');
w();
w('### libVLC (Android)');
w();
w(`- Version ${vlc}, \`org.videolan.android:libvlc-all:${vlc}\`.`);
w('- Licence: GNU Lesser General Public License, version 2.1 or later (LGPL-2.1-or-later). libVLC bundles further libraries under the LGPL or more permissive licences, among them FFmpeg.');
w('- Used for playback of formats the system web view cannot play, on Android.');
w('- Source code: https://code.videolan.org/videolan/vlc-android (the Android library) and https://code.videolan.org/videolan/vlc (libVLC itself). Licence text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html');
w('- You may replace libVLC with your own build of it. It is a separate shared library (libvlc.so, libvlcjni.so) in the app package, not compiled into the app’s own code. The publisher will provide the corresponding libVLC source code on request for at least three years from distribution; it is also available from VideoLAN.');
w();
w('### libav.js and FFmpeg');
w();
w(`- libav.js ${libavVersion} (https://github.com/Yahweasel/libav.js, by Yahweasel and contributors) is FFmpeg ${ffmpegVersion} compiled to WebAssembly. The app uses it in the web version only, to take a video file apart in the browser so that it can be played: it reads the container (Matroska, AVI, MP4, MPEG-TS and others), passes the picture through unchanged and, when the sound is not AAC, decodes it and encodes AAC. The app serves it as three separate downloads (\`libav-streamix.mjs\`, \`libav-streamix.wasm.mjs\` and \`libav-streamix.wasm.wasm\`). It is not part of the Android, iPhone, iPad, Samsung or LG apps, which play with the system’s own player or libVLC.`);
w('- Licence: GNU Lesser General Public License, version 2.1 or later (LGPL-2.1-or-later), because the compiled files contain FFmpeg. Copyright the FFmpeg developers. https://ffmpeg.org/legal.html . libav.js’s own source files, the thin layer around FFmpeg, carry a permissive (ISC-style) notice; the complete licence texts, including those of Emscripten and musl, are the header of `libav-streamix.wasm.mjs`, which is shipped unchanged.');
w(`- Source code. FFmpeg ${ffmpegVersion}: https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.xz . libav.js ${libavVersion} with its patches to FFmpeg: https://github.com/Yahweasel/libav.js , also published as the npm package \`libav.js@${libavVersion}\`, whose \`sources/\` folder holds the FFmpeg tarball, the other sources and the patches. The variant is selected by a short list of components (${libavFragments} entries) and built by a script, both in \`apps/web/libav/\` of the Streamix source (\`config.json\`, \`build.sh\`); the exact FFmpeg configuration is given below. The publisher will provide the corresponding source code on request for at least three years from distribution.`);
w('- You may replace it: the three files are separate from the rest of the app and are loaded at run time. Build your own with a modified FFmpeg using the recipe above and put it in their place.');
w();
w('FFmpeg configuration of the shipped files:');
w();
w('```');
w(libavConfigure);
w('```');
w();
w('Why this is the LGPL build and not the GPL one. FFmpeg is configured without `--enable-gpl`, `--enable-nonfree` or `--enable-version3`, and with no external codec library at all: no x264, no x265, no libpostproc, no zlib. The components are FFmpeg’s own: the Matroska, AVI, MP4, MPEG-TS, ASF, FLV and MPEG demuxers, the MP4 muxer, native decoders for H.264, HEVC, VP8, VP9, MPEG-1/2/4, VC-1, AAC, AC-3, E-AC-3, DTS, TrueHD, MP2, MP3, FLAC, Vorbis, Opus, ALAC, WMA and PCM, and the native AAC encoder. FFmpeg’s own build summary for these files reads “LGPL version 2.1 or later”, and `CONFIG_GPL`, `CONFIG_NONFREE`, `CONFIG_VERSION3`, `CONFIG_LIBX264` and `CONFIG_LIBX265` are all 0. The file does contain the text “x264 - core”: it is what the H.264 decoder looks for when it reads the encoder’s name out of a stream, not encoder code.');
w();
w('## Other components');
w();
w('### Capacitor, hls.js, mpegts.js, React and the rest of the app’s code');
w();
w('They are listed with their licence texts under “Packages” below. Capacitor (MIT) is the native shell on Android and iOS. hls.js (Apache-2.0) and mpegts.js (Apache-2.0) play streams in the web view. The Android build also contains AndroidX libraries (Apache-2.0).');
w();
w('### Fonts');
w();
w('None are bundled. The app uses the fonts of the device it runs on.');
w();
w('### Icons');
w();
w('- Lucide icons (`lucide-react`): ISC licence. https://lucide.dev');
w('- Material Design Icons (`@mdi/js`): Apache-2.0. https://pictogrammers.com/library/mdi/');
w();
w('### Sports backgrounds');
w();
w('Photographs shown dimmed behind the Sports screen, each from Unsplash under the Unsplash License (https://unsplash.com/license): free to use, no attribution required, credited here anyway.');
w();
for (const m of photoRows) w(`- ${m[1]}: ${m[2]} – ${m[3]}`);
w();
w('## Demo films');
w();
w('The optional demo playlist that some deployments offer (so that a new user, or a store reviewer, has something to play) lists three Creative Commons films by the Blender Foundation. They are not part of the app.');
w();
w('- Big Buck Bunny, © Blender Foundation | peach.blender.org. Licensed under Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). https://peach.blender.org/about/');
w('- Sintel, © Blender Foundation | durian.blender.org. Licensed under Creative Commons Attribution 3.0. https://durian.blender.org/sharing/');
w('- Tears of Steel, © Blender Foundation | mango.blender.org. Licensed under Creative Commons Attribution 3.0. https://mango.blender.org/sharing/');
w();
w('## Packages');
w();
w(`${pkgs.length} packages from the app’s production dependency tree.`);
w();
for (const p of pkgs) {
  w(`- ${p.name} ${p.version} – ${p.licence}${p.homepage === '' ? '' : ` – ${p.homepage}`}`);
}
w();
w('## Licence texts');
w();
for (const t of texts.values()) {
  w(`### ${t.licence}`);
  w();
  w(`Applies to: ${t.users.join(', ')}.`);
  w();
  w('```');
  w(t.text ?? `(The package declares ${t.licence} but ships no licence file. The standard text is at https://spdx.org/licenses/ .)`);
  w('```');
  w();
}

const doc = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
const targets = [join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(ROOT, 'legal/licenses.md')];
if (check) {
  const stale = targets.filter((f) => !existsSync(f) || readFileSync(f, 'utf8') !== doc);
  if (stale.length > 0) { console.error(`stale: ${stale.join(', ')} — run node scripts/licenses.mjs`); process.exit(1); }
} else {
  for (const f of targets) writeFileSync(f, doc);
  console.log(`wrote ${targets.length} files, ${pkgs.length} packages, ${texts.size} distinct licence texts`);
}
