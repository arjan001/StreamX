import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, X, Check, AlertTriangle } from 'lucide-react';
import { focusFirst } from '../lib/spatialNav';
import type { ReleaseInfo } from '../lib/updateCheck';
import { getUpdateRelease, setUpdateRelease, subscribeUpdateRelease } from '../lib/updateState';
import { dismissVersion } from '../lib/updateCheck';

/**
 * Top update banner — sits at the very top of the app, above the navbar.
 *
 * Shows "NEW VERSION {version}" with an Update button and X dismiss button.
 * When the user clicks Update, a modal appears showing download progress.
 * After download, the modal switches to an install prompt, mimicking Android's
 * package installer dialog. No browser navigation or Chrome redirects.
 *
 * The banner is always in flow (not floating), so it pushes everything down
 * rather than covering it.
 */
export function UpdateBanner() {
  const release = useSyncExternalStore(subscribeUpdateRelease, getUpdateRelease, () => null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const dismiss = useCallback(() => {
    if (release !== null) dismissVersion(release.version);
    setUpdateRelease(null);
  }, [release]);

  const startDownload = useCallback(async () => {
    if (release == null || downloading) return;
    const url = release.download_url;
    if (!url) return;
    setDownloading(true);
    setDownloaded(false);
    setDownloadError(false);
    setProgress(0);
    setShowModal(true);

    // Revoke previous blob URL if any
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length')) || 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader');

      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (contentLength > 0) {
          setProgress(Math.round((received / contentLength) * 100));
        }
      }

      const blob = new Blob(chunks);
      const blobUrl = URL.createObjectURL(blob);
      blobUrlRef.current = blobUrl;

      // Trigger the download
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `streamix-v${release.version}.apk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setDownloading(false);
      setDownloaded(true);
    } catch {
      setDownloading(false);
      setDownloadError(true);
    }
  }, [release, downloading]);

  // Trigger install using the already-downloaded blob URL
  const triggerInstall = useCallback(() => {
    const blobUrl = blobUrlRef.current;
    if (blobUrl && release) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `streamix-v${release.version}.apk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setShowModal(false);
  }, [release]);

  if (release === null) return null;

  return (
    <>
      <div
        ref={panel}
        data-nav-scope
        className="relative z-50 flex items-center justify-between gap-3 px-4 py-2
          bg-tally/10 border-b border-tally/20"
      >
        {/* Left: NEW VERSION label */}
        <div className="flex items-center gap-2 min-w-0">
          <Download className="h-4 w-4 shrink-0 text-tally" aria-hidden />
          <span className="text-[length:var(--t-sm)] font-semibold text-tally">
            NEW VERSION {release.version}
          </span>
        </div>

        {/* Center: progress bar while downloading */}
        {downloading && (
          <div className="hidden sm:flex items-center gap-2 flex-1 max-w-[20rem]">
            <div className="relative h-1.5 flex-1 rounded-full bg-tally/20 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-tally rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[length:var(--t-xs)] font-mono text-tally tabular-nums shrink-0">
              {progress}%
            </span>
          </div>
        )}

        {/* Right: buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {downloaded ? (
            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="tap flex items-center gap-1.5 rounded-full bg-tally/20 px-3 py-1.5
                text-[length:var(--t-xs)] font-medium text-tally hover:bg-tally/30 transition-colors"
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              Install update
            </button>
          ) : downloading ? (
            <span className="text-[length:var(--t-xs)] text-tally/70 shrink-0">
              Downloading...
            </span>
          ) : (
            <button
              data-nav-first
              type="button"
              onClick={startDownload}
              className="tap flex items-center gap-1.5 rounded-full bg-tally/20 px-3 py-1.5
                text-[length:var(--t-xs)] font-medium text-tally hover:bg-tally/30 transition-colors"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Update
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="card-hover tap flex h-6 w-6 items-center justify-center rounded-full text-tally/60 hover:text-tally transition-colors"
            aria-label="Dismiss update notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Download / Install modal */}
      {showModal && (
        <div
          data-nav-contain
          role="dialog"
          aria-modal="true"
          className="anim-fade fixed inset-0 z-[71] flex items-center justify-center bg-black/50 px-4 py-6 tv:px-8"
        >
          <div className="relative w-full max-w-[24rem] rounded-xl border border-rule bg-panel shadow-2xl tv:max-w-[28rem]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-rule px-5 py-3 tv:px-6">
              <h3 className="text-[length:var(--t-md)] font-semibold text-ink tv:text-[length:var(--t-lg)]">
                {downloadError ? 'Download failed' : downloaded ? 'Install update' : 'Updating Streamix'}
              </h3>
              <button
                type="button"
                onClick={() => { setShowModal(false); setDownloadError(false); }}
                className="text-ink-3 hover:text-ink"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-5 tv:px-6 tv:py-5">
              {downloadError ? (
                /* Download error state */
                <div className="text-center">
                  <AlertTriangle className="mx-auto h-10 w-10 text-ink-3 mb-3" />
                  <p className="text-[length:var(--t-sm)] text-ink-2 mb-4 tv:text-[length:var(--t-md)]">
                    The update could not be downloaded. Please check your internet connection and try again.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setDownloadError(false); startDownload(); }}
                    className="tap inline-flex items-center gap-2 rounded-full bg-tally px-5 py-2.5
                      text-[length:var(--t-sm)] font-semibold text-ground hover:bg-tally/90 transition-colors"
                  >
                    <Download className="h-4 w-4" />
                    Try again
                  </button>
                </div>
              ) : downloaded ? (
                /* Install prompt — mimics Android's install dialog */
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-tally/10">
                    <Check className="h-8 w-8 text-tally" />
                  </div>
                  <p className="text-[length:var(--t-md)] font-semibold text-ink mb-1 tv:text-[length:var(--t-lg)]">
                    Streamix v{release.version}
                  </p>
                  <p className="text-[length:var(--t-sm)] text-ink-2 mb-5 tv:text-[length:var(--t-md)]">
                    Update downloaded successfully. Tap below to install.
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="tap rounded-full border border-rule px-5 py-2.5
                        text-[length:var(--t-sm)] text-ink-2 hover:border-ink-3 hover:text-ink transition-colors"
                    >
                      Later
                    </button>
                    <button
                      type="button"
                      onClick={triggerInstall}
                      className="tap rounded-full bg-tally px-5 py-2.5
                        text-[length:var(--t-sm)] font-semibold text-ground hover:bg-tally/90 transition-colors"
                    >
                      Install now
                    </button>
                  </div>
                </div>
              ) : (
                /* Downloading state with progress */
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center">
                    <Download className="h-8 w-8 animate-spin text-tally" />
                  </div>
                  <p className="text-[length:var(--t-md)] font-semibold text-ink mb-1 tv:text-[length:var(--t-lg)]">
                    Downloading update
                  </p>
                  <p className="text-[length:var(--t-sm)] text-ink-2 mb-5 tv:text-[length:var(--t-md)]">
                    Streamix v{release.version} is being downloaded...
                  </p>
                  {/* Progress bar */}
                  <div className="relative h-3 w-full rounded-full bg-tally/10 overflow-hidden mb-2">
                    <div
                      className="absolute inset-y-0 left-0 bg-tally rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <p className="text-[length:var(--t-xs)] font-mono text-tally tabular-nums">
                    {progress}%
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
