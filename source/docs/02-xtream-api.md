# Xtream Codes API

The client-facing surface. No official spec exists (see `README.md`); field names below
are cross-verified against several independent client implementations and live testing.

## 1. Endpoints

```
http://host:port/player_api.php   client API (JSON)        ← use this
http://host:port/panel_api.php    legacy client API        ← fallback only, §7
http://host:port/get.php          playlist generation
http://host:port/xmltv.php        XMLTV EPG
http://host:port/portal.php       Stalker/MAG              ← see 04-stalker-portals.md
```

Ports seen in the wild: 80, 8080, 8000, 2082, 25461. Both `GET` and `POST` work on most
panels. Credentials travel in the query string in plaintext, always; HTTPS only if the
provider set `https_port`.

## 2. Auth (no `action` parameter)

```
GET /player_api.php?username=USER&password=PASS
→ {"user_info": {...}, "server_info": {...}}
```

`user_info`: `username`, `password`, `message`, `auth`, `status`, `exp_date`, `is_trial`,
`active_cons`, `created_at`, `max_connections`, `allowed_output_formats`.

`server_info`: `url`, `port`, `https_port`, `server_protocol`, `rtmp_port`, `timezone`,
`timestamp_now`, `time_now`, `process`.

- `status` ∈ `"Active"`, `"Expired"`, `"Banned"`, `"Disabled"`.
- `exp_date` is `null` for never-expiring lines. `max_connections: "0"` means unlimited on
  some panels.
- **Auth failure is HTTP 200 with `auth: 0`** — not a 401. Some forks return `{}` or `[]`.
- **`server_info.url` is authoritative for streaming** and can differ from the host you
  dialled; multi-server panels use it to steer clients to a load balancer.

## 3. Actions

| Action | Params | Notes |
|---|---|---|
| *(none)* | — | auth + `user_info`/`server_info` |
| `get_live_categories` | — | |
| `get_live_streams` | `category_id?` | Omit for all |
| `get_vod_categories` | — | |
| `get_vod_streams` | `category_id?` | |
| `get_vod_info` | `vod_id` | |
| `get_series_categories` | — | |
| `get_series` | `category_id?` | |
| `get_series_info` | **`series_id`** | Not `series` |
| `get_short_epg` | `stream_id`, `limit?` (default 4) | |
| `get_simple_data_table` | `stream_id` | Full stored EPG. Spelling: "data", not "date" |

### Do not implement these — they do not exist

Circulating documentation asserts them. Verified absent:

- **`get_live_streams_by_category`** [WRONG] — filtering is the `category_id` *parameter*.
- **`get_vod_streams_by_category`** [WRONG] — same.
- **`get_all_epg`** [WRONG].

Fork-added actions seen in the wild (`get_account_info`, `get_epg`, `get_catchup_table`,
"latest 100" variants) are **[unverified]** and must not be depended on.

## 4. The type minefield

Panels emit integers as strings and forks disagree. Every mature client ships tolerant
coercion types; so must this one. Confirmed live — a single
response mixed both conventions.

| Trap | Handling |
|---|---|
| `auth` is `1` (number) or `"1"` (string) | Convertible boolean |
| `exp_date`, `active_cons`, `max_connections`, `port`, `https_port` are strings-with-integers | Flexible int |
| `exp_date` may be `null` | Nullable |
| `rating` may be string, number, or `""` | Flexible float |
| `backdrop_path` may be a string or an array | Normalise to array |
| **`get_vod_info.info` is often `[]` instead of `{}`** | Accept object-or-empty-array |
| **`get_series_info.seasons` / `.episodes` may be `[]`** | Same — and see below |
| `releaseDate` (series, camelCase) vs `releasedate` (VOD, lowercase) | Read both |
| Attribute/field name casing varies (`tvg-ID`) | Case-insensitive |

## 5. Response shapes

**Category** (all three category actions):
```json
{"category_id": "1", "category_name": "XX | ENTERTAINMENT", "parent_id": 0}
```
`category_id` string, `parent_id` int.

**`get_live_streams`** items: `num`, `name`, `stream_type` (`"live"`), `stream_id`,
`stream_icon`, `epg_channel_id`, `added` (unix string), `is_adult`, `category_id`,
`category_ids[]`, `custom_sid`, **`tv_archive`** (1/0), `direct_source`,
**`tv_archive_duration`** (days), `thumbnail`.

- `epg_channel_id` is the XMLTV join key and is frequently `""` or `null`.
- `tv_archive` + `tv_archive_duration` gate catch-up. Both are hardcoded to `0` in the
  1.6x-era backport, so `0` can mean "old panel", not "no archive".
- `direct_source`, when non-empty, is a complete URL to use *instead of* constructing one.

**`get_vod_streams`** items add `container_extension` — **required** to build the movie URL
(`mkv`, `mp4`, `avi`, `ts`) — plus `title`, `year`, `rating`, `rating_5based`.

**`get_vod_info`** returns `{info, movie_data}`. `info` carries TMDB-ish metadata plus raw
ffprobe `video` / `audio` dicts whose fields vary per asset. **`info` may be `[]`.**

**`get_series`** items: `series_id` (**not** `stream_id` — series are not streams), `name`,
`cover`, `plot`, `cast`, `director`, `genre`, `releaseDate`, `last_modified`, `rating`,
`backdrop_path[]`, `youtube_trailer`, `episode_run_time`, `category_id`.

**`get_series_info`** returns `{seasons, info, episodes}`:

```json
{
  "seasons": [...],
  "info": {...},
  "episodes": {
    "1": [{"id": "778901", "episode_num": 1, "title": "...",
           "container_extension": "mkv", "season": 1, "info": {...}}],
    "2": [...]
  }
}
```

**This is where clients break most often:**

- **`episodes` is an object keyed by season number as a *string*.** Keys sort
  lexicographically, so `"10" < "2"` — **sort numerically.**
- **`seasons` is frequently empty while `episodes` is fully populated, and occasionally the
  inverse** (both observed live). **Enumerate from `episodes`
  keys.**
- `episode.id` is a **string** and is what goes in the `/series/` URL.
- `episodes` may itself be `[]`.

**`get_short_epg` / `get_simple_data_table`** return `{"epg_listings": [...]}` with `id`,
`epg_id`, `title`, `lang`, `start`, `end`, `description`, `channel_id`,
`start_timestamp`, `stop_timestamp`, `stream_id`, `now_playing`, `has_archive`.

- **`title` and `description` are Base64-encoded UTF-8.** Decode defensively: some forks
  double-encode, some don't encode at all. Heuristic — try Base64; if the result isn't valid
  UTF-8, use the raw string.
- **Use `start_timestamp` / `stop_timestamp`.** The `start` / `end` strings are server-local
  time with no timezone marker.
- `has_archive` per programme is the most precise catch-up signal available.

## 6. Stream URLs

```
live      http://host:port/live/USER/PASS/{id}.ts | .m3u8
legacy    http://host:port/USER/PASS/{id}
movie     http://host:port/movie/USER/PASS/{id}.{container_extension}
episode   http://host:port/series/USER/PASS/{episode.id}.{container_extension}
rtmp      rtmp://host:rtmp_port/live/USER/PASS/{id}
```

- **The path prefix *is* the `stream_type`.** That's why the field matters.
- **Series URLs are flat and use the episode id.** There is no
  `/series/USER/PASS/SERIES/SEASON/EPISODE` hierarchy — documentation claiming otherwise is
  **[WRONG]**.
- **Some panels emit the legacy no-prefix form for live.** A client that only knows
  `/live/` sees zero working channels there. Always support both.
- URL-encode credentials in **path** segments (they contain `@`, `+`, `%`), but keep them
  **raw in query strings** — encoding them in `timeshift.php` params breaks auth on some
  panels.
- Choose the extension from `allowed_output_formats`; resolve "auto" to `m3u8`, then `ts`.

## 7. `panel_api.php` — legacy, fallback only

Returns one monolithic document: `user_info`, a truncated `server_info`, `categories`, and
`available_channels` — **a map keyed by stream_id string containing live + VOD + series
together**. On a 150k-entry provider that is a 100–300 MB single JSON document with no
pagination; it will OOM a set-top box. Its `server_info` lacks `https_port`, `timezone`,
`server_protocol` and `rtmp_port`, so you cannot build HTTPS URLs or interpret EPG times.
No series structure at all. Implement read-only, last resort, for pre-2.x panels.

## 8. Scale, rate limiting, operational behaviour

**No pagination exists anywhere in this API.** `get_vod_streams` returns everything —
measured at 20.6 MB / 50,343 items on a mid-size provider, and 60–150 MB on large ones. A
48,000-entry playlist takes 30–90 s to download and parse on a first-generation Fire Stick.

**Panels have flood protection, not `429`.** Stock Xtream Codes exposes a configurable
per-IP request-rate threshold; exceeding it gets you blocked at the firewall/fail2ban layer
for minutes, with no `Retry-After`. Therefore:

- Serialise catalogue requests; cap concurrency at 1–2; space them 100–300 ms.
- Exponential backoff on any 4xx/5xx.
- **Never fan out `get_series_info`.** Resolve lazily on open.

**Connection limits are the most misdiagnosed failure in IPTV clients.** Exceeding
`max_connections` does not produce a clean error — panels return `auth: 0` (identical to bad
credentials), serve a "connection limit" clip, or refuse the socket. Sessions linger 30–120 s
after disconnect because accounting is timeout-based. So:

- Exactly **one stream socket per playing surface**.
- **Tear down the previous stream before opening the next**, not after.
- Never pre-buffer adjacent channels.
- Surface `active_cons >= max_connections` as its own UI state.

**Status codes in practice:** `200` with `auth: 0` (bad creds *or* limit), `401` (nginx/UA),
`403` (UA/IP/geo block), `404` (`get.php` disabled or wrong extension), `301`/`302`
(load-balancer — follow cross-host redirects and re-derive the base for segments), `5xx`
(backend dead). `512` is **not** a real HTTP status; treat all 5xx as retryable.

**Broken verbs.** Some panels return `502` for `OPTIONS` and `HEAD`. Never build
change-detection or capability probing on either.

**`get.php` is the endpoint providers disable most often** to stop playlist resharing
(symptoms: 403, 404, empty body, marketing redirect). **The client must be able to build the
entire catalogue from `player_api.php` alone.**

**`User-Agent` must be a first-class per-provider setting**, sent identically on API,
playlist, EPG *and* stream requests — many providers filter on it at the WAF layer, and an
API/stream mismatch is a classic silent failure. Commonly accepted values:
`VLC/3.0.20 LibVLC/3.0.20`, `Lavf/…`, `okhttp/4.x`.

## 9. Fork landscape

| Fork | Behaviour |
|---|---|
| **Xtream Codes v2** | The reference behaviour. Full `player_api.php`. |
| **Xtream Codes 1.6x** | **No `player_api.php` at all** — only `panel_api.php`. The community backport hardcodes `tv_archive=0`, `tv_archive_duration=0`, `direct_source=""` and has no series support. |
| **XtreamUI** | Free fork of the v2 leak, broadly compatible. Known bug: **`max_connections` not enforced** on some builds — don't assume limits are real. |
| **XUI.ONE 1.5.x+** | Commercial continuation. Adds `category_ids[]`, `title`/`year` on VOD, `release_date` alongside `releaseDate`. Aims for client compatibility. |
| **Dispatcharr / tuliprox / iptv-proxy** | Modern servers that *emulate* the API. Their coverage is a good de-facto compatibility floor. |
