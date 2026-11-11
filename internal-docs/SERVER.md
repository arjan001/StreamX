# The Streamix server

`apps/server` (package `@iptv/server`) is a small Node service. It exists so the
app has somewhere to report problems, a place to read settings from, a key for
live captions, and so the publisher has a website with the legal pages every store
asks for.

## What it does

| Area | Routes | Notes |
|---|---|---|
| Front door | `/` | Sends visitors straight into the web app (`/home`), where they add a source. Without a web build it shows the About page instead. |
| About | `/about` | What the app is, store links (hidden while empty), links to the legal pages and the download page |
| Download page | `/download` (alias `/get`), `/download/<file>` | Store links (when set) and the packages found in `DOWNLOAD_DIR`; see below |
| Legal pages | `/terms`, `/privacy`, `/copyright`, `/licenses` | Server-rendered HTML, no scripts, no external assets. The wording is `legal/*.md`; the same files are bundled in the app |
| Web app | everything else | The built web app (`apps/web/dist`) when it exists |
| Remote config | `GET /api/app-config` | A notice, a minimum version (sends old builds to the store), the error-report switch |
| Error reports | `POST /api/log`, `/api/log/batch` | **Off unless the operator turns them on** (below). Credentials redacted, no IP stored, deleted after 7 days |
| Live captions | `GET /api/captions/health`, `POST /api/captions/session` | Mints a 5-minute Soniox key with the publisher's own account key. Audio never touches this server |
| Demo playlist | `GET /demo/playlist.m3u` | Off unless `DEMO_ENABLED=1` |
| Admin | `/admin`, `/api/admin/*` | Overview, errors, settings. Does not exist without `ADMIN_PASSWORD` |
| Health | `/healthz` (no database), `/api/health` (database too) | |

## What it does not do

It has no channels, playlists, catalogue or guide, and never sees, relays or
proxies a stream or a picture. It never holds a viewer's provider address or
password, has no accounts, no analytics and no ads. Its download page is a website page for people; the apps never
fetch from it, and there is no updater. It does not know who is watching.

What it stores: one table of error reports (only while reports are on) and one row
of remote config. The request log records an address only as its network
(`203.0.113.0/24`), never the full address, and cuts credentials out of URLs.

## Publisher details (the legal pages)

The legal texts name the publisher. Fill in the `publisher` block of the **root**
`brand.config.json`; the server and the web build both read that file.

```json
"publisher": {
  "name": "Your company or your name",
  "email": "legal@example.com",
  "address": "",
  "website": "https://streamix.example.com",
  "governingLaw": "",
  "termsEffectiveDate": "1 October 2026",
  "privacyEffectiveDate": "1 October 2026"
},
"captions": { "provider": "Soniox", "privacyUrl": "https://soniox.com/policies/privacy-policy" },
"android": { "playStoreUrl": "" },
"ios": { "appStoreUrl": "" }
```

`address` and `governingLaw` are optional. An empty `address` leaves its line out of
the contact block; an empty `governingLaw` makes the Terms say they are governed by
the law that applies where the App is used, without limiting the reader's rights
under local law. Any other empty value shows a highlighted **[to be filled in]**
marker instead of the value, so an unfinished page cannot be mistaken for a
finished one.
After editing, run `pnpm brand` (writes the values into the web build) and restart
the server. The store links on the About page appear when `playStoreUrl` /
`appStoreUrl` are set. If you change the wording in `legal/*.md`, rebuild the web
app so the in-app copy matches.

Open-source licences: `node scripts/licenses.mjs` regenerates
`THIRD_PARTY_NOTICES.md` and `legal/licenses.md` from the dependency tree plus the
native components (libVLC, libav.js/FFmpeg). Run it after changing dependencies;
`node scripts/licenses.mjs --check` fails when the files are stale.

## Configuration

Everything comes from the environment, or from `apps/server/.env` (loaded by the
process itself; `ENV_FILE` names another file). `.env.example` is the template.

| Variable | Default | Effect |
|---|---|---|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | | Postgres. Or `DATABASE_URL` instead |
| `PG_POOL_MAX` | 10 | Pool size |
| `PORT` / `HOST` | 7500 / 127.0.0.1 | Where it listens |
| `PUBLIC_SITE_ORIGIN` | | The site's public address; allowed by CORS |
| `CORS_ORIGINS` | | Extra browser origins, comma separated. Always allowed: `capacitor://localhost`, `ionic://localhost`, `http(s)://localhost`, `null` (the `file://` Tizen and webOS packages) |
| `TRUST_PROXY` | `127.0.0.1` | Which proxy may set `X-Forwarded-For`: address, CIDR, `true` or `false`. Rate limits use the client address, so set this to your proxy |
| `LOG_LEVEL` | info | |
| `LOG_OUT_FILE` `LOG_ERR_FILE` | | Files the server caps at 128 MB (pm2 config sets them) |
| `ADMIN_USERNAME` | admin | |
| `ADMIN_PASSWORD` | | Unset: no admin area, and no way to turn error reports on |
| `SONIOX_API_KEY` | | Captions. Unset: captions report unavailable |
| `SONIOX_API_BASE` | `https://api.soniox.com` | EU accounts: `https://api.eu.soniox.com`. Keys are region-scoped |
| `SONIOX_WS_URL` | derived from the base | Override the realtime socket |
| `SONIOX_MODEL` | `stt-rt-v5` | |
| `DEMO_ENABLED` | | `1` serves the demo playlist |
| `DEMO_STREAMS_FILE` | `apps/server/demo/streams.json` | |
| `DOWNLOAD_DIR` | `apps/server/downloads` | Packages offered on `/download` (gitignored; may be empty or missing) |
| `WEB_DIST` `BRAND_CONFIG` `LEGAL_DIR` | `apps/web/dist`, root `brand.config.json`, `legal/` | Only for a deploy apart from the checkout |

`NODE_ENV=production` also stops the CORS allowance for local dev servers.

## Download page

`GET /download` (and `/get`) is a plain server-rendered page, styled like the landing
page, that lists what can be installed:

- **Store links**, when `android.playStoreUrl` / `ios.appStoreUrl` in
  `brand.config.json` are set.
- **Direct files** found in `DOWNLOAD_DIR` (default `apps/server/downloads`): Android
  `.apk` (the ABI is read from the file name: `arm64-v8a`, `armeabi-v7a`, `x86_64`,
  `x86` or `universal`), Samsung `.wgt` and LG `.ipk`. Each shows its size, version
  and SHA-256, with short install instructions per platform (allow installs from
  this source; a downloader app on Android TV; developer mode on Samsung and LG).
  The version is taken from a name such as `streamix-1.63.0-arm64-v8a.apk`, or from
  `{ "version": "1.63.0" }` in `DOWNLOAD_DIR/version.json`.
- With no files, the page says the app will be listed in the stores and shows any
  store links.

Files are served from `/download/<file>` with the right content type,
`Content-Disposition: attachment` and `Range` support. Only plain file names with
an `.apk`, `.wgt` or `.ipk` extension directly inside `DOWNLOAD_DIR` are reachable:
no directory listing, no sub-folders, no symlinks, no path traversal.

`node scripts/collect-downloads.mjs [--dest <dir>] [--debug]` copies freshly built
packages (Android release APKs, or debug ones when no release exists or with
`--debug`; `apps/tizen/dist/*.wgt`; `apps/webos/dist/*.ipk`) into `DOWNLOAD_DIR` as
`streamix-<version>[-<abi>].<ext>`, the version coming from `version.json`. It
deletes nothing; remove old versions by hand.

This is a website page only. The apps contain no update check and no download code;
updates reach users through the stores.

## Postgres

Any Postgres 14 or newer. Create a database and a role, put them in `.env`, then:

```bash
createuser streamix && createdb -O streamix streamix       # once
psql -c "alter role streamix password '...'"                # once
pnpm --filter @iptv/server migrate                          # creates the tables; safe to re-run
```

Without a database the About page, legal pages, demo playlist and captions still
work; error reports, remote config and the admin need it.

## Running it

### pm2

```bash
pnpm install --frozen-lockfile
pnpm build                              # the web app, served at /home etc.
cd apps/server && cp .env.example .env  # fill in
pnpm migrate
pm2 start ecosystem.config.cjs && pm2 save
```

The ecosystem file reads `.env` itself (pm2 does not) and rotates logs to
`apps/server/logs/`. After editing `.env`, `pm2 restart streamix --update-env`.

### Docker

`apps/server/Dockerfile` builds the web app and the server into one image;
`apps/server/docker-compose.yml` adds Postgres.

```bash
cd apps/server
cp .env.example .env        # set PGPASSWORD at least
docker compose up -d --build
docker compose run --rm server node --experimental-strip-types --no-warnings src/db/migrate.ts
```

It publishes `127.0.0.1:7500` only; put a reverse proxy in front.

### TLS

The server speaks plain HTTP. Terminate TLS in a reverse proxy and forward to
`127.0.0.1:7500`, passing `X-Forwarded-For` and `X-Forwarded-Proto`. With
`X-Forwarded-Proto: https` the server adds HSTS. nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name streamix.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://127.0.0.1:7500;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Error reports

Off by default. The app asks `/api/app-config` and only sends reports when
`errorReports` is `true`. To turn them on, set `ADMIN_PASSWORD`, sign in at
`/admin`, open Settings and switch error reports on. The app picks it up within
hours (it re-reads the config on start and every six hours).

What is sent (see the Privacy Policy): short error descriptions, the app version,
device model and system version, and a random number that changes every launch.
Usernames, passwords, tokens, MAC addresses and serials are cut out of addresses
by the app before sending and again by the server before storing. The server stores
no IP address at all. Reports older than 7 days are deleted hourly, and at start-up,
whether or not new ones arrive.

## Live captions

1. Create a Soniox account and an API key (https://console.soniox.com).
2. Set `SONIOX_API_KEY` (and `SONIOX_API_BASE` for an EU key) and restart.
3. `GET /api/captions/health` should now answer `{"available":true,...}`.

Captions cost the publisher money per viewer-hour. Each address may open 30
sessions per 10 minutes. The privacy text names Soniox as the provider; if you use
another one, change `captions` in `brand.config.json` and the code in
`apps/server/src/captions.ts`.

## Demo playlist for store reviewers

Reviewers need something to play. `GET /demo/playlist.m3u` serves an M3U built from
`apps/server/demo/streams.json`: three Creative Commons films by the Blender
Foundation, with their attribution in the entry names (Big Buck Bunny, Sintel,
Tears of Steel, all CC BY 3.0).

1. Set `DEMO_ENABLED=1` and restart. Entries with an empty `url` are skipped.
2. As shipped, Sintel and Tears of Steel point at the official
   `download.blender.org` files; Big Buck Bunny is only published there as `.zip`
   archives, so its `url` is empty. For a dependable review, download the films
   from their licence pages (peach.blender.org, durian.blender.org,
   mango.blender.org), host them yourself (any web server or object store that
   supports range requests), and put those URLs in the JSON.
3. Give the reviewer `https://<your site>/demo/playlist.m3u` as an M3U link. Turn
   `DEMO_ENABLED` off again after review if you want.

The credits are also on the `/licenses` page.

## Security notes

- Admin sign-in: 8 attempts a minute per address, constant-time comparison,
  eight-hour in-memory tokens (a restart signs everyone out). Use HTTPS: the
  password is sent in the request body.
- Secrets never reach the log: request headers and bodies are not logged, URLs are
  cut by `logUrl`, addresses are masked.
- HTML pages carry a strict Content-Security-Policy, `nosniff`, no-referrer and
  frame denial. CORS allows only the app's own origins (above).

## Checks

```bash
pnpm --filter @iptv/server typecheck
pnpm --filter @iptv/server test     # needs no database and no network
```
