/**
 * Shared state for app update availability and download progress.
 *
 * Both the top banner (Chrome) and the "Check for updates" button (More.tsx)
 * read and write this store so they stay in sync without prop-drilling through
 * the entire app tree.
 *
 * Download uses XHR blob download with progress tracking so the app can show
 * a progress bar and an "Install now" button directly in the UI. This is
 * essential for TV users who cannot access the system notification shade.
 * When the download completes, the blob URL is used to trigger the Android
 * package installer via a temporary anchor tag — the same flow used by the
 * initial APK downloader.
 */

import type { ReleaseInfo } from './updateCheck';

let currentRelease: ReleaseInfo | null = null;

/** Download progress state shared between banner and modal. */
export interface DownloadProgress {
  downloading: boolean;
  percent: number;
  completed: boolean;
  blobUrl: string | null;
  error: boolean;
}

let downloadProgress: DownloadProgress = {
  downloading: false,
  percent: 0,
  completed: false,
  blobUrl: null,
  error: false,
};

const listeners = new Set<() => void>();

export function getUpdateRelease(): ReleaseInfo | null {
  return currentRelease;
}

export function setUpdateRelease(release: ReleaseInfo | null): void {
  currentRelease = release;
  for (const fn of listeners) fn();
}

export function getDownloadProgress(): DownloadProgress {
  return downloadProgress;
}

export function setDownloadProgress(patch: Partial<DownloadProgress>): void {
  downloadProgress = { ...downloadProgress, ...patch };
  for (const fn of listeners) fn();
}

/** Reset download progress and revoke the blob URL to free memory. */
export function resetDownloadProgress(): void {
  if (downloadProgress.blobUrl) {
    URL.revokeObjectURL(downloadProgress.blobUrl);
  }
  downloadProgress = {
    downloading: false,
    percent: 0,
    completed: false,
    blobUrl: null,
    error: false,
  };
  for (const fn of listeners) fn();
}

export function subscribeUpdateRelease(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
