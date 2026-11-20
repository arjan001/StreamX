# Fire OS 7 Compatibility Research Report

**Date:** 2026-11-17
**Device:** Amazon Fire TV Stick / Fire TV running Fire OS 7 (Android 9, API 28)
**Issue:** Films not loading or playing on Fire OS 7 device

---

## 1. Fire OS 7 Environment Overview

| Property | Value |
|----------|-------|
| Fire OS version | 7.x |
| Android base | Android 9 (Pie), API level 28 |
| WebView | Amazon WebView (AWV) — custom Chromium build, **cannot be upgraded independently** |
| Chromium version | Unknown exact version; frozen at whatever shipped with the device's Fire OS update |
| Google Play Services | **Not available** — Amazon uses its own services |
| Hardware | ARM-based (ARM64-v8a or ARMv7a) |

**Key finding:** The Amazon WebView (AWV) is a custom Chromium build that is **frozen at the version shipped with the device**. Unlike regular Android devices where WebView updates via Play Store, Fire OS 7 devices cannot update their WebView without a full OS update from Amazon.

---

## 2. App Architecture Analysis

### Platform Detection
- **File:** `apps/web/src/lib/platform.ts`
- Fire OS 7 is detected as `'android'` platform because Capacitor reports `android`
- This is **correct** — the device has access to all Android native plugins

### Playback Engine Chain
- **File:** `apps/web/src/lib/playerCore.ts`
- **File:** `apps/web/src/lib/nativePlayer.ts`

The app uses a **three-tier fallback system**:

1. **hls.js** (WebView) — for HLS streams in the browser
2. **mpegts.js** (WebView) — for MPEG-TS streams in the browser
3. **libVLC 3.6.5** (Native) — for films and streams the WebView cannot decode

**Critical logic in `nativePlayer.ts`:**
```typescript
// Films and episodes go directly to libVLC, whatever the container says
if (isFilmUrl(opts.url)) return 'native';
```

This means **movies and series should automatically use libVLC**, bypassing the WebView entirely.

### Build Configuration
- **File:** `apps/web/vite.config.ts`
- JavaScript target: `chrome68` — compatible with older WebViews
- CSS target: `chrome68` — same floor
- Service worker: Plain ES2017 — no transpilation needed

### Android Build
- **File:** `apps/mobile/android/variables.gradle`
- minSdkVersion: **23** (Android 6.0) — Fire OS 7 (API 28) is well above this ✓
- targetSdkVersion: **36** (Android 14)
- libVLC version: **3.6.5**

### Capacitor Configuration
- **File:** `apps/mobile/capacitor.config.ts`
- `allowMixedContent: true` — allows HTTP streams ✓
- `androidScheme: 'https'` — secure context for crypto.subtle ✓

---

## 3. Known Fire OS 7 Issues (from Web Research)

### Issue 1: Amazon WebView HLS.js bufferAppendError
- **Source:** Amazon Developer Community
- **Symptom:** HLS.js playback stops with `bufferAppendError` when video is **unmuted**
- **Affected:** Fire TV Stick 4K Select, but likely affects all Fire OS 7 devices
- **Impact on our app:** **LOW** — films go to libVLC, not hls.js. Live TV channels might be affected if played in WebView.

### Issue 2: Video Autoplay Blocked in WebView
- **Source:** Amazon Developer Community
- **Symptom:** HTML5 `<video>` elements cannot auto-start in Fire OS WebView
- **Impact on our app:** **LOW** — user-initiated playback, not autoplay. Films use libVLC.

### Issue 3: MediaSource Extensions (MSE) Support
- **Source:** hls.js documentation
- **Requirement:** hls.js requires MSE API with `video/mp4` support
- **Fire OS 7 status:** AWV likely has MSE, but version is unknown
- **Impact on our app:** **LOW** — films bypass WebView entirely via libVLC

### Issue 4: Older Chromium Features Missing
- **Source:** Various developer forums
- **Symptom:** Features available in Chrome 68+ may not work on frozen AWV
- **Impact on our app:** **MEDIUM** — UI rendering issues possible, but not playback

### Issue 5: No Google Play Services
- **Source:** Amazon documentation
- **Symptom:** Apps relying on Google services fail
- **Impact on our app:** **NONE** — app doesn't use Google services

---

## 4. Root Cause Analysis

### Why Films Might Not Load on Fire OS 7

Based on the code review, here are the **most likely causes**:

#### Cause 1: libVLC Native Plugin Initialization Failure (HIGH PROBABILITY)

**File:** `apps/mobile/android/app/src/main/java/com/streamx/app/StreamixPlayerPlugin.java`

The libVLC plugin initializes on first use:
```java
private synchronized void ensurePlayer(String userAgent) {
    if (player != null) return;
    libVlc = new LibVLC(getContext(), vlcOptions(userAgent));
    player = new MediaPlayer(libVlc);
    // ...
}
```

**Potential issues:**
- libVLC native libraries (`libvlc.so`) may not load correctly on Fire OS 7's ARM architecture
- The `armeabi-v7a` ABI is included in the build, but Fire OS 7 devices are typically `arm64-v8a`
- If libVLC fails to initialize, the plugin silently falls back to WebView, which may not decode the stream

**Evidence needed:** Check if libVLC is actually loading on the device. Add Sentry logging to the `ensurePlayer` method.

#### Cause 2: WebView Cannot Decode Stream, libVLC Fallback Not Triggered (MEDIUM PROBABILITY)

**File:** `apps/web/src/lib/nativePlayer.ts`

The decision to use native player is made by `shouldUseNative()`:
```typescript
if (isFilmUrl(opts.url)) return 'native';
```

**Potential issue:**
- If the film URL doesn't match `/\/(movie|series)\//i`, it won't route to libVLC
- Some panels use different URL patterns for VOD (Video on Demand)
- The stream might be served as a direct `.mp4` or `.mkv` file URL, not through the movie/series path

**Evidence needed:** Check the actual film URLs being requested on Fire OS 7. Add Sentry logging to `shouldUseNative()` to see what engine is chosen.

#### Cause 3: Network/CORS Issues Specific to Fire OS 7 (MEDIUM PROBABILITY)

**File:** `apps/mobile/capacitor.config.ts`

- `allowMixedContent: true` is set, allowing HTTP streams
- However, Fire OS 7 may have stricter network security policies

**Potential issue:**
- If the panel uses HTTP-only streams and the app's WebView has mixed content restrictions
- DNS resolution or TLS handshake differences on Fire OS 7

**Evidence needed:** Check if API calls to the panel succeed. Add Sentry logging to fetch failures.

#### Cause 4: Service Worker Interference (LOW PROBABILITY)

**File:** `apps/web/public/sw.js`

- The service worker is plain ES2017, which should work on Fire OS 7
- However, the Cache API behavior may differ on AWV

**Potential issue:**
- Stale cached responses could serve broken shell/chunks
- Cache API not fully supported on older AWV versions

**Evidence needed:** Test with service worker disabled.

#### Cause 5: Capacitor WebView Configuration (LOW PROBABILITY)

**File:** `apps/mobile/capacitor.config.ts`

- `androidScheme: 'https'` makes the WebView a secure context
- This is required for `crypto.subtle`, `AudioWorklet`, and persistent storage

**Potential issue:**
- If AWV on Fire OS 7 doesn't properly handle the `https` scheme for local content
- Could cause the entire app to fail to load, not just films

**Evidence needed:** Check if the app UI loads at all, or only films fail.

---

## 5. Code Review Findings

### Strengths (Already Working Correctly)

| Feature | Status | Notes |
|---------|--------|-------|
| minSdk compatibility | ✓ | Fire OS 7 (API 28) > minSdk (23) |
| libVLC native fallback | ✓ | Films route to libVLC via `isFilmUrl()` |
| Mixed content allowed | ✓ | `allowMixedContent: true` in Capacitor config |
| Secure context | ✓ | `androidScheme: 'https'` for crypto.subtle |
| JavaScript target | ✓ | Chrome 68 floor covers older WebViews |
| Service worker | ✓ | Plain ES2017, no transpilation needed |
| ABI support | ✓ | `arm64-v8a` and `armeabi-v7a` included |
| Network caching | ✓ | libVLC options tuned for live and VOD |

### Potential Weaknesses

| Area | Risk | Description |
|------|------|-------------|
| libVLC initialization | **HIGH** | No error logging if libVLC fails to load native libraries |
| Film URL pattern | **MEDIUM** | `isFilmUrl()` regex may not match all panel URL patterns |
| WebView fallback | **MEDIUM** | If libVLC fails, fallback to WebView may silently fail |
| Sentry logging | **LOW** | Limited logging in native player plugin |
| AWV version | **UNKNOWN** | Cannot determine exact Chromium version on device |

---

## 6. Recommendations

### Immediate Actions (Before Fixing)

1. **Enable Sentry Logging on Fire OS 7 Device**
   - The app already has Sentry configured
   - Reproduce the issue on the device and check your Sentry dashboard for errors
   - Look for: `libVLC`, `nativePlayer`, `playerCore` error logs

2. **Add Diagnostic Logging**
   - Add `logInfo()` calls in `ensurePlayer()` to confirm libVLC initializes
   - Add `logInfo()` calls in `shouldUseNative()` to see which engine is chosen
   - Add `logError()` calls in WebView playback failures

3. **Collect Device Information**
   - Check the exact Fire OS version: Settings → My Fire TV → About
   - Check the AWV version: `adb shell dumpsys package com.amazon.webview.chromium | grep versionName`
   - Check the device model code (e.g., `AFTSS` for Fire TV Stick HD)

### Recommended Fixes (After Diagnosis)

#### Fix 1: Improve libVLC Error Handling
**File:** `StreamixPlayerPlugin.java`

Add error logging when libVLC fails to initialize:
```java
try {
    libVlc = new LibVLC(getContext(), vlcOptions(userAgent));
} catch (Exception e) {
    Log.e("StreamixPlayer", "libVLC initialization failed", e);
    // Report to web layer so Sentry can capture it
}
```

#### Fix 2: Broaden Film URL Detection
**File:** `apps/web/src/lib/nativePlayer.ts`

Expand `isFilmUrl()` to match more patterns:
```typescript
export function isFilmUrl(url: string): boolean {
    return /\/(movie|series|vod|clip)\//i.test(url) || /\.(mp4|mkv|avi|m4v)(?:[?#]|$)/i.test(url);
}
```

#### Fix 3: Force libVLC for All VOD on Android
**File:** `apps/web/src/lib/nativePlayer.ts`

If WebView consistently fails on Fire OS 7, consider forcing libVLC for all VOD content on Android:
```typescript
if (platform === 'android' && !isLive) return 'native';
```

#### Fix 4: Add Fire OS Detection
**File:** `apps/web/src/lib/platform.ts`

Detect Fire OS specifically for targeted fixes:
```typescript
if (/FireTV|Fire TV|AFT|FDR|FN/.test(ua)) return 'fireos';
```

---

## 7. Comparison with Other Platforms

| Platform | WebView | Native Player | Films Work? |
|----------|---------|---------------|-------------|
| Android Phone | Updatable Chromium | libVLC | ✓ |
| Android TV | Frozen Chromium | libVLC | ✓ |
| **Fire OS 7** | **Frozen AWV** | **libVLC** | **?** |
| Fire OS 8 | Frozen AWV (newer) | libVLC | Likely ✓ |
| iOS | WKWebView | None (native HLS) | ✓ |
| Tizen | Frozen Chromium | None | ✓ (hls.js) |
| webOS | Frozen Chromium | None | ✓ (hls.js) |

**Key difference:** Fire OS 7 has the **oldest frozen WebView** among supported platforms, but has libVLC as a fallback — same as regular Android.

---

## 8. Conclusion

The app's architecture is **well-designed for Fire OS 7 compatibility**:

1. ✅ Films automatically route to libVLC, bypassing the WebView
2. ✅ Build targets are compatible (minSdk 23 < Fire OS 7 API 28)
3. ✅ JavaScript and CSS targets are conservative (Chrome 68)
4. ✅ Mixed content is allowed for HTTP streams
5. ✅ Secure context is configured for modern APIs

**Most likely cause:** libVLC native library initialization failure or film URL pattern mismatch preventing libVLC fallback.

**Next steps:**
1. Enable Sentry logging and reproduce the issue
2. Check Sentry dashboard for specific errors
3. Add diagnostic logging to confirm libVLC initialization
4. Based on findings, apply targeted fixes from Section 6

**No immediate code changes recommended** until we have error logs from the actual device. The architecture is sound; we need to identify where the failure occurs.

---

## 9. Files Examined

| File | Purpose |
|------|---------|
| `apps/web/src/lib/platform.ts` | Platform detection |
| `apps/web/src/lib/playerCore.ts` | Playback engine selection |
| `apps/web/src/lib/nativePlayer.ts` | Native player decision logic |
| `apps/web/vite.config.ts` | Build targets and configuration |
| `apps/mobile/capacitor.config.ts` | WebView and network settings |
| `apps/mobile/android/variables.gradle` | SDK versions and libVLC version |
| `apps/mobile/android/app/build.gradle` | ABI filters and build config |
| `apps/mobile/android/app/src/main/java/com/streamx/app/StreamixPlayerPlugin.java` | libVLC native plugin |
| `apps/web/public/sw.js` | Service worker |
| `apps/web/src/lib/warm.ts` | Service worker registration |

---

*Report generated by Junie based on codebase analysis and web research.*
