/**
 * A line that allows ONE connection cannot let the browser fetch a film itself.
 *
 * ── the measurement this exists for ──
 *
 * Photographed off the owner's own network panel: a film playing directly from
 * `203.0.113.10/live/play/<token>`, then a drag, then a run of fresh `206`
 * responses — 5,145 kB, then 28.4 kB, then 355 kB, then 1,554 kB — and
 * "Playback failed. The film arrived but this screen could not show it."
 *
 * That is not a bug in the seek bar. It is what a `<video>` element DOES: every
 * seek is one or more new ranged requests, and the connection it supersedes is
 * not closed at the moment the new one opens. The same behaviour is written up
 * against another IPTV proxy, where superseded upstream connections were
 * measured lingering FIFTEEN TO TWENTY-FOUR SECONDS
 * (github.com/euzu/tuliprox issue 866). On a subscription that allows one, the
 * new request is refused for that whole window — and XUI refuses with a 200 and
 * the words MAX CONNECTIONS REACHED in the body, so what arrives where the
 * video should be is a sentence. The element calls that a decode failure.
 *
 * So on such a line the element must never be handed the file. The server
 * assembles it instead: one ffmpeg, one connection, held for the whole viewing,
 * and seeking is something WE do inside it rather than something the browser
 * does to the panel.
 *
 * ── deliberately narrow ──
 *
 * Only VOD, only where the page is the player. Live is a single continuous
 * connection that is never seeked; and a box with libVLC keeps its own
 * connection across a seek rather than opening a second, which is most of the
 * reason it exists.
 *
 * Unknown is not one. A panel that does not say how many connections it allows
 * gets the old behaviour, because guessing "one" would route every film on
 * every generous line through the server for nothing.
 */
import { currentSubscription } from './session.ts';

export function connectionsAllowed(): number | null {
  const n = currentSubscription()?.maxConnections ?? null;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** True only when the panel has SAID the line allows exactly one. */
export function oneConnectionLine(): boolean {
  return connectionsAllowed() === 1;
}
