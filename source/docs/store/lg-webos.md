# LG Smart TV (webOS)

Distribution is through the **LG Seller Lounge** and the LG Content Store. Unlike Samsung,
LG does not bind the package to specific TVs: `ares-package` produces an unsigned `.ipk`.

Official self-checklist (opened and checked 2026-10-01):
https://webostv.developer.lge.com/distribute/app-self-checklist

## 1. Build

```sh
pnpm webos     # -> apps/webos/dist/com.easyred.streamix_<version>_all.ipk
```

Needs Docker (the SDK image) or `ares-package` on `PATH`. Use
`STREAMIX_API_ORIGIN=https://<site> pnpm webos` for the production build. Testing on a TV:
install **Developer Mode** from LG's store, sign in with an LG developer account, turn it
on, then from a PC `ares-setup-device`, `ares-novacom --getkey`, `ares-install` (steps in
`apps/webos/README.md`). The developer-mode session expires after some hours.

## 2. Account and submission

1. Create an **LG Seller Lounge** account (business details, verification).
2. Upload the `.ipk`, store artwork, title, description and the **completed App Self
   Checklist** (download it from the page above and fill it in). **If you do not upload the
   checklist, or the information is insufficient, the app may be rejected without QA.** Mark an
   item N/A only if it truly is; wrong answers cause rejection.
3. LG reviews; expect one or more resubmission rounds.

## 3. Checklist items that matter for Streamix

Content self-check (LG looks for sexually offensive, violent, discriminatory, crime/drug and
gambling content). The app contains none of its own and states it plays only the user's
sources. The permanent adult filter is relevant here: describe it in the notes, and review with the Creative Commons demo only.

UX (mandatory):
- [ ] Every selectable element is operable with the 4-way keys, OK and Back.
- [ ] Every element is operable with the Magic Remote pointer and OK.
- [ ] Back on the app's first screen goes to the TV Home screen (webOS 23 to 25).
- [ ] **Every object always shows a selection effect** (no exceptions).

UX (recommended): 1920x1080 resolution; buttons at least 75x75 px at 1080p; text at least 20
px at 1080p; visible state for selectable items; a visual cue while content loads; Magic
Remote wheel scrolls in the expected direction; LG virtual keyboard works for input fields;
playback controls operate with keys and pointer, and the Play button also pauses.

**Privacy and credentials.** LG asks that privacy and credential information is stored in safe
storage or encrypted, and not hard-coded. Their scanner flags variable names containing
`passwd`, `pwd`, `password`, `credential` or `token`, PEM private keys, and file names
containing those words. Streamix handles user passwords (Xtream logins), so:
- [ ] Nothing is hard-coded: no provider, server, user or password in the bundle (the
  repository test `scripts/no-credentials.test.mjs` and `no-builtin-hosts.test.mjs` guard
  this).
- [ ] Stored source credentials are encrypted at rest where the platform allows.
- [ ] Be ready to answer the scanner's findings for password fields in the Add a source form:
  they are user input, not stored secrets, and are kept only on the device.
- [ ] Answer the checklist's questions in the file honestly; do not mark them N/A.

## 4. Notes for the reviewer

```
Streamix is a player. It contains no channels, films or playlists. To test it: Add a source > Playlist link (M3U/M3U8), and enter <site>/demo/playlist.m3u (Creative Commons films hosted by us). No account is needed. Contact: <publisher email>.
```

## 5. Before submitting

- [ ] Run on a real LG TV (or the webOS simulator) with the remote and the Magic Remote.
- [ ] Back button works (key 461, `disableBackHistoryAPI` is set in `appinfo.json`).
- [ ] Playback tested with the demo source and with a plain-http source.
- [ ] `appinfo.json` id is `com.easyred.streamix`, version matches `version.json`.
