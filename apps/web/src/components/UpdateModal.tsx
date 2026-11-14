import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Download, X } from 'lucide-react';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import type { ReleaseInfo } from '../lib/updateCheck';

/**
 * "What's New" update modal — shown when a newer stable release is available.
 *
 * Uses the same centered overlay design as Welcome, ExpiredDialog and ExitDialog:
 * glass-float card, data-nav-contain, focusFirst on mount, anim-fade overlay.
 * z-[71] sits between Welcome (z-[70]) and ExpiredDialog (z-[72]).
 *
 * The changelog body comes from the GitHub release notes, rendered as plain text
 * in a scrollable area. Three states:
 * 1. "Update now" — fetches the APK as a blob and triggers download via blob URL,
 *    avoiding any browser navigation or "open with" dialog on Android TWA apps.
 * 2. "Downloading..." — shows while the APK is being fetched.
 * 3. "Install update" — appears after download completes, attempts to open the
 *    package installer intent.
 * Dismiss closes and remembers the version (with 1-hour expiry).
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
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

  const startDownload = useCallback(async () => {
    if (release == null || downloading) return;
    const url = release.download_url;
    if (!url) return;
    setDownloading(true);
    setDownloaded(false);

    try {
      // Fetch the APK as a blob and trigger download via a temporary blob URL.
      // This avoids any browser navigation or "open with" dialog on Android TWA apps.
      // The browser's download manager handles the APK file automatically.
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `streamix-v${release.version}.apk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke the blob URL after a short delay to allow the download to start
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      setDownloading(false);
      setDownloaded(true);
    } catch {
      // If fetch fails (e.g., CORS), fall back to window.location.href
      // which will trigger the browser's download manager
      window.location.href = url;
      setDownloading(false);
      setDownloaded(true);
    }
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
          {downloaded ? (
            <button
              data-nav-first
              type="button"
              onClick={() => {
                // Try to open the downloaded APK for installation
                // On Android, the download should be in the Downloads folder
                // We attempt to trigger the package installer via intent
                try {
                  // On TWA/native WebView, try to use the Intent directly
                  const intentUrl = `intent://view?package=${encodeURIComponent('com.streamix')}&type=application/vnd.android.package-archive#Intent;scheme=package;end`;
                  window.location.href = intentUrl;
                } catch {
                  // Fallback: just let the user find it in their downloads
                  onDismiss();
                }
              }}
              className={`${button} bg-tally/8 border-tally/30`}
            >
              <CheckCircle className="h-5 w-5 shrink-0 text-ground" aria-hidden />
              <span className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                Install update
              </span>
            </button>
          ) : (
            <button
              data-nav-first
              type="button"
              onClick={startDownload}
              disabled={downloading}
              className={`${button} bg-tally/8 border-tally/30 ${downloading ? 'opacity-60' : ''}`}
            >
              <Download className={`h-5 w-5 shrink-0 text-ground ${downloading ? 'animate-spin' : ''}`} aria-hidden />
              <span className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
                {downloading ? 'Downloading...' : 'Update now'}
              </span>
            </button>
          )}
          <button type="button" onClick={onDismiss} className={button}>
            <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
              {downloaded ? 'Done' : 'Dismiss'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
