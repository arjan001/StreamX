/**
 * Adding and removing sources — the one place the add flow and the Sources sheet
 * both go through.
 *
 * A source is whatever the viewer points the app at: an Xtream server, a
 * playlist link, a single stream link. Several can be saved; one is active.
 * `SOURCE_TYPES` is the picker's list, and it is the ONE place a new type is
 * announced: add an entry here, add its form to `components/AddSource.tsx`, and
 * the first run, Add account and Sources sheet all offer it.
 */
import { sourceName } from './sourceName.ts';
import {
  activeProvider, addProvider, allProviders, forgetPanelState, getProvider, removeProvider,
  resetPanelClient, setActiveProvider, type Provider,
} from './providers/index.ts';
import {
  attachSubscription, forgetAccountData, localStatus, switchToAccount,
} from './localCatalogue.ts';
import { forgetGuideOf } from './bulkGuide.ts';
import { signOut, startSourceSession } from './session.ts';
import { reopenDoor } from './firstRun.ts';
import { normaliseMac } from '@iptv/core-stalker';
import { macProblem } from './providers/stalker.ts';
import { stalkerSupported } from './platform.ts';

/** Stop playback before the library changes under it; absent where there is no player (tests). */
async function stopPlayback(): Promise<void> {
  try { (await import('./playerCore.ts')).player.teardown(); } catch { /* no player here */ }
}

export type SourceTypeId = 'xtream' | 'm3u' | 'stream' | 'stalker';

export interface SourceType {
  readonly id: SourceTypeId;
  /** Short and plain: this is a button on a television. */
  readonly label: string;
  readonly hint: string;
}

export const SOURCE_TYPES: readonly SourceType[] = [
  { id: 'xtream', label: 'Xtream server', hint: 'Server address, username and password' },
  { id: 'm3u', label: 'Playlist link (M3U/M3U8)', hint: 'A link to a playlist, and optionally a TV guide' },
  { id: 'stream', label: 'Single stream link', hint: 'One link that plays one channel' },
  { id: 'stalker', label: 'Stalker portal', hint: 'Portal address and the MAC address your provider registered' },
];

/**
 * What THIS device can add.
 *
 * A portal needs request headers a browser forbids (`Cookie`, `User-Agent`), so it
 * is offered only where the app has a native HTTP layer — the Android and iOS
 * apps. On the website, Tizen and webOS it is not listed at all rather than listed
 * and failing. Everything that shows the picker goes through here.
 */
export function sourceTypesOffered(): readonly SourceType[] {
  return SOURCE_TYPES.filter((t) => t.id !== 'stalker' || stalkerSupported());
}

export interface AddResult {
  ok: boolean;
  message: string;
}

/** An http(s) address, tidied, or null when it is not one. */
export function cleanUrl(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : null;
  } catch { return null; }
}

function nameFor(typed: string | undefined, address: string, kind: Provider['kind']): string {
  return sourceName(typed, address, kind, allProviders().map((p) => p.name));
}

/**
 * Add a playlist-shaped source and load it.
 *
 * It is saved first and loaded through the ordinary refresh, so the progress the
 * rest of the app already shows is the progress here. A source that fails to
 * load is taken back out again — and the one that was active is restored — so a
 * mistyped link never leaves a dead entry behind.
 */
async function addPlaylistShaped(
  fields: Omit<Provider, 'id' | 'addedAt'>,
  failure: string,
): Promise<AddResult> {
  const before = activeProvider()?.id ?? null;
  const created = addProvider(fields);
  setActiveProvider(created.id);
  resetPanelClient();
  await attachSubscription();
  const st = localStatus();
  if (st.state === 'error') {
    const why = st.error ?? failure;
    await removeSource(created.id, { keepDoor: true });
    if (before !== null && getProvider(before) !== null) {
      setActiveProvider(before);
      await switchToAccount();
    }
    return { ok: false, message: why };
  }
  await startSourceSession(`${created.kind}:${created.id}:${Date.now()}`);
  return { ok: true, message: 'Added. Your channels are ready.' };
}

export async function addPlaylistSource(
  opts: { url: string; epgUrl?: string; name?: string },
): Promise<AddResult> {
  const url = cleanUrl(opts.url);
  if (url === null) return { ok: false, message: 'Enter the playlist link, starting with http:// or https://.' };
  const guide = opts.epgUrl === undefined || opts.epgUrl.trim() === '' ? null : cleanUrl(opts.epgUrl);
  if (opts.epgUrl !== undefined && opts.epgUrl.trim() !== '' && guide === null) {
    return { ok: false, message: 'The TV guide link must start with http:// or https://.' };
  }
  const name = opts.name?.trim() ?? '';
  return addPlaylistShaped({
    kind: 'm3u',
    name: nameFor(name, url, 'm3u'),
    url,
    ...(guide === null ? {} : { epgUrl: guide }),
    enabled: true,
  }, 'The playlist could not be read.');
}

export async function addStreamSource(opts: { url: string; name?: string }): Promise<AddResult> {
  const url = cleanUrl(opts.url);
  if (url === null) return { ok: false, message: 'Enter the stream link, starting with http:// or https://.' };
  const name = opts.name?.trim() ?? '';
  return addPlaylistShaped({
    kind: 'stream',
    name: nameFor(name, url, 'stream'),
    url,
    enabled: true,
  }, 'The stream could not be added.');
}

export interface StalkerFields {
  portal: string;
  mac: string;
  serial?: string;
  deviceId?: string;
  deviceId2?: string;
  signature?: string;
  /** Only for portals that ask for a login after the MAC check. */
  username?: string;
  password?: string;
  name?: string;
}

export async function addStalkerSource(opts: StalkerFields): Promise<AddResult> {
  if (!stalkerSupported()) {
    return { ok: false, message: 'Portals can be added in the Android and iOS apps.' };
  }
  const url = cleanUrl(opts.portal);
  if (url === null) return { ok: false, message: 'Enter the portal address, starting with http:// or https://.' };
  const problem = macProblem(opts.mac);
  if (problem !== null) return { ok: false, message: problem };
  const text = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());
  const serial = text(opts.serial);
  const deviceId = text(opts.deviceId);
  const deviceId2 = text(opts.deviceId2);
  const signature = text(opts.signature);
  const username = text(opts.username);
  const name = opts.name?.trim() ?? '';
  return addPlaylistShaped({
    kind: 'stalker',
    name: nameFor(name, url, 'stalker'),
    url,
    mac: normaliseMac(opts.mac),
    ...(serial === null ? {} : { serial }),
    ...(deviceId === null ? {} : { deviceId }),
    ...(deviceId2 === null ? {} : { deviceId2 }),
    ...(signature === null ? {} : { signature }),
    ...(username === null ? {} : { username, password: opts.password ?? '' }),
    enabled: true,
  }, 'The portal could not be read.');
}

/**
 * Remove a source and everything this device kept for it: its stored password or
 * link, its cached channel list, its guide and its remembered connection.
 *
 * Removing the one in use switches to whatever is left; removing the last one
 * signs out and puts the first-run door back.
 */
export async function removeSource(id: number, opts: { keepDoor?: boolean } = {}): Promise<void> {
  const wasActive = activeProvider()?.id === id;
  if (wasActive) await stopPlayback();
  removeProvider(id);
  resetPanelClient();
  forgetPanelState(id);
  await forgetGuideOf(id);
  await forgetAccountData(id);
  if (allProviders().length === 0) {
    signOut();
    if (opts.keepDoor !== true) reopenDoor();
    return;
  }
  if (wasActive) await switchToAccount();
}

/** Make a saved source the one in use. */
export async function useSource(id: number): Promise<void> {
  /* Stop whatever the previous source was playing before the library changes
     under it — otherwise the old stream keeps running under the new name. */
  await stopPlayback();
  setActiveProvider(id);
  resetPanelClient();
  /* Not a re-download: this device may already hold that source's library. */
  await switchToAccount();
}
