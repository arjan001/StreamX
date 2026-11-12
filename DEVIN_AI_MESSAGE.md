# Message for Devin AI

## Context: APK Build Revert to Debug Mode

We recently reverted the Android APK build from `release` mode back to `debug` mode in `.github/workflows/build-android-apk.yml` because the release builds were causing APK installation failures on devices. The release builds introduced signing requirements and configuration issues that prevented the APK from installing properly.

### What we changed:
- Switched from `assembleRelease` to `assembleDebug` in the Gradle build command
- Removed the signing keystore generation step (not needed for debug builds)
- Updated all artifact paths from `release` to `debug` directories
- Kept `VITE_APP_BUILD: '1'` environment variable so error reports continue to be sent via beta mode
- Added `x86_64` to ABI filters in `apps/mobile/android/app/build.gradle` for emulator support

---

## Architecture Clarification (IMPORTANT)

**Two completely separate URL systems:**

1. **Logs only → `https://dev.lovix.com`**
   - This is where error logs are sent via `/api/log/batch`
   - Set by `STREAMIX_API_ORIGIN` in the workflow, mapped to `VITE_API_ORIGIN` in the build
   - The `apiUrl()` function in `api.ts` prefixes this origin to log endpoints

2. **Catalogue & videos → User-added provider URLs**
   - Examples: `http://line.istreamix.com`, `http://vpn.istreamix.com`, `http://vpn.new4k-tx.site`, `http://line.trexottvendor.store`, `http://vpn.trexottvendor.store`
   - Defined in `apps/web/src/lib/providerUrls.ts` as hardcoded fallbacks
   - Users only enter username/password on login; the provider URLs are baked in
   - The catalogue is fetched from these providers, NOT from dev.lovix.com

**dev.lovix.com is NOT used for catalogue or video content.** It's only for receiving error logs.

---

### The beta mode error reporting:
In `apps/web/src/lib/errorReports.ts`, the `IS_BETA` flag is set to `true` when:
- `NATIVE` is true (i.e., `VITE_PLATFORM === 'capacitor'`)
- `BUILD` is not empty (i.e., `VITE_APP_BUILD` is set)

Since we set `VITE_APP_BUILD: '1'` in the workflow, and the mobile build script sets `VITE_PLATFORM=capacitor`, the `IS_BETA` flag should be `true`, which means error reporting should be automatically enabled without needing server config.

### The issues:
1. **Catalogue loading is very slow** - The app installs correctly but takes forever to load the catalogue. This is likely because the **provider URLs** (line.istreamix.com, etc.) are slow or unreachable, NOT dev.lovix.com. The app tries to authenticate and fetch the catalogue from these Xtream provider URLs.

2. **No logs are being received on the server** - Despite the beta mode being enabled, we're not seeing any error logs at `https://dev.lovix.com/api/log/batch`.

### Questions for Devin AI:
1. **Why are we not receiving logs at dev.lovix.com?** The build should have `VITE_API_ORIGIN=https://dev.lovix.com` set. Is the error reporting initializing correctly? Is the `IS_BETA` flag actually `true` in the built APK?
2. **Is the `IS_BETA` flag being set correctly?** Can we verify that `VITE_PLATFORM=capacitor` and `VITE_APP_BUILD=1` are both present in the built app's JavaScript?
3. **Why is the catalogue loading so slowly?** The providers (line.istreamix.com, etc.) might be slow, unreachable, or the credentials might be invalid. The app needs to successfully authenticate with one of these providers before it can load any catalogue.
4. **Can we add debug logging** to confirm the error reporting is actually trying to send logs?

### Key files:
- `.github/workflows/build-android-apk.yml` - Build workflow (sets STREAMIX_API_ORIGIN for logs)
- `apps/mobile/package.json` - Mobile build script (maps STREAMIX_API_ORIGIN → VITE_API_ORIGIN)
- `apps/web/src/lib/errorReports.ts` - Error reporting logic (sends to dev.lovix.com)
- `apps/web/src/lib/api.ts` - API URL configuration (apiUrl() function)
- `apps/web/src/lib/providerUrls.ts` - Provider URLs for catalogue (line.istreamix.com, etc.)
- `apps/web/src/lib/session.ts` - Login/authentication with providers
