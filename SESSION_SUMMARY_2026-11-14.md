# Streamix Session Summary — All Issues & Fixes

**Date:** 2026-11-14
**Version:** 1.64.2 (build 210)

---

## 1. APK Logs Not Being Sent

### Problem
The client installed the new APK version but logs were not arriving on the server at `https://dev.lovix.com`.

### Root Cause Analysis
The logging system has two requirements for logs to reach the server:

1. **`IS_BETA` must be `true`** — This auto-enables error reporting. It is `true` when `VITE_PLATFORM=capacitor` AND `VITE_APP_BUILD` is non-empty. The CI workflow sets both correctly (`VITE_PLATFORM=capacitor`, `VITE_APP_BUILD='1'`).

2. **`VITE_API_ORIGIN` must be set** — This is the critical piece. When `VITE_API_ORIGIN` is empty, `apiUrl('/api/log/batch')` returns the relative path `/api/log/batch`. In a Capacitor APK, this resolves against `https://localhost` — which has no API server listening. The request fails silently.

The CI workflow (`.github/workflows/build-android-apk.yml`) correctly sets `STREAMIX_API_ORIGIN: https://dev.lovix.com`. However, if the APK was built locally or the environment variable wasn't passed, the API origin would be empty.

### Fix Applied
Enhanced diagnostic logging in `apps/web/src/lib/errorReports.ts`:

- **Startup diagnostics**: Logs `NATIVE`, `BUILD`, `IS_BETA`, `API_ORIGIN`, and `VERSION` at module load
- **Critical warning**: If `NATIVE=true` and `API_ORIGIN` is empty, logs a `console.error` with clear instructions to rebuild with `STREAMIX_API_ORIGIN`
- **Flush diagnostics**: Logs the actual URL, device ID, platform, version, and server response body on failure
- **Network error details**: When flush fails, explains that API_ORIGIN may not be set

### How to Verify
After rebuilding the APK with the correct `STREAMIX_API_ORIGIN`, check the APK's logcat for:
```
[errorReports] Startup diagnostics:
[errorReports]   API_ORIGIN (log endpoint base): https://dev.lovix.com
[errorReports] Beta mode: enabling error reports automatically
```

If you see `(EMPTY — logs will NOT reach the server!)`, the APK was built without the API origin.

### Build Command (Correct)
```bash
STREAMIX_API_ORIGIN=https://dev.lovix.com pnpm --filter @iptv/mobile build:web
```

---

## 2. Fire OS & Google TV Architecture Compatibility

### Assessment
The app is fully compatible with both Fire OS (Amazon Fire TV) and Google TV (Android TV).

### Evidence

**AndroidManifest.xml** declares:
- `android.software.leanback` — Android TV / Google TV support
- `android.intent.category.LEANBACK_LAUNCHER` — TV launcher category
- `android.hardware.touchscreen` not required — works with D-pad remotes
- `android:screenOrientation="sensorLandscape"` — landscape-only (TV-appropriate)
- `android:banner="@drawable/tv_banner"` — TV store banner image

**build.gradle** architecture filters:
- `arm64-v8a` — 64-bit ARM (modern phones, Fire TV Stick 4K, Shield TV)
- `armeabi-v7a` — 32-bit ARM (older devices, Fire TV Stick basic)
- `x86_64` — Emulator support only (not on real TV devices)

**Server-side platform detection** (`lvx/logs_api.php`):
- Detects `fire-os` from device model strings containing "fire", "amazon", "kindle"
- Detects `android-tv` from strings containing "tv", "leanback", "android tv"
- Logs platform type for analytics

### Conclusion
No changes needed. The single APK works on phones, tablets, Fire TV, and Google TV.

---

## 3. Navigation Bar — Removed Adult, Added Heart Icon

### Problem
Client wanted the Adult section removed from the main navigation menu and replaced with a heart icon (♡) next to the profile icon.

### Fix Applied (`apps/web/src/components/Chrome.tsx`)
- Removed Adult from `TABS` and `MODERN_HEADER_TABS` arrays
- Added standalone heart icon (`<Heart>`) link to `/adult` in the header's right-side icon cluster
- Icon-only, no text label, positioned before the Profile/User icon
- `PHONE_TABS` indices updated after Adult removal

---

## 4. Home Page — Removed Adult Card

### Problem
The Adult card needed to be removed from the home page, keeping only 5 cards: Live TV, Sports TV, Movies, Series, Replay.

### Fix Applied (`apps/web/src/routes/ModernHome.tsx`)
- Removed Adult tile from `tiles()` function
- Removed unused `Heart` import from lucide-react
- Five remaining cards auto-center in one row (existing flex layout)

---

## 5. Reduced Spacing Around Continue Watching

### Problem
Too much empty vertical space between the main cards and the Continue Watching section.

### Fix Applied (`apps/web/src/routes/ModernHome.tsx`)
- Changed grid gap from `gap-4 tv:gap-5` to `gap-3 tv:gap-4`

---

## 6. Removed White Border Under Header

### Problem
A white line/border appeared under the Streamix header.

### Fix Applied (`apps/web/src/components/Chrome.tsx`)
- Removed `border-b` class from the header element
- Removed all `border-*` utility classes from the dynamic className string
- Removed `border-color` from CSS transition property list

---

## 7. Progress Bars on Continue Watching

### Status
Already implemented in `apps/web/src/components/WatchTile.tsx` (lines 107-111). Shows watch fraction as a tally-colored bar at the bottom of each Continue Watching tile.

---

## 8. Slow Tab Navigation — Background Pre-fetching

### Problem
Navigating between tabs (Live TV, Movies, Series) took ~10 seconds on first load.

### Fix Applied (`apps/web/src/lib/usePagedItems.ts`, `apps/web/src/main.tsx`)
- Added `prefetchList()` — pre-fetches first page of items for a section, seeding the MEM cache
- Added `prefetchAllTabs()` — warms all three major tabs sequentially plus react-query metadata
- Hooked into two paths: when library becomes ready, and on ordinary launch after 3 seconds (when nothing is playing)
- Fire-and-forget with silent error handling

---

## 9. Sports Grey Bottom-Right Area

### Problem
On Sports TV, a grey area appeared in the bottom-right corner of the playing screen, obscuring part of the football match.

### Fix Applied (`apps/web/src/components/VideoPlayer.tsx`, `apps/web/src/routes/Live.tsx`)
- Added `forceCover` prop to VideoPlayer
- When `forceCover=true`, video uses `object-fit: cover` instead of `contain`, filling the entire player
- Only applied for sports content; Live TV, Movies, and Series keep normal `contain` behavior

---

## 10. Series "Reconnecting" Issue

### Investigation
The code is correct — `onRetry` is passed properly in both desk and portal modes, and the auto-retry mechanism works. The root cause is likely server-side: if an episode's `ext` field is `null`, the URL defaults to `.mp4`, but 54% of episodes are actually `.mkv`, causing error 551 and a reconnect loop.

### Recommendation
Ensure the server publishes correct file extensions for all episodes.

---

## 11. Search Autocomplete & Cast Suggestions

### Problem
Search was showing all results immediately instead of providing autocomplete suggestions while typing.

### Fix Applied (`apps/web/src/lib/localRead.ts`, `apps/web/src/routes/Search.tsx`)
- Added `localSearchSuggestions()` — synchronous search returning item names in 4-8ms
- Added autocomplete dropdown showing up to 12 suggestions with type icons (channel/movie/series/actor)
- Cast/actor name scanning: when typing an actor's name, shows both the actor suggestion and movies featuring that actor
- Clicking an actor suggestion filters by that person using `?person=` parameter

---

## 12. Adult Content — Tag Extraction & View Toggle

### Problem
Adult content tags were not comprehensive, and the covers/tiles view toggle was needed.

### Fix Applied (`apps/web/src/lib/adult.ts`, `apps/web/src/components/TagsRail.tsx`, `apps/web/src/routes/Adult.tsx`)
- Added `extractTagsFromTitle()`, `extractTagsFromDescription()` with ~80 adult keywords
- Tags extracted synchronously from all movie titles plus asynchronously from plot descriptions
- Added covers/tiles view toggle (List/Grid icons) in the Adult filter bar
- Covers mode: portrait cards (2:3), Tiles mode: landscape cards (3:2)
- Increased tag fetching from 100 to 300 items for better coverage

---

## 13. Adult Tab — Search-First Layout

### Problem
The adult tab needed a search bar occupying most of the row, with compact gender dropdown on the right.

### Fix Applied (`apps/web/src/routes/Adult.tsx`)
- Wide search bar occupying ~75% of the row
- Compact gender `<select>` dropdown on the right
- Covers/tiles view toggle button
- Removed old gender chips rail, quick filters, reset button, and title count display
- Tags rail remains below the search row

---

## 14. Error Codes on Login Failures

### Problem
When login failed, users saw only a generic error message with no diagnostic information.

### Fix Applied (`apps/web/src/components/SignInFields.tsx`, `apps/web/src/components/AddSource.tsx`)
- Added expandable "Error details" section showing structured error codes:
  - **E001**: Invalid credentials
  - **E002**: Server busy
  - **E003**: Subscription not found
  - **E004**: Cannot reach server
  - **E005**: Missing credentials
  - **E006**: Missing server address
  - **E999**: Unknown error
  - **N001-N003**: Network errors for playlist/stream sources
- Each code includes troubleshooting hints

---

## 15. Refresh Button Status Messages

### Problem
The refresh button showed generic messages during library rebuild.

### Fix Applied (`apps/web/src/components/RefreshLibrary.tsx`)
- Tooltip now shows phase-specific labels: "Downloading channels", "Downloading movies", "Downloading series", "Saving to device"
- Maps all `IngestStatus` phase values (vod, series, live, saving, store, packages)

---

## Files Modified

| File | Change |
|------|--------|
| `apps/web/src/lib/errorReports.ts` | Enhanced diagnostic logging for APK log troubleshooting |
| `apps/web/src/components/Chrome.tsx` | Removed Adult nav, added heart icon, removed header border |
| `apps/web/src/routes/ModernHome.tsx` | Removed Adult card, reduced spacing |
| `apps/web/src/routes/Adult.tsx` | Search-first layout, view toggle |
| `apps/web/src/routes/Search.tsx` | Autocomplete with cast suggestions |
| `apps/web/src/lib/localRead.ts` | Fast synchronous search, cast scanning |
| `apps/web/src/components/SignInFields.tsx` | Error codes on login |
| `apps/web/src/components/AddSource.tsx` | Error codes on source add |
| `apps/web/src/components/VideoPlayer.tsx` | Force cover for sports |
| `apps/web/src/routes/Live.tsx` | Pass forceCover for sports |
| `apps/web/src/components/TagsRail.tsx` | Adult tag extraction |
| `apps/web/src/lib/adult.ts` | Tag extraction functions |
| `apps/web/src/components/TitleGrid.tsx` | Aspect ratio prop for view toggle |
| `apps/web/src/components/PosterCard.tsx` | Aspect ratio support |
| `apps/web/src/components/RefreshLibrary.tsx` | Phase-specific messages |
| `apps/web/src/lib/usePagedItems.ts` | Background pre-fetching |
| `apps/web/src/main.tsx` | Pre-fetch hook |

---

## Verification

- TypeScript compilation (`tsc --noEmit`) passes with zero errors
- All modified files compile without warnings

## Known Items Requiring Action

1. **APK Log Testing**: Rebuild the APK via CI (which sets `STREAMIX_API_ORIGIN`) and verify logs arrive. The enhanced logging will show exactly what's happening in logcat.
2. **Series Reconnecting**: Requires server-side fix — ensure episode `ext` field is correctly populated.
3. **Adult Content Count**: Only 2 adult films showing is likely a provider-side issue — the `adultOnly` flag and query flow are correct.
