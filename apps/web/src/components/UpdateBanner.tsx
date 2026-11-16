import { X, Download } from 'lucide-react';
import { useState } from 'react';
import { getUpdateRelease, setUpdateRelease } from '../lib/updateState';
import { dismissVersion } from '../lib/updateCheck';

/**
 * Top update banner — shows "NEW VERSION {version}" with an Update button.
 *
 * Download flow: When the user clicks "Update", the APK is downloaded using
 * the browser's native download manager. On Android, this triggers the system
 * download notification. After the download completes, the user taps the
 * notification to open Android's built-in package installer dialog, which
 * shows the standard "Install unknown app" / "Update app" system prompt.
 *
 * This is the same flow used by the Play Store and other app stores on Android.
 * The app cannot programmatically trigger the package installer from a WebView
 * without native code and the REQUEST_INSTALL_PACKAGES permission, which is
 * forbidden by the project's CI tests.
 *
 * Users are never redirected to the GitHub repository page.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const release = getUpdateRelease();

  const version = release?.version ?? '';

  /**
   * Start the APK download using the browser's native download manager.
   *
   * On Android WebView (Capacitor), `window.location.href` with an APK URL
   * triggers the system download manager, which shows a notification in the
   * status bar. When the user taps the notification, Android opens the built-in
   * package installer dialog — the same "Install unknown app" prompt users see
   * when installing any APK from a browser.
   *
   * This avoids:
   * - Redirecting users to the GitHub release page (source code exposure)
   * - Showing a custom download modal (not the system's native flow)
   * - Using blob URLs which may not work on all Android WebView versions
   */
  const startDownload = () => {
    if (!release?.download_url || downloading) return;
    setDownloading(true);

    // Create a temporary anchor to trigger the download
    // The anchor approach with a direct URL (not blob) lets the browser's
    // download manager handle the file, which on Android shows the system
    // download notification and package installer prompt.
    const a = document.createElement('a');
    a.href = release.download_url;
    a.download = `streamix-${release.version}.apk`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Give feedback after a short delay — the download happens in the background
    setTimeout(() => setDownloading(false), 2000);
  };

  const handleDismiss = () => {
    if (release) dismissVersion(release.version);
    setDismissed(true);
    setUpdateRelease(null);
  };

  if (dismissed) return null;

  return (
    <div className="bg-ink-1/80 border-b border-rule/40 px-4 py-2 text-center">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 shrink-0 text-ink-3" />
          <span className="font-mono text-[length:var(--t-xs)] text-ink-2">
            NEW VERSION {version}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startDownload}
            disabled={downloading}
            className="card-hover tap flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-white disabled:opacity-50"
          >
            {downloading ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                Downloading...
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Update
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="card-hover tap flex h-7 w-7 items-center justify-center rounded-md text-ink-3"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
