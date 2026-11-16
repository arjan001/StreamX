import { X, Download } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getUpdateRelease, setUpdateRelease } from '../lib/updateState';
import { dismissVersion } from '../lib/updateCheck';

/**
 * Top update banner — shows "NEW VERSION {version}" with an Update button.
 *
 * Clicking Update downloads the APK from GitHub Pages as a blob and triggers
 * the browser's download manager. Users are never redirected to the GitHub
 * repository page.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const release = getUpdateRelease();
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const version = release?.version ?? '';

  const startDownload = useCallback(() => {
    if (!release?.download_url || downloading) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setDownloading(true);
    setDownloaded(false);
    setProgress(0);

    fetch(release.download_url, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error('Download failed');
        const contentLength = Number(res.headers.get('content-length')) || 0;
        let received = 0;
        const reader = res.body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (contentLength > 0) {
            setProgress(Math.round((received / contentLength) * 100));
          }
        }
        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `streamix-${release.version}.apk`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setDownloading(false);
        setDownloaded(true);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setDownloading(false);
          setDownloaded(false);
          setProgress(0);
        }
      });
  }, [release, downloading]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleDismiss = () => {
    if (downloading) {
      abortRef.current?.abort();
      setDownloading(false);
    }
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
        {downloading && (
          <div className="flex-1 max-w-[8rem]">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-3/30">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!downloading && !downloaded && (
            <button
              type="button"
              onClick={startDownload}
              className="card-hover tap flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-white"
            >
              <Download className="h-3.5 w-3.5" />
              Update
            </button>
          )}
          {downloaded && (
            <span className="font-mono text-[length:var(--t-xs)] text-green-400">
              Downloaded
            </span>
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
