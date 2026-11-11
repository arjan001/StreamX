/**
 * Where sources live: on the device, and nowhere else.
 *
 * A client that talks to the provider directly must be able to sign in again on
 * every launch, so the secrets are kept — but not as readable text. The password
 * (and a playlist link, which routinely carries one) is sealed with a
 * non-extractable key held in IndexedDB; see `vault.ts`. Where that is not
 * possible the secrets stay in the stored list, which is the plain behaviour this
 * file always had.
 *
 * Two more mitigations:
 *   · `redact()` strips credentials from anything that leaves the device;
 *   · the URL is never rendered — see `displayLabel`.
 */
import { kv } from '../kv.ts';
import { seal, unseal, vaultAvailable } from './vault.ts';
import { isPlaylistKind, type Provider, type ProviderKind } from './types.ts';

const LIST_KEY = 'iptv.providers.v1';
const SECRETS_KEY = 'iptv.providers.secrets.v1';
const ACTIVE_KEY = 'iptv.providers.active';

/**
 * Fields that are secrets for any kind of source. A new source type adds its own
 * (a portal's MAC and serial) by listing the field name here.
 */
const SECRET_FIELDS = [
  'password', 'mac', 'serial', 'deviceId', 'deviceId2', 'signature', 'stalkerSession',
] as const;
/** For playlist-shaped sources the addresses themselves are secrets (user:pass in the query). */
const PLAYLIST_SECRET_FIELDS = ['url', 'epgUrl', 'headerGuideUrls'] as const;

function secretFieldsOf(kind: ProviderKind): readonly string[] {
  return isPlaylistKind(kind) ? [...SECRET_FIELDS, ...PLAYLIST_SECRET_FIELDS] : SECRET_FIELDS;
}

/** A stored entry whose secrets were moved into the sealed map. */
type Stored = Omit<Provider, 'password'> & { sealed?: true; password?: string };

let cache: Provider[] | null = null;
/** Opened secrets by provider id, filled by `hydrateProviders()`. */
let opened = new Map<number, Record<string, unknown>>();

function parseList(): Stored[] {
  const raw = kv.get(LIST_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Stored[]).filter((p) => p && typeof p.id === 'number') : [];
  } catch {
    return [];
  }
}

function read(): Provider[] {
  if (cache !== null) return cache;
  cache = parseList().map((p) => {
    const { sealed, ...rest } = p;
    if (sealed !== true) return rest as Provider;
    return { ...rest, ...(opened.get(p.id) ?? (isPlaylistKind(p.kind) ? { url: '' } : {})) } as Provider;
  });
  return cache;
}

let writeSeq = 0;
/** Resolves once the latest sealed copy is on disk. Tests await it. */
let settled: Promise<void> = Promise.resolve();
export function providersSettled(): Promise<void> { return settled; }

/**
 * Persist the list. The plain copy goes to storage at once, so a kill in the
 * next few milliseconds loses nothing; the sealed copy replaces it as soon as the
 * key has answered. Newest write wins.
 */
function persist(list: Provider[]): void {
  const seq = ++writeSeq;
  kv.set(LIST_KEY, JSON.stringify(list));
  settled = (async () => {
    if (!(await vaultAvailable())) return;
    const stored: Stored[] = [];
    const secrets: Record<string, string> = {};
    const mirror = new Map<number, Record<string, unknown>>();
    for (const p of list) {
      const bag: Record<string, unknown> = {};
      const rec = p as unknown as Record<string, unknown>;
      const fields = secretFieldsOf(p.kind);
      for (const f of fields) if (rec[f] !== undefined && rec[f] !== '') bag[f] = rec[f];
      if (Object.keys(bag).length === 0) { stored.push(p); continue; }
      const sealedText = await seal(JSON.stringify(bag));
      if (sealedText === null) return;
      secrets[String(p.id)] = sealedText;
      mirror.set(p.id, bag);
      const rest: Record<string, unknown> = { ...rec };
      for (const f of fields) delete rest[f];
      if (isPlaylistKind(p.kind)) rest['url'] = '';
      stored.push({ ...(rest as unknown as Stored), sealed: true });
    }
    if (seq !== writeSeq) return;
    kv.set(SECRETS_KEY, JSON.stringify(secrets));
    kv.set(LIST_KEY, JSON.stringify(stored));
    opened = mirror;
  })().catch(() => undefined);
}

/**
 * Open the sealed secrets, and seal any plain entry an older build left behind.
 * Awaited once at boot, before the first render: `read()` is synchronous.
 */
export async function hydrateProviders(): Promise<void> {
  cache = null;
  opened = new Map();
  if (!(await vaultAvailable())) return;
  let secrets: Record<string, string> = {};
  try { secrets = JSON.parse(kv.get(SECRETS_KEY) ?? '{}') as Record<string, string>; } catch { /* none */ }
  let plain = false;
  for (const p of parseList()) {
    if (p.sealed === true) {
      const text = secrets[String(p.id)];
      const bag = text === undefined ? null : await unseal(text);
      if (bag !== null) { try { opened.set(p.id, JSON.parse(bag) as Record<string, unknown>); } catch { /* unreadable */ } }
      continue;
    }
    const rec = p as unknown as Record<string, unknown>;
    if (secretFieldsOf(p.kind).some((f) => rec[f] !== undefined && rec[f] !== '')) plain = true;
  }
  cache = null;
  if (plain) {
    persist(read());
    await settled;
  }
  for (const fn of subs) fn(read());
}

function write(next: Provider[]): void {
  cache = next;
  persist(next);
  for (const fn of subs) fn(next);
}

const subs = new Set<(p: Provider[]) => void>();

export function subscribeProviders(fn: (p: Provider[]) => void): () => void {
  subs.add(fn);
  fn(read());
  return () => void subs.delete(fn);
}

export function allProviders(): Provider[] { return [...read()]; }
export function enabledProviders(): Provider[] { return read().filter((p) => p.enabled); }
export function getProvider(id: number): Provider | null { return read().find((p) => p.id === id) ?? null; }

/**
 * The one being browsed.
 *
 * One at a time rather than merged: provider stream ids are unique only within a
 * provider, and every favourite, hidden channel and continue-watching row in
 * `prefs.ts` is keyed by one. Merging would need all of them migrated, and the
 * viewer gains a list they cannot tell apart.
 */
export function activeProvider(): Provider | null {
  const raw = kv.get(ACTIVE_KEY);
  const id = raw === null ? Number.NaN : Number(raw);
  const list = read();
  if (Number.isFinite(id)) {
    const hit = list.find((p) => p.id === id && p.enabled);
    if (hit) return hit;
  }
  return list.find((p) => p.enabled) ?? null;
}

export function setActiveProvider(id: number): void {
  kv.set(ACTIVE_KEY, String(id));
  for (const fn of subs) fn(read());
}

/** Monotonic across deletions: `max(id) + 1`, never `length + 1`. */
function nextId(list: Provider[]): number {
  return list.reduce((max, p) => Math.max(max, p.id), 0) + 1;
}

export function addProvider(p: Omit<Provider, 'id' | 'addedAt'>): Provider {
  const list = read();
  const created: Provider = { ...p, id: nextId(list), addedAt: Date.now() };
  write([...list, created]);
  if (activeProvider() === null || list.length === 0) setActiveProvider(created.id);
  return created;
}

export function updateProvider(id: number, patch: Partial<Omit<Provider, 'id'>>): void {
  write(read().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

/** Remove a source. The app holds nothing else to fall back to. */
export function removeProvider(id: number): void {
  write(read().filter((p) => p.id !== id));
}

/**
 * What may be shown on screen for a provider.
 *
 * Never the URL. A viewer's own M3U routinely carries their username and
 * password in its query string — so "showing the address" is showing their
 * credentials to whoever is in the room.
 */
export function displayLabel(p: Provider): string {
  if (p.name.trim() !== '') return p.name.trim();
  if (p.kind === 'stream') return 'Stream';
  if (p.kind === 'stalker') return 'Portal';
  return p.kind === 'xtream' ? 'Server' : 'Playlist';
}

/**
 * What a pasted address is.
 *
 * `get.php` / `type=m3u_plus` is the classic "M3U link" a reseller hands out: it
 * carries its own username and password, so it is a playlist, not a panel, even
 * though it came from an Xtream server.
 */
export function detectKind(url: string): ProviderKind {
  const u = url.toLowerCase();
  if (u.includes('player_api.php')) return 'xtream';
  if (u.includes('get.php') || u.includes('type=m3u')) return 'm3u';
  if (/\.m3u8?(\?|$)/.test(u)) return 'm3u';
  return 'xtream';
}

/** Strip anything that identifies a subscription, before text leaves the device. */
export function redact(text: string): string {
  return text
    .replace(/([?&](?:username|password|mac|sn|serial|device_id2?|signature|token)=)[^&\s]*/gi, '$1<redacted>')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@');
}
