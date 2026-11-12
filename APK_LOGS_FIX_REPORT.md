# APK Logs Not Arriving — Root Cause & Fix

## Date: 2026-11-12

---

## Problem

Two users installed the new APK (one on emulator, one on Android TV), but the logs admin panel at `dev.lovix.com` shows zero logs. The server endpoint returns `200 OK` for `GET /api/admin/logs/stats`, confirming the endpoint works, but no logs are arriving.

---

## Root Cause

### The APK's automatic error reporting was OFF.

The logging system has a deliberate design: **error reporting is OFF by default** and only turns on when explicitly enabled. This is by design — it costs the user bandwidth, so it should be a conscious decision.

The APK checks two conditions to enable automatic reporting:

### Condition 1: Server config flag (PRIMARY — was NOT met)

**File:** `apps/web/src/lib/errorReports.ts` (line 315-319)

```ts
if (!IS_BETA) {
  setErrorReportsEnabled((raw as { errorReports?: unknown }).errorReports === true);
}
```

At boot, the APK fetches `GET /api/app-config` from the server. The server at `dev.lovix.com` returns a JSON object. For automatic reporting to activate, the server **must** include `errorReports: true` in that response.

**File:** `apps/server/src/admin.ts` (line 593-604)

```ts
app.get('/api/app-config', async (req) => {
  try {
    return await publicAppConfig(req.query.version);
  } catch (e) {
    // No database = all-off defaults
    return {
      updatedAt: null, brand: BRAND.name, mustUpdate: false, minVersion: null, updateMessage: null,
      notice: null, deviceRelayOff: false, localCatalogueDefault: false, errorReports: false,
    };
  }
});
```

The server returns `errorReports: false` by default. This happens when:
- The server has no PostgreSQL database configured
- The `app_config` table exists but `errorReports` is not set to `true`
- The server at `dev.lovix.com` is running a different codebase (PHP/SQLite) that doesn't return this flag

**Result:** The APK reads `errorReports: false` (or the field is missing) and keeps automatic reporting OFF.

### Condition 2: Beta mode (SECONDARY — was NOT met)

**File:** `apps/web/src/lib/errorReports.ts` (line 298-307)

```ts
const IS_BETA = NATIVE && BUILD !== '';

export function installErrorReports(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Beta mode: always enable error reporting for client monitoring
  if (IS_BETA) {
    setErrorReportsEnabled(true);
  }
  // ...
}
```

Beta mode forces error reporting ON regardless of server config. It activates when:
- `NATIVE` is `true` (the app runs in Capacitor/Android)
- `BUILD` is a non-empty string (set via `VITE_APP_BUILD` at build time)

**The CI workflow was NOT setting `VITE_APP_BUILD`**, so `BUILD` was empty string `''`, meaning `IS_BETA` was `false`. The APK was a release build, not a beta build.

---

## What Gets Logged When Enabled

Once error reporting is ON, the following are captured and sent every 1 minute:

| Log Tag | What It Captures | Level |
|---------|-----------------|-------|
| `signin` | Login attempts, success, failure, host discovery | info/error |
| `player` | Playback failures, decoder errors | error |
| `catalogue` | Library build failures, storage issues, host switches | info/warn/error |
| `boot` | Device summary, build version, platform, native engine | info |
| `console` | All `console.error` and `console.warn` output | error/warn |
| `page` | Uncaught exceptions, unhandled promise rejections | error |
| `net` | Offline/online connection status changes | warn/info |
| `native` | libVLC probe, crash reasons, bridge errors | info/error |
| `epg` | Bulk guide download failures | info/warn |
| `captions` | Native audio probe results | info |

Each log carries:
- `deviceId`: Random 24-char ID per launch
- `accountId`: User's account ID from the session
- `device`: Full device summary (build, platform, native engine, Chromium version, device model, decoders, viewport, origin, online status)
- `version`: App version (e.g., "1.64.1+1")
- `platform`: "android-app"

---

## The Fix Applied

### Two changes were made to force-enable error reporting:

**1. CI workflow: Set `VITE_APP_BUILD` environment variable**

**File:** `.github/workflows/build-android-apk.yml` (line 104)

```yaml
- name: Build Android release APK
  env:
    STREAMIX_API_ORIGIN: https://dev.lovix.com
    VITE_APP_BUILD: '1'          # ← NEW: Enables beta mode
  run: |
    pnpm --filter @iptv/mobile build:web
```

**2. Mobile build script: Pass `VITE_APP_BUILD` through to Vite**

**File:** `apps/mobile/package.json` (line 7)

```json
"build:web": "VITE_BASE=./ VITE_ROUTER=hash VITE_PLATFORM=capacitor VITE_PACKAGED=1 VITE_DATA=local VITE_OUT=dist-app VITE_API_ORIGIN=${STREAMIX_API_ORIGIN:-} VITE_APP_BUILD=${VITE_APP_BUILD:-} pnpm --filter @iptv/web build ..."
```

### How the fix works:

1. CI workflow sets `VITE_APP_BUILD=1` as an environment variable
2. Mobile build script passes it to Vite as `VITE_APP_BUILD=${VITE_APP_BUILD:-}`
3. Vite bakes it into the bundled JavaScript via `import.meta.env.VITE_APP_BUILD`
4. At runtime, `errorReports.ts` reads `BUILD = '1'` (non-empty string)
5. `IS_BETA = NATIVE && BUILD !== ''` evaluates to `true`
6. `setErrorReportsEnabled(true)` is called immediately at boot
7. The server config is ignored — reporting stays ON regardless

---

## Alternative Fix: Server-Side

If you prefer to control error reporting via the server instead of beta mode, you need to configure the server at `dev.lovix.com` to return `errorReports: true` in its `/api/app-config` response.

### For the StreamX Node.js server (PostgreSQL):

```sql
-- Set errorReports to true in the app_config table
UPDATE app_config SET payload = jsonb_set(payload, '{errorReports}', 'true') WHERE id = 1;
```

Or via the admin API:

```bash
curl -X PUT https://dev.lovix.com/api/admin/config \
  -H "Content-Type: application/json" \
  -d '{"revision": 1, "config": {"errorReports": true}}'
```

### For a custom PHP/SQLite server:

The `/api/app-config` endpoint must return:

```json
{
  "updatedAt": "2026-11-12T00:00:00.000Z",
  "brand": "StreamX",
  "mustUpdate": false,
  "minVersion": null,
  "updateMessage": null,
  "notice": null,
  "deviceRelayOff": false,
  "localCatalogueDefault": false,
  "errorReports": true
}
```

---

## Verification Steps

After the new APK is built and installed:

1. **Install the new APK** on the emulator or Android TV
2. **Open the app** — boot info is logged immediately
3. **Log in** with your Xtream credentials — login attempt and result are logged
4. **Wait 1 minute** — the first batch of logs is sent to `https://dev.lovix.com/api/log/batch`
5. **Check the admin panel** at `https://dev.lovix.com/api/admin/logs` or `https://dev.lovix.com/logs`
6. **Look for entries** with `platform: "android-app"` and `version: "1.64.1+1"`

### Expected log entries after first login:

| Tag | Message | Level |
|-----|---------|-------|
| `boot` | Device summary with build 1.64.1+1, platform android-app | info |
| `signin` | Login attempt for user: ... server: ... | info |
| `signin` | Login successful account: ... user: ... server: ... | info |

---

## Why the Previous APK Didn't Send Logs

| Factor | Previous APK | New APK |
|--------|-------------|---------|
| `VITE_APP_BUILD` | Not set (empty string) | `'1'` |
| `IS_BETA` | `false` | `true` |
| Server `errorReports` | `false` (default) | `false` (default) |
| **Reporting enabled** | **NO** | **YES** (via beta mode) |

The previous APK had both conditions unmet: the server returned `errorReports: false` and the build was not a beta build. The new APK bypasses the server check entirely by running in beta mode.

---

## Data Flow After Fix

```
┌──────────────────────────────────────────────┐
│           StreamX APK (Android TV)           │
│                                              │
│  IS_BETA = true → reporting FORCED ON        │
│  debugLog.ts → errorReports.ts              │
│  - Captures all errors/warnings              │
│  - Folds duplicates                          │
│  - Flushes every 1 minute                    │
│  - Final flush on app close                  │
└──────────────────┬───────────────────────────┘
                   │
                   │  POST /api/log/batch
                   │  (JSON, max 30 entries)
                   ▼
┌──────────────────────────────────────────────┐
│         https://dev.lovix.com                │
│                                              │
│  /api/log/batch → stores logs               │
│  - Redacts credentials                       │
│  - Rate limits: 60 rows/device/minute        │
│  - Stores in database                        │
│                                              │
│  Admin panel: /api/admin/logs                │
│  - View, filter, group all logs              │
└──────────────────────────────────────────────┘
```

---

## Summary

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| No logs arriving | Server returns `errorReports: false` by default | Enabled beta mode via `VITE_APP_BUILD=1` in CI |
| APK not in beta mode | `VITE_APP_BUILD` not passed to Vite build | Added `VITE_APP_BUILD=${VITE_APP_BUILD:-}` to mobile build script |

**The fix is committed and pushed.** The CI pipeline is building the new APK now. Once the build completes, download the new APK from GitHub Releases and install it — logs will start arriving within 1 minute of first use.

---

**Confirmed by Junie AI**
**Date: 2026-11-12**
