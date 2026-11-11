#!/usr/bin/env node
/**
 * Turn `apps/webos/staging/` into `apps/webos/dist/*.ipk`.
 *
 * ── the difference from Tizen that decides everything ──
 *
 * A Samsung `.wgt` is signed with a certificate that has specific televisions'
 * DUIDs baked into it, so a package built here installs on nothing until a
 * customer's own TV has been registered. An LG `.ipk` has **no signature at
 * all**: `ares-package` produces a plain ipk, and a webOS TV in Developer Mode
 * installs whatever it is handed. That makes this the one TV platform where a
 * file built on this box is genuinely the file that runs on a television.
 *
 * What replaces the certificate as the limit is TIME rather than identity: LG's
 * Developer Mode is a session on the set — installed from the Content Store,
 * signed in with an LG developer account, and it expires (and takes sideloaded
 * apps with it) unless it is extended. So this is a real test build and still
 * not a way to ship to customers; the LG Content Store is. See README.md.
 *
 * Uses a local `ares-package` if one is on PATH, otherwise the same Docker
 * image the Tizen packager uses — it carries both SDKs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const staging = join(HERE, 'staging');
const out = join(HERE, 'dist');
const IMAGE = process.env.STREAMIX_WEBOS_IMAGE ?? 'vitalets/tizen-webos-sdk:latest';

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

function have(cmd) {
  return spawnSync('bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

if (!existsSync(join(staging, 'appinfo.json'))) {
  console.error('package: nothing staged — run apps/webos/build.mjs first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (have('ares-package')) {
  console.log('package: using the local ares-package');
  run('ares-package', [staging, '-o', out]);
} else if (have('docker')) {
  console.log(`package: no local ares-package — using Docker image ${IMAGE}`);
  run('docker', [
    'run', '--rm',
    '-v', `${staging}:/src:ro`,
    '-v', `${out}:/out`,
    IMAGE,
    'bash', '-lc',
    /* `ares-package` refuses a read-only source directory because it writes a
       temporary manifest beside it, so the mount is copied first. The copy is
       ~12MB and costs nothing next to the packaging itself. */
    'set -e && cp -r /src /tmp/app && ares-package /tmp/app -o /out'
      + ` && chown ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} /out/*.ipk || true`,
  ]);
} else {
  console.error('package: neither ares-package nor docker is available.');
  console.error('  Install the webOS TV CLI (https://webostv.developer.lge.com/develop/tools/cli-installation)');
  console.error(`  or Docker, which can run ${IMAGE}.`);
  process.exit(1);
}

const made = readdirSync(out).filter((f) => f.endsWith('.ipk'));
if (made.length === 0) {
  console.error('package: ares-package finished but produced no .ipk');
  process.exit(1);
}
for (const f of made) {
  console.log(`package: wrote ./dist/${f} — ${mb(statSync(join(out, f)).size)}`);
}
/*
 * Said on every run, not buried in a document: this file is NOT signed and does
 * not need to be, which is exactly why it is only a test build. It installs on
 * a set in Developer Mode and on nothing else.
 */
console.log('package: unsigned, as webOS expects — installs on a TV in Developer Mode');
console.log('package: reaching a customer needs the LG Content Store; see README.md');
