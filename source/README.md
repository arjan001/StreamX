# Streamix

Streamix is a media player for live TV, movies and series from sources the user adds
themselves. One React front end is packaged for the web, Android (phone, tablet and Android
TV), iOS, Samsung Tizen and LG webOS.

**Streamix contains no content.** There are no channels, playlists, servers or accounts built
in, and nothing is hosted or sold by the app. The user adds a source from a provider they
already use and the app plays what that source gives them:

- an Xtream-style server (address, username, password)
- an M3U / M3U8 playlist link, with an optional XMLTV guide link
- a single stream link
- a Stalker / MAC portal (Android and iOS only)

Several sources can be saved. The app ships no content of its own. Adult categories and titles
are removed from every list, search and guide by a permanent filter; there is no setting to show
them. The app is free, with no
ads, no in-app purchases, no analytics and no accounts. App ID / bundle ID:
`com.easyred.streamix`.

## Repository layout

```
apps/web         the application: every screen, the player, remote handling (React, Vite)
apps/mobile      Capacitor shell: Android (libVLC player, captions, logo store) and iOS
apps/tizen       Samsung TV package (.wgt)
apps/webos       LG TV package (.ipk)
apps/server      the publisher's server: website, legal pages, remote config,
                 error reports, captions keys, admin, demo playlist (Node, Postgres)
packages/
  core-xtream    Xtream-style API client, URL builder, catch-up
  core-m3u       M3U / M3U8 parser
  core-stalker   Stalker / MAC portal client
  core-store     the on-device catalogue: indexes, search, guide
brand/           logo
brand.config.json  name, colours, IDs and the publisher block (see below)
scripts/         build helpers, fake panel / fake portal fixtures, repository checks
docs/            technical notes and the store kit
```

## Getting started

Node 22 or newer and `pnpm`.

```sh
pnpm install --frozen-lockfile
pnpm web          # dev server for the app, http://localhost:5173
pnpm typecheck
pnpm test         # no browser, database or network needed
pnpm build        # the website bundle, into apps/web/dist
```

Build-time settings are environment variables on the command line, not a `.env` file:

| Variable | What it does |
|---|---|
| `STREAMIX_API_ORIGIN` | the publisher server a packaged build talks to, e.g. `https://example.com` |
| `STREAMIX_IMAGE_ORIGIN` | where artwork is loaded from; defaults to the API origin |
| `VITE_API_BASE` | dev-server proxy target |

Reviewers can use the demo playlist at `/demo/playlist.m3u`, which the server serves only
when `DEMO_ENABLED=1`. Neutral test sources, with no real providers: `node scripts/fake-panel.mjs` (an Xtream-style
panel) and `node scripts/fake-stalker.mjs` (a Stalker portal).

## Building each target

| Target | Command | Output |
|---|---|---|
| Website | `pnpm build` | `apps/web/dist` |
| Android release bundle (Google Play) | `pnpm --filter @iptv/mobile bundle` | `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab` |
| Android debug APK (testing) | `pnpm --filter @iptv/mobile apk` | `apps/mobile/android/app/build/outputs/apk/debug/` |
| Both Android outputs | `pnpm --filter @iptv/mobile build:android` | as above |
| Samsung Tizen | `pnpm tizen` | `apps/tizen/dist/Streamix.wgt` |
| LG webOS | `pnpm webos` | `apps/webos/dist/*.ipk` |
| Server | `pnpm --filter @iptv/server start` | see `docs/SERVER.md` |
| iOS | on a Mac (local or cloud): `cap sync ios`, then build in Xcode | see `apps/mobile/README.md` and `docs/store/app-store.md` |

Android needs a JDK and the Android SDK (environment in `apps/mobile/scripts/android-env.sh`).
Release bundles are signed only if a `keystore.properties` exists; no keys are in the
repository. The Tizen and webOS packages need Docker or the vendors' command-line tools.
iOS needs a Mac and a paid Apple Developer account; it cannot be built on Linux. Set
`STREAMIX_API_ORIGIN` for every packaged build so it points at your own server.

`pnpm brand` writes the name, colours and IDs from `brand.config.json` into the Android,
Tizen and webOS projects. Run it after editing that file.

## Versioning

`version.json` is the single source of truth. `pnpm version:bump minor` raises it,
`pnpm version:apply` writes it to the projects and `pnpm version:check` fails if anything has
drifted. Every store upload needs a higher number than the last one.

## Legal texts and publisher settings

- **Publisher block**: in `brand.config.json`. It holds the publisher's name, address and
  contact email, website, governing law and the two effective dates (`publisher.name`,
  `email`, `address`, `website`, `governingLaw`, `termsEffectiveDate`,
  `privacyEffectiveDate`), and fills the placeholders in the Terms, Privacy and Copyright
  pages and the in-app wording. The captions provider and its policy link are
  `captions.provider` and `captions.privacyUrl`; the store links are `android.playStoreUrl`
  and `ios.appStoreUrl`. Fill it in before anything else.
- **Where users see the texts**: in the app under Settings > About & legal (routes
  `/legal/*`), and on the website served by `apps/server` at `/terms`, `/privacy`,
  `/copyright` and `/licenses`. The first-run screen asks users to confirm they have the
  right to use the sources they add.
- **Review**: the texts are drafts. Have a lawyer review them for your country before launch.
- **Copyright contact**: the contact address from the publisher block, also used in the store
  listings. How to handle a complaint: `docs/store/takedown-process.md`.

## Documentation

Start at [docs/README.md](docs/README.md).

| For | Read |
|---|---|
| Submitting to the stores | [docs/store/launch-checklist.md](docs/store/launch-checklist.md), then the per-store files in `docs/store/` |
| Running the server | [docs/SERVER.md](docs/SERVER.md) and `apps/server/README.md` |
| How the app works | [docs/06-architecture.md](docs/06-architecture.md) |
| Formats and providers' behaviour | [docs/01-playlist-formats.md](docs/01-playlist-formats.md), [docs/02-xtream-api.md](docs/02-xtream-api.md), [docs/03-catchup-epg.md](docs/03-catchup-epg.md), [docs/04-stalker-portals.md](docs/04-stalker-portals.md) |
| Playback engines and TVs | [docs/05-platform-engines.md](docs/05-platform-engines.md) |
| Samsung and LG specifics | `apps/tizen/README.md`, `apps/tizen/SUBMISSION.md`, `apps/webos/README.md` |

## Conventions

- Comments say why, not what.
- No credentials, provider hosts or real addresses in the tree, in tests or in fixtures. Use
  `panel.example.com`, `portal.example.com`, `stream.example.com`.
- Measure before trusting a comment about an external system; providers change behaviour.
