/**
 * Check for new app releases.
 *
 * Tries apk.lovix.com first (dedicated APK download server), then falls back
 * to GitHub API. The server approach avoids redirecting users to GitHub on TV
 * devices and works with a private repository.
 *
 * Dismissed versions are remembered via localStorage with a 10-minute expiry so the
 * same update reappears periodically until the user installs it.
 *
 * A 5-second timeout prevents blocking the UI on slow networks, and failures
 * are silent — no update shown on error.
 */

const GITHUB_REPO = 'arjan001/StreamX';
const APK_SERVER_URL = 'https://apk.lovix.com/api/release.json';
const DISMISS_PREFIX = 'update.dismissed.';

/** Dismissed versions reappear after this many milliseconds (10 minutes). */
const DISMISS_EXPIRY_MS = 10 * 60 * 1000;

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
 * Mark a version as dismissed with a timestamp so it reappears after 10 minutes.
 */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}v${version}`, String(Date.now()));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

/**
 * Fetch release info from the apk.lovix.com server.
 * Returns null if the server is not yet configured or returns an error.
 */
async function checkApkServer(): Promise<ReleaseInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const response = await fetch(APK_SERVER_URL, { signal: controller.signal });
    window.clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const version = (data.version as string | undefined) ?? '';
    const downloadUrl = (data.download_url as string | undefined) ?? '';
    const changelogUrl = (data.changelog as string | undefined) ?? '';
    if (!version || !downloadUrl) return null;
    // Fetch changelog body if available
    let body = '';
    if (changelogUrl) {
      try {
        const clResp = await fetch(changelogUrl, { signal: controller.signal });
        if (clResp.ok) body = await clResp.text();
      } catch { /* changelog optional */ }
    }
    console.log('[updateCheck] apk.lovix.com release:', version);
    return { version, body, html_url: '', download_url: downloadUrl };
  } catch {
    return null;
  }
}

/**
 * Fetch the latest stable release from GitHub.
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
    const assets = (data.assets as Array<{ name: string; browser_download_url: string }> | undefined) ?? [];
    const arm64Asset = assets.find(a => (a.name ?? '').includes('arm64'));
    const fallbackAsset = assets[0];
    const downloadUrl = (arm64Asset ?? fallbackAsset)?.browser_download_url ?? '';
    console.log('[updateCheck] GitHub latest release:', releaseVersion);
    return {
      version: releaseVersion,
      body: (data.body as string | undefined) ?? '',
      html_url: (data.html_url as string | undefined) ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
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
 * Tries apk.lovix.com first, then falls back to GitHub API.
 * Times out after 5 seconds and fails silently on network errors.
 */
export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  // Development builds don't check for updates
  if (CURRENT_VERSION === '') {
    console.warn('[updateCheck] checkForUpdate skipped: VITE_APP_VERSION is empty — APK was likely built without version stamping');
    return null;
  }
  console.log('[updateCheck] checkForUpdate: current version =', CURRENT_VERSION);

  // Try apk.lovix.com first, then GitHub
  let release: ReleaseInfo | null = null;
  release = await checkApkServer();
  if (!release) release = await checkGitHub();
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

  console.log('[updateCheck] Update available:', release.version, 'with download_url:', !!release.download_url);
  return release;
}

/**
 * Force check for updates, ignoring any previous dismissal.
 * Used by the "Check for updates" button in Settings → About so the user
 * always sees the modal when they manually request it.
 *
 * Tries apk.lovix.com first, then falls back to GitHub API.
 */
export async function forceCheckForUpdate(): Promise<ReleaseInfo | null> {
  // Development builds don't check for updates
  if (CURRENT_VERSION === '') {
    console.warn('[updateCheck] forceCheckForUpdate skipped: VITE_APP_VERSION is empty');
    return null;
  }
  console.log('[updateCheck] forceCheckForUpdate: current version =', CURRENT_VERSION);

  // Try apk.lovix.com first, then GitHub
  let release: ReleaseInfo | null = null;
  release = await checkApkServer();
  if (!release) release = await checkGitHub();
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
