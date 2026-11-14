/**
 * Check for new app releases on GitHub.
 *
 * Fetches the latest stable release from the GitHub API, compares it with the
 * current app version, and returns release info if a newer version is available.
 * Dismissed versions are remembered via localStorage with a 1-hour expiry so the
 * same update reappears periodically until the user installs it.
 *
 * The GitHub API is public and rate-limited at 60/hour unauthenticated, which
 * is sufficient for app boot checks. A 5-second timeout prevents blocking the
 * UI on slow networks, and failures are silent — no update shown on error.
 */

const GITHUB_REPO = 'arjan001/StreamX';
const DISMISS_PREFIX = 'update.dismissed.';

/** Dismissed versions reappear after this many milliseconds (1 hour). */
const DISMISS_EXPIRY_MS = 60 * 60 * 1000;

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
  /** The GitHub release page URL (not used for download). */
  html_url: string;
  /** Direct APK download URL from release assets. */
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
 * Returns false if the dismissal has expired (1 hour has passed), so the
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
 * Mark a version as dismissed with a timestamp so it reappears after 1 hour.
 */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}v${version}`, String(Date.now()));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

/**
 * Fetch the latest stable release from GitHub and compare with the current
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

    console.log('[updateCheck] GitHub latest release:', releaseVersion, '(tag:', tag + ')');

    // Compare versions — only show if the release is newer
    const cmp = compareVersion(releaseVersion, CURRENT_VERSION);
    console.log('[updateCheck] compareVersion(', releaseVersion, ', ', CURRENT_VERSION, ') =', cmp);
    if (cmp <= 0) {
      console.log('[updateCheck] No update needed: release is not newer than current version');
      return null;
    }

    // Skip if the user already dismissed this version (within expiry window)
    const dismissed = isDismissed(releaseVersion);
    console.log('[updateCheck] isDismissed(', releaseVersion, ') =', dismissed);
    if (dismissed) return null;

    // Extract the arm64 APK download URL from release assets
    const assets = (data.assets as Array<{ name: string; browser_download_url: string }> | undefined) ?? [];
    const arm64Asset = assets.find(a => (a.name ?? '').includes('arm64'));
    const fallbackAsset = assets[0];
    const downloadUrl = (arm64Asset ?? fallbackAsset)?.browser_download_url ?? '';

    console.log('[updateCheck] Update available:', releaseVersion, 'with download_url:', !!downloadUrl);
    return {
      version: releaseVersion,
      body: (data.body as string | undefined) ?? '',
      html_url: (data.html_url as string | undefined) ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
      download_url: downloadUrl,
    };
  } catch (e) {
    // Network error, timeout, or parse error — log for debugging
    console.error('[updateCheck] Error checking for update:', e);
    return null;
  }
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

    console.log('[updateCheck] forceCheck: GitHub latest release:', releaseVersion);

    // Compare versions — only show if the release is newer
    if (compareVersion(releaseVersion, CURRENT_VERSION) <= 0) {
      console.log('[updateCheck] forceCheck: No update needed');
      return null;
    }

    // Skip dismiss check — user explicitly requested this check
    // Extract the arm64 APK download URL from release assets
    const assets = (data.assets as Array<{ name: string; browser_download_url: string }> | undefined) ?? [];
    const arm64Asset = assets.find(a => (a.name ?? '').includes('arm64'));
    const fallbackAsset = assets[0];
    const downloadUrl = (arm64Asset ?? fallbackAsset)?.browser_download_url ?? '';

    console.log('[updateCheck] forceCheck: Update available:', releaseVersion);
    return {
      version: releaseVersion,
      body: (data.body as string | undefined) ?? '',
      html_url: (data.html_url as string | undefined) ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
      download_url: downloadUrl,
    };
  } catch (e) {
    console.error('[updateCheck] forceCheck error:', e);
    return null;
  }
}
