# Getting Streamix onto Samsung TVs — what is done, what is yours

Everything on this page was verified on 2026-09-20 against Samsung's own
documentation and against the package this repo builds. It is written for
whoever does the Samsung account work, not for whoever wrote the code.

## The one thing to understand first

There are two completely separate goals, and the first does **not** lead to the
second on its own:

| Goal | What it needs |
|---|---|
| Install on **your own** TV, to test | A certificate carrying **that television's device id** |
| Install on **anyone's** TV, like a normal app | **Samsung TV Seller Office** — Samsung re-signs it |

A certificate is a testing tool. It does not distribute anything: the package is
authorised for the exact sets whose device id was baked in, and for no others.

**Both are free.** Samsung charges nothing to register and nothing to submit.

---

## Done, in this repo

- **The package.** `pnpm tizen` → `apps/tizen/dist/Streamix.wgt`, a real signed
  widget (about 4 MB). Rebuilt from the repository; it is handed to Samsung through
  Seller Office, not published anywhere else.
- **Package ID** `StreamixTV`, app id `StreamixTV.Streamix` — ten characters,
  alphanumeric, which is the form Samsung requires. Samsung generates its own
  Seller Office application id separately, so nothing here has to change at
  submission.
- **Its `<access>` element names an HTTPS origin** (or, with none configured, a
  wildcard), never a bare IP over plain http. The origin is set at build time with
  `STREAMIX_API_ORIGIN` and is not stored in the repository. The built package
  contains no IP addresses.
- **Version and ids come from the repository.** The widget version is
  `version.json` (three numbers); the package and application ids are derived from
  the brand name (`apps/tizen/manifest.mjs`).
- **It runs.** The staged package boots at 1920×1080 with the hash router and
  relative asset paths, and `scripts/bundle-floor.mjs` (run by the build) confirms the code
  stays at or below Chrome 68 — Tizen 5.5 (2020 sets) is Chromium 69, so the oldest
  televisions worth supporting can run it.
- **The remote's Back button** is handled (`remoteKeys.ts`, keyCode 10009).
- **Store artwork**, in `apps/tizen/store/`, every file inside Samsung's limits:

  | File | Samsung asks for | Ours |
  |---|---|---|
  | `logo-1920x1080.png` | 1920×1080, 32-bit PNG (RGBA), ≤300 kB | 90 kB |
  | `background-1920x1080.jpg` | 1920×1080, 24-bit PNG or JPG, ≤300 kB | 56 kB |
  | `icon-512x423.png` | 512×423 PNG, ≤300 kB | 76 kB |
  | `screenshot-1..4*.jpg` | exactly 4, 1920×1080 JPG, ≤500 kB each | 119–444 kB |

  **Which of these must be retaken.** `logo-1920x1080.png` and `icon-512x423.png`
  are the Streamix mark and stay. `background-1920x1080.jpg` is a generic dusk
  landscape with no brand content; its origin is not recorded in the repository, so
  confirm you hold the rights to it or replace it. The four
  `screenshot-1..4*.jpg` files that the old pipeline wrote here are **not part of
  this repository** (they showed another product's catalogue and poster artwork,
  which is not ours to ship) and must be retaken from the current app against the
  demo source before submission — see the store kit for the demo source.

---

## Yours — the certificate (a PC and a television)

This cannot be done on the server. Samsung's Certificate Manager is a desktop
program, it signs you in with a Samsung account, and it needs the television.

1. Install **Tizen Studio** and the **Samsung Certificate Extension** on a
   Windows or Mac machine.
2. On the TV: **Settings → Support → About This TV**, and note the **Device Unique
   ID (DUID)**.
3. In Tizen Studio: **Tools → Certificate Manager → +**, choose **Samsung**,
   sign in with a Samsung account, and add the DUID.
4. On the TV: open the **Apps** screen and press **1 2 3 4 5**. Turn Developer
   Mode on and enter the **IP address of that PC**. The TV restarts.
5. Copy the resulting profile directory here and run:

   ```bash
   STREAMIX_TIZEN_PROFILES_DIR=/path/to/profile pnpm tizen
   ```

   The packager mounts your certificate in place of the sample one. That is the
   only change needed — the mechanism is already written.
6. Push it from Tizen Studio's **Device Manager**, or `tizen install`.

There is no step where the TV opens a `.wgt` from a USB stick or a web address.

---

## Yours — the store

1. Create a **TV Seller Office** account. Free.
2. **Important:** a new account is a **public seller**, and a public seller can
   publish **only in the United States**. Reaching the Netherlands or anywhere
   else needs an approval to become a **partner seller** — also free, but it is
   a gate, and it is the one that decides whether your customers can get the app.
   Start it early.
3. Upload the `.wgt`, the artwork above, and a description.
4. Samsung reviews, and can reject and ask for changes.

---

## What a reviewer sees

The app ships **no sources of any kind**: no server addresses, playlists or
channel lists. On first run the viewer adds their own (an Xtream server, an M3U
link, a single stream link or a Stalker portal), the same bring-your-own shape as
every other player in the Samsung store. Say so in the submission notes, and give
the reviewer the demo playlist from the store kit so they can see playback without
needing an account. There is no self-update and no download page; updates come
only through the store.

## Still unknown

**Whether video actually plays on a Samsung television.** The app uses the
browser video path; Samsung's guidance points at `webapis.avplay` for serious
playback and **that is not implemented**. Nothing on this box can answer it —
it needs one real set. Everything above is worth doing only if the answer is
yes, which is why step one is a television, not paperwork.
