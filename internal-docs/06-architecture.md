# Architecture

**The app is the product and it is self-contained.** It connects to the user's own source,
downloads the catalogue to the device, builds its own stream URLs, keeps its own guide and
holds its own credentials. The publisher's server keeps a few small things and nothing else.

Streamix is a neutral player. It ships no channels, playlists, servers or accounts.

## 1. Sources

Several sources can be saved; one is active at a time. Each is one of:

| Source | The user enters | Package |
|---|---|---|
| Xtream server | address, username, password | `packages/core-xtream` |
| M3U / M3U8 playlist | a link, plus an optional XMLTV guide link (`.xml` or `.xml.gz`) | `packages/core-m3u` |
| Single stream | one stream link | player only |
| Stalker / MAC portal (Android and iOS only) | portal address, MAC, optional serial/login | `packages/core-stalker` |

On first run the user confirms they have the right to use the sources they add and accepts
the Terms (the wording is part of the legal texts, shown by the sources screen). Until a
source is added the app shows an empty state, never a catalogue.

Credentials are stored on the device only, encrypted at rest where the platform allows.
Android sets `allowBackup=false` so they do not leave through a cloud backup.

## 2. The catalogue lives on the device

The app downloads the listing once and keeps it locally in `packages/core-store`, a columnar
store (parallel typed arrays, one text blob and an offset table, not a record per item).
Measured on a 124,000-item catalogue: about 55 ms to build the indexes, 2 ms to search,
roughly 12 MB stored.

What this buys:

- The publisher's server never sees a library and never holds a provider password.
- Browsing and searching need no network round trip, which is what makes an old TV box
  usable.
- The app keeps working when the publisher's server does not.

Because the providers differ, the app is tolerant of what they send: integers as strings,
`[]` for `{}`, missing guide ids, bad time zones. See `02-xtream-api.md` and `03-catchup-epg.md`.

## 3. The permanent filter

There is no adult section and no setting to show adult items. The store removes them from
every list, row, search result and guide at read time:

- categories the provider files as adult, or whose name reads as adult;
- items flagged adult by the provider, tagged in their title, or in an adult category;
- M3U entries whose `group-title` reads as adult.

The check is applied inside `packages/core-store` itself (`src/adult.ts`), so no screen can
forget it. This is a keyword filter, so it reduces adult material; it cannot guarantee none.
The store listings and the age-rating answers account for that.

## 4. What the publisher's server does

`apps/server`. Details are in `docs/SERVER.md`.

| Area | Purpose |
|---|---|
| Website and legal pages | the built web app, `/terms`, `/privacy`, `/copyright`, `/licenses`; the app shows the same texts under `/legal/*` |
| Remote config | a notice banner and a minimum version that sends old apps to the store. Fetched by the app, never pushed |
| Error reports | optional, off by default, redacted, IP shortened, deleted after 7 days |
| Live captions | mints a short-lived speech-recognition key so the account key never ships in the app (Android and web; hidden on iOS) |
| Admin | a small operator screen over the above |
| Demo playlist | `/demo/playlist.m3u`, an M3U of Creative Commons films for store reviewers; served only when `DEMO_ENABLED=1` |

It deliberately does not: know who is watching, hold a catalogue, relay or proxy a provider's
streams or artwork, host downloads, or update the app. Updates come from the stores only.
Every call degrades to off: a device that cannot reach the server is a working player with
fewer menu entries.

Request logs keep an address only as its network, never the full IP.

## 5. Playback rules

- Exactly one stream socket per playing surface. Providers limit simultaneous connections
  and exceeding the limit looks identical to bad credentials, so tear down the previous
  stream before opening the next and never pre-buffer neighbours.
- Surface "connection limit reached" as its own state, not a login error.
- Serialise catalogue requests and back off on errors. Providers rate-limit by IP.
- Resolve series details lazily; never fan out one request per series.

Engines and platform differences: `05-platform-engines.md`.

## 6. Live captions

Captions are hidden on iOS, because WebKit cannot hand the playing audio to the speech service. When the user turns captions on: the server issues a temporary key, the app sends the sound
of what is playing straight to the speech-recognition provider, and subtitles come back.
On Android the sound comes from the app's own audio (audio playback capture restricted to
the app's own process, via a foreground service of type `mediaProjection`), not from the
microphone. Nothing is recorded or stored by the publisher. The first time, the app explains
this and asks.

## 7. Layout of the code

```
apps/web/           React + TypeScript: every screen, the player, remote handling
apps/mobile/        Capacitor shell for Android (and iOS): libVLC, logo store, captions
apps/tizen/         Samsung package
apps/webos/         LG package
apps/server/        the publisher's server (Node, Postgres)
packages/core-xtream  Xtream client, URL builder, catch-up
packages/core-m3u     M3U/M3U8 parsing
packages/core-stalker Stalker portal client
packages/core-store   on-device catalogue, search, guide, the adult filter
```
