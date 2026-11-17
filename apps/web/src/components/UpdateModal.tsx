import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import { getUpdateRelease, subscribeUpdateRelease } from '../lib/updateState';
import { recordInstalledVersion } from '../lib/updateCheck';
import type { ReleaseInfo } from '../lib/updateCheck';
import { logInfo } from '../lib/sentry';

/**
 * "What's New" update modal — shown when a newer stable release is available.
 *
 * Uses the same centered overlay design as Welcome, ExpiredDialog and ExitDialog:
 * glass-float card, data-nav-contain, focusFirst on mount, anim-fade overlay.
 * z-[71] sits between Welcome (z-[70]) and ExpiredDialog (z-[72]).
 *
 * The changelog body comes from the GitHub release notes, rendered as plain text
 * in a scrollable area.
 *
 * Download flow: "Update now" triggers the APK download via `window.location.href`,
 * which on Android WebView opens the system download manager. The user sees a
 * notification in the status bar with live progress. When complete, they tap the
 * notification to open Android's built-in package installer — the same flow used
 * by the Play Store, Telegram, VLC, MX Player, and other apps.
 *
 * After the user clicks "Update now", the modal shows a confirmation message
 * telling them to check their notification shade for the download progress.
 * The version is recorded so the modal does not reappear after the app restarts.
 *
 * Dismiss closes the modal and remembers the version for 24 hours.
 */
export function UpdateModal({
  release,
  onDismiss,
}: {
  release: ReleaseInfo | null;
  onDismiss: () => void;
}) {
  const modern = useSkin().shell === 'modern';
  const panel = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

  useEffect(() => {
    return subscribeUpdateRelease(() => {});
  }, []);

  /**
   * Start the APK download using the system download manager.
   *
   * On Android WebView (Capacitor), `window.location.href` with a direct APK URL
   * triggers the system download manager, which shows a notification in the
   * status bar with live progress. When the user taps the notification, Android
   * opens the built-in package installer dialog.
   *
   * This is preferred over blob downloads because:
   * - The system handles retries, pauses, and network changes
   * - Download continues even if the app is backgrounded
   * - No memory pressure from holding the entire APK in WebView RAM
   * - Works reliably across all Android WebView versions
   * - The user sees progress in the system notification shade
   */
  const startDownload = useCallback(() => {
    if (release == null || downloading) return;
    const url = release.download_url;
    if (!url) return;

    setDownloading(true);
    logInfo('Update download started (modal)', { version: release.version });

    // Record that the user initiated the install so we don't prompt again
    recordInstalledVersion(release.version);

    // Trigger the system download manager
    window.location.href = url;
  }, [release, downloading]);

  if (release === null) return null;

  const card = modern
    ? 'welcome-card glass-float tally-glow is-on w-full max-w-[26rem] tv:max-w-[36rem] p-5 tv:p-6'
    : 'card w-full max-w-[26rem] tv:max-w-[36rem] border border-rule bg-panel p-5 shadow-lg tv:p-6';
  const button = 'card card-hover tap mt-3 flex w-full items-center justify-center gap-3'
    + ' border border-rule px-4 py-3 text-center tv:py-3.5';

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="anim-fade fixed inset-0 z-[71] flex items-center justify-center bg-black/35 px-4 py-6 tv:px-8"
    >
      <div className="absolute inset-0" aria-hidden />
      <div ref={panel} className={`relative z-10 ${card}`}>
        <div className="flex items-start justify-between gap-3">
          <h1
            id="update-title"
            className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]"
          >
            What's new in v{release.version}
          </h1>
          <button
            type="button"
            onClick={onDismiss}
            className="card-hover tap ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
            aria-label="Dismiss"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {release.body && (
          <div
            className="mt-3 max-h-[20rem] overflow-y-auto text-[length:var(--t-sm)] leading-relaxed text-ink-2"
            style={{ scrollbarWidth: 'thin' }}
          >
            {release.body.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                {line}
              </p>
            ))}
          </div>
        )}

        <div className="mt-5">
          {downloading ? (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-tally/30 bg-tally/8 px-4 py-3">
              <Download className="h-5 w-5 shrink-0 animate-pulse text-ground" aria-hidden />
              <div>
                <p className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                  Download started
                </p>
                <p className="text-[length:var(--t-xs)] text-ink-2 tv:text-[length:var(--t-sm)]">
                  Check your notification shade for progress. Tap the notification when complete to install.
                </p>
              </div>
            </div>
          ) : (
            <button
              data-nav-first
              type="button"
              onClick={startDownload}
              className={`${button} bg-tally/8 border-tally/30`}
            >
              <Download className="h-5 w-5 shrink-0 text-ground" aria-hidden />
              <span className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                Update now
              </span>
            </button>
          )}
          <button type="button" onClick={onDismiss} className={button}>
            <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
              Dismiss
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
