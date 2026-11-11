# Catch-up, timeshift, and EPG

How Streamix builds replay URLs and reads guides. All of it runs on the device, against the
user's own provider (`packages/core-xtream`, `apps/web/src/lib/localEpg.ts`, `localArchive.ts`).

## 1. Xtream catch-up: two incompatible URL families

Both are in active use. A client must try one and fall back.

**Query form:**
```
/streaming/timeshift.php?username=U&password=P&stream={id}&start=YYYY-MM-DD:HH-MM&duration={minutes}[&extension=ts|m3u8]
```

**Path form** (what Kodi's `catchup="xc"` generates):
```
/timeshift/U/P/{duration_minutes}/{Y}-{m}-{d}:{H}-{M}/{stream_id}.ts|.m3u8
```

`duration` is **minutes**, not seconds.

### Probe once, then cache

Working implementations probe candidate variants for HTTP `200`/`206` and **persist the
winning variant keyed by playlist + `allowed_output_formats`**. Probing on every seek is
unacceptable. Candidate order: REST form in each preferred extension, then legacy form in
each, then bare legacy.

Extension preference comes from `allowed_output_formats` on `user_info`; "auto" resolves to
`m3u8` first, then `ts`.

### The timezone question

**The two reference implementations genuinely disagree**, and this is worth understanding
rather than picking one blindly:

- Kodi's `pvr.iptvsimple` generates **UTC** (`gmtime_r()`).
- IPTVnator formats in the **server's** timezone (`server_info.timezone`).

Both are correct about their own codebase, and the disagreement is real: **panels differ.**
That is precisely why `catchup-correction` / `catchup_start_offset_hours` settings exist in
every mature client.

**Resolution:** default to formatting in `server_info.timezone` (for example
`Europe/Amsterdam`), and expose a **per-provider correction in
hours**. Treat "catch-up plays the wrong programme" as an offset bug, not a URL bug.

### Gating logic

In priority order:

1. **Per programme:** `has_archive == 1` from `get_simple_data_table` — the most precise
   signal. Prefer it when present.
2. **Per channel:** `tv_archive == 1` **and** `tv_archive_duration > 0` → offer catch-up with
   that depth in days.
3. **Fallback:** if the API reports `tv_archive_duration: 0` but the M3U carries a non-zero
   `catchup-days`, **trust the M3U** — the 1.6x-era backported `player_api.php` hardcodes
   those fields to `0`, so `0` can mean "old panel" rather than "no archive".

Compute duration from `stop_timestamp - start_timestamp` **plus a 1–2 minute tail buffer**,
because panels cut on segment boundaries.

## 2. Flat-m3u catch-up

A different mechanism entirely. Determine support:

- If `catchup-source` is a full `http(s)` URL → **source mode**: use it as the template.
- Else if `catchup` is `shift` (or absent) and the stream URL is http(s) → **shift mode**:
  append `?utc={programme_start}&lutc={now}` to the live URL.
- Archive depth: first non-blank of `catchup-days`, `timeshift`, `tvg-rec`. Zero ⇒ no
  catch-up.

Many Xtream playlists carry none of these attributes, so for those providers catch-up
comes from the API only.

## 3. XMLTV

```xml
<tv date="20260818120000 +0000" generator-info-name="...">
  <channel id="ChannelOne.xx">
    <display-name lang="en">Channel One HD</display-name>
    <icon src="http://host/channel1.png"/>
  </channel>
  <programme start="20260818060000 +0000" stop="20260818090000 +0000" channel="ChannelOne.xx">
    <title lang="en">Breakfast</title>
    <sub-title/><desc/><credits/><date/><category/><episode-num system="onscreen">S01E13</episode-num>
    <icon/><rating system="MPA"><value>PG</value></rating>
  </programme>
</tv>
```

Per the DTD: `channel` requires `id` and one or more `display-name`; `programme` requires
`start` and `channel`. **`stop` is optional** — a programme without one runs until the next
on that channel, so end times must be synthesised. `clumpidx` handles two programmes sharing
a slot.

### Timestamps

Format is `YYYYMMDDHHMMSS` optionally followed by a space and a `±HHMM` offset — but **any
initial substring is legal** (`200209` means September 2002), and **when no timezone is given
UTC is assumed**.

In practice a large fraction of IPTV EPGs emit local time with no offset, or emit `+0000`
while meaning local time. Parser requirements in priority order:

1. Accept `YYYYMMDDHHMMSS ±HHMM`, **`YYYYMMDDHHMMSS±HHMM` (no space — very common)**, bare,
   `YYYYMMDDHHMM`, `YYYYMMDD`, and named zones (`BST`, `CET`).
2. **Never assume `+0000` is truthful.** Provide a per-source manual offset override.
3. Sanity-check: if "now playing" is consistently N hours off across *all* channels, offer to
   shift by N.

Watch the sign-parsing trap: for an offset like `-0030` the hour part is `-00`, and
`Number("-00") === -0`, so deriving the sign arithmetically silently drops it. Derive the
sign from the string.

### Delivery

- Usually gzip — `.xml.gz`, or `xmltv.php` with `Content-Encoding: gzip`. **Sniff the `1f 8b`
  magic bytes as well as trusting the header**: panels gzip without declaring it, *and*
  declare gzip while sending plain XML.
- Also seen: `.xz`, `.zip` with one member, chunked with no `Content-Length`.
- Declared UTF-8 containing Latin-1 bytes is common — decode with replacement, don't fail the
  file.
- Undeclared/invalid entities appear regularly; a strict parser aborts mid-file. Use a
  recovering parser or an entity-repair pre-pass.

### Sizes and parsing strategy

| Scope | Gzipped | Raw |
|---|---|---|
| ~1,000 channels × 3 days | ~5 MB | ~50 MB |
| ~22,000 channels × 7 days | 18–22 MB | ~180 MB |

Measured on an Amlogic S905X4 with an 18 MB gzip: **native SAX ≈ 12 s vs Java DOM ≈ 38 s.**

Pipeline:

1. Stream-decompress; never buffer the whole decompressed file.
2. SAX / pull-parse, clearing each element's subtree.
3. **Filter early.** Collect the set of channel ids the catalogue actually needs, then
   discard any `<programme>` whose `channel` isn't in that set *before* allocating a row. On a
   22k-channel guide serving a 500-channel view this removes ~97% of the work.
4. Batch inserts (5k–20k rows) in one transaction; **build indices after insert**, on
   `(channel_id, start)`.
5. Prune older than `now − catchup_days` and beyond N days ahead.
6. Cache the compressed original with `If-Modified-Since` / `If-None-Match`; most panels
   regenerate on a cron, so a `304` skips the whole job.

## 4. The `tvg-id` ↔ `<channel id>` matching problem

**This is the single largest source of user-visible IPTV breakage.** The match must be exact,
and providers routinely fail it: `FOO1.xx` in the playlist vs `FOO.1.xx` in the EPG, trailing
spaces, case differences, numeric ids on one side and dotted ids on the other, or
`epg_channel_id` empty entirely.

On large lists this is the norm, not the exception: a catalogue of hundreds of thousands of
entries can carry only a few thousand distinct `tvg-id` values, and `""` is one of them. Name
matching and the override table are the primary path there, not a fallback.

Deterministic tiered matcher:

1. **Exact** `tvg-id` / `epg_channel_id` → `<channel id>`.
2. **User override table**, persisted per provider and editable in the UI. **Non-negotiable —
   ship it in v1.**
3. **Numeric** match (playlist id `"101"` against numeric EPG ids).
4. **Case-insensitive** id match.
5. **Normalised name** match: `tvg-name` (falling back to the display name after the comma)
   against each `<display-name>`. Normalisation — HTML-entity decode, Unicode NFKC,
   lowercase, strip all non-alphanumerics, collapse whitespace, and strip quality/region noise
   (`hd`, `fhd`, `uhd`, `4k`, `sd`, `raw`, `backup`, `vip`) and leading country prefixes
   (`uk:`, `us|`).
6. **Fuzzy** match with a high threshold — **surfaced as a suggestion the user confirms,
   never applied silently.** A false positive ("Channel One" → "Channel One Regional") is worse than
   no EPG at all.

Also normalise attribute aliases on ingest: `tvg_id` → `tvg-id`, `tvg-ID` → `tvg-id`,
`group_title` → `group-title`.
