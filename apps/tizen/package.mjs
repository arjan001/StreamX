#!/usr/bin/env node
/**
 * Turn the staging directory (`apps/tizen/staging`, built by `build.mjs`)
 * into a signed `apps/tizen/dist/Streamix.wgt`.
 *
 * A `.wgt` is a plain ZIP with `config.xml` at its root — the packaging tool's
 * real job is not zipping, it's SIGNING: `tizen build-web` validates the
 * widget manifest, and `tizen package -t wgt` writes two XML-DSig signatures
 * into the archive (`author-signature.xml`, `signature1.xml`) that a Tizen
 * device checks before it will run anything inside. Producing bytes without
 * that signature is trivial (any zip tool); producing something a device
 * will actually launch requires the real `tizen` CLI (or a compatible one) and
 * a certificate. This script never fakes either.
 *
 * ── two ways to get the `tizen` CLI onto this box ──
 *
 * 1. The real Samsung Tizen Studio CLI, if it's on PATH. Nothing this script
 *    does depends on Tizen Studio specifically vs. the standalone
 *    `tizen-studio-cli` bundle — both install the same `tizen` binary.
 *
 * 2. `vitalets/tizen-webos-sdk`, a Docker image bundling the same CLI
 *    (verified here: `tizen version` -> "Tizen CLI 2.5.25" inside the
 *    container). This box has no sudo but Docker works and is already used
 *    for other work in this repo (`iptv-tv/emulator`), so this is preferred
 *    over asking a future reader to install a multi-GB SDK by hand when they
 *    don't have to. VERIFIED end-to-end on this box: `docker pull
 *    vitalets/tizen-webos-sdk` (2.66 GB), then `tizen build-web` and
 *    `tizen package -t wgt -s dev` against this project's own staged output
 *    produced a 4,075,784-byte `Streamix.wgt` containing both
 *    `author-signature.xml` and `signature1.xml` — a real, structurally valid,
 *    cryptographically signed widget package, not a bare zip.
 *
 * ── what that signature is actually worth — READ THIS BEFORE ASSUMING A
 *    DOCKER-PRODUCED .wgt CAN GO ON A REAL TV ──
 *
 * The image ships Tizen Studio's own bundled SAMPLE certificate pair
 * (`author.p12` + `tizen-studio/.../tizen-distributor-signer.p12`, profile
 * name "dev" — verified present in the image at those exact paths). This is
 * the same generic distributor certificate that comes with every Tizen Studio
 * install everywhere; it has no device registered against it. Samsung's own
 * documentation is explicit that a real TV enforces the opposite of that:
 * "Your application package file can only be installed on devices in which
 * their Device Unique ID (DUID) have been registered in your pseudo-
 * distributor certificate" (developer.samsung.com/galaxy-watch-tizen/
 * getting-certificates/overview.html — the certificate policy is shared
 * across Tizen device classes, TV included, and the TV-specific certificate
 * guide requires connecting to the physical TV to read its DUID into the
 * certificate: developer.samsung.com/smarttv/develop/getting-started/
 * setting-up-sdk/creating-certificates.html). So a `.wgt` built with the
 * default "dev" profile:
 *   - WILL install and run in the Tizen TV Emulator, which accepts it.
 *   - Will NOT be accepted by a real Samsung TV, which enforces the DUID
 *     check the sample certificate was never issued to satisfy.
 * This is not a limitation of this script or of Docker — it is the same wall
 * a real Tizen Studio install on a real machine would hit with the same
 * sample certificate. See README.md for what actually gets a `.wgt` onto a
 * real set.
 *
 * ── the certificate profile is a name, read from the environment ──
 *
 * `STREAMIX_TIZEN_PROFILE` (default `dev`, matching the docker image's
 * built-in profile name) is passed to `tizen package -s <profile>`. This
 * script invents no credentials and stores none: a real profile — one built
 * from a Samsung Certificate Extension login, with a real TV's DUID baked in
 * — is created outside this script (Tizen Studio's Certificate Manager, or
 * `tizen certificate`/`tizen security-profiles` on the CLI) and this script
 * only needs to be told its name (local CLI) or given the resulting
 * `profiles.xml` + `.p12` files to mount (Docker path, see
 * `STREAMIX_TIZEN_PROFILES_DIR` below).
 *
 * Usage:
 *   node apps/tizen/build.mjs        # writes apps/tizen/staging/
 *   node apps/tizen/package.mjs       # writes apps/tizen/dist/Streamix.wgt
 *
 * Env:
 *   STREAMIX_TIZEN_PROFILE       security profile name (default: dev)
 *   STREAMIX_TIZEN_PROFILES_DIR  Docker path only — host directory containing
 *                                 a real profiles.xml + certificate files, to
 *                                 mount over the image's sample profile so a
 *                                 real DUID-registered certificate can sign
 *                                 the build without installing anything.
 *                                 Unset uses the image's bundled sample "dev"
 *                                 profile (emulator-only, see above).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGING = join(HERE, 'staging');
const OUT_DIR = join(HERE, 'dist');
const PROFILE = process.env.STREAMIX_TIZEN_PROFILE ?? 'dev';
const PROFILES_DIR = process.env.STREAMIX_TIZEN_PROFILES_DIR ?? '';
const DOCKER_IMAGE = 'vitalets/tizen-webos-sdk:latest';
const WGT_NAME = 'Streamix.wgt';

function ok(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasLocalTizenCli() {
  return ok('bash', ['-lc', 'command -v tizen']);
}

function hasWorkingDocker() {
  return ok('bash', ['-lc', 'command -v docker']) && ok('docker', ['info']);
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function packageWithLocalCli() {
  console.log(`package: using local tizen CLI, profile "${PROFILE}"`);
  const buildOut = join(HERE, '.build-web-out');
  run('tizen', ['build-web', '--', STAGING, '-out', buildOut]);
  run('tizen', ['package', '-t', 'wgt', '-s', PROFILE, '-o', OUT_DIR, '--', buildOut]);
  reportResult();
}

function packageWithDocker() {
  console.log(`package: no local "tizen" CLI — using Docker image ${DOCKER_IMAGE}`);
  console.log('package: pulling (first run only; the image is ~2.7GB)…');
  run('docker', ['pull', DOCKER_IMAGE]);

  const mounts = [
    '-v', `${STAGING}:/src:ro`,
    '-v', `${OUT_DIR}:/out`,
  ];
  if (PROFILES_DIR) {
    if (!existsSync(PROFILES_DIR)) {
      console.error(`package: STREAMIX_TIZEN_PROFILES_DIR does not exist: ${PROFILES_DIR}`);
      process.exit(1);
    }
    console.log(`package: mounting real certificate profile from ${PROFILES_DIR}`);
    mounts.push('-v', `${resolve(PROFILES_DIR)}:/home/developer/tizen-studio-data/profile:ro`);
  } else {
    console.log(
      'package: no STREAMIX_TIZEN_PROFILES_DIR set — signing with the image\'s bundled '
      + 'SAMPLE certificate. That produces a real, structurally valid, signed .wgt, but '
      + 'one only the Tizen Emulator will accept — see this file\'s header and README.md '
      + 'for why a real Samsung TV needs a DUID-registered certificate instead.',
    );
  }

  const containerCmd = [
    'set -e',
    'tizen build-web -- /src -out /tmp/build-out',
    `tizen package -t wgt -s ${shQuote(PROFILE)} -o /out -- /tmp/build-out`,
    // The container runs as root and /out is bind-mounted from the host, so
    // fix ownership back to whoever ran this script rather than leaving the
    // output owned by root.
    `chown ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} /out/*.wgt || true`,
  ].join(' && ');

  run('docker', ['run', '--rm', ...mounts, DOCKER_IMAGE, 'bash', '-lc', containerCmd]);
  reportResult();
}

function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function reportResult() {
  const wgt = join(OUT_DIR, WGT_NAME);
  if (!existsSync(wgt)) {
    console.error(`package: FAIL — expected ${wgt}, nothing was written`);
    process.exit(1);
  }
  const size = statSync(wgt).size;
  console.log(`package: wrote ${wgt.replace(HERE, '.')} — ${(size / 1024 / 1024).toFixed(2)} MB`);
}

function main() {
  if (!existsSync(join(STAGING, 'index.html'))) {
    console.error('package: no staging build found at apps/tizen/staging — run `node apps/tizen/build.mjs` first.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  if (hasLocalTizenCli()) {
    packageWithLocalCli();
    return;
  }
  if (hasWorkingDocker()) {
    packageWithDocker();
    return;
  }

  console.error(`
package: no Tizen packaging tool available — neither a local "tizen" CLI nor a
working Docker daemon was found. To produce apps/tizen/dist/${WGT_NAME}, get one of:

  1. Docker (preferred on this box — no multi-GB local install):
       Make sure Docker is running and this user can reach it (\`docker info\`
       should succeed), then re-run this script. It will pull and use the
       ${DOCKER_IMAGE} image (~2.7GB, one-time), which bundles the Tizen CLI.
       Source: https://github.com/vitalets/docker-tizen-webos-sdk

  2. Samsung's own Tizen Studio (the full IDE, includes the CLI) or the
     standalone "tizen-studio-cli" package, either of which puts a \`tizen\`
     binary on PATH:
       https://developer.samsung.com/smarttv/develop/getting-started/
         setting-up-sdk/installing-tv-sdk.html
     This is a multi-GB download — prefer the Docker path above unless you
     specifically need the GUI (device manager, emulator control panel, etc).

Either way, actually installing onto a real Samsung TV additionally needs a
certificate registered to that TV's device ID — see apps/tizen/README.md,
"The certificate situation" — packaging alone does not get you there.
`);
  process.exit(1);
}

main();
