/**
 * Gzip, on the device, for the one thing that is pure JSON and enormous.
 *
 * ── why this exists ──
 *
 *     server should not be called for stuff like that and save storage and do
 *     things on demand
 *
 * The panel payloads — every channel, film and series row exactly as the
 * provider sent them — are 151.7MB on the owner's line, and they are stored
 * ALONGSIDE the built catalogue they were used to make (107.3MB). 259MB on an
 * origin that is plain HTTP on an IP, so not a secure context, so
 * `navigator.storage` does not exist and IndexedDB runs on a small best-effort
 * quota. The write aborts, and until last night it aborted silently.
 *
 * Deleting the raw rows was the obvious move and is wrong: six separate paths
 * call `rebuild()` — opening a package, clearing packages, toggling the free
 * channels alongside a subscription — and every one of them reads those rows
 * back. Dropping them would turn each of those into a full re-download, which
 * is the opposite of what was asked for.
 *
 * So they are kept and squeezed. Measured in the real browser on the real
 * origin: 16.6MB of this exact row shape becomes 1.0MB — 94% — in 381ms, and
 * comes back byte-identical in 332ms. `CompressionStream` needs no secure
 * context (checked: available with `isSecureContext === false`), and it is the
 * browser's own gzip, so nothing is shipped to do it and nothing leaves the
 * device.
 *
 * ── deliberately NOT the generic blob store ──
 *
 * The built catalogue is columnar and holds TYPED ARRAYS. Structured clone
 * carries those natively; `JSON.stringify` would turn a `Uint32Array` into
 * `{"0":1,"1":2,…}` and the catalogue would come back subtly wrong rather than
 * broken, which is the worst way for a store to fail. This is for payloads that
 * are plain JSON from a panel and nothing else.
 */

/** Marks a stored value as squeezed, so an older uncompressed one still reads. */
export const GZ = '__gz1';

export interface Squeezed {
  [GZ]: true;
  /** Gzip bytes. An ArrayBuffer, because that is what structured clone
      carries most cheaply and what `Blob` will take without argument. */
  bytes: ArrayBuffer;
}

export function isSqueezed(v: unknown): v is Squeezed {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>)[GZ] === true;
}

/** Available since Chromium 80 and Safari 16.4, and in no way secure-context only. */
function canSqueeze(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

export async function squeeze(value: unknown): Promise<unknown> {
  if (!canSqueeze()) return value;
  try {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const gz = new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = await new Response(gz).arrayBuffer();
    /* A squeeze that grew it is not a squeeze. Cannot happen for a megabyte of
       JSON, and storing the plain value is the honest answer if it ever does. */
    return bytes.byteLength < raw.byteLength ? { [GZ]: true, bytes } : value;
  } catch {
    /* No compression here for whatever reason — store it as it is and let the
       quota decide. Failing to SAVE because we could not compress would be a
       worse trade than saving something large. */
    return value;
  }
}

export async function unsqueeze(stored: unknown): Promise<unknown> {
  if (!isSqueezed(stored)) return stored;
  const ds = new Blob([stored.bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(ds).text()) as unknown;
}
