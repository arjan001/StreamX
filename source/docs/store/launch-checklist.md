# Launch checklist

Everything the publisher must do before the first submission, in order. Details live in the
per-store files in this folder; the server side is in `docs/SERVER.md`.

## A. Who you are

- [ ] Decide the publisher: an individual or an organisation. Stores show this name, and
  Play's rules differ (see [google-play.md](google-play.md) section 5: new personal accounts
  need a 12-tester, 14-day closed test; organisations need a D-U-N-S number, which can take
  weeks).
- [ ] Fill in the **publisher block in `brand.config.json`** (name, postal address, contact
  email, the captions provider's name and privacy URL, the effective date, the site address).
  The Terms, Privacy and Copyright pages and the in-app text are rendered from it. A
  placeholder left behind (`{{...}}`) is a defect.
- [ ] Set the public site address in the same file and in `apps/server/.env`.
- [ ] Create the contact mailbox and put a person on it (see
  [takedown-process.md](takedown-process.md)).
- [ ] **Have a lawyer review the Terms, Privacy Policy and Copyright text** for your country,
  and the answers in the store files that rest on them. They are drafts, not advice.

## B. The server

- [ ] Deploy `apps/server` (Node and Postgres, pm2 or Docker) behind **HTTPS with a valid
  certificate** on your own domain. Follow `docs/SERVER.md`.
- [ ] `ADMIN_PASSWORD` set to a long random value (or unset to disable the admin entirely).
- [ ] **`SONIOX_API_KEY` set** if live captions are offered. Without it the feature must be
  hidden or disabled; check the app. Use the key for the region your account is in.
- [ ] Error reports: leave them off by default. If you turn them on, update the Privacy text
  and the store answers first.
- [ ] **Enable the demo playlist** and host the Creative Commons film files; confirm
  `<site>/demo/playlist.m3u` opens and every film plays. Keep it up for as long as the app is
  in review.
- [ ] Check the legal pages (`/terms`, `/privacy`, `/copyright`) load and show your details.
- [ ] Back up the database and test a restore.

## C. Build and sign

- [ ] `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and the server tests
  pass on a clean checkout.
- [ ] `pnpm brand` applied; `pnpm version:check` clean; version in `version.json` is the one
  you want in the stores.
- [ ] Release builds pointed at your server: `STREAMIX_API_ORIGIN=https://<site>`.
- [ ] **Android**: create a new upload key (never reuse an old app's key), back it up, set up
  `keystore.properties`, build `pnpm --filter @iptv/mobile bundle`, enrol in Play App
  Signing.
- [ ] **iOS**: Apple Developer account, App ID `com.easyred.streamix`, signing certificates
  and provisioning profiles in a cloud Mac pipeline (Codemagic or GitHub Actions macOS) or a
  local Mac; build and upload to TestFlight.
- [ ] **Tizen**: Samsung certificate (for testing) and Seller Office account; `pnpm tizen`.
- [ ] **webOS**: LG developer account and Seller Lounge account; `pnpm webos`.

## D. Test on real devices

- [ ] A real phone and a tablet (Android) and an iPhone and iPad (iOS).
- [ ] An Android TV or Google TV box with a remote only (no touch), including Back behaviour.
- [ ] A Samsung TV and an LG TV if you are submitting there. Playback on these is the
  biggest risk (see [samsung-tizen.md](samsung-tizen.md)).
- [ ] Walk every source type: the demo playlist, an Xtream-style server (use
  `scripts/fake-panel.mjs` for a neutral fixture), a single stream link, and a Stalker/MAC
  portal (`scripts/fake-stalker.mjs`; Android and iOS only).
- [ ] First run: the rights confirmation appears, links to Terms and Privacy work, the empty
  state shows no content.
- [ ] Settings > About & legal opens all texts and the open-source licences screen (the app
  routes are `/legal/*`; the website serves `/terms`, `/privacy`, `/copyright`, `/licenses`);
  the version shown is right.
- [ ] Live captions (Android only; the control is hidden on iOS): first-time explanation,
  Android consent, notification, captions appear, captions off stops the service.
- [ ] Adult filter: add a source containing a category named `18|` or `XXX Movies`
  (`node scripts/fake-panel.mjs --adult`) and confirm it never appears in any list or search.
- [ ] Age ratings answered for user-supplied sources (the filter reduces adult items; it cannot guarantee none).
- [ ] The website's /download page lists the right files (`node scripts/collect-downloads.mjs`).
- [ ] No leftover provider names, addresses or IPs anywhere in the app, the site or the
  listing (the repo tests `no-builtin-hosts` and `no-credentials` help; also grep the built
  bundle).

## E. Artwork and text

- [ ] Icons (all sizes), the Android TV 320x180 banner, the Play feature graphic and the
  Samsung logo/background/icon are final and contain no one else's marks.
- [ ] Screenshots taken per [screenshots.md](screenshots.md).
- [ ] Listing text per store file, checked against the "never say" list in
  [takedown-process.md](takedown-process.md) section 7.
- [ ] Open-source licences and `THIRD_PARTY_NOTICES` included, including libVLC (LGPL-2.1+)
  and the FFmpeg-based remux library (libav.js, built LGPL-only; the configure line is in apps/web/libav/dist/ffmpeg-configuration.txt). Rebuild it only with apps/web/libav/build.sh, which keeps it LGPL.

## F. Submit

1. Google Play: internal test, then the 12-tester closed test if you have a personal
   account, then production. Complete App content, Data safety, foreground service and
   `RECORD_AUDIO` declarations ([google-play.md](google-play.md)).
2. Apple: TestFlight, then App Review with the notes in [app-store.md](app-store.md).
3. Samsung and LG after the phones work: they take longer and need real TVs.
4. After each approval, keep the demo server up and watch the mailbox for a week.

## G. After launch

- [ ] Re-test the demo playlist weekly.
- [ ] Every release: bump the version (`pnpm version:bump`), re-check the Data safety and
  privacy answers if anything about data changed, and never add a self-updater.
- [ ] Review store policy changes quarterly (Play target API level rises every year).
