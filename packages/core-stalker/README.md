# @iptv/core-stalker

Client for Stalker / Ministra ("MAG") middleware portals. The user supplies a
portal URL and a MAC address (optionally serial number, device ids, signature,
login). Output rows are the same shapes `@iptv/core-xtream` produces
(`CategoryRow`, `ItemRow`, `SeriesRow`, `EpisodeRow`, `EpgEntry`), extended with
the portal's own `remoteId` and `cmd`, so the store treats a portal like an
Xtream line.

## Protocol flow

1. **Endpoint discovery.** The pasted URL may be `http(s)://host[:port]`, `/c/`,
   `/stalker_portal/c/`, `/portal.php` or `/stalker_portal/server/load.php`.
   `parsePortalUrl` reduces it to origin + prefix; the client then handshakes
   against `[pasted API path], /portal.php, /server/load.php,
   /stalker_portal/server/load.php, /c/portal.php, /stalker_portal/c/portal.php`
   and remembers the first that answers with a token (`client.session.endpoint`).
2. **Handshake** `type=stb&action=handshake&token=&JsHttpRequest=1-xml` -> `js.token`
   (and sometimes `js.random`). Later requests send `Authorization: Bearer <token>`.
3. **Profile** `type=stb&action=get_profile` with the usual STB parameters; when a
   `login` is configured, `type=stb&action=do_auth&login=&password=` then profile again.
4. **Catalogue.** Live: `itv/get_genres`, `itv/get_all_channels` (falls back to
   paging `itv/get_ordered_list&genre=*&p=N`). VOD: `vod/get_categories`,
   `vod/get_ordered_list&category=&p=`. Series: `series/get_categories`,
   `series/get_ordered_list` for titles, then `movie_id=&season_id=` for seasons and
   episodes (both "season row with `series:[1,2]`" and "one row per episode" shapes).
   A missing module yields empty results, not errors (many portals are itv-only).
5. **Playback.** `*/create_link&cmd=...` -> `js.cmd`, with the `ffmpeg ` / `ffrt `
   prefix stripped. **Links are short-lived: call `resolveLiveUrl` / `resolveVodUrl`
   immediately before playback, every time. Never store them.**
6. **EPG.** `itv/get_short_epg&ch_id=&size=` and `get_epg_info&period=`.
7. **Catch-up.** `resolveArchiveUrl(cmd)` calls `tv_archive/create_link`. The
   protocol shape is unverified against a real portal (see the TODO in the source).

All replies are wrapped as `{ "js": ... }`. A 401/403 or an "Authorization failed"
body triggers one re-handshake and a retry; a second failure throws
`StalkerError('auth')`.

## Adult content

A channel with `censored == 1`, or one in a genre/category with `censored == 1`
(or a clearly adult genre name), gets `isAdult = true`; the app's permanent adult
filter then drops it. Adult ids are tracked per module (ids overlap between itv,
vod and series).

## Transport requirement

Portals identify the box by `Cookie: mac=...` and a MAG `User-Agent`. Browsers
forbid setting both, so **on the web a plain fetch cannot work** (the portal
answers "Authorization failed"). Inject a native HTTP layer on Android/iOS
through `StalkerOptions.fetch`:

```ts
type StalkerFetch = (url: string, init: { headers: Record<string,string>; signal?: AbortSignal })
  => Promise<{ status: number; text(): Promise<string> }>;
```

Global `fetch` is only the default, for Node and tests.

## Testing

`scripts/fake-stalker.mjs` is a synthetic portal (`startFakePortal({ port: 0 })`)
used by the tests; run it directly to get a URL to poke at. It contains no real
hosts or MACs (`portal.example.com`, `00:1A:79:00:00:01`).
