# Streamix for LG webOS TV

```bash
pnpm webos          # build + package, from the repo root
```

Produces `apps/webos/dist/com.easyred.streamix_<version>_all.ipk`. The version in
`appinfo.json` is `version.json`'s (three numbers), written by `build.mjs`. The
build also runs `scripts/bundle-floor.mjs`: syntax newer than the Chromium 68
floor fails it.

## How this differs from Samsung, which is the whole point

A Samsung `.wgt` is signed with a certificate carrying specific televisions'
Device Unique IDs, so a package built here installs on **nothing** until a
customer's own set has been registered into the certificate.

**webOS has no equivalent.** `ares-package` produces an **unsigned** ipk, and a
TV in Developer Mode installs whatever it is handed. The file in `dist/` is
genuinely the file that runs on a television — no certificate step, no DUID, no
per-TV build.

What replaces identity as the limit is **time**.

## Installing it on a TV

1. **On the TV:** install **Developer Mode** from the LG Content Store (search
   for it — it is a normal free app published by LG), open it, and sign in with
   an **LG developer account** (free, created at
   [webostv.developer.lge.com](https://webostv.developer.lge.com/)).
2. Turn **Dev Mode Status** on. The TV restarts. Note the **IP address** and the
   **passphrase** the app shows.
3. **On a PC on the same network**, with the webOS TV CLI installed:

   ```bash
   ares-setup-device --add tv --info "host=<TV-IP>;port=9922;username=prisoner"
   ares-novacom --device tv --getkey        # asks for the passphrase from step 2
   ares-install --device tv streamix-lg-webos.ipk
   ```

4. The app appears at the end of the TV's app row.

There is no way to install an `.ipk` from a USB stick or a URL on the set
itself, the same as Tizen. The PC step is not optional.

### The session expires

LG's Developer Mode is a **time-limited session**, not a permanent setting. It
lasts a matter of hours and has an **extend** button inside the Developer Mode
app; when it lapses, sideloaded apps are removed with it. That is fine for
testing and is not a way to keep a customer running.

## Reaching an actual customer

The **LG Content Store**, and nothing else:

1. An **LG Seller Lounge** account (business details, verification).
2. Upload the same ipk, with store artwork and a description.
3. LG's review.

Only after that does a customer's TV install it from the store the way it
installs any other app.

## What is untested

Stated plainly, the same as the Tizen notes:

- **Never run on a real or emulated LG television.** Built and packaged only.
- **Video playback is browser-level.** This is the same `<video>` +
  `hls.js`/`mpegts.js` path the website uses. webOS has its own media pipeline
  and LG's guidance points at it for serious playback, the way Samsung's points
  at AVPlay — **neither is implemented**. A 2020 webOS 5 set is Chromium 68, so
  `scripts/css-compat.mjs` runs over this bundle for the same reason it runs
  over the Tizen one.
- **No obfuscation pass** runs over this bundle. It carries no built-in sources
  or provider addresses to hide — see `apps/tizen/README.md`.
- **The remote is handled, the TV is not verified.** `lib/webosKeys.ts` maps
  LG's Back (keyCode 461) to the same `exit` intent Tizen's 10009 gets, pinned
  in `webosKeys.test.ts`. This matters more than it looks: `appinfo.json` sets
  `disableBackHistoryAPI`, so webOS stops closing the app itself, and without
  that listener Back would do nothing at all. Researched, not measured.

## Files here

- `build.mjs` — builds `@iptv/web` in the packaged-local combination
  (`VITE_BASE=./`, hash router, local catalogue, absolute API origins,
  `VITE_PLATFORM` unset) and writes `staging/` with `appinfo.json` and icons.
- `package.mjs` — `staging/` → `dist/*.ipk`, via a local `ares-package` or the
  `vitalets/tizen-webos-sdk` Docker image, which carries both TV SDKs.
- `icon.png` (80×80), `icon-large.png` (130×130) — the sizes webOS asks for,
  generated from `apps/web/public/icon-512.png`.
- `staging/`, `dist/` — build output, not checked in.

## Environment variables

| Variable                  | Default                      |
|---------------------------|------------------------------|
| `STREAMIX_API_ORIGIN`     | empty (falls back to `PUBLIC_SITE_ORIGIN` in `.env`) |
| `STREAMIX_WEBOS_IMAGE`    | `vitalets/tizen-webos-sdk:latest` |
