/**
 * Artwork hosts that do not answer, learned once and applied everywhere.
 *
 * ── the measurement ──
 *
 * This catalogue's artwork is spread over hosts that are not equally alive.
 * Counted on the live line: of 47,056 films, 27,537 point at `image.tmdb.org`,
 * 16,700 at something else, and 2,819 carry no icon at all. The largest of the
 * "something else" hosts is `203.0.113.40`, which serves 14,688 channel logos
 * and thousands of film posters — and does not answer at all from anywhere I can
 * reach it: eight seconds, no connection, no refusal, while two other picon
 * hosts in the same catalogue answer in 30-100ms.
 *
 * ── why a registry rather than a per-image timeout ──
 *
 * `Poster` already gives a single image eight seconds before it draws a
 * monogram, which is the right rule for one image and the wrong one for a page
 * of forty from the same dead host: every tile waits its own eight seconds, and
 * a home page of six rails spends forty seconds arriving at the same answer
 * forty times. Worse on a television, where each of those is a live socket.
 *
 * So several failures from a host that has never answered are enough to stop
 * asking it. Everything on that host draws its generated tile immediately, with no request at all — and
 * a title that HAS other artwork (a tmdb backdrop, say) can be shown that
 * instead, because the caller now knows the poster is not coming.
 *
 * ── and why a success cancels the verdict ──
 *
 * Two failures were enough, and two failures is nothing next to the 27,537
 * posters `image.tmdb.org` serves this catalogue. A slow minute, a service
 * worker hiccup, two off-screen tiles that were never even requested (the bug
 * in `Poster`'s deadline, now fixed) — and every remaining picture from the
 * largest artwork host in the app was replaced by a monogram for the rest of
 * the session. Reported exactly as it looked: "when i navigate i lose images".
 *
 * A host that has ever handed over one picture is answering, so it is never
 * given up on, whatever the failures beside it. That is what separates the
 * genuine case from the noise: `203.0.113.40` has never returned a single
 * image from any network, so it fails every count and succeeds none.
 *
 * Deliberately per session and in memory. A host that was down at breakfast may
 * be up at lunch, and persisting the verdict would turn a bad afternoon into a
 * permanent one.
 */

/**
 * How many failures from one host before we stop asking it — and only while
 * that host has never answered at all. See the head of this file.
 *
 * ── why this is 1 and not 4 ──
 *
 * Four was a fair number for a flaky host and the wrong one for a dead one, and
 * the catalogue's biggest picon host is dead: measured, `203.0.113.40` accepts
 * no connection at all, and it carries about 82% of the plaintext artwork. A
 * console shows the consequence — the same picture requested three times,
 * a dozen hosts' worth of `ERR_CONNECTION_TIMED_OUT`, each one holding a browser
 * connection for the full `SLOW_MS` deadline before anything is recorded. Four
 * tiles had to pay that in series before the fifth was spared.
 *
 * One is enough because of what guards it: `wins`. A host that has EVER returned
 * a picture is immune to this no matter how many later failures it has, so the
 * only thing one strike can retire is a host that has never once answered. The
 * cost of being wrong is a monogram instead of a logo; the cost of being right
 * four times over is four stalled connections per host, per screen.
 */
const GIVE_UP_AT = 1;

const fails = new Map<string, number>();
const wins = new Map<string, number>();

const WSRV_HOST = /^(?:images\.)?wsrv\.nl$/i;

/**
 * Only ever used to give a relative path something to parse against.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so if this ever
 * escaped as a verdict it would condemn a host that does not exist rather than a
 * real one. It does not escape — a relative URL that names no origin still
 * answers `null` below.
 */
const NOWHERE = 'http://relative.invalid';

/**
 * The origin a wrapped URL is really asking about, or null if it is not wrapped.
 *
 * Two wrappers, one rule: wsrv, and the APK's own `/_img` route, which fetches a
 * plaintext picture on the device. wsrv accepts a bare host and assumes http, so
 * both inner values are normalised the same way before being resolved.
 */
function unwrap(parsed: URL): string | null {
  /*
   * HTTPS pages wrap plaintext artwork in a proxy. A 404 from the proxy is a
   * fact about the origin, not about the proxy — blaming the proxy condemned
   * every other http image on the page after four bad picons.
   */
  const inner = WSRV_HOST.test(parsed.hostname)
    ? parsed.searchParams.get('url')
    : parsed.pathname === '/_img'
      ? parsed.searchParams.get('u')
      : null;
  if (inner === null || inner === '') return null;
  return /^https?:\/\//i.test(inner) ? inner : `http://${inner}`;
}

function hostOf(url: string): string | null {
  const rooted = /^https?:\/\//i.test(url);
  let parsed: URL;
  try {
    parsed = new URL(url, rooted ? undefined : NOWHERE);
  } catch {
    return null;
  }
  const inner = unwrap(parsed);
  if (inner !== null) return hostOf(inner);
  /* No origin named and none of its own: ours, and nothing to blame. */
  return rooted ? parsed.host.toLowerCase() : null;
}

/** Record that this URL did not produce a picture — an error, or a long silence. */
export function noteArtFailure(url: string): void {
  const host = hostOf(url);
  if (host === null) return;
  fails.set(host, (fails.get(host) ?? 0) + 1);
}

/** Record a picture that arrived. One of these clears the host for good. */
export function noteArtSuccess(url: string): void {
  const host = hostOf(url);
  if (host === null) return;
  wins.set(host, (wins.get(host) ?? 0) + 1);
}

/**
 * Is this URL on a host that has already failed enough times to skip?
 *
 * Null and empty are "no artwork", which is a different fact and answered false
 * here — the caller has its own branch for that.
 */
export function artIsDead(url: string | null | undefined): boolean {
  if (url === null || url === undefined || url === '') return false;
  const host = hostOf(url);
  if (host === null) return false;
  if ((wins.get(host) ?? 0) > 0) return false;
  return (fails.get(host) ?? 0) >= GIVE_UP_AT;
}

/** For tests and for a viewer who presses refresh: forget every verdict. */
export function forgetDeadArt(): void {
  fails.clear();
  wins.clear();
}

/** What has been given up on, for the diagnostics screen. */
export function deadArtHosts(): { host: string; failures: number }[] {
  return [...fails.entries()]
    .filter(([host, n]) => n >= GIVE_UP_AT && (wins.get(host) ?? 0) === 0)
    .map(([host, failures]) => ({ host, failures }));
}
