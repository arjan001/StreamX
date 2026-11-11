# Playback engines, remote input and platforms

Streamix is one React front end packaged for the web, Android (phone, tablet, Android TV),
iOS, Samsung Tizen and LG webOS. This page explains why playback is not one engine, how the
TV remote is handled, and what each platform adds.

## 1. The split that determines everything

Platforms differ by who owns the decoder.

| Family | Platforms | Decoder situation |
|---|---|---|
| **A: the platform owns it** | Web, Samsung Tizen, LG webOS, iOS | You cannot ship a decoder. Feed the platform something it already accepts. |
| **B: the app owns it** | Android, Android TV | Bundle a player (libVLC) and play almost anything. |

Most playback trouble comes from family A: HEVC, AC-3/E-AC-3/DTS audio, raw MPEG-TS and
servers that send no CORS headers.

## 2. Engines in the app

The player chooses an engine per stream (`apps/web/src/lib/playerCore.ts`,
`codecs.ts`). Library versions are the ones in `apps/web/package.json`.

| Engine | Where | Used for |
|---|---|---|
| `<video>` | everywhere | progressive files a browser can open itself |
| hls.js (Apache-2.0) | web, Tizen, webOS, Android WebView | HLS everywhere except Safari, which plays HLS natively |
| mpegts.js (Apache-2.0) | web, Tizen, webOS | MPEG-TS live streams over Media Source Extensions |
| libav.js remux (FFmpeg 9.0, LGPL-2.1 build; recipe in `apps/web/libav/`) | web | turning an `.mkv` the browser cannot open into something it can, on the device |
| libVLC 3.6.5 (LGPL-2.1+) | Android | everything else, including AC-3, E-AC-3, DTS and HEVC on TV boxes |
| WKWebView native HLS | iOS | live requested as `.m3u8`; MKV and AVI cannot be opened on iPhone or iPad |

Consequences worth knowing before changing anything:

- **A browser cannot switch soundtrack or see embedded subtitles** in an `.mkv`: Chromium
  has no `audioTracks` API. The remux path (`filmTracks.ts`, `filmSubs.ts`) exists for this.
- **`MediaSource.isTypeSupported()` can say yes for codecs a TV cannot decode.** Do not
  trust it alone.
- **AC-3 / E-AC-3 are effectively unavailable in Chrome**, and MPEG audio Layer II is not a
  browser codec. Android uses libVLC for these.
- On Android the video is drawn by libVLC on a native surface behind a transparent WebView.
  CSS overlays, rounded corners over the video and cross-fades do not apply to it.

## 3. Platform notes

### Android and Android TV
Capacitor shell, minSdk 23, target/compileSdk 36, 64-bit and 16 KB page-size compliant native
libraries, shipped as an Android App Bundle. Android TV needs the leanback launcher category,
a 320x180 banner, and `touchscreen` / `leanback` marked not required, all of which the
manifest already declares. Back must always be able to reach the launcher on TV.

### iOS
The Capacitor project, built on a Mac (cloud or local). Native plugins in this repo are
Android-only, so iOS has stubs. `AVPlayer` plays HLS but rejects raw MPEG-TS, which is why
live is requested as `.m3u8`. MP4, M4V and MOV play; MKV and AVI files cannot be opened on iPhone or iPad and the player says so. Live captions are hidden there. Cleartext HTTP needs an
App Transport Security exception because users' servers are often plain http.

### Samsung Tizen
A web app packaged as a signed `.wgt`. Chromium by Tizen version: 5.0 is M63, 5.5 is M69,
6.0 is M76, 7.0 is M94. The build targets Chrome 68 as its floor.
Playback is browser-level (`<video>` + hls.js/mpegts.js); `webapis.avplay` is not
implemented. Submission details: `docs/store/samsung-tizen.md`, `apps/tizen/SUBMISSION.md`.

### LG webOS
A web app packaged as an `.ipk`; webOS 5 is Chromium 68. Playback is browser-level as on
Tizen. Submission details: `docs/store/lg-webos.md`.

## 4. Remote input

One intent table (`apps/web/src/lib/remoteKeys.ts`) maps every platform's keys to the same
intents. Arrows and OK are the same everywhere; Back is not.

| Action | Tizen | webOS | Android TV |
|---|---|---|---|
| Arrows / OK | 37-40 / 13 | 37-40 / 13 | 37-40 / 13 |
| Back | 10009 | 461 | `KEYCODE_BACK` |
| Exit | 10182 | none | none |
| Channel up / down | 427 / 428 | none | `KEYCODE_CHANNEL_UP/DOWN` |
| Play / Pause | 10252 | none | media keys |
| Digits | 48-57 | 48-57 | `KEYCODE_0..9` |

- **Tizen** needs `hwkey-event="enable"` in `config.xml` for Back, and
  `tizen.tvinputdevice.registerKey()` for keys beyond arrows/OK/Back.
- **webOS** branch on `keyCode`, not `key`: several Magic Remote keys report
  `key === "unidentified"`. The Magic Remote is also a pointer, so both a pointer mode and
  a D-pad mode must work, and every object needs a visible selection effect.
- **Android TV**: Back is a breadcrumb only; it must never act as a toggle.
- Never require a keyboard for anything mandatory. The Add a source screens must be usable with a
  remote and the on-screen keyboard.

### 10-foot checklist
Safe area about 5% on every edge; text at least 20 px at 1080p; focus is never lost (after a
list refresh, restore focus to the same item id, not index 0); animate only `transform` and
`opacity`; virtualise long lists; no heavy `box-shadow`, `filter` or blur on scrolling items.
Old TVs have roughly 0.5 to 2 GB of RAM and slow CPUs.

## 5. Bundle floor

Supporting an old TV Chromium means one modern syntax feature from a dependency is a white
screen with no console. `scripts/css-compat.mjs` (run by `pnpm build`) flattens modern CSS for
old engines; after adding a dependency, test the Tizen and webOS bundles on an old emulator or
TV. `scripts/bundle-floor.mjs` (run by the Tizen and webOS builds) fails the build if a
chunk uses syntax or a runtime API newer than Chromium 68 that nothing puts back. The
inline block in `apps/web/index.html` supplies `Array.prototype.flat/flatMap`,
`Object.fromEntries`, `globalThis` and `structuredClone` where an engine lacks them.
