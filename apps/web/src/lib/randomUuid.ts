/**
 * `crypto.randomUUID` on a page that is not a secure context.
 *
 *     Uncaught TypeError: globalThis.crypto.randomUUID is not a function
 *
 * ── the trap ──
 *
 * `randomUUID` and `crypto.subtle` are SECURE-CONTEXT-ONLY. `https://` has
 * them and so does `localhost`; a plain-HTTP page served from an IP address
 * does not — and that is how this app is actually reached. Nothing warns: the
 * property is simply absent, and code that calls it throws on its first line.
 *
 * The device-side remuxer this was first found in has since been replaced by
 * libav.js, which does not call it — `scripts/insecure-context.test.mjs`
 * checks the shipped files for it — but a dependency can start calling it at
 * any upgrade, and the page is where that is cheapest to fill in.
 *
 * ── and why the app's own code does not need it ──
 *
 * It already knows: `playerCore` guards its
 * own call with `typeof c.randomUUID === 'function'`. What cannot be guarded
 * from inside is a dependency, so the platform is filled in instead.
 */

/** RFC 4122 version 4, from `getRandomValues`, which IS available insecurely. */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  const c = globalThis.crypto as Crypto | undefined;
  if (c !== undefined && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  /* The version and variant bits, so anything that PARSES the result rather
     than only comparing it still agrees this is a v4 uuid. */
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Give this page a `crypto.randomUUID` if the platform withheld one.
 *
 * Idempotent, and it never replaces a real implementation — on `https://` this
 * does nothing at all. Returns whether it had to step in, which is the one
 * thing worth knowing from a debug log.
 */
export function installRandomUuid(): boolean {
  const c = globalThis.crypto as (Crypto & { randomUUID?: unknown }) | undefined;
  if (c === undefined || c === null) return false;
  if (typeof c.randomUUID === 'function') return false;
  try {
    Object.defineProperty(c, 'randomUUID', {
      configurable: true, writable: true, value: uuidV4,
    });
  } catch {
    /* A frozen `crypto` cannot be helped from here. Anything that needs the
       function will say so in its own words rather than being masked. */
    return false;
  }
  return true;
}
