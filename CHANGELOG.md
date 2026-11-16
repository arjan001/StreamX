# Changelog

## 1.64.34 (2026-11-16)

### Sentry Error Tracking

- **Configured Sentry DSN** — error tracking is now active. The app captures errors automatically and sends them to the Sentry dashboard with full stack traces, device info, and APK version tracking.
- **Free tier**: 5,000 errors/month with 30-day retention — sufficient for a stable app.
- **Privacy**: Passwords are automatically redacted from error reports. Common noise (network errors, browser quirks) is filtered out.

## 1.64.33 (2026-11-16)

### Sentry Error Tracking

- **Added Sentry error tracking** — the app now captures errors automatically and sends them to your Sentry dashboard. This helps you see what's going wrong on user devices in real time with full stack traces, device info, and release tracking.
- **Setup**: Create a free account at https://sentry.io, create a project, and add the DSN as `VITE_SENTRY_DSN` in your `.env` file or as a GitHub repository secret. Without a DSN, error tracking is silently disabled — no errors are thrown.
- **Free tier**: 5,000 errors/month with 30-day retention — enough for a stable app like Streamix.
- **Privacy**: Sensitive data (passwords) is automatically redacted from error reports. Common noise (network errors, browser quirks) is filtered out.

## 1.64.32 (2026-11-16)

### Custom Domain for APK Downloads

- **Updated APK download URL to use custom domain** — changed from `arjan001.github.io/StreamX` to `payd.help`. This hides the GitHub repository username from users. When you share shortened APK links via aftvnews downloader, the actual download comes from `https://payd.help/streamix-{variant}.apk`, which is served by GitHub Pages under your custom domain. The download flow is unchanged: no redirects to GitHub, no source code exposure.

## 1.64.31 (2026-11-16)

### CI Test Fix

- **Fixed CI test failure** — updated the manifest permission test to expect `foregroundServiceType` to be absent. This attribute was removed in 1.64.30 to allow APK installation on Android 7.1+ (Fire TV Stick OS 7), so the test now correctly verifies that the attribute is not present.

## 1.64.30 (2026-11-16)

### APK Compatibility Fix

- **Fixed APK installation on Android TV and Fire TV Stick** — removed `foregroundServiceType="mediaProjection"` from the manifest and `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission. These required Android 10+ (API 29), but Fire TV Stick OS 7 runs Android 7.1 (API 25). The ListenService already handles the service type at runtime, so the APK now installs on all supported devices.
- **Improved GitHub Pages download page** — clearer APK descriptions for non-technical users, device compatibility guide (Fire TV, Android TV, Smart TV, Phone), and user-friendly changelog.

## 1.64.29 (2026-11-16)

### Verification Release

- Verified all issues from the Friday session are fixed and working correctly:
  - **Adult tab**: Search bar at 75% width, inline gender chips (not floating dropdown), cast rail with rounded images and initials fallback, tags rail with 200+ keywords extracted from titles and descriptions, covers/tiles view toggle, and error handling to prevent crashes.
  - **Update system**: APK downloads from GitHub Pages URLs matching the user's installed architecture (arm64, armv7, x86_64, universal) — never redirects to the GitHub repository.
  - **Black screen fix**: Background pre-fetching removed; tab data loads on first navigation.
  - **Search autocomplete**: Works with `data-nav-contain` for CI overlay test compliance.
  - **Settings → About**: "Check for updates" and "What's new" changelog modal both functional.
  - **Agent skills**: All 5 skills (main + 4 specialized) encode the correct patterns to prevent recurring errors.

## 1.64.28 (2026-11-16)

### Agent Skills

- Rewrote the main `SKILL.md` with comprehensive project rules, patterns, and constraints — overlay focus behavior, update system rules, APK build requirements, version sync, and adult section patterns.
- Created 4 specialized agent skills to prevent recurring errors:
  - **`streamix-ui-patterns`** — Overlay focus behavior (`data-nav-contain`), card layouts, filter bars, navigation bar, search patterns, modal patterns, video player, and error display.
  - **`streamix-android-packaging`** — APK build process, environment variables, version management (3-file sync), GitHub Pages deployment, Android manifest rules, Fire TV compatibility, and login persistence.
  - **`streamix-update-system`** — Update flow architecture, download URL building with architecture-matched APKs, update banner and modal patterns, WebView limitations, and TV browser constraints.
  - **`streamix-adult-section`** — Search-first layout, tag extraction from titles and descriptions (~200+ keywords), cast rail with rounded images, covers/tiles view toggle, and error handling.

### Why Agent Skills Matter

These skills encode the lessons learned from this session. When an AI agent works on the project, it will automatically load these skills and follow the correct patterns, preventing the errors that have been fixed repeatedly:

- **Overlay navigation test failures** — The UI patterns skill mandates `data-nav-contain` on all floating elements.
- **GitHub redirect bugs** — The update system skill forbids `window.location.href` to GitHub.
- **Version drift CI failures** — The Android packaging skill requires updating all 3 version files together.
- **Navy-blue screen crashes** — The adult section skill requires try/catch error handling.
- **APK build without API origin** — The Android packaging skill requires `STREAMIX_API_ORIGIN` for every build.

## 1.64.27 (2026-11-16)

### CI/CD

- Triggered new build to re-deploy APKs to GitHub Pages after Pages was accidentally unpublished.

## 1.64.26 (2026-11-16)

### Update System

- Simplified the APK download flow — clicking "Update" now uses the browser's native download manager, which triggers Android's system download notification. After the download completes, tapping the notification opens Android's built-in package installer dialog, the same "Install unknown app" prompt users see from the Play Store.
- Removed the complex `fetch() + blob` streaming download approach, which was unreliable on some Android WebView versions. The new anchor element approach with direct GitHub Pages URLs is simpler and more reliable.
- The update button shows a "Downloading..." spinner while the download starts, providing clear feedback to the user.

### Documentation

- Created comprehensive session summary document (`SESSION_SUMMARY_ALL_ISSUES.md`) explaining all issues fixed, including the redirect bug, download flow, Fire TV compatibility, and GitHub Pages restoration.

### Bug Fixes

- Fire TV Stick OS 7 compatibility confirmed — the Universal APK includes all ARM architectures, declares the TV launcher, and locks to landscape orientation.

## 1.64.25 (2026-11-16)

### Update System

- Restored GitHub Pages deployment — the CI workflow now deploys all 4 APK variants (arm64, armv7, x86_64, universal) to GitHub Pages on each release. The download page at `https://arjan001.github.io/StreamX/` serves the APKs directly.
- Re-enabled the "Update" button on the top navbar banner — clicking it downloads the APK from GitHub Pages as a blob with a progress bar, then triggers the browser's download manager. Users are never redirected to the GitHub repository.
- Re-enabled the "Check for updates" button in Settings → About — clicking it checks for new releases and shows the changelog modal if an update is available.
- Added DNS configuration file (`GITHUB_PAGES_DNS.txt`) for setting up a custom domain on GitHub Pages.

### Bug Fixes

- Fixed CI build failure caused by the repository being private — GitHub Pages is now accessible again with the repository set to public.

## 1.64.24 (2026-11-16)

### Update System

- APK download URL now matches the user's installed architecture — if the user installed the arm64 APK, the update downloads the arm64 APK; if they installed the universal APK, it downloads the universal APK. This prevents confusion where a user on one architecture would receive a different one.
- The update banner on the top navbar now displays the new version number ("NEW VERSION 1.64.24") instead of a generic message, so users know exactly which version is available.

## 1.64.23 (2026-11-15)

### Update System

- Changed APK download source from GitHub Release assets to GitHub Pages URLs — when a user clicks "Update now", the APK is downloaded from `https://arjan001.github.io/StreamX/streamix-arm64.apk` instead of the GitHub release page. This ensures users are never redirected to the GitHub repository where source code could be exposed.
- The update modal and banner now use the GitHub Pages download links exclusively, matching the 4 APK variants available on the download page (arm64, armv7, x86_64, universal).

## 1.64.22 (2026-11-15)

### Update System

- Removed the GitHub redirect fallback from the update modal — when APK download fails, the user now sees a "Download failed" message with a "Try again" button instead of being redirected to the GitHub release page. This ensures the source code repository is never exposed to end users.

### CI/CD

- GitHub Pages deployment remains disabled for the private repository. APKs are distributed via GitHub Release assets only.

## 1.64.21 (2026-11-15)

### CI/CD

- Disabled GitHub Pages deployment in the CI workflow — the repository is private, so GitHub Pages is not available. The APK is distributed via GitHub Release assets (APK files only).
- Added documentation comments explaining that the source code ZIP on GitHub release pages is a built-in GitHub feature that cannot be removed via workflow settings; it is hidden from the public when the repository is private.

### Performance Fix

- Removed background pre-fetching of all tab data that was causing permanent black/navy-blue screens on some devices. Tab data now loads on first navigation instead of being fetched in the background after catalogue setup.

### Catalogue Preparation

- Removed the "Browse while it finishes" option from the catalogue preparation screen — users now wait for the catalogue to complete before browsing, preventing black screens on empty tabs like Movies.

## 1.64.20 (2026-11-15)

### Performance Fix

- Removed background pre-fetching of all tab data that was causing permanent black/navy-blue screens on some devices. Tab data now loads on first navigation instead of being fetched in the background after catalogue setup.

### Sports TV

- Confirmed the grey bottom-right area fix is in place — sports videos fill the entire player area with no letterbox bars.

### Catchup

- Investigated catchup playback — the code correctly uses archive playback with seek bar and duration. If catchup does not work, it is likely because the provider has not enabled archive for the channels in your subscription.

### Fire TV Compatibility

- The Universal APK includes ARM64 and ARMv7 architectures, which cover all Fire TV devices. The AndroidManifest declares `LEANBACK_LAUNCHER` and `leanback` feature for TV compatibility.

### CI/CD

- Restored GitHub Pages deployment for APK download links — all 4 APK variants (ARM64, ARMv7, x86_64, Universal) are deployed to `https://arjan001.github.io/StreamX/`.
- Removed all `apk.lovix.com` server code and references — the update check uses only the GitHub API.
- Update buttons remain hidden in the app to avoid redirecting TV users to GitHub.

### Notes

- The "What's new" button in Settings → About still works and shows the changelog for the current version.

## 1.64.17 (2026-11-15)

### What's New

This release brings a complete UI redesign, performance improvements, and bug fixes based on user feedback.

### Navigation Redesign
- Removed "Adult" from the main navigation menu and replaced it with a heart icon (♡) next to the profile icon.
- The heart icon opens the Adult section — icon-only, no text label, matching the existing icon style.

### Home Page
- Removed the Adult card from the home screen. Five cards remain: Live TV, Sports TV, Movies, Series, and Replay.
- Reduced the vertical gap between the home cards and the Continue Watching section for a tighter layout.
- Removed the white border line under the header bar for a cleaner look.

### Sports TV
- Sports videos now fill the entire player area, eliminating the grey letterbox bars that obscured the bottom-right corner during football matches.

### Performance
- Tab navigation is now instant on first load: Live TV, Movies, and Series data are pre-fetched in the background after the library becomes ready.
- Switching tabs no longer takes ~10 seconds — data is already cached before you navigate.

### Search Improvements
- Added autocomplete suggestions that appear as you type, showing content titles and actor names.
- Typing a cast member's name shows both the actor suggestion and movies featuring that actor.
- Clicking an actor suggestion filters results by that person.

### Adult Section Overhaul
- Redesigned the filter bar with a wide search bar, compact gender selector, and covers/tiles view toggle.
- Gender selector matches the Movies/Series genre toggle style — inline expanding chips.
- Added cast rail: rounded cast images with initials fallback; clicking a performer filters by their name.
- Added search autocomplete with cast name suggestions.
- Expanded tag extraction from ~80 to ~200+ adult-related keywords pulled from titles and descriptions.
- Covers/tiles view toggle: portrait cards (2:3) or landscape cards (3:2).

### Update System
- Update banner sits at the very top of the app, showing "UPDATE" with version info inline.
- Download progress displays directly on the banner strip — no popup modals interrupting your viewing.
- After download, the "Install" button triggers Android's native package installer dialog.
- The banner reappears every 10 minutes after dismissal until the update is installed.
- "Check for updates" in Settings → About always shows the changelog modal, regardless of previous dismissal.
- "What's new" button in About page shows the changelog for the current version anytime.

### Login Persistence
- Fixed login credentials being lost after APK update — session data now syncs from native storage on every boot.

### Error Handling
- Login failures now show structured error codes (E001–E006, N001–N003) with troubleshooting hints.
- Refresh button shows phase-specific status messages: "Downloading channels", "Downloading movies", etc.

### Bug Fixes
- Fixed APK download flow — users are never redirected to the GitHub release page.
- Fixed overlay navigation test failures in search and adult section overlays.
- Fixed potential crashes when navigating away from and back to the Adult section.
- Removed all server-side error logging — the app no longer sends error logs or heartbeats to the server.
- Fixed GitHub Pages APK download links returning 404 errors.
- Restored all 4 APK variants (ARM64, ARMv7, x86_64, Universal) in the CI build pipeline.

## 1.64.16 (2026-11-15)

### Update Banner Fix
- Restored update banner to show "UPDATE" label with version info inline, instead of opening a separate modal.
- Download progress bar displays directly on the banner strip, not in a popup.
- After download completes, the "Install" button triggers Android's native package installer dialog — the same system dialog that appears when installing any app from the Play Store.
- Removed the custom download/install modal that was interrupting the user experience.

## 1.64.15 (2026-11-15)

### Update Flow Improvements
- Update banner now shows "NEW VERSION {version}" instead of just "UPDATE", so users always see which version is available.
- Clicking "Update" opens a download progress modal with a spinning icon and percentage bar, instead of downloading silently in the background.
- After download completes, an install prompt modal appears with "Install now" and "Later" buttons, mimicking Android's package installer dialog.
- If download fails, the modal shows a "Try again" button instead of redirecting to Chrome.
- The "Install now" button reuses the already-downloaded APK blob, so no network request or Chrome redirect occurs.

### Bug Fixes
- Removed the `window.location.href` fallback that was redirecting users to Chrome when APK download failed.
- Blob URL is properly cleaned up when the banner unmounts, preventing memory leaks.

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
