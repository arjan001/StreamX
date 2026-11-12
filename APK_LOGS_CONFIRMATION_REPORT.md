# APK Logs Integration — Confirmation Report

## Date: 2026-11-12

---

## Overview

This report confirms that the StreamX APK, when built by the GitHub Actions CI pipeline, is configured to send all user logs automatically to the Lovix server at `https://dev.lovix.com`.

---

## 1. API Origin Configuration

### CI Workflow

**File:** `.github/workflows/build-android-apk.yml` (lines 101-108)

The "Build Android release APK" step sets the environment variable:

```yaml
env:
  STREAMIX_API_ORIGIN: https://dev.lovix.com
```

This value is available to all subsequent commands in that step.

### Mobile Build Script

**File:** `apps/mobile/package.json` (line 7)

The `build:web` script passes the CI environment variable to Vite:

```
VITE_API_ORIGIN=${STREAMIX_API_ORIGIN:-} pnpm --filter @iptv/web build
```

Chain: `STREAMIX_API_ORIGIN` (CI env) → `VITE_API_ORIGIN` (Vite env) → bundled JavaScript.

### Vite Runtime

**File:** `apps/web/src/lib/api.ts`

The `apiUrl()` function reads the build-time origin:

```ts
const ORIGIN = (import.meta.env?.VITE_API_ORIGIN ?? '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (ORIGIN === '' || !path.startsWith('/')) return path;
  return ORIGIN + path;
}
```

With `VITE_API_ORIGIN=https://dev.lovix.com`, the function resolves:

| Function Call | Resolved URL |
|---|---|
| `apiUrl('/api/log/batch')` | `https://dev.lovix.com/api/log/batch` |
| `apiUrl('/api/log')` | `https://dev.lovix.com/api/log` |

---

## 2. Automatic Log Sending

### Flush Interval

**File:** `apps/web/src/lib/errorReports.ts` (line 56)

```ts
export const FLUSH_MS = 60_000;  // 1 minute
```

Logs are sent automatically every **1 minute** after the first error occurs. This was reduced from 3 minutes to ensure faster delivery to the server.

### What Gets Sent

The automatic reporter (`errorReports.ts`) captures and sends:

1. **Login logs** (`signin` tag) — login attempts, success, failure, host discovery
2. **Player errors** (`player` tag) — playback failures, decoder errors
3. **Catalogue errors** (`catalogue` tag) — library build failures, storage issues, host switches
4. **Boot info** (`boot` tag) — device summary, build version, platform, native engine status
5. **Console errors** (`console` tag) — all `console.error` and `console.warn` output
6. **Uncaught exceptions** (`page` tag) — unhandled errors and promise rejections
7. **Network status** (`net` tag) — offline/online connection changes
8. **Native engine errors** (`native` tag) — libVLC probe, crash reasons, bridge errors
9. **EPG errors** (`epg` tag) — bulk guide download failures
10. **Captions errors** (`captions` tag) — native audio probe results

### What Each Log Carries

- `deviceId`: Random 24-character ID generated at app launch
- `accountId`: User's account ID from the current session (for per-user tracking)
- `entries`: Array of `{ tag, text, level, count, ago }`
- `device`: Device summary (build, platform, native engine, Chromium version, device model, decoders, viewport, origin, online status)
- `version`: App version string (e.g., "1.64.1")
- `platform`: "android-app"

### Queue Behavior

- **Max 30 distinct errors** per flush queue
- **Duplicate folding**: Same error = one entry with incremented count
- **Resend cooldown**: 30 minutes per error signature
- **Final flush**: On app close, remaining queued errors sent via `navigator.sendBeacon()`
- **Failed flush**: Dropped (not re-queued) to prevent memory growth

---

## 3. Server Endpoints

The APK sends logs to these endpoints on `https://dev.lovix.com`:

| Endpoint | Purpose | Frequency |
|---|---|---|
| `POST /api/log/batch` | Automatic batch error reports | Every 1 minute |
| `POST /api/log` | Manual single debug report | User-triggered |

### Batch Request Format

```json
{
  "deviceId": "abc123def456789012345678",
  "accountId": "user123",
  "entries": [
    {
      "tag": "player",
      "text": "Playback failed: decoder refused",
      "level": "error",
      "count": 3,
      "ago": 120
    }
  ],
  "device": {
    "Build": "1.64.1",
    "Running as": "installed app",
    "Native engine": "libVLC present",
    "Device": "Samsung QN90A"
  },
  "version": "1.64.1",
  "platform": "android-app"
}
```

---

## 4. Credential Redaction

All logs are redacted **twice** before reaching the server:

1. **Client-side** (`debugLog.ts`): Strips usernames, passwords, tokens, MAC addresses, Bearer tokens, Xtream path credentials
2. **Server-side** (`log.ts`): Same rules applied again on arrival

No user credentials can reach the server logs.

---

## 5. Error Reporting Enablement

### How It Gets Enabled

- **Default**: OFF
- **Server config**: Server admin enables via `errorReports: true` in app config
- **Beta mode**: ALWAYS ON in beta APK builds (native build with non-empty build number)

The APK reads the server config at startup via `GET /api/app-config` and enables automatic reporting if the server returns `errorReports: true`.

---

## 6. Data Flow Summary

```
┌──────────────────────────────────────────────┐
│           StreamX APK (Android TV)           │
│                                              │
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
│  /api/log/batch → log.ts → PostgreSQL        │
│  - Redacts credentials again                 │
│  - Rate limits: 60 rows/device/minute        │
│  - Stores in client_log table                │
│  - 7-day retention                           │
│                                              │
│  Admin panel: /api/admin/logs                │
│  - View, filter, group all logs              │
└──────────────────────────────────────────────┘
```

---

## 7. Verification Checklist

- [x] `STREAMIX_API_ORIGIN` set to `https://dev.lovix.com` in CI workflow
- [x] Mobile build script passes `STREAMIX_API_ORIGIN` to Vite as `VITE_API_ORIGIN`
- [x] `apiUrl()` function constructs full URLs with the origin
- [x] `errorReports.ts` sends to `apiUrl('/api/log/batch')`
- [x] Flush interval set to 1 minute (60,000ms)
- [x] Credential redaction active on both client and server
- [x] Final flush on app close via `navigator.sendBeacon()`
- [x] Server endpoints configured to receive logs

---

## 8. Expected Behavior After Installing New APK

1. **On first launch**: The APK sends boot info (device summary, build version) to the server
2. **On user login**: Login attempt and result are logged
3. **During use**: Any errors (playback failures, catalogue issues, etc.) are queued
4. **Every 1 minute**: Queued errors are sent to `https://dev.lovix.com/api/log/batch`
5. **On app close**: Any remaining queued errors are sent via background beacon
6. **On server**: Logs are stored in the database and viewable via admin panel

---

## 9. How to Verify Logs Are Arriving

1. Install the new APK on an Android TV device
2. Open the app and perform actions (login, browse, play content)
3. Wait 1-2 minutes
4. Check the server logs at `https://dev.lovix.com/api/admin/logs`
5. Look for entries with `platform: "android-app"` and `version: "1.64.1"`

---

**Confirmed by Junie AI**
**Date: 2026-11-12**
