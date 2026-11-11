# Samsung Smart TV (Tizen)

Distribution is through the **Samsung TV Seller Office**. Samsung re-signs the package; the
`.wgt` this repo builds installs only on TVs registered in your own test certificate until
then. Background and the certificate walk-through: `apps/tizen/README.md` and
`apps/tizen/SUBMISSION.md`.

Official checklist (opened and checked 2026-10-01):
https://developer.samsung.com/tv-seller-office/checklists-for-distribution/launch-checklist.html

## 1. Build

```sh
pnpm tizen            # -> apps/tizen/dist/Streamix.wgt
```

Needs Docker (Tizen/webOS SDK image) or the Tizen CLI. With no real certificate the build is
signed with a sample certificate that only works in the TV emulator. For a real TV,
create a certificate for that TV's Device Unique ID (Tizen Studio > Certificate Manager,
Samsung account), then:

```sh
STREAMIX_TIZEN_PROFILES_DIR=/path/to/profile pnpm tizen
```

Build with the production server address so the package talks to your HTTPS server:
`STREAMIX_API_ORIGIN=https://<site> pnpm tizen`.

## 2. Account

1. Create a TV Seller Office account (free).
2. A new account is a **public seller**, which can publish in the United States only.
   Reaching other countries needs an approval to become a **partner seller**. Apply early;
   it decides where your users can get the app.
3. Seller Office asks for business details and may ask for verification.

## 3. Launch checklist (from Samsung's page)

Packaging and manifest:
- [ ] The package contains `config.xml`, `author-signature.xml` and `signature1.xml`.
- [ ] **Package ID**: unique, alphanumeric, no special characters (ours: `StreamixTV`). A
  package ID already registered by anyone else is refused.
- [ ] **Version** is in `[0-255].[0-255].[0-65535]` form. Each upload must be higher than the
  one before. `version.json` produces `1.63.0`-style numbers that fit; keep the third number
  under 65536.
- [ ] `required_version` is `x.y` (ours targets 5.5 and later).
- [ ] The widget **name matches the app title** you enter for the default language in Seller
  Office.
- [ ] Screen size is declared in the manifest.
- [ ] **Only public-level privileges** are declared. A partner- or platform-level privilege
  is blocked at Seller Office's pre-test. Declare only what the app uses (the app asks for
  `internet`); do not declare `adinfo` (no ads) or `sso.partner` / `productinfo` / `billing`
  (no purchases); never `smartcontroller.microphone`.
- [ ] Every update is signed with the **same author certificate** as the first release.
  Back up the author certificate and password.

Things you prepare for Seller Office:
- [ ] **Application UI description** file, following Samsung's UI description guide.
- [ ] **Logo** (with transparency) and **background** images: ready in `apps/tizen/store/`
  (`logo-1920x1080.png`, `background-1920x1080.jpg`), plus `icon-512x423.png`.
- [ ] **Four screenshots**, JPEG, under 500 kB each, 1280x720 or 1920x1080. Rules:
  [screenshots.md](screenshots.md).
- [ ] **Title and description** in each language you list (use the Google Play full
  description, section 1 of [google-play.md](google-play.md), including the "contains no
  channels" paragraph).
- [ ] **Privacy policy URL** (`<site>/privacy`): Samsung asks for it where the app collects
  personal information; give it anyway because the app talks to your server.
- [ ] **Contact email** for customer enquiries (`<publisher email>`).
- [ ] **Test account credentials**: the checklist asks for credentials that let Samsung fully
  test the app. Streamix has no accounts; give them the demo playlist address
  `<site>/demo/playlist.m3u` and the steps (Add a source > Playlist link (M3U/M3U8) > paste it).
- [ ] Age rating questionnaire in Seller Office: answer honestly. The app contains no content
  of its own but can play any source the user adds, and says so. Adult categories and titles are
  always filtered out; the filter reduces adult items but cannot guarantee none, so answer
  for that, and demo only the Creative Commons playlist.

## 4. Things Samsung's testers will check on a real TV

- Playback on the model years you select. Playback here is browser-level (`<video>`, hls.js,
  mpegts.js); `webapis.avplay` is not implemented, so test real sets before submitting. If
  streams fail on real hardware, AVPlay integration is the next job.
- Every screen reachable with the remote only; Back from the first screen exits.
- No crash on network loss, wrong password, or an empty source.
- The app works with the demo source.

## 5. Declare honestly

Describe the app as a player with no content. Do not call it "free TV" or name channels.
Keep to the same listing text as the other stores.
