import { X, Download, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  getDownloadProgress,
  getUpdateRelease,
  resetDownloadProgress,
  setDownloadProgress,
  setUpdateRelease,
  subscribeUpdateRelease,
} from '../lib/updateState';
import { dismissVersion, recordInstalledVersion } from '../lib/updateCheck';
import { logInfo } from '../lib/sentry';

/**
 * Top update banner — shows "NEW VERSION {version}" with an Update button.
 *
 * Download flow: When the user clicks "Update", the APK is fetched as a blob
 * with XHR progress events. The banner shows a live progress bar during the
 * download. When complete, the button changes to "Install" which triggers the
 * Android package installer via a blob URL — the same flow used by the initial
 * APK downloader.
 *
 * This approach is essential for TV users who cannot access the system
 * notification shade. The install prompt appears directly in the app UI.
 *
 * Download state is shared via updateState.ts so dismissing the UpdateModal
 * does not hide the progress — the banner continues to show the download status.
 *
 * After the user triggers the install, the version is recorded so the banner
 * does not reappear after the app restarts with the new version.
 *
 * Users are never redirected to the GitHub repository page.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgressState] = useState(getDownloadProgress);
  const release = getUpdateRelease();

  const version = release?.version ?? '';
  const { downloading, percent, completed, blobUrl, error } = progress;

  // Subscribe to shared download progress updates
  useEffect(() => {
    return subscribeUpdateRelease(() => setProgressState(getDownloadProgress()));
  }, []);

  /**
   * Start the APK download using XMLHttpRequest for progress tracking.
   * The blob is stored in the shared state so both banner and modal can access it.
   */
  const startDownload = () => {
    if (!release?.download_url || downloading) return;

    setDownloadProgress({ downloading: true, percent: 0, completed: false, error: false });
    logInfo('Update download started (banner)', { version });

    // Record that the user initiated the install so we don't prompt again
    recordInstalledVersion(version);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', release.download_url, true);
    xhr.responseType = 'blob';

    xhr.onprogress = (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        setDownloadProgress({ percent: pct });
      } else {
        // Fallback: simulate progress when total is unknown
        setDownloadProgress({ percent: Math.min(percent + 2, 90) });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response as Blob;
        const blobUrl = URL.createObjectURL(blob);
        setDownloadProgress({ downloading: false, percent: 100, completed: true, blobUrl });
        logInfo('Update download completed (banner)', { version, size: blob.size });
      } else {
        setDownloadProgress({ downloading: false, error: true });
        logInfo('Update download failed (banner)', { version, status: xhr.status });
      }
    };

    xhr.onerror = () => {
      setDownloadProgress({ downloading: false, error: true });
      logInfo('Update download network error (banner)', { version });
    };

    xhr.send();
  };

  /** Trigger the install by opening the blob URL. */
  const triggerInstall = () => {
    if (!blobUrl) return;
    logInfo('Update install triggered (banner)', { version });
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `streamix-v${release?.version}.apk`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDismiss = () => {
    if (release) dismissVersion(release.version);
    setDismissed(true);
    setUpdateRelease(null);
    // Clean up blob URL if download was completed
    if (completed) {
      resetDownloadProgress();
    }
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
        <div className="flex flex-1 items-center gap-2">
          {/* Progress bar — shown when downloading */}
          {downloading && (
            <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-ink-1/50">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {/* Action button */}
          {error ? (
            <button
              type="button"
              onClick={() => {
                setDownloadProgress({ error: false });
                startDownload();
              }}
              className="card-hover tap flex items-center gap-1.5 rounded-md bg-red-500/20 px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-red-300"
            >
              Retry
            </button>
          ) : completed && blobUrl ? (
            <button
              type="button"
              onClick={triggerInstall}
              className="card-hover tap flex items-center gap-1.5 rounded-md bg-tally/8 px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-ground"
            >
              <Check className="h-3.5 w-3.5" />
              Install
            </button>
          ) : (
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
                  {percent}%
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  Update
                </>
              )}
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
