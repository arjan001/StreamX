# Changelog

## 1.64.5 (2026-11-15)

### Update Detection Fix
- Added diagnostic logging to the update check system so you can see in logcat why updates are not detected (empty version, dismissed flag, or network error).
- Added `.env` file with `PUBLIC_API_ORIGIN` fallback so local APK builds know where to send logs without requiring environment variables.

### Logging Fix
- The `.env` fallback ensures APKs built locally still send logs to the correct server. CI builds continue to use the `STREAMIX_API_ORIGIN` environment variable.
- Created `LOGS_TESTING.md` with step-by-step commands to verify log capture on your device.

### How to verify
- After installing this APK, run `adb logcat | Select-String "updateCheck|errorReports"` to see diagnostic output confirming the version and API origin are set correctly.

## 1.64.4 (2026-11-15)

### Update System
- Replaced the update modal popup with a slim top banner showing "UPDATE" label.
- The banner sits at the very top of the app, above the navigation bar.
- APK downloads silently in the background when clicking "Update", similar to Play Store behavior.
- The full changelog modal is still available in Settings → About → "Check for updates".

### Login Persistence
- Fixed login credentials being lost after APK update: session data now syncs from native storage on every app boot, so users don't need to re-login after updating.

### CI & Build
- Removed the GitHub Pages deployment job that was causing CI failures on every build.
- Fixed TypeScript type error in UpdateModal: added `download_url` field to ReleaseInfo type.
- Fixed overlay navigation test: added `data-nav-contain` to search autocomplete dropdown.
- Removed `REQUEST_INSTALL_PACKAGES` permission from Android manifest.

### Bug Fixes
- APK download no longer redirects users to the GitHub release page (which exposed the source code).
- The "Check for updates" button in Settings → About now reliably shows the changelog modal, even after dismissing the banner.

## 1.64.3 (2026-11-14)

### Navigation
- Removed "Adult" text link from the main navigation bar.
- Added a heart icon (♡) next to the profile icon in the header; clicking it opens the Adult section.
- The heart icon is icon-only with no text label, matching the existing icon style.

### Home Page
- Removed the Adult card from the home screen; only Live TV, Sports TV, Movies, Series, and Replay remain.
- Reduced the vertical gap between the home cards and the Continue Watching section for a tighter layout.
- Removed the white border line under the header bar.

### Sports TV
- Sports videos now fill the entire player area (`object-fit: cover`), eliminating the grey letterbox bars that obscured the bottom-right corner during football matches.
- Live TV, Movies, and Series keep the normal `contain` behavior unchanged.

### Performance
- Tab navigation is now instant on first load: Live TV, Movies, and Series data are pre-fetched in the background after the library becomes ready, so switching tabs no longer takes ~10 seconds.
- Pre-fetching runs silently and does not interfere with normal use.

### Search
- Added autocomplete suggestions that appear as you type, showing content titles and actor names.
- Typing a cast member's name shows both the actor suggestion and movies featuring that actor.
- Clicking an actor suggestion filters results by that person.

### Adult Section
- Redesigned the filter bar: a wide search bar occupies most of the row, with a compact gender dropdown and view toggle on the right.
- Added covers/tiles view toggle: "Covers" shows portrait cards (2:3), "Tiles" shows landscape cards (3:2).
- Improved tag extraction: tags are now pulled from movie titles and plot descriptions using ~80 adult-related keywords (blonde, milf, threesome, POV, amateur, etc.).
- Tags are fetched from 300 items (increased from 100) for better coverage.
- Clicking a tag filters movies by that tag name.

### Error Handling
- Login failures now show structured error codes (E001–E006, N001–N003) with troubleshooting hints in an expandable "Error details" section.
- Enhanced diagnostic logging for APK log reporting: startup diagnostics now log NATIVE, BUILD, IS_BETA, API_ORIGIN, and VERSION; critical warning if the APK is built without `VITE_API_ORIGIN`.

### Refresh & Updates
- The refresh button now shows phase-specific status messages: "Downloading channels", "Downloading movies", "Downloading series", "Saving to device".
- The "Check for updates" button in Settings → About checks GitHub for the latest release and shows the "What's New" modal if a newer version is available.
- The update modal appears automatically on app start when a newer, non-dismissed release exists.

### Bug Fixes
- Fixed version drift: `version.json`, `build.gradle`, and `package.json` are now in sync (1.64.3, build 211).
- Progress bars on Continue Watching tiles show the watch fraction correctly.

## Unreleased

First store release of Streamix as a neutral player.

- CI: Fixed tag creation to skip when tag already exists on remote, preventing re-run failures.

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
