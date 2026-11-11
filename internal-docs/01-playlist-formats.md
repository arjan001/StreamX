# Playlist formats: `m3u`, `m3u_plus`, and the directive vocabulary

What an IPTV playlist contains and how Streamix reads it (`packages/core-m3u`). The
Xtream `get.php` examples are what a user's own provider may generate; Streamix itself
ships no playlist.

An IPTV M3U is **not** an HLS playlist. It is the older Winamp-lineage M3U with IPTV
attributes bolted on. The URLs *inside* it frequently point at real HLS.

## 1. `type=m3u` vs `type=m3u_plus`

Same endpoint, one parameter apart:

```
/get.php?username=U&password=P&type=m3u&output=ts
/get.php?username=U&password=P&type=m3u_plus&output=ts
```

- **`m3u`** — legacy/minimal: `#EXTINF:-1,Channel Name` + URL. No attributes. Grouping is
  sometimes carried by a separate `#EXTGRP:` line.
- **`m3u_plus`** — de-facto standard: same two-line structure, with quoted `key="value"`
  attributes before the comma.

**The stream URLs are identical between the two.** Only metadata differs. `output=` controls
the container in those URLs, not the playlist flavour: `ts` and `mpegts` are synonyms;
`m3u8` and `hls` are widely treated as synonyms, though whether they are truly identical is
**[unverified]** — conflicting reports exist, and on Xtream Codes 1.6 there are documented
cases of `m3u8` links being generated but not working at all.

Duration is `-1` for live (`0` is also accepted). Everything before the comma is attributes;
everything after it is the display name.

## 2. `#EXTM3U` header attributes

```
#EXTM3U url-tvg="http://host/xmltv.php?username=U&password=P" x-tvg-url="..."
        tvg-shift="0" catchup="default" catchup-days="7" catchup-correction="0"
```

- `url-tvg` / `x-tvg-url` — EPG source. **`url-tvg` accepts a comma-separated list.**
- `tvg-shift` — global default EPG hour offset for channels that don't override it.
- `catchup-correction` — global default catch-up time adjustment in hours (may be fractional
  or negative).

## 3. `#EXTINF` attribute catalogue

Sample:

```
#EXTINF:-1 tvg-id="ChannelOne.xx" tvg-name="Channel One HD" tvg-logo="http://host/channel1.png" tvg-chno="101" group-title="XX | ENTERTAINMENT" catchup="xc" catchup-days="7",XX: Channel One HD
http://provider:8080/live/user/pass/40521.ts
```

| Attribute | Meaning |
|---|---|
| `tvg-id` | Key matched against XMLTV `<channel id>`. **Exact** string match. |
| `tvg-name` | Fallback EPG match key (against `<display-name>`). |
| `tvg-logo` | Logo URL. Some clients accept a bare name + configured base path. |
| `tvg-chno` (alias `ch-number`) | LCN / channel number for ordering and number-entry zapping. |
| `group-title` | Category. **Kodi treats it as a semicolon-separated *list*** (a channel can be in several groups); most other clients treat it as one string. |
| `tvg-shift` | Per-channel EPG offset in hours (`"-1"`, `"2"`, `"0.5"`). Overrides the header. |
| `tvg-language` | Human-readable language name(s), semicolon-separated. |
| `tvg-lang` | ISO-639 code. Distinct from `tvg-language`. |
| `tvg-country` | Country metadata. |
| `radio` | `"true"` marks audio-only; clients skip video rendering. |
| `catchup` (alias `catchup-type`) | `default` \| `append` \| `shift` \| `flussonic*` \| `fs` \| `xc` \| `vod` |
| `catchup-source` | Full URL template, or a query fragment. |
| `catchup-days` | Archive depth in days. |
| `catchup-correction` | Per-channel hour adjustment. |
| `tvg-rec` | Older archive-depth marker, equivalent to `catchup-days`. |
| `timeshift` | Another alias in the same family. |
| `provider`, `provider-type`, `provider-logo` | Kodi provider grouping. `provider-type` ∈ addon/satellite/cable/aerial/iptv/unknown. |
| `media`, `media-dir`, `media-size` | Kodi: mark as VOD, virtual directory, byte size. |
| `realtime` | `"false"` disables live behaviour (no auto-restart on stall). |
| `parent-code`, `adult` | Adult marking. Streamix reads these only to filter the item out (see `06-architecture.md`). |
| `audio-track`, `aspect-ratio`, `description`, `content-type` | Player-specific (SS-IPTV). |

**Archive depth resolution order:** first non-blank of `catchup-days`, `timeshift`, `tvg-rec`.

### Not real attributes

`user-agent="…"` and `channel-id="…"` as `#EXTINF` attributes are **[unverified]** — they
appear only in secondary blog content, never in a reference parser. Read them defensively if
present; the genuine mechanisms are `#EXTVLCOPT` / `#EXTHTTP` / the pipe suffix for headers,
and `tvg-chno` for numbering.

### Name hygiene, required from day one

Parse attribute names **case-insensitively** — panels emit `tvg-ID` as well as `tvg-id` — and
normalise underscore aliases (`tvg_id` → `tvg-id`, `group_title` → `group-title`,
`tvg_logo` → `tvg-logo`). A meaningful share of "provider X doesn't work" reports are exactly
this.

## 4. Directives between `#EXTINF` and the URL

```
#EXTINF:-1 tvg-id="news1.xx" group-title="News",News One HD
#EXTGRP:News
#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64)
#EXTVLCOPT:http-referrer=https://provider.example/
#EXTHTTP:{"User-Agent":"Mozilla/5.0","Referer":"https://provider.example/","X-Token":"abc"}
#KODIPROP:inputstream=inputstream.ffmpegdirect
http://provider:8080/live/user/pass/40521.ts|User-Agent=VLC/3.0.20
```

- **`#EXTGRP:`** — group name(s), semicolon-separated. **In Kodi it is a *begin* directive**
  applying to every following entry until changed; in OTT Navigator it is per-channel. A real
  interop hazard — **prefer `group-title`**.
- **`#EXTVLCOPT:key=value`** — one property per line. Only `http-user-agent` and
  `http-referrer` are meaningfully translated into HTTP headers by most clients. **Channel-level
  values must win over global settings.**
- **`#EXTHTTP:{json}`** — arbitrary request headers as JSON. The cleanest mechanism when you
  need more than UA/Referer.
- **`#KODIPROP:key=value`** — passed to the Kodi inputstream; the DRM carrier (§6).
- **`#EXT-X-PLAYLIST-TYPE:VOD`** inside an IPTV M3U (not an HLS media playlist) marks the
  entry as VOD rather than live.
- **URL pipe suffix** — `|User-Agent=X`, `|k1=v1&k2=v2` for headers, `|!name=value` for a
  non-standard header. A leading `@URL` means "scrape this page for the stream".

**Browser limitation:** none of the User-Agent mechanisms work in a web client. `fetch`/XHR
forbid setting `User-Agent`. Streamix's native Android build sets its own User-Agent; the web build cannot.

## 5. Catch-up modes and the placeholder language

Modes (Kodi's `pvr.iptvsimple` is the reference implementation others copied):

| Mode | Behaviour |
|---|---|
| `default` | `catchup-source` is a complete URL; if it starts with `?`/`&`, it's a query fragment appended to the channel URL. |
| `append` | `catchup-source` is appended to the live URL verbatim. |
| `shift` | Auto-generates SIPTV style: appends `?utc={utc}&lutc={lutc}` to the live URL. |
| `flussonic` / `flussonic-hls` / `flussonic-ts` / `fs` | Derives Flussonic archive paths (`/archive-{utc}-{duration}.ts` and `index.m3u8` variants). |
| `xc` | Auto-generates the Xtream timeshift URL from the live URL. |
| `vod` | `catchup-source` alone is a VOD asset, keyed by `{catchup-id}` from XMLTV. |

Placeholders (both `{brace}` and `${dollar}` spellings accepted):

| Placeholder | Value |
|---|---|
| `{utc}` / `${start}` | Programme start, Unix seconds UTC |
| `{lutc}` / `${now}` / `${timestamp}` | Now, Unix seconds UTC |
| `{utcend}` / `${end}` | Start + duration |
| `{Y} {m} {d} {H} {M} {S}` | Zero-padded components of the start time |
| `{duration}` | Duration in seconds (plus configured buffer) |
| `{duration:X}` | Duration divided by X — `{duration:60}` for minutes |
| `{offset:X}` | `(now − start)` divided by X |
| `{catchup-id}` | Provider programme id from XMLTV |
| `{utc:YmdHM}` | Any timestamp placeholder accepts a `Y m d H M S` format string |

Supporting `shift` + `default` + `xc` covers the overwhelming majority of providers.

## 6. DRM via `#KODIPROP`

Property naming changed across Kodi versions; read all three forms.

**Deprecated but still dominant in the wild (Kodi v18–v22):**
```
#KODIPROP:inputstream=inputstream.adaptive
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey
#KODIPROP:inputstream.adaptive.license_key=<KID hex>:<KEY hex>
```
`license_key` also accepts a JWK blob (`{"keys":[{"kty":"oct","k":"…","kid":"…"}]}`) and,
for Widevine, `licenseURL|headers|postdata|responsehandling`.

**`drm_legacy` (v21+)** — `[KeySystem]|[LicenseURL or KeyIds]|[License headers]`:
```
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|<KID>:<KEY>
#KODIPROP:inputstream.adaptive.drm_legacy=com.widevine.alpha|https://lic.example/req|User-Agent=Mozilla%2F5.0
```

**`drm` (v22+)** — JSON keyed by key system:
```
#KODIPROP:inputstream.adaptive.drm={"org.w3.clearkey":{"license":{"keyids":{"KID":"KEY"}}}}
```

Key systems: `com.widevine.alpha`, `com.microsoft.playready` (Android only),
`com.huawei.wiseplay` (Android only), `org.w3.clearkey`, `none` (non-DRM encryption such as
HLS AES-128, v22+). Also `inputstream.adaptive.stream_headers` and `.manifest_headers`.

**Practical position:** only **ClearKey** is realistically supportable in a web engine
(Shaka). Detect Widevine/PlayReady license-server types and surface a clear diagnostic rather
than failing opaquely. Note that handing a stream off to mpv/VLC **loses** the ClearKey
configuration, so that fallback must be gated for DRM channels.

## 7. HLS, as it matters here

**Master playlist** lists renditions via `#EXT-X-STREAM-INF` (`BANDWIDTH` required;
`RESOLUTION`, `CODECS` recommended, RFC 6381 identifiers such as `avc1.640028`, `mp4a.40.2`).

**Media playlist** for live:
```
#EXT-X-TARGETDURATION:10      ← required; max segment duration
#EXT-X-MEDIA-SEQUENCE:585     ← first segment listed; increments as the window slides
                              ← absence of #EXT-X-ENDLIST is what makes it live
```

Most panels emit a short sliding window, which is why live latency is structurally ~20–30 s
(typically 10 s segments). `#EXT-X-DISCONTINUITY` appears when
the provider switches source or inserts ads, far more often than in commercial OTT; the
decoder timeline must reset.

**LL-HLS is effectively nonexistent in IPTV panels.** No evidence any Xtream-lineage panel
emits `#EXT-X-PART` / `#EXT-X-PRELOAD-HINT` / `#EXT-X-SERVER-CONTROL`. Treat LL-HLS support
as dead weight for this product.

## 8. Container trade-offs

| | MPEG-TS over HTTP | HLS | DASH |
|---|---|---|---|
| Transport | One infinite chunked `GET` | Manifest polling + segments | Manifest + segments |
| Latency | Lowest (~1–3 s) | Window × segment duration | Similar; lower with CMAF |
| ABR | None | Yes if provider publishes variants (most don't) | Yes |
| Seek/timeshift | Needs a server archive endpoint | Within window | Yes |
| Resilience | Poor — a TCP stall is a visible stutter | Good — retry a segment | Good |
| Browser | Needs MSE demux (mpegts.js) | Native Safari; hls.js elsewhere | dash.js / Shaka |
| DRM | No | AES-128 / SAMPLE-AES / FairPlay | Widevine / PlayReady / ClearKey |

**For a web client, HLS is the most compatible choice.** Raw TS needs mpegts.js, which
issues `Range` requests that some providers answer badly on a CORS preflight. On native
platforms (libVLC on Android), `.ts` gives lower zap latency.
