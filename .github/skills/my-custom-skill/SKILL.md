# Streamix — Project Rules and Patterns

Streamix is a React + TypeScript media player packaged via Capacitor (WebView) for Android, and natively for Samsung Tizen and LG webOS. It plays live TV, movies, and series from user-added sources (Xtream, M3U, Stalker).

**This document encodes the project's critical rules, patterns, and constraints.** Follow these rules to avoid the errors that have been fixed repeatedly in this project.

## Critical Rules — DO NOT VIOLATE

### 1. Overlay Focus Behavior (CI Test Requirement)
**Every floating element** (`z-40`, `z-50`, `z-[80]`, etc.) that sits above the app frame **must** declare one of:
- `data-nav-contain` — for menus/dialogs that trap focus
- `data-nav-scope` — for sections with internal navigation
- `data-nav-skip` — for decorative overlays

The CI test (`overlays.test.ts`) scans all components and **fails the build** if any floating element lacks this attribute. Always add `data-nav-contain` to dropdowns, modals, and autocomplete suggestions.

### 2. Update System — NEVER Redirect to GitHub
Users must **never** be redirected to the GitHub repository page (release tags, source code ZIP, etc.). The update flow:
- APK downloads from GitHub Pages: `https://arjan001.github.io/StreamX/streamix-{variant}.apk`
- Uses `fetch() + blob URL` or anchor element download — no browser navigation
- On failure, show "Download failed" with "Try again" — **never** `window.location.href` to GitHub
- The `updateCheck.ts` file uses `PAGES_BASE` for download URLs, not GitHub release asset URLs

### 3. APK Build — Always Set Environment Variables
Building the APK without `STREAMIX_API_ORIGIN` causes:
- Logs to use `https://localhost` (no server)
- Update checks to fail silently
- Empty version string ("development build")

Always build with: `STREAMIX_API_ORIGIN=https://dev.lovix.com`

### 4. Version Sync — Three Files Must Match
`version.json`, `build.gradle` (versionCode + versionName), and `CHANGELOG.md` must be updated together. The CI test fails if they drift.

### 5. Android Manifest — No Forbidden Permissions
The CI test (`origins.test.mjs`) checks that `AndroidManifest.xml` does **not** contain `REQUEST_INSTALL_PACKAGES`. This permission is forbidden because it allows silent APK installation.

### 6. Adult Section — Distinct from Main App
The Adult section (`Adult.tsx`) has its own:
- Search-first layout (wide search bar, compact filters)
- Tag extraction from titles and descriptions (~200+ keywords)
- Cast rail with rounded images and initials fallback
- Covers/tiles view toggle (portrait vs landscape cards)
- Gender filter as inline expanding chips (not floating dropdown)

## Project Structure

```
apps/web         React frontend: all screens, player, remote handling (Vite)
apps/mobile      Capacitor shell: Android (libVLC) and iOS
apps/tizen       Samsung TV package (.wgt)
apps/webos       LG TV package (.ipk)
packages/
  core-xtream    Xtream API client
  core-m3u       M3U parser
  core-stalker   Stalker portal client
  core-store     On-device catalogue
brand.config.json  App name, colors, publisher info
version.json       Single source of truth for versioning
```

## Key Patterns

### Search Autocomplete
- Synchronous search from local catalogue via `localSearchSuggestions()`
- Shows content titles AND actor names (type 'actor')
- Clicking an actor filters by `?person=` parameter
- Dropdown must have `data-nav-contain`

### Tab Navigation
- Tab data loads on first navigation, not at startup
- Background pre-fetching was removed — it caused black screens
- Use `usePagedItems` hook with MEM cache (10-min TTL)

### Sports Video Player
- Sports content uses `forceCover={true}` on `VideoPlayer`
- This eliminates grey letterbox bars by forcing `object-fit: cover`
- Live TV, Movies, Series keep normal `contain` behavior

### Login Persistence
- Capacitor Preferences → localStorage sync on every native boot
- Credentials survive APK updates because Preferences are durable
- See `kv.ts` for the sync logic

## Build Commands

```bash
pnpm install --frozen-lockfile
pnpm web          # Dev server
pnpm typecheck    # TypeScript check — ALWAYS run before commit
pnpm test         # Unit tests
pnpm build        # Web bundle
```

## Conventions

- Comments say why, not what
- No credentials or real provider URLs in code
- Always run `tsc -b` after changes to catch type errors
- Floating overlays need `data-nav-contain`
- Update flow never redirects to GitHub
- APK build requires `STREAMIX_API_ORIGIN`
