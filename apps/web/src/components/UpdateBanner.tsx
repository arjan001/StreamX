import { X, Download, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  getUpdateRelease,
  setUpdateRelease,
  subscribeUpdateRelease,
} from '../lib/updateState';
import { dismissVersion, recordInstalledVersion } from '../lib/updateCheck';
import { logInfo } from '../lib/sentry';

/**
 * Top update banner — shows "NEW VERSION {version}" with an Update button.
 *
 * Download flow: When the user clicks "Update", the APK download is triggered
 * via `window.location.href`, which on Android WebView opens the system download
 * manager. The user sees a notification in the status bar showing download
 * progress. When complete, they tap the notification to open Android's built-in
 * package installer — the same "Install unknown app" / "Update app" system
 * prompt used by the Play Store, Telegram, VLC, MX Player, and other apps.
 *
 * This is the standard approach for APK auto-update in WebView-based apps.
 * The app does not need REQUEST_INSTALL_PACKAGES permission because the system
 * download manager handles the install flow natively.
 *
 * After the user triggers the install, the version is recorded so the banner
 * does not reappear after the app restarts with the new version.
 *
 * Users are never redirected to the GitHub repository page.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const release = getUpdateRelease();

  const version = release?.version ?? '';

  useEffect(() => {
    return subscribeUpdateRelease(() => {});
  }, []);

  /**
   * Start the APK download using the system download manager.
   *
   * On Android WebView (Capacitor), `window.location.href` with a direct APK URL
   * triggers the system download manager, which shows a notification in the
   * status bar with live progress. When the user taps the notification, Android
   * opens the built-in package installer dialog — the same flow users see when
   * installing any APK from a browser or from apps like Telegram/VLC.
   *
   * This is preferred over blob downloads because:
   * - The system handles retries, pauses, and network changes
   * - Download continues even if the app is backgrounded
   * - No memory pressure from holding the entire APK in WebView RAM
   * - Works reliably across all Android WebView versions
   * - The user sees progress in the system notification shade
   */
  const startDownload = () => {
    if (!release?.download_url || installing) return;
    setInstalling(true);
    logInfo('Update download started (banner)', { version });

    // Record that the user initiated the install so we don't prompt again
    recordInstalledVersion(version);

    // Trigger the system download manager
    window.location.href = release.download_url;
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
            NEW VERSION <strong className="font-bold">{version}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {installing ? (
            <div className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              <span className="font-mono text-[length:var(--t-xs)] text-ink-3">
                Downloading...
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={startDownload}
              className="card-hover tap flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-white"
            >
              <Download className="h-3.5 w-3.5" />
              Update
            </button>
          )}
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
