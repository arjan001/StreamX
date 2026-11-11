# Streamix for Samsung Tizen TV

This directory produces `apps/tizen/dist/Streamix.wgt` — the same `@iptv/web`
app the website and the Android APK ship, built and packaged for a Samsung
Tizen TV. It does not need the Android app or the website to change: a Tizen
TV app is a web app (HTML/CSS/JS in a signed ZIP called a `.wgt`), so the
existing bundle is the raw material and only the build/packaging shape differs.

```
node apps/tizen/build.mjs      # -> apps/tizen/staging/  (bundle + config.xml + icon)
node apps/tizen/package.mjs    # -> apps/tizen/dist/Streamix.wgt  (signed)
# or, from the repo root:
pnpm tizen
```

Read `build.mjs` and `package.mjs` themselves for the file-by-file "why" —
this file is the part meant to save a day of re-research: how a `.wgt`
actually gets onto a TV, why the certificate is the real constraint, what
still has to happen before a customer can use this, and what is known not to
work yet.

## How a `.wgt` gets onto a TV

There is no Android-Downloader-style path — no "enter this code / open this
URL on the TV" flow that installs an app the way sideloading an APK does. The
only way an unpublished `.wgt` reaches a Samsung TV is:

1. **Developer Mode on the set.** Apps screen -> press `1 2 3 4 5` in
   sequence -> a Developer Mode dialog appears -> turn it on and enter the IP
   address of the PC that will push the app -> restart the TV when prompted.
2. **A PC on the same network, running Tizen's own tooling** (Tizen Studio's
   Device Manager, or the CLI's `sdb`/`tizen install`), connects to the TV by
   that IP and pushes the signed package directly over the network.

There is no step where a `.wgt` file sits on a USB stick or a web address
and the TV opens it. (Samsung's *native* app format, `.tpk`, is a different
thing entirely and irrelevant here — this app is, and stays, a web app, so
`.wgt` is the only format in play.)

A TV user's own source (Xtream server, M3U link, single stream, Stalker portal) is
typed in inside the app after it is installed; nothing about it is part of the
install, and the package carries no sources of its own.

## The certificate situation — the real constraint

Packaging (zipping + writing `config.xml`) is trivial. What a Tizen device
actually checks before it will run anything is two XML-DSig signatures inside
the package (`author-signature.xml`, `signature1.xml`), and **the signing
certificate is bound to specific TVs**, not to the app:

> "Your application package file can only be installed on devices in which
> their Device Unique ID (DUID) have been registered in your pseudo-distributor
> certificate. This ensures that the application can only be installed on
> your device and the ones that you have approved even when your package file
> is leaked."
> — [Samsung Developer: Getting the Certificates](https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/overview.html)
> (the certificate policy is one Tizen-wide mechanism, not watch-specific —
> the TV certificate guide below requires the identical DUID step)

Creating a real distributor certificate for a TV means: connect to that
physical TV from Tizen Studio, read its DUID from
`Settings > Support > Contact Samsung > Unique Device ID` (or let the IDE
auto-fill it over the network connection), bake that DUID into a certificate
signed in with a Samsung account, then on the TV itself select
"Permit to install apps" for that certificate.
([Samsung Developer: Creating Certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html);
walkthrough with screenshots:
[Creating Development Certificates for Samsung Tizen TVs](https://blog.j2i.net/2020/12/27/creating-development-certificates-for-samsunt-tizen-tvs/))

**The consequence that matters for planning:** a test `.wgt` signed this way
is not something you can hand to an arbitrary customer. It is authorized for the specific set(s) whose DUID went into it at
signing time, full stop. **Only a build signed by the Samsung Apps TV Seller
Office during store publication installs on every TV** — that final signature
replaces the developer's own, and it is the store's install path (not a
DUID list) that then makes it available to any customer.

### What this repo's pipeline can and cannot sign today

This box has no Tizen SDK installed and no physical Samsung TV, so it cannot
create a DUID-bound certificate — that step inherently needs a Samsung
account and a real, network-reachable television, neither of which exist
here. What `package.mjs` CAN do, and what was verified here:

- **Docker path (verified working, this session):** `docker pull
  vitalets/tizen-webos-sdk` (2.66GB, one-time) gives a container with the same
  `tizen` CLI Tizen Studio ships (`tizen version` → `Tizen CLI 2.5.25`). Run
  against this app's own staged build, `tizen build-web` + `tizen package -t
  wgt -s dev` produced a **real, 4,075,784-byte, structurally valid `.wgt`**
  containing both `author-signature.xml` and `signature1.xml` — genuinely
  signed, not a bare zip. Confirmed by unzipping it and reading both
  signature files.
- **The certificate that signed it is the image's bundled SAMPLE
  certificate** (`author.p12` + Tizen Studio's own generic
  `tizen-distributor-signer.p12`, the exact file every Tizen Studio install
  ships with, profile name `dev`). It has no DUID registered. Per the quote
  above, that means this package **will install and run in the Tizen TV
  Emulator, and will NOT be accepted by a real Samsung TV.** This is not a
  limitation of Docker or of this script — a real Tizen Studio install on a
  real machine, using the same sample certificate, hits the identical wall.
- **`package.mjs` has an escape hatch for when a real certificate exists:**
  set `STREAMIX_TIZEN_PROFILES_DIR` to a host directory holding a real
  `profiles.xml` (and the `.p12` files it points at) produced by Tizen
  Studio's Certificate Manager against an actual TV's DUID, and the Docker
  container mounts it in place of the sample one. Not exercised here — there
  was no certificate to mount — but the mechanism is real and the mount point
  (`/home/developer/tizen-studio-data/profile`) is the same file the CLI
  reads inside the container regardless of who created it.

Nothing here claims to be installable on a real TV. The filename
(`Streamix.wgt`) is the same regardless of which certificate signed it — the
distinction that matters lives in the log line `package.mjs` prints
("signing with the image's bundled SAMPLE certificate…") and in this
document, not in the file itself, so read the build log, not just the
presence of a `.wgt`, before handing one to anyone.

## What is still required before a customer can have this

1. **A Samsung Apps TV Seller Office account**, with business verification.
   It's free to create, but a new account is a "public seller" by default,
   which can only distribute in the United States — reaching other markets
   (the Netherlands, for instance) needs a partner-seller request.
   ([Samsung Developer: TV Seller Office](https://developer.samsung.com/tv-seller-office))
2. **A real Samsung TV** to test on. Not optional and not approximated by the
   emulator for the parts that matter most here (see AVPlay below) — the
   emulator's media pipeline does not exercise the same hardware decode path
   webapis.avplay drives on a real set.
3. **App review**, which happens after the package above is uploaded to
   Seller Office. Samsung tests against their own checklist and can reject
   and require resubmission; store icons (512x423 and 1920x1080 px — separate
   from and much larger than the 117x117-class icon `config.xml` points at,
   which Samsung's docs say is only ever shown in the emulator) and
   screenshots are submitted through Seller Office, not carried in the
   package. ([Samsung Developer: Entering Application Information](https://developer.samsung.com/tv-seller-office/guides/applications/entering-application-information.html))
4. Only once all three of the above are done does Samsung's own signature
   replace the developer one this pipeline produces, and only then can any
   customer's TV install it — see "The certificate situation" above.

## What is known NOT to work yet

Stated plainly rather than discovered later:

- **Video playback is browser-level only.** This build uses the same
  `<video>` + `hls.js`/`mpegts.js` (MediaSource Extensions) path the website
  and the APK use. On a real Samsung TV, Samsung's own guidance is that
  adaptive streaming, several subtitle formats and DRM are "difficult or not
  supported" through the plain video tag and are the reason `webapis.avplay`
  (AVPlay) exists — it drives the TV's own hardware media pipeline directly.
  ([Samsung Developer: Playback Using AVPlay](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html))
  **AVPlay integration has not been implemented anywhere in this codebase.**
  Whether MSE playback via hls.js is good enough on its own on a 2020-era
  Tizen 5.5 set (Chromium 69) is unverified — it was not tested on real or
  emulated hardware, only built. Until AVPlay lands, treat any format or
  DRM path that the website's plain `<video>` fallback would also struggle
  with as untested on Tizen.
- ~~**The TV remote's Return/Back hardware key**~~ — **resolved, 2026-09-20.**
  The key reaches the page as a `tizenhwkey` event (keyCode `10009`) because
  `config.xml` declares `hwkey-event="enable"`, and the app does handle it:
  `apps/web/src/lib/remoteKeys.ts:247` maps `10009` to `exit`, with
  `intentForTizenCode(10009) === 'exit'` pinned in `remoteKeys.test.ts` and
  the event path itself covered in `tizenKeys.test.ts`. Nothing to do here.
  (Still unverified on real hardware, like everything else below — but the
  code is present rather than absent, which is what this entry asked.)
- **No obfuscation pass runs over the Tizen bundle** the way
  `apps/mobile/scripts/harden.mjs` runs over the Capacitor one. The package ships no
  provider addresses or built-in sources (the viewer adds their own), so there is no
  list for it to hide; the bundle is as readable as the website's JavaScript, which
  is public anyway. `bundle-floor.mjs` does run (see below).
- **Not tested on the Tizen Emulator or any real hardware**, only built and
  packaged. The `.wgt` produced here has not been installed anywhere and
  therefore has not been seen to actually run.

## Files in this directory

- `config.xml` — the widget manifest (W3C `widget` element + Tizen
  extensions). Read the comments inline for why `required_version="5.5"`
  (2020 TVs, Chromium 69), why `tizen:profile name="tv-samsung"` and not the
  generic `tv`, and why only the `internet` privilege is requested so far.
  It holds four placeholders that `build.mjs` fills in: `__STREAMIX_API_ORIGIN__`
  (the `<access>` element — whatever `STREAMIX_API_ORIGIN` that build used),
  `__STREAMIX_VERSION__` (from `version.json`, three numbers), and
  `__TIZEN_PACKAGE__` / `__TIZEN_APP_ID__` (ten alphanumeric characters derived from
  the brand name by `manifest.mjs`: `StreamixTV` and `StreamixTV.Streamix`). The
  build fails if any token is left behind.
- `icon.png` — copied from `apps/web/public/icon-512.png`. Only used by the
  emulator per Samsung's own docs; the icons a store listing actually shows
  (512x423, 1920x1080) are uploaded separately through Seller Office and are
  not part of this pipeline yet.
- `manifest.mjs` — the package id, application id and widget version rules, pinned
  by `scripts/bundle-floor.test.mjs`.
- `build.mjs` — builds `@iptv/web` in the combination a packaged local widget
  needs (`VITE_BASE=./`, `VITE_ROUTER=hash`, `VITE_DATA=local`, an absolute
  API origin, `VITE_PLATFORM` left unset) and assembles
  `apps/tizen/staging/`. Verified: produces a real `dist-tizen/index.html`
  with correctly relative asset paths (`./assets/…`) and stamps/CSS-flattens
  it with the same `scripts/stamp-build.mjs` / `scripts/css-compat.mjs` the
  main build uses, then runs `scripts/bundle-floor.mjs`: syntax newer than the
  Chromium 68 floor fails the build, so a stray modern API cannot white-screen a
  2020 set.
- `package.mjs` — turns `staging/` into `dist/Streamix.wgt`, using a local
  `tizen` CLI if one is on PATH, otherwise the `vitalets/tizen-webos-sdk`
  Docker image, otherwise it prints exactly what to install and where to get
  it (verified: ran with an empty `PATH` and got the intended message, exit
  code 1, no stack trace).
- `staging/`, `dist/` — build output, not checked in.

## Environment variables

| Variable                        | Used by      | Default                          |
|----------------------------------|--------------|-----------------------------------|
| `STREAMIX_API_ORIGIN`            | `build.mjs`  | empty (same as `apps/mobile`'s `build:web`); falls back to `PUBLIC_SITE_ORIGIN` in `.env` |
| `STREAMIX_TIZEN_PROFILE`         | `package.mjs`| `dev` (the Docker image's built-in sample profile name) |
| `STREAMIX_TIZEN_PROFILES_DIR`    | `package.mjs`, Docker path only | unset — uses the sample certificate (emulator-only, see above) |
