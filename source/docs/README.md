# Streamix documentation

Technical notes for whoever builds and maintains Streamix, and the store kit for whoever
submits it.

## Technical reference

| Doc | What it covers |
|---|---|
| [01-playlist-formats.md](01-playlist-formats.md) | M3U / M3U8 attributes, directives, catch-up placeholders, DRM carriers |
| [02-xtream-api.md](02-xtream-api.md) | The Xtream-style API: endpoints, response shapes, the type traps, stream URLs, rate limits |
| [03-catchup-epg.md](03-catchup-epg.md) | Catch-up URL families, XMLTV parsing, matching guide ids to channels |
| [04-stalker-portals.md](04-stalker-portals.md) | Stalker / MAC portals |
| [05-platform-engines.md](05-platform-engines.md) | Playback engines per platform, remote keys, TV constraints |
| [06-architecture.md](06-architecture.md) | How the app, the on-device store and the publisher's server fit together |
| [SERVER.md](SERVER.md) | Installing and running `apps/server` |

There is no official specification for the M3U attribute set or the Xtream-style API.
These notes are reverse-engineered from independent clients and live behaviour. Items marked
**[unverified]** rest on secondary sources; items marked **[WRONG]** circulate in other
documentation and are false.

## Store kit (`docs/store/`)

Copy-ready text and checklists for each store.

| Doc | Use it for |
|---|---|
| [store/launch-checklist.md](store/launch-checklist.md) | **Start here.** Everything to do before the first submission |
| [store/google-play.md](store/google-play.md) | Listing, Data safety, content rating, app access, permission declarations |
| [store/app-store.md](store/app-store.md) | Apple listing, privacy labels, age rating, review notes, 5.2.3 reply |
| [store/samsung-tizen.md](store/samsung-tizen.md) | Samsung TV Seller Office |
| [store/lg-webos.md](store/lg-webos.md) | LG Seller Lounge |
| [store/screenshots.md](store/screenshots.md) | What may and may not appear in screenshots, sizes |
| [store/takedown-process.md](store/takedown-process.md) | Handling copyright complaints and store notices |

The legal texts (Terms, Privacy, Copyright, in-app wording) are drafts with placeholders that
the server and app fill from the `publisher` block of `brand.config.json`. Have a lawyer
review them before launch. The store answers in `docs/store/` are written to match the
Privacy text exactly; if one changes, change the other.
