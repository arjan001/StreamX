/**
 * Shared state for app update availability.
 *
 * Both the top banner (Chrome) and the "Check for updates" button (More.tsx)
 * read and write this store so they stay in sync without prop-drilling through
 * the entire app tree.
 */

import type { ReleaseInfo } from './updateCheck';

let currentRelease: ReleaseInfo | null = null;
const listeners = new Set<() => void>();

export function getUpdateRelease(): ReleaseInfo | null {
  return currentRelease;
}

export function setUpdateRelease(release: ReleaseInfo | null): void {
  currentRelease = release;
  for (const fn of listeners) fn();
}

export function subscribeUpdateRelease(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
