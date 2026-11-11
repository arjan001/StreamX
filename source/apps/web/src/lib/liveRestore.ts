/**
 * Does `?ch=` name a channel nobody has answered yet?
 *
 * Live TV keeps what it is playing in the address, so that a search result, a
 * home rail, a resume banner and a reload all lead to the same place. The other
 * half of that is an effect which OPENS whatever the address names — and the
 * question it has to answer is not "is a channel named" but "is this channel
 * named a REQUEST, or is it the address describing what is already happening".
 *
 * The answer is three refs deep because the address lags every one of them. A ref
 * changes on the line that sets it; `?ch=` changes a commit later, when
 * `setParams` lands. So between the two there is always a render where the two
 * disagree, and the effect runs in it:
 *
 *   opened  — the channel this page put on screen. The address agrees with it.
 *   pending — asked to OPEN, address not caught up. Answering it again cancels
 *             the load in flight (`open()` bumps a generation), which is the
 *             "one click did nothing, the second stuck" bug.
 *   closed  — asked to CLOSE, address not caught up. THIS is the one that was
 *             missing, and it is what the box reported as "when you go back
 *             instead of going back it goes to another channel": BACK cleared
 *             `opened` and tore the stream down, the address still said
 *             `?ch=1.501495737`, and the effect read that as a deep link and
 *             re-opened the channel the viewer had just left. Measured on
 *             `/live` with `scripts/back-probe.mjs`: the first BACK re-opened the
 *             stream (new blob source), re-armed the country healing so the list
 *             re-filtered to another country, and left the highlight on a
 *             different channel. Only the SECOND BACK closed anything.
 *
 * A pure decision, and separate from the route, for the same reason
 * `resolveBack` is: this is the whole rule, it is three lines, and nothing about
 * it should need a renderer to pin.
 */

/** What this page has claimed, or is in the middle of claiming. */
export interface ChannelClaims {
  /** The channel on screen — `open()` set it and the address agrees. */
  opened: string | null;
  /** Asked to open, before `?ch=` caught up. */
  pending: string | null;
  /** Asked to close, before `?ch=` dropped it. */
  closed: string | null;
}

/**
 * True only when `?ch=` is an instruction from outside this page.
 *
 * Deliberately compares the CLOSED channel by ref rather than reading a bare
 * "closing" flag: the flag would also swallow the deep link that arrives while
 * the close is settling — someone leaving a channel and pressing the same one in
 * the list, or a resume banner naming it — and a channel that refuses to open is
 * a worse bug than the one this exists to stop.
 */
export function wantsChannel(urlCh: string, claims: ChannelClaims): boolean {
  if (urlCh === '') return false;
  if (claims.pending !== null) return false;
  if (claims.closed === urlCh) return false;
  return claims.opened !== urlCh;
}
