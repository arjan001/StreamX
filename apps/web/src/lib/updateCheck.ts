/**
 * Check for new app releases on GitHub.
 *
 * Fetches the latest stable release from the GitHub API, compares it with the
 * current app version, and returns release info if a newer version is available.
 *
 * Dismissed versions are remembered via localStorage with a 10-minute expiry so the
 * same update reappears periodically until the user installs it.
 *
 * A 5-second timeout prevents blocking the UI on slow networks, and failures
 * are silent — no update shown on error.
 */

const GITHUB_REPO = 'arjan001/StreamX';
const DISMISS_PREFIX = 'update.dismissed.';

/**
 * Dismissed versions reappear after this many milliseconds (24 hours).
 *
 * 10 minutes was too short — users who dismissed the prompt would see it again
 * within the same viewing session. 24 hours gives a reasonable reminder interval
 * without being annoying. Once the user installs the update, the app restarts
 * with the new version, so the prompt naturally goes away.
 */
const DISMISS_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Key in localStorage that stores the last installed version (set after successful install). */
const INSTALLED_VERSION_KEY = 'update.installed.version';

/** GitHub Pages download base URL — APKs are served from here, never from GitHub releases. */
const PAGES_BASE = 'https://payd.help';

/**
 * Detect the APK variant from the device's User-Agent string.
 *
 * Android WebViews include architecture hints like "arm64-v8a", "armeabi-v7a",
 * "x86_64" in the UA. When running inside a Capacitor shell (the APK), these
 * values tell us which APK variant the user installed. Falls back to "universal"
 * when the architecture cannot be determined.
 */
function detectApkVariant(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/arm64|aarch64/i.test(ua)) return 'arm64';
  if (/armeabi|armv7/i.test(ua)) return 'armv7';
  if (/x86_64|x86\/64|Win64|amd64/i.test(ua)) return 'x86_64';
  // Default to universal for unknown architectures (TVs, emulators, etc.)
  return 'universal';
}

/**
 * Build the GitHub Pages download URL matching the user's installed APK variant.
 * This ensures the update downloads the same architecture, not a random one.
 */
function getDownloadUrl(): string {
  const variant = detectApkVariant();
  return `${PAGES_BASE}/streamix-${variant}.apk`;
}

/** The current app version, stamped at build time. */
const CURRENT_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';

/**
 * Information about an available release.
 */
export interface ReleaseInfo {
  /** The version string, e.g. "1.65.0". */
  version: string;
  /** The release body/changelog from GitHub. */
  body: string;
  /** Direct APK download URL from GitHub Pages. */
  download_url: string;
}

/**
 * Compare two semantic version strings. Returns positive if a > b, negative if
 * a < b, zero if equal. Handles x.y.z format; ignores build metadata (+suffix).
 */
function compareVersion(a: string, b: string): number {
  const cleanA = a.replace(/^v/, '').split('+')[0] ?? '';
  const cleanB = b.replace(/^v/, '').split('+')[0] ?? '';
  const partsA = cleanA.split('.').map(Number);
  const partsB = cleanB.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Check if a version was previously dismissed by the user.
 * Returns false if the dismissal has expired (10 minutes have passed), so the
 * modal reappears periodically until the user installs the update.
 */
export function isDismissed(version: string): boolean {
  try {
    const ts = localStorage.getItem(`${DISMISS_PREFIX}v${version}`);
    if (ts === null || ts === '1') {
      // Legacy '1' value or missing — treat as not dismissed so it shows again
      return false;
    }
    const dismissedAt = Number(ts);
    if (Number.isNaN(dismissedAt)) return false;
    // Return true only if less than DISMISS_EXPIRY_MS has passed
    return Date.now() - dismissedAt < DISMISS_EXPIRY_MS;
  } catch {
    return false;
  }
}

/**
 * Mark a version as dismissed with a timestamp so it reappears after 24 hours.
 */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}v${version}`, String(Date.now()));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

/**
 * Record that the user has installed a specific version.
 *
 * Called after the system package installer is triggered. The next time the app
 * starts, it will compare the current version with the installed version and not
 * show the update prompt if they match.
 */
export function recordInstalledVersion(version: string): void {
  try {
    localStorage.setItem(INSTALLED_VERSION_KEY, version);
  } catch {
    // Storage full or unavailable — silently fail
  }
}

/**
 * Get the last installed version, or null if never installed via update.
 */
export function getInstalledVersion(): string | null {
  try {
    return localStorage.getItem(INSTALLED_VERSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Fetch the latest stable release from GitHub and compare with the current
 * app version. Returns release info if a newer, non-dismissed version is
 * available, or null if no update is needed.
 *
 * Times out after 5 seconds and fails silently on network errors.
 */
async function checkGitHub(): Promise<ReleaseInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { signal: controller.signal },
    );
    window.clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const tag = (data.tag_name as string | undefined) ?? '';
    const releaseVersion = tag.replace(/^v/, '');
    // Use GitHub Pages URL matching the user's APK variant — never redirect to GitHub release page.
    // Detects arm64, armv7, x86_64, or universal from the device's User-Agent.
    const downloadUrl = getDownloadUrl();
    console.log('[updateCheck] GitHub latest release:', releaseVersion);
    return {
      version: releaseVersion,
      body: (data.body as string | undefined) ?? '',
      download_url: downloadUrl,
    };
  } catch (e) {
    console.error('[updateCheck] GitHub error:', e);
    return null;
  }
}

/**
 * Fetch the latest stable release and compare with the current
 * app version. Returns release info if a newer, non-dismissed version is
 * available, or null if no update is needed.
 *
 * Times out after 5 seconds and fails silently on network errors.
 */
export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  // Development builds don't check for updates
  if (CURRENT_VERSION === '') {
    console.warn('[updateCheck] checkForUpdate skipped: VITE_APP_VERSION is empty — APK was likely built without version stamping');
    return null;
  }
  console.log('[updateCheck] checkForUpdate: current version =', CURRENT_VERSION);

  const release = await checkGitHub();
  if (!release) return null;

  // Compare versions — only show if the release is newer
  const cmp = compareVersion(release.version, CURRENT_VERSION);
  console.log('[updateCheck] compareVersion(', release.version, ', ', CURRENT_VERSION, ') =', cmp);
  if (cmp <= 0) {
    console.log('[updateCheck] No update needed: release is not newer than current version');
    return null;
  }

  // Skip if the user already dismissed this version (within expiry window)
  const dismissed = isDismissed(release.version);
  console.log('[updateCheck] isDismissed(', release.version, ') =', dismissed);
  if (dismissed) return null;

  // Skip if the user has already installed this version
  const installed = getInstalledVersion();
  if (installed === release.version) {
    console.log('[updateCheck] Version already installed:', release.version);
    return null;
  }

  console.log('[updateCheck] Update available:', release.version, 'with download_url:', !!release.download_url);
  return release;
}

/**
 * Force check for updates, ignoring any previous dismissal.
 * Used by the "Check for updates" button in Settings → About so the user
 * always sees the modal when they manually request it.
 */
export async function forceCheckForUpdate(): Promise<ReleaseInfo | null> {
  // Development builds don't check for updates
  if (CURRENT_VERSION === '') {
    console.warn('[updateCheck] forceCheckForUpdate skipped: VITE_APP_VERSION is empty');
    return null;
  }
  console.log('[updateCheck] forceCheckForUpdate: current version =', CURRENT_VERSION);

  const release = await checkGitHub();
  if (!release) return null;

  // Compare versions — only show if the release is newer
  if (compareVersion(release.version, CURRENT_VERSION) <= 0) {
    console.log('[updateCheck] forceCheck: No update needed');
    return null;
  }

  // Skip dismiss check — user explicitly requested this check
  console.log('[updateCheck] forceCheck: Update available:', release.version);
  return release;
}
