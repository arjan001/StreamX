# Streamix Update System

This skill documents the update system architecture, constraints, and patterns. The update system allows users to check for and download new APK versions without ever being redirected to the GitHub repository.

## 1. Core Constraint — NEVER Redirect to GitHub

**Rule:** Users must never be redirected to the GitHub repository page (release tags, source code ZIP, etc.).

**Why:** The client made the repository private to prevent source code exposure. Even when public, redirecting users to the release page shows the source code ZIP download link.

**How:**
- APK downloads from GitHub Pages: `https://arjan001.github.io/StreamX/streamix-{variant}.apk`
- Uses anchor element download — no browser navigation
- On failure, show "Download failed" with "Try again" — **never** `window.location.href` to GitHub

## 2. Update Flow Architecture

### Components
1. **`updateCheck.ts`** — Checks for new versions, builds download URLs
2. **`updateState.ts`** — Shared store for update state across components
3. **`UpdateBanner.tsx`** — Top banner showing "NEW VERSION {version}" with Update button
4. **`UpdateModal.tsx`** — Full changelog modal for manual "Check for updates" in Settings

### Flow
```
1. App starts → checkForUpdate() fetches latest GitHub release tag
2. Compares version → if newer and not dismissed, sets release in shared store
3. UpdateBanner reads store → shows "NEW VERSION {version}" banner
4. User clicks "Update" → anchor element triggers browser download manager
5. Android shows download notification → user taps it
6. Android opens built-in package installer → user confirms update
```

### Key Files
- `apps/web/src/lib/updateCheck.ts` — Version check, download URL building
- `apps/web/src/lib/updateState.ts` — Shared store
- `apps/web/src/components/UpdateBanner.tsx` — Top banner
- `apps/web/src/components/UpdateModal.tsx` — Changelog modal
- `apps/web/src/routes/More.tsx` — "Check for updates" button in Settings

## 3. Download URL Building

### Architecture-Matched Downloads
The `detectApkVariant()` function reads the device's User-Agent to determine the installed APK variant:

```
User-Agent contains "arm64-v8a" → streamix-arm64.apk
User-Agent contains "armeabi-v7a" → streamix-armv7.apk
User-Agent contains "x86_64" → streamix-x86_64.apk
Unknown architecture → streamix-universal.apk
```

This ensures the update downloads the matching architecture, so users never download the wrong APK variant.

### GitHub Pages Base URL
```typescript
const PAGES_BASE = 'https://arjan001.github.io/StreamX';
const downloadUrl = `${PAGES_BASE}/streamix-${variant}.apk`;
```

The GitHub API is used only to check for new version tags and changelog body, not for APK downloads.

## 4. Update Banner

### Design
- Shows "NEW VERSION {version}" at the top of the app, above the navbar
- "Update" button triggers the download
- "X" dismiss button hides the banner
- Banner reappears after 10 minutes if dismissed

### Download Flow
1. User clicks "Update"
2. Anchor element with `download` attribute triggers browser download manager
3. Button shows "Downloading..." spinner
4. After 2 seconds, button returns to "Update" state
5. Android shows download notification in status bar
6. User taps notification → Android opens package installer

### Dismiss Behavior
- `dismissVersion()` stores a timestamp with 10-minute expiry
- After 10 minutes, the banner reappears if the user hasn't installed the update
- `forceCheckForUpdate()` bypasses the dismiss flag for manual checks

## 5. Update Modal (Settings → About)

### "Check for updates" Button
- Uses `forceCheckForUpdate()` — bypasses dismiss flag
- Always shows the changelog modal if a newer version exists
- No timer — works anytime the user clicks it

### "What's new" Button
- Shows the changelog for the current version
- Bundled from `CHANGELOG.md` via raw string import
- `getChangelogForVersion()` extracts the section for any version

### Modal Sizing
- Responsive: `max-w-[26rem]` mobile, `tv:max-w-[36rem]` TV
- Uses `data-nav-contain` for overlay test

## 6. WebView Limitations

### Why No Auto-Install
A WebView-based app (Capacitor) runs inside Android's WebView, which is essentially a browser. Unlike a native Android app with `REQUEST_INSTALL_PACKAGES` permission, a WebView cannot:
- Programmatically trigger the package installer
- Bypass the "Install unknown app" system dialog
- Detect when a download completes

### The Solution
The browser's download manager is the standard and only reliable way to handle APK downloads in this architecture. The system download notification and package installer dialog are the same UI elements users see when downloading any APK from Chrome or any other browser on Android.

## 7. TV Browser Limitations

### Problem
On TV browsers (WebOS, Tizen, Android TV), the anchor element download approach may not work. The browser may redirect to the GitHub Pages URL instead of downloading the APK.

### Current State
The update banner is present but the download flow may not work on all TV browsers. Users on TV should download the APK manually from the GitHub Pages URL.

## 8. Common Mistakes

### Redirecting to GitHub
**Never do this:**
```typescript
window.location.href = release.html_url; // WRONG — redirects to GitHub
```

**Do this instead:**
```typescript
const a = document.createElement('a');
a.href = release.download_url; // GitHub Pages URL
a.download = `streamix-${release.version}.apk`;
a.click();
```

### Missing `data-nav-contain`
The update modal must have `data-nav-contain` on its overlay element to pass the CI test.

### Using GitHub Release Asset URLs
**Never do this:**
```typescript
const url = asset.browser_download_url; // WRONG — GitHub release asset
```

**Do this instead:**
```typescript
const url = `${PAGES_BASE}/streamix-${variant}.apk`; // GitHub Pages URL
```
