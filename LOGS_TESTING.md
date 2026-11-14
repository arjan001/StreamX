# APK Logs Testing Guide

This document helps you verify that your APK is sending logs to `dev.lovix.com` and that the update system is working correctly.

## Prerequisites

- Android device or emulator with the APK installed
- ADB (Android Debug Bridge) installed on your computer
- The device connected via USB or emulator running

---

## Step 1: Check if the APK has the correct version

```powershell
adb logcat -b main | Select-String "VITE_APP_VERSION|CURRENT_VERSION|updateCheck"
```

**Expected output:**
```
[updateCheck] checkForUpdate: current version = 1.64.4
```

**If you see:**
```
[updateCheck] checkForUpdate skipped: VITE_APP_VERSION is empty
```
→ The APK was built without version stamping. Rebuild via CI or with:
```powershell
$env:STREAMIX_API_ORIGIN="https://dev.lovix.com"; $env:VITE_APP_BUILD="1"; pnpm --filter @iptv/mobile build:web
```

---

## Step 2: Check if the APK knows where to send logs

```powershell
adb logcat -b main | Select-String "API_ORIGIN|errorReports"
```

**Expected output:**
```
[errorReports]   API_ORIGIN (log endpoint base): https://dev.lovix.com
[errorReports] Beta mode: enabling error reports automatically
```

**If you see:**
```
[errorReports]   API_ORIGIN (log endpoint base): (EMPTY — logs will NOT reach the server!)
[errorReports] CRITICAL: APK built without VITE_API_ORIGIN!
```
→ The APK was built without the API origin. The `.env` file now contains the fallback value, but CI builds use `STREAMIX_API_ORIGIN` environment variable.

---

## Step 3: Check if error reports are enabled

```powershell
adb logcat -b main | Select-String "installErrorReports|IS_BETA|Beta mode"
```

**Expected output:**
```
[errorReports] installErrorReports called
[errorReports]   IS_BETA: true (NATIVE: true BUILD: 1)
[errorReports] Beta mode: enabling error reports automatically
```

**Note:** Beta mode auto-enables logs when `VITE_APP_BUILD` is set during the build. The CI workflow sets this variable.

---

## Step 4: Check if logs are being sent

```powershell
adb logcat -b main | Select-String "Flushing|log/batch|Flush response"
```

**Expected output:**
```
[errorReports] Flushing 1 entries to https://dev.lovix.com/api/log/batch
[errorReports] Flush response: 200 OK
```

**If you see:**
```
[errorReports] Flushing 1 entries to /api/log/batch
```
→ The API_ORIGIN is empty. The URL is relative, so it can't reach the server.

**If you see:**
```
[errorReports] Flush network error: TypeError: Failed to fetch
```
→ Network issue or wrong API_ORIGIN.

---

## Step 5: Check heartbeat logs

```powershell
adb logcat -b main | Select-String "heartbeat"
```

**Expected output (within 10 seconds of app start):**
```
[errorReports] Queued error: heartbeat heartbeat v=1.64.4+212 platform=android-app model=...
```

Heartbeats are sent every 5 minutes but deduplicated to once per 30 minutes.

---

## Step 6: Check update detection

```powershell
adb logcat -b main | Select-String "updateCheck|compareVersion|GitHub latest"
```

**Expected output:**
```
[updateCheck] checkForUpdate: current version = 1.64.4
[updateCheck] GitHub latest release: 1.64.4 (tag: v1.64.4)
[updateCheck] compareVersion( 1.64.4 ,  1.64.4 ) = 0
[updateCheck] No update needed: release is not newer than current version
```

**If your APK is older (e.g., 1.64.3):**
```
[updateCheck] checkForUpdate: current version = 1.64.3
[updateCheck] GitHub latest release: 1.64.4 (tag: v1.64.4)
[updateCheck] compareVersion( 1.64.4 ,  1.64.3 ) = 1
[updateCheck] isDismissed( 1.64.4 ) = false
[updateCheck] Update available: 1.64.4 with download_url: true
```

---

## Step 7: Verify the server is receiving logs

On your server, check the SQLite database:

```bash
ssh arjan@83.229.83.91
cd "/var/www/X Love X/data"
sqlite3 apk_logs.db "SELECT COUNT(*) FROM logs;"
sqlite3 apk_logs.db "SELECT * FROM logs ORDER BY created_at DESC LIMIT 5;"
```

If the database doesn't exist:
```bash
sudo mkdir -p "/var/www/X Love X/data"
sudo chown www-data:www-data "/var/www/X Love X/data"
```

Then initialize the database (see LVX_FIXES.md for full instructions).

---

## Step 8: Test the API endpoint directly

```powershell
curl -k -X POST https://dev.lovix.com/api/log/batch `
  -H "Content-Type: application/json" `
  -d '{"deviceId":"test1234567890123456789012","entries":[{"tag":"test","text":"Manual test log","level":"info","count":1,"ago":0}],"device":{"model":"Test"},"version":"1.64.4","platform":"android-app"}'
```

**Expected response:**
```json
{"ok":true}
```

**If you get an error:**
- Check that the PHP API is running on the server
- Verify the database exists and is writable
- Check nginx/PHP error logs

---

## Common Issues

### Issue: "VITE_APP_VERSION is empty"
**Cause:** APK was built locally without the version environment variable.
**Fix:** The `.env` file now provides a fallback. Rebuild the APK via CI or ensure `version.json` is readable during build.

### Issue: "API_ORIGIN is empty"
**Cause:** APK was built without `STREAMIX_API_ORIGIN` environment variable.
**Fix:** The `.env` file now contains `PUBLIC_API_ORIGIN=https://dev.lovix.com` as a fallback. Rebuild the APK.

### Issue: Update banner doesn't appear
**Cause:** The app's version matches the GitHub release, or the update was dismissed within the last hour.
**Fix:** Check logs for `[updateCheck]` output. If `isDismissed` returns `true`, wait 1 hour or clear the dismiss flag:
```
localStorage.removeItem('update.dismissed.v1.64.4')
```

### Issue: Logs not received on server
**Cause:** The `/var/www/X Love X/data/` directory doesn't exist on the server.
**Fix:** Run the SSH commands in Step 7 to create and initialize the database.

---

## Quick Diagnostic Command

Run this single command to see all relevant logs at once:

```powershell
adb logcat -b main | Select-String "errorReports|updateCheck|API_ORIGIN|VITE_APP_VERSION|heartbeat|log/batch"
```

This shows:
- Whether the APK has the correct version
- Whether the API origin is set
- Whether error reports are enabled
- Whether logs are being sent
- Whether the update check is running

---

## Summary of Fixes Applied

1. **`.env` file created** — Contains `PUBLIC_API_ORIGIN=https://dev.lovix.com` as a fallback for local builds
2. **Update check logging** — Added diagnostic logs to `updateCheck.ts` so you can see why updates aren't detected
3. **Force check logging** — Added diagnostic logs to `forceCheckForUpdate()` for the Settings → About button
4. **Error reports logging** — Existing logs in `errorReports.ts` show API_ORIGIN, VERSION, and deviceId on startup

Rebuild the APK via CI to get these fixes, then use the commands above to verify everything is working.
