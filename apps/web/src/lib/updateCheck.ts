/**
 * Check for new app releases on GitHub.
 *
 * Fetches the latest stable release from the GitHub API, compares it with the
 * current app version, and returns release info if a newer version is available.
 * Dismissed versions are remembered via localStorage so the same update isn't
 * shown repeatedly.
 *
 * The GitHub API is public and rate-limited at 60/hour unauthenticated, which
 * is sufficient for app boot checks. A 5-second timeout prevents blocking the
 * UI on slow networks, and failures are silent — no update shown on error.
 */

const GITHUB_REPO = 'arjan001/StreamX';
const DISMISS_PREFIX = 'update.dismissed.';

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
  /** The GitHub release page URL. */
  html_url: string;
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
 */
export function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}v${version}`) === '1';
  } catch {
    return false;
  }
}

/**
 * Mark a version as dismissed so it won't be shown again.
 */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}v${version}`, '1');
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
  if (CURRENT_VERSION === '') return null;

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

    // Compare versions — only show if the release is newer
    if (compareVersion(releaseVersion, CURRENT_VERSION) <= 0) return null;

    // Skip if the user already dismissed this version
    if (isDismissed(releaseVersion)) return null;

    return {
      version: releaseVersion,
      body: (data.body as string | undefined) ?? '',
      html_url: (data.html_url as string | undefined) ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
    };
  } catch {
    // Network error, timeout, or parse error — silently fail
    return null;
  }
}
