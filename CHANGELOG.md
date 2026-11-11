# Changelog

## Unreleased

First store release of Streamix as a neutral player.

- Plays sources the viewer adds: an Xtream server, an M3U playlist link, a
  single stream link, or a Stalker portal. Nothing is built in.
- No adult section. Adult categories and titles from any source are filtered
  out of every list, row, search and guide; there is no setting to show them.
- Live TV opens as the plain list of categories by default, not grouped by country,
  and nothing is filtered by country by default. A viewer who chooses the grouped view
  in Settings keeps it.
- The legal pages are filled in from the publisher block of brand.config.json. An empty address line is
  left out and an empty governing-law field gives a general clause, so no
  "[to be filled in]" marker shows for optional fields.
- The website has a download page, `/download` (alias `/get`): store links and any
  Android APK, Samsung `.wgt` or LG `.ipk` in `DOWNLOAD_DIR`, with sizes, versions and
  SHA-256 checksums. It is a website page only; the apps have no update check.
  `scripts/collect-downloads.mjs` copies fresh builds into it.
- Updates come from the app stores. There is no in-app updater.
