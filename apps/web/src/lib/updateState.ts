/**
 * Shared state for app update availability and download progress.
 *
 * Both the top banner (Chrome) and the "Check for updates" button (More.tsx)
 * read and write this store so they stay in sync without prop-drilling through
 * the entire app tree.
 *
 * Download progress is tracked centrally so dismissing the modal does not hide
 * the ongoing download — the banner continues to show the progress bar.
 */

import type { ReleaseInfo } from './updateCheck';

let currentRelease: ReleaseInfo | null = null;

/** Download progress state shared between banner and modal. */
interface DownloadProgress {
  /** Whether a download is currently in progress. */
  downloading: boolean;
  /** Progress percentage 0–100. */
  percent: number;
  /** Whether the download has completed and the APK blob is ready. */
  completed: boolean;
  /** The blob URL for the downloaded APK (for triggering install). */
  blobUrl: string | null;
  /** Whether the last download attempt failed. */
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

/** Get the current download progress state. */
export function getDownloadProgress(): DownloadProgress {
  return { ...downloadProgress };
}

/** Update download progress and notify all listeners. */
export function setDownloadProgress(update: Partial<DownloadProgress>): void {
  Object.assign(downloadProgress, update);
  for (const fn of listeners) fn();
}

/** Reset download progress to initial state. */
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
