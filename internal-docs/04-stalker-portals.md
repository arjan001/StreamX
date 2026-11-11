# Stalker / Ministra ("MAG") portals

A source type for users whose provider gives a portal address and registers a MAC address
instead of a username and password. The client is `packages/core-stalker`; it produces the
same row shapes as `core-xtream`, so the on-device store treats a portal like an Xtream
line. Its own README has the full protocol notes; this page is the short version.

## What the user enters

- the portal address (any of `http://host`, `/c/`, `/stalker_portal/c/`, `/portal.php`,
  `/stalker_portal/server/load.php` — the client works out the real endpoint);
- the MAC address registered with the provider;
- optionally a serial number, device ids, a signature and a login/password.

## Flow

1. Handshake, which returns a token (sent afterwards as `Authorization: Bearer`).
2. Profile (and `do_auth` when a login is configured).
3. Live, movie and series categories and listings. A module the portal lacks gives empty
   results, not an error; many portals carry live TV only.
4. Playback links are created on demand and are short-lived. The app asks for a link
   immediately before playing and never stores one.
5. Short EPG per channel. Catch-up link creation exists but is unverified against a real
   portal.

## Why it is native-only for requests

Portals identify the box by a `Cookie: mac=...` header and a set-top-box `User-Agent`.
Browsers forbid setting both, so a plain `fetch` on the web is answered "Authorization
failed". On Android and iOS the app routes these requests through the native HTTP layer
(`CapacitorHttp.request`, called directly; global fetch patching stays off). The website,
Tizen and webOS builds are web builds with the same restriction, so the source type is not
offered there at all (`stalkerSupported()` in `lib/platform.ts`). On iOS the native layer
is `URLSession`, so plain-http portals need `NSAllowsArbitraryLoads` (see
`apps/mobile/README.md`).

## In the app

- Add source > Stalker portal: portal address, MAC address, and an Advanced section
  (serial number, device id, login). The MAC, serial, device ids, signature, login
  password and the stored session are sealed at rest with the other secrets.
- The catalogue (live, films, series) is built on the device into the same store the
  Xtream path uses; adult genres and `censored` rows are dropped. Each row's `cmd` is kept
  in a side map (`lib/playSide.ts`), never a playable link.
- Playback asks the portal for a link immediately before every play and once more, through
  the player, if the first link will not open (`lib/stalkerPlay.ts`, `lib/freshLink.ts`).
- The guide is `get_short_epg` per channel. Catch-up (`tv_archive`) is attempted only for a
  channel that reports an archive and its `cmd` shape is unverified.

## Testing without a real portal

`scripts/fake-stalker.mjs` starts a synthetic portal on an ephemeral port
(`startFakePortal({ port: 0 })`). It uses `portal.example.com` and the MAC
`00:1A:79:00:00:01`; it contains no real hosts or devices.
