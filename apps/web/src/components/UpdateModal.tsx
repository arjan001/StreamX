import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, X } from 'lucide-react';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import {
  getDownloadProgress,
  getUpdateRelease,
  resetDownloadProgress,
  setDownloadProgress,
  subscribeUpdateRelease,
} from '../lib/updateState';
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
 * in a scrollable area. Download uses XHR with progress events so the user sees
 * a live progress bar. Download state is shared via updateState.ts so the banner
 * also reflects the progress — dismissing the modal does not cancel the download.
 *
 * This approach is essential for TV users who cannot access the system
 * notification shade. The install prompt appears directly in the app UI.
 *
 * Three states:
 * 1. "Update now" — starts the XHR download.
 * 2. "Downloading..." — shows progress bar with percentage.
 * 3. "Install" — triggers the APK install via blob URL.
 * Dismiss closes the modal but keeps the download running in the background.
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
  const [progress, setProgressState] = useState(getDownloadProgress);

  const { downloading, percent, completed, blobUrl, error } = progress;

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

  // Subscribe to shared download progress updates
  useEffect(() => {
    return subscribeUpdateRelease(() => setProgressState(getDownloadProgress()));
  }, []);

  /**
   * Start the APK download using XMLHttpRequest for progress tracking.
   * The blob is stored in the shared state so both banner and modal can access it.
   */
  const startDownload = useCallback(() => {
    if (release == null || downloading) return;
    const url = release.download_url;
    if (!url) return;

    setDownloadProgress({ downloading: true, percent: 0, completed: false, error: false });
    logInfo('Update download started (modal)', { version: release.version });

    // Record that the user initiated the install so we don't prompt again
    recordInstalledVersion(release.version);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';

    xhr.onprogress = (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        setDownloadProgress({ percent: pct });
      } else {
        setDownloadProgress({ percent: Math.min(percent + 2, 90) });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response as Blob;
        const blobUrl = URL.createObjectURL(blob);
        setDownloadProgress({ downloading: false, percent: 100, completed: true, blobUrl });
        logInfo('Update download completed (modal)', { version: release.version, size: blob.size });
      } else {
        setDownloadProgress({ downloading: false, error: true });
        logInfo('Update download failed (modal)', { version: release.version, status: xhr.status });
      }
    };

    xhr.onerror = () => {
      setDownloadProgress({ downloading: false, error: true });
      logInfo('Update download network error (modal)', { version: release.version });
    };

    xhr.send();
  }, [release, downloading, percent]);

  /** Trigger the install by opening the blob URL. */
  const triggerInstall = useCallback(() => {
    if (!blobUrl || !release) return;
    logInfo('Update install triggered (modal)', { version: release.version });
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `streamix-v${release.version}.apk`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [blobUrl, release]);

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
          {error ? (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-red-400/30 bg-red-500/8 px-4 py-3">
              <span className="text-[length:var(--t-md)] font-semibold text-red-300 tv:text-[length:var(--t-lg)]">
                Download failed
              </span>
              <button
                type="button"
                onClick={() => { setDownloadProgress({ error: false }); startDownload(); }}
                className="ml-auto card-hover tap rounded-md bg-red-400/20 px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-red-300"
              >
                Try again
              </button>
            </div>
          ) : completed && blobUrl ? (
            <>
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-tally/30 bg-tally/8 px-4 py-3">
                <Check className="h-5 w-5 shrink-0 text-ground" aria-hidden />
                <div>
                  <p className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                    Download complete
                  </p>
                  <p className="text-[length:var(--t-xs)] text-ink-2 tv:text-[length:var(--t-sm)]">
                    Tap Install to update the app now.
                  </p>
                </div>
              </div>
              <button
                data-nav-first
                type="button"
                onClick={triggerInstall}
                className={`${button} bg-tally/8 border-tally/30`}
              >
                <Check className="h-5 w-5 shrink-0 text-ground" aria-hidden />
                <span className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                  Install
                </span>
              </button>
            </>
          ) : downloading ? (
            <>
              {/* Progress bar */}
              <div className="mb-3 flex items-center gap-3">
                <Download className={`h-5 w-5 shrink-0 text-ground ${downloading ? 'animate-spin' : ''}`} aria-hidden />
                <div className="flex-1">
                  <p className="text-[length:var(--t-sm)] font-medium text-ink tv:text-[length:var(--t-md)]">
                    Downloading... {percent}%
                  </p>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-1/50">
                    <div
                      className="h-full bg-brand transition-all duration-300"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              </div>
              <button type="button" onClick={onDismiss} className={button}>
                <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
                  Dismiss
                </span>
              </button>
              <p className="mt-2 text-center text-[length:var(--t-xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
                Dismissing keeps the download running.
              </p>
            </>
          ) : (
            <>
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
              <button type="button" onClick={onDismiss} className={button}>
                <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
                  Dismiss
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
