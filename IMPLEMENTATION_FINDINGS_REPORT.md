# Implementation Findings Report

## Date: 2026-11-10

---

## Task 1: Multi-Provider URL Failover System

### Client Requirement
The client wants multiple provider URLs baked into the app with automatic failover when one is down. Users should only enter **username** and **password** — no server URL input.

**Provider URLs (in priority order):**
1. `http://line.istreamix.com` (primary)
2. `http://vpn.istreamix.com`
3. `http://vpn.new4k-tx.site`
4. `http://line.trexottvendor.store`
5. `http://vpn.trexottvendor.store`

### Current Architecture Analysis

#### Login Flow
The current login flow is:
```
Splash → Welcome overlay → AddSource (source type picker) → SignInFields (server URL + username + password) → signIn() → signInXtream() → resolveHost()
```

**Key files:**
- `Welcome.tsx` — First-run overlay, shows AddSource component
- `AddSource.tsx` — Source type picker (Xtream/M3U/Stalker/Stream), then renders the appropriate form
- `SignInFields.tsx` — Three-field form: server address, username, password
- `session.ts` — `signIn()` function that calls `signInXtream()`
- `panel.ts` — `signInXtream()` that calls `resolveHost()` with the URL and extra hosts
- `hosts.ts` — `resolveHost()` — **the core failover engine**

#### Existing Failover Engine (`hosts.ts`)
The app **already has a sophisticated multi-host failover system**:

1. **`resolveHost(url, username, password, extra[])`** — Takes a primary URL and an array of extra host URLs
2. **`candidatesBoth(url, extra[])`** — Builds a list of all hosts to try (HTTP first, then HTTPS)
3. **`orderHosts(hosts[])`** — Orders hosts by memoized success/failure history
4. **Host probing** — Each host is probed with authentication; first successful host wins
5. **Sticky caching** — A successful host is remembered for 1 hour; failed hosts for 24 hours
6. **Busy retry** — If a host returns flood protection (456/509/511/513), it retries after 2.5 seconds
7. **HTTP-first** — All HTTP addresses are tried before any HTTPS address
8. **Stream failover** — `nextStreamOrigin()` provides runtime stream-level failover too

**This means the infrastructure for multi-provider failover already exists.** The `signInXtream()` function accepts an `opts.hosts` array that gets passed to `resolveHost()` as the `extra` parameter.

### Implementation Plan

#### Step 1: Create Provider Configuration
Create a new configuration file for the hardcoded provider URLs:

**New file: `apps/web/src/lib/providers.ts`**
```typescript
export const PROVIDER_URLS = [
  'http://line.istreamix.com',    // Primary
  'http://vpn.istreamix.com',
  'http://vpn.new4k-tx.site',
  'http://line.trexottvendor.store',
  'http://vpn.trexottvendor.store',
] as const;

export const PRIMARY_PROVIDER = PROVIDER_URLS[0];
export const FALLBACK_PROVIDERS = PROVIDER_URLS.slice(1);
```

#### Step 2: Modify `SignInFields.tsx` for Simplified Login
Add support for hiding the server URL field and using a default server:

**Changes to `SignInFields.tsx`:**
- Add new props: `hideServer?: boolean` and `defaultServer?: string`
- When `hideServer` is true, hide the server address input entirely
- When `defaultServer` is provided, use it as the server URL instead of user input
- The form will only show username and password fields

#### Step 3: Modify `session.ts` `signIn()` for Failover
Update the `signIn()` function to support fallback providers:

**Changes to `session.ts`:**
- Add optional parameter `fallbackUrls?: string[]`
- When primary URL fails, automatically try each fallback URL in order
- Return which URL succeeded (for logging purposes)
- Only show error if ALL URLs fail

#### Step 4: Modify `panel.ts` `signInXtream()` for Failover
Update `signInXtream()` to try multiple primary URLs:

**Changes to `panel.ts`:**
- Add optional parameter `fallbackUrls?: string[]`
- Loop through URLs: primary first, then fallbacks
- For each URL, call `resolveHost()` with the remaining URLs as `extra` hosts
- Return on first success
- Collect all `tried` probes from all URLs for the final error report

#### Step 5: Modify `AddSource.tsx` for Xtream-Only Simplified Login
When the app is configured for simplified login:

**Changes to `AddSource.tsx`:**
- Add a flag to skip the source type picker and go directly to Xtream sign-in
- Pass the provider URLs to SignInFields

#### Step 6: Modify `Welcome.tsx` for Direct Login
Skip the source picker and show the simplified login form directly:

**Changes to `Welcome.tsx`:**
- When configured for simplified login, skip AddSource entirely
- Show SignInFields directly with `hideServer=true` and `defaultServer=PRIMARY_PROVIDER`
- Remove or hide the "Not now" button if login is required

#### Step 7: Add Configuration Flag
Add a build-time or runtime configuration to enable simplified login mode:

**Option A: Build-time (Vite env variable)**
```
VITE_SIMPLIFIED_LOGIN=true
VITE_PROVIDER_URLS=http://line.istreamix.com,http://vpn.istreamix.com,...
```

**Option B: Runtime (app-config from server)**
Add to the app-config document fetched at boot:
```json
{
  "simplifiedLogin": true,
  "providerUrls": ["http://line.istreamix.com", "http://vpn.istreamix.com", ...]
}
```

**Recommendation:** Option B (runtime) is more flexible — the operator can change provider URLs without rebuilding the APK. However, Option A (build-time) is simpler and ensures the URLs are baked into the APK as requested.

**Best approach:** Use **both** — bake the URLs into the APK (build-time) but allow the server config to override them (runtime).

---

## Task 2: User Logging System

### Client Requirement
The client wants all user logs automatically sent to the server for monitoring each user in beta mode:
- Login logs (success/failure)
- Bugs and errors
- Streaming errors
- etc.

### Current Architecture Analysis

#### Existing Logging Infrastructure
The app has a **comprehensive logging system** already in place:

1. **`debugLog.ts`** — In-memory ring buffer (400 entries) of all app events
   - Captures: player events, native engine events, fetch errors, unhandled exceptions, console.error/warn
   - Redacts credentials automatically
   - Has `errorWatchers` mechanism for automatic error reporting
   - Can manually send reports via `sendDebugReport()` to `/api/log`

2. **`errorReports.ts`** — **Automatic error reporting system**
   - Subscribes to all debugLog errors via `subscribeErrors()`
   - Batches errors (up to 30 distinct errors)
   - Sends every 3 minutes (`FLUSH_MS = 180_000ms`)
   - Folds duplicate errors into counts
   - Deduplicates by signature with 30-minute cooldown (`RESEND_MS`)
   - Posts to `/api/log/batch`
   - **Controlled by server config flag `errorReports`** (off by default)
   - Uses `sendBeacon` on page hide for last-chance delivery
   - Filters out noise (fetch errors, player retry attempts, etc.)

3. **`main.tsx`** — Installs both systems at startup:
   ```typescript
   installDebugCapture();  // Hooks console.error, window.error, fetch
   installErrorReports();  // Subscribes to errors, reads config flag
   ```

#### What's Already Being Logged
The following are automatically captured and sent to the server when `errorReports` is enabled:

| Category | Tag | What's Logged |
|----------|-----|---------------|
| **Sign-in** | `signin` | Host probes, authentication failures, verdicts |
| **Player** | `player` | Engine selection, URL requests, hls.js/libVLC errors, escalation |
| **Native** | `native` | Decoder failures, hardware decoder issues |
| **Network** | `net` | Online/offline status |
| **Fetch** | `fetch` | Failed HTTP requests (filtered from reports) |
| **Page** | `page` | Unhandled exceptions, unhandled rejections |
| **Console** | `console` | console.error/warn from any library |
| **Catalogue** | `catalogue` | Ingestion errors |
| **Captions** | `captions` | Caption errors |
| **Update** | `update` | App update errors |
| **Performance** | `perf` | Slow page operations |

#### What's Missing for Client's Requirements

1. **Login logs** — Sign-in errors ARE logged (`signin` tag), but **successful logins are NOT logged** to the server. Only failures generate error entries.

2. **Per-user identification** — The current system uses `launchId()` (random per launch, not persisted). There's no user identity in the logs — only a device ID that changes every launch.

3. **Login success events** — The error reporting system only sends errors/warnings. Successful logins, stream starts, and other positive events are not sent.

4. **Streaming error details** — Streaming errors ARE captured (`player` tag), but the client may want more detailed per-stream logging (which channel, how long it played, why it failed).

### Implementation Plan

#### Step 1: Enable Error Reports by Default for Beta Mode
The simplest change — enable the existing error reporting system:

**Option A: Server config**
Set `errorReports: true` in the app-config document on the server.

**Option B: Build-time default**
In `errorReports.ts`, change the default:
```typescript
let enabled = true; // true for beta mode, false for production
```

**Recommendation:** Use a build-time env variable:
```
VITE_ERROR_REPORTS=true
```

#### Step 2: Add Login Success Logging
Add a log entry when a user successfully logs in:

**Changes to `session.ts`:**
```typescript
// After successful signIn:
dlog.info('signin', `login success: user=${redact(username)} host=${redact(host)}`);
```

**Changes to `panel.ts`:**
```typescript
// After successful signInXtream:
dlog.info('signin', `authenticated: host=${chosen.host} ms=${chosen.ms}`);
```

#### Step 3: Add Per-User Identification
Add the user's account digest (already computed) to error reports:

**Changes to `errorReports.ts`:**
- Include the session account digest in `flushBody()`:
```typescript
export function flushBody(queue, now) {
  const session = getSession(); // from session.ts
  return {
    deviceId: launchId(),
    accountId: session?.account ?? null, // NEW: user identity
    entries: ...,
    device: ...,
  };
}
```

This gives the server a stable identifier per user per device (the SHA-256 digest of their credentials), without exposing the actual credentials.

#### Step 4: Add Streaming Event Logging
Enhance the player logging to include more context:

**Changes to player-related files:**
- Log stream start with channel name and ID
- Log stream stop with duration and reason
- Log stream failover events (which host was tried, which succeeded)

#### Step 5: Enhance the Server-Side Log Viewer
The server receives logs at `/api/log/batch`. Ensure the admin panel can:
- Filter logs by `accountId` (per-user view)
- Filter by tag (signin, player, etc.)
- Show login success/failure timeline per user
- Show streaming errors per user with channel context

#### Step 6: Add Beta Mode Indicator
Add a clear indicator in the app that beta logging is enabled:

**Changes to settings/about screen:**
- Show "Beta logging: ON" when error reports are enabled
- Allow user to opt-out if needed

---

## Summary of Required Changes

### Multi-Provider Failover (6 files)

| File | Change | Priority |
|------|--------|----------|
| `apps/web/src/lib/providers.ts` | **NEW** — Provider URL configuration | High |
| `apps/web/src/components/SignInFields.tsx` | Add `hideServer` and `defaultServer` props | High |
| `apps/web/src/lib/session.ts` | Add `fallbackUrls` parameter to `signIn()` | High |
| `apps/web/src/lib/providers/panel.ts` | Add `fallbackUrls` loop in `signInXtream()` | High |
| `apps/web/src/components/AddSource.tsx` | Support skipping source picker | Medium |
| `apps/web/src/components/Welcome.tsx` | Show simplified login directly | Medium |

### User Logging System (4 files)

| File | Change | Priority |
|------|--------|----------|
| `apps/web/src/lib/errorReports.ts` | Include `accountId` in flush body, enable by default for beta | High |
| `apps/web/src/lib/session.ts` | Log successful login events | High |
| `apps/web/src/lib/providers/panel.ts` | Log successful authentication with host info | High |
| Player files | Enhance streaming event logging | Medium |

### Server-Side Changes

| Endpoint | Change | Priority |
|----------|--------|----------|
| App-config document | Set `errorReports: true` for beta mode | High |
| `/api/log/batch` | Handle `accountId` field in log entries | High |
| Admin panel | Add per-user log filtering by `accountId` | Medium |

---

## Risk Assessment

### Multi-Provider Failover
- **Low risk** — The failover engine already exists and is well-tested. We're just adding hardcoded URLs to the existing `extra` hosts parameter.
- **Testing needed** — Verify that when primary URL is down, failover to secondary works correctly.
- **Edge case** — What if ALL providers are down? The current error handling already covers this.

### User Logging
- **Low risk** — The error reporting system is already production-tested. We're just enabling it and adding more log entries.
- **Privacy** — The `accountId` is a SHA-256 hash, not the actual credentials. Credentials are already redacted by `redactSecrets()`.
- **Bandwidth** — Errors are batched (30 errors max, 3-minute interval). Login success logs are single-line info entries.
- **Server load** — Need to ensure `/api/log/batch` can handle the increased volume from all beta users.

---

## Recommendations

1. **For multi-provider failover:** Use the existing `resolveHost()` infrastructure. Add the provider URLs as a configuration constant. Modify `signInXtream()` to loop through URLs until one succeeds. This is the minimal change with maximum reliability.

2. **For user logging:** Enable the existing `errorReports` system and add `accountId` to the flush body. Add login success logging. This gives the client per-user monitoring with minimal new code.

3. **For the simplified login:** The cleanest approach is to add a configuration flag that, when enabled, skips the source picker in Welcome.tsx and shows SignInFields directly with the server URL hidden and pre-filled.

4. **Server-side:** Ensure the admin panel can filter logs by `accountId` so the client can see each user's activity separately.

---

## Next Steps

1. Confirm the implementation approach with the client
2. Implement the multi-provider failover system
3. Implement the user logging enhancements
4. Test failover with providers down
5. Verify logs are received on the server with per-user identification
6. Update the admin panel for per-user log viewing
