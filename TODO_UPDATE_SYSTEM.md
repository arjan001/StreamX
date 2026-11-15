# TODO: Update System — Temporarily Disabled

**Date:** 2026-11-15
**Status:** Blocked — needs dedicated APK download server

## Problem

The update system currently redirects users to GitHub on TV devices (WebOS, Tizen, Android TV), exposing the private source code repository. The `fetch() + blob URL` download flow works on Android phones but not on TV browsers.

Additionally, making the GitHub repository private breaks GitHub Pages, which was our APK download portal.

## What Was Disabled

1. **UpdateBanner.tsx** — The top navbar "UPDATE" banner returns `null` (hidden).
2. **More.tsx** — The "Check for updates" button in Settings → About is hidden behind a TODO comment.
3. **main.tsx** — All three automatic update check hooks (on startup, after catalog ready, hourly) are commented out.

## Required Fix

Set up a dedicated APK download server at `apk.lovix.com` (or similar subdomain on dev.lovix.com) to serve the 4 APK variants without exposing the source code.

### Steps

1. **Create subdomain** — Add `apk.lovix.com` DNS record pointing to the VPS (83.229.83.91).
2. **Configure Nginx** — Create a new server block for `apk.lovix.com` serving static files.
3. **Update CI workflow** — Modify `.github/workflows/build-android-apk.yml` to:
   - Upload APKs to `apk.lovix.com` via SCP/SFTP after build.
   - Deploy the `docs/index.html` download page to the same server.
4. **Update app code** — Change `updateCheck.ts` to fetch release info from `apk.lovix.com/api/release.json` instead of GitHub API.
5. **Re-enable update system** — Uncomment the disabled code in UpdateBanner.tsx, More.tsx, and main.tsx.

## Alternative Options

- **Option A:** Keep GitHub repo public but remove source code ZIP from releases (only allow APK downloads).
- **Option B:** Use a private download link service (e.g., Dropbox, Google Drive) with direct download URLs.
- **Option C:** Set up the dedicated server as described above (recommended).

## Code Locations

- `apps/web/src/components/UpdateBanner.tsx` — Banner component (returns null)
- `apps/web/src/routes/More.tsx` — "Check for updates" button (hidden)
- `apps/web/src/main.tsx` — Auto update checks (commented out)
- `apps/web/src/lib/updateCheck.ts` — Fetches from GitHub API
- `apps/web/src/components/UpdateModal.tsx` — Changelog modal (still works for manual checks)
- `.github/workflows/build-android-apk.yml` — CI build and deploy workflow
- `docs/index.html` — Download page HTML
