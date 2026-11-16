# Streamix Android Packaging

This skill documents the APK build process, version management, and GitHub Pages deployment. Follow these rules to ensure successful CI builds and working APK downloads.

## 1. APK Build Process

### Environment Variables (REQUIRED)
Building the APK without these variables causes critical failures:

```bash
STREAMIX_API_ORIGIN=https://dev.lovix.com
```

**Without `STREAMIX_API_ORIGIN`:**
- Logs use `https://localhost` — no server receives them
- Update checks fail silently
- Version string is empty ("development build")

### Build Commands

```bash
# Full Android build (all 4 APK variants)
pnpm --filter @iptv/mobile build:android

# Debug APK only
pnpm --filter @iptv/mobile apk

# Release bundle (Google Play)
pnpm --filter @iptv/mobile bundle
```

### APK Variants
The build produces 4 APKs:
1. `app-debug-arm64-v8a.apk` — ARM64 (recommended for most devices)
2. `app-debug-armeabi-v7a.apk` — ARMv7 (older devices)
3. `app-debug-x86_64.apk` — x86_64 (emulators, Chromebooks)
4. `app-debug-universal.apk` — Universal (all architectures)

**For Fire TV Stick:** Use the Universal APK. It contains all ARM architectures and declares `LEANBACK_LAUNCHER`.

## 2. Version Management

### Three Files Must Match
These files must be updated together on every release:

1. **`version.json`** — Single source of truth
   ```json
   { "version": "1.64.27", "build": 235 }
   ```

2. **`apps/mobile/android/app/build.gradle`** — Android version
   ```gradle
   versionCode 235
   versionName "1.64.27"
   ```

3. **`CHANGELOG.md`** — Release notes
   ```markdown
   ## 1.64.27 (2026-11-16)
   ### Category
   - Change description
   ```

**CI Test:** The `version:check` test fails if `version.json` and `build.gradle` drift.

### Version Bump Commands
```bash
pnpm version:bump minor    # Raises version.json
pnpm version:apply         # Writes to build.gradle
pnpm version:check         # Verifies sync
```

## 3. GitHub Pages Deployment

### Purpose
GitHub Pages serves as the APK download portal. Users download APKs directly without seeing the source code repository.

### Download Links
- `https://arjan001.github.io/StreamX/streamix-arm64.apk`
- `https://arjan001.github.io/StreamX/streamix-armv7.apk`
- `https://arjan001.github.io/StreamX/streamix-x86_64.apk`
- `https://arjan001.github.io/StreamX/streamix-universal.apk`

### CI Workflow (`build-android-apk.yml`)
The `deploy-docs` job:
1. Downloads all 4 APK artifacts from the build job
2. Renames them to `streamix-{variant}.apk`
3. Copies them to the `site/` directory alongside `docs/index.html`
4. Deploys to GitHub Pages via `actions/deploy-pages@v4`
5. Uses `continue-on-error: true` so APK build proceeds even if Pages fails

### GitHub Pages Requirements
- Repository must be **public** for Pages to work
- Pages must be enabled in repository settings: Settings → Pages → Source → GitHub Actions
- The `docs/index.html` file is the download page

### Common Issues
- **404 on APK links:** APKs were not copied to `site/` — check artifact names match
- **Pages not deploying:** Repository is private or Pages not enabled in settings
- **Missing x86_64/universal APKs:** Gradle build only produced ARM variants

## 4. Android Manifest Rules

### Required Declarations
- `LEANBACK_LAUNCHER` category — for TV launchers
- `android.software.leanback` feature as `required="false"` — runs on phones and TVs
- `android.hardware.touchscreen` as `required="false"` — Fire TV has no touchscreen
- `android:screenOrientation="sensorLandscape"` — TV is always landscape
- `android:banner="@drawable/tv_banner"` — TV banner icon

### Forbidden Permissions
The CI test (`origins.test.mjs`) checks that `AndroidManifest.xml` does **not** contain:
- `REQUEST_INSTALL_PACKAGES` — allows silent APK installation

**Why forbidden:** A WebView-based app cannot programmatically trigger the package installer. The browser's download manager is the only reliable method.

## 5. Fire TV Compatibility

### Verified Working
The Universal APK is fully compatible with Fire TV Stick OS 7 (Android 9):
- NDK includes `arm64-v8a` and `armeabi-v7a` — all Fire TV devices use ARM
- Manifest declares `LEANBACK_LAUNCHER` and `leanback` feature
- Landscape orientation lock
- TV banner icon

### Recommendation
For Fire TV users, use the **Universal APK** (`streamix-universal.apk`).

## 6. Login Persistence After APK Update

### Problem
On APK update, Android clears the WebView's localStorage but preserves Capacitor Preferences.

### Solution
`kv.ts` syncs Capacitor Preferences → localStorage on every native boot. The durable Preferences data (containing session digest and provider credentials) is restored to localStorage, so credentials survive updates.

### Key File
- `apps/web/src/lib/kv.ts` — The sync logic

## 7. CI Workflow Structure

### Jobs
1. **test** — Runs unit tests
2. **typecheck** — TypeScript compilation check
3. **build-apk** — Builds all 4 APK variants
4. **create-release** — Creates GitHub tag and release with CHANGELOG.md body
5. **deploy-docs** — Deploys APKs to GitHub Pages (continue-on-error: true)

### Critical Rules
- All jobs must pass except `deploy-docs` (continue-on-error)
- APK artifacts are uploaded per-variant, not as a single wildcard
- Release body uses `body_path: CHANGELOG.md`
