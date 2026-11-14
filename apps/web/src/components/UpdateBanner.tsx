import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, X } from 'lucide-react';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import type { ReleaseInfo } from '../lib/updateCheck';
import { getUpdateRelease, setUpdateRelease, subscribeUpdateRelease } from '../lib/updateState';
import { dismissVersion } from '../lib/updateCheck';

/**
 * Slim update banner — sits below the header, above the page content.
 *
 * Replaces the modal popup: a thin bar with "Update available" text, the
 * version number, an "Update" button, and a dismiss (X) button. When the
 * user clicks "Update", the APK is downloaded silently in the background,
 * similar to how the Play Store works.
 *
 * The banner is always in flow (not floating), so it pushes content down
 * rather than covering it.
 */
export function UpdateBanner() {
  const release = useSyncExternalStore(subscribeUpdateRelease, getUpdateRelease, () => null);
  const modern = useSkin().shell === 'modern';
  const panel = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

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
    setProgress(0);

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
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `streamix-v${release.version}.apk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      setDownloading(false);
      setDownloaded(true);
    } catch {
      // If fetch fails (e.g., CORS), fall back to window.location.href
      window.location.href = url;
      setDownloading(false);
      setDownloaded(true);
    }
  }, [release, downloading]);

  if (release === null) return null;

  return (
    <div
      ref={panel}
      data-nav-scope
      className={`relative z-30 flex items-center gap-3 px-4 py-2
        ${modern
          ? 'bg-tally/10 backdrop-blur-sm border-b border-tally/20'
          : 'bg-tally/10 border-b border-tally/20'
        }`}
    >
      {/* Left: icon + text */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Download className="h-4 w-4 shrink-0 text-tally" aria-hidden />
        <span className="text-[length:var(--t-sm)] font-medium text-tally truncate">
          Update available — v{release.version}
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
          <span className="text-[length:var(--t-xs)] text-tally/70 shrink-0">
            Downloaded — install from Downloads
          </span>
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
  );
}
