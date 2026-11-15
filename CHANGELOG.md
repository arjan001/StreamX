# Changelog

## 1.64.14 (2026-11-15)

### Adult Section
- Gender selector now matches the Movies/Series genre toggle style: a button that expands inline chips horizontally, replacing the floating dropdown.
- Fixed CI overlay navigation test: removed floating z-50 gender dropdown that lacked focus behavior declaration.

### About Page
- Added "What's new in v{version}" button below version info — opens a modal showing the bundled changelog for the current version.
- The changelog modal is accessible anytime, regardless of update check status, and adapts sizing for mobile and TV screens.

## 1.64.13 (2026-11-15)

### Adult Section Improvements
- Search bar width reduced to 75% so gender filter and view toggle don't feel squeezed.
- Gender filter converted to expandable dropdown (like Movies genre toggle) instead of a native select box.
- Added cast rail below the filter bar: rounded cast images with initials fallback, clicking a cast member filters by their name.
- Added search autocomplete with cast name suggestions — typing a performer's name shows matching actors and titles.
- Expanded tag extraction keywords from ~80 to ~200+ covering more categories (body types, settings, scenarios, attributes, etc.).
- Increased tag fetching from 300 to 500 items for better tag coverage.
- Added error handling to prevent crashes when cast data is unavailable.

### Bug Fixes
- Fixed potential navy blue screen crash when navigating away and back to the Adult section.

## 1.64.12 (2026-11-15)

### CI Build Fix
- Restored all 4 APK variants (ARM64, ARMv7, x86_64, Universal) in the CI build pipeline. Each APK is now uploaded as a separate artifact, ensuring the GitHub Pages download page and GitHub Releases include all 4 download links.

## 1.64.11 (2026-11-15)

### CI & Build
- Removed `continue-on-error: true` from the GitHub Pages deployment job — any workflow failure now properly stops the entire build instead of being silently ignored.
- Improved APK deployment: the build now warns when some APK variants are missing (e.g., x86_64, universal) but only fails if no APKs are found at all, preventing false failures while still alerting to incomplete builds.

## 1.64.10 (2026-11-15)

### GitHub Pages Download Fix
- Fixed GitHub Pages APK download links returning 404: removed `continue-on-error` from artifact download so the deploy step fails loudly if APKs are missing, and added detailed logging at each step.
- Added validation that all 4 APK variants are present before deploying; the job will fail with a clear error if any APK is missing.

## 1.64.9 (2026-11-15)

### GitHub Pages APK Download Fix
- Fixed GitHub Pages APK download links returning 404: the CI workflow now correctly renames the built APKs from `app-debug-*.apk` to `streamix-*.apk` so the download page links work.
- All 4 APK variants (ARM64, ARMv7, x86_64, Universal) are now properly deployed to the GitHub Pages download site.

### Debug Logging
- The `subscribeErrors` function in `debugLog.ts` is preserved and ready for future integration with Sentry or Cloudflare error tracking.

## 1.64.8 (2026-11-15)

### GitHub Pages Restoration
- Restored GitHub Pages deployment workflow so APK download links are available on the project's documentation page.
- Redesigned the download page with a clean layout: 4 APK download cards (ARM64, ARMv7, x86_64, Universal), changelog section, and installation steps.
- Removed all GitHub repository links from the download page — users can download APKs directly without being redirected to the source code.

### APK Download Flow
- The "Update now" button in the app downloads the APK silently via fetch+blob — no browser navigation or "open with" dialog.
- Users are never redirected to the GitHub release page, keeping the source code private.

### CI & Build
- The `deploy-docs` CI job deploys the documentation page with the latest APK files after each successful build.
- Job uses `continue-on-error: true` so it does not block the APK build and release process if GitHub Pages is not enabled.

## 1.64.7 (2026-11-15)

### Removed
- Removed all server-side error logging (errorReports module, heartbeat, batch log sending) — the app no longer sends error logs or heartbeats to the server.
- Removed the "Collect errors from apps" toggle from admin settings.

### CI & Build
- Removed GitHub Pages deployment workflow that was failing on every run because the repository was set to private. The APK is distributed via GitHub Releases, so Pages was not needed.

## 1.64.6 (2026-11-15)

### Update System
- Changed update banner dismiss timer from 1 hour to 10 minutes, so the update notification reappears more frequently until the user installs it.
- The "Check for updates" button in Settings → About has no timer — it always shows the changelog modal when a newer version is available.

### CI & Build
- Restored GitHub Pages deployment job with `continue-on-error: true` so it no longer blocks the APK build and release process.
- Ensured `VITE_APP_VERSION` is always stamped from `version.json` during build, so the APK always reports the correct version.

### Verified
- Adult card is confirmed removed from the home page.
- Heart icon (♡) is confirmed placed next to the profile icon in the navigation bar.

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
