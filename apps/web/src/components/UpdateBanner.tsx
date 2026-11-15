import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, X, Check } from 'lucide-react';
import { focusFirst } from '../lib/spatialNav';
import type { ReleaseInfo } from '../lib/updateCheck';
import { getUpdateRelease, setUpdateRelease, subscribeUpdateRelease } from '../lib/updateState';
import { dismissVersion } from '../lib/updateCheck';

/**
 * Top update banner — TEMPORARILY DISABLED.
 *
 * The download flow redirects users to GitHub on Smart TV/Google TV devices.
 * Hidden until a proper TV-compatible update mechanism is implemented.
 * The "Check for updates" button in Settings → About still works for manual checks.
 */
export function UpdateBanner() {
  // TODO: Re-enable when TV-compatible download flow is ready
  // The fetch+blob approach works on Android phones but redirects to GitHub
  // on TV browsers (WebOS, Tizen, Android TV) which don't support blob downloads.
  return null;
}
