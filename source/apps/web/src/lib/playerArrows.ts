/**
 * What the four arrows do over a picture — and it is not one answer.
 *
 * "U cant move up / down channels", on a screen where zapping was written,
 * wired and working: `Live.tsx` hands the player `onPrev`/`onNext`, and they
 * step past the whole family of feeds a channel is published as. The keys were
 * the problem. A channel change was bound to `CH+`/`CH-`, `PageUp`/`PageDown`,
 * the next/prev-track pair and the skip buttons — six buttons, and a Samsung,
 * Fire TV or generic Android box delivers NONE of them to a WebView. What the
 * viewer's thumb has is the D-pad, and over a playing picture the D-pad was
 * volume up, volume down, and two keys that did nothing at all on live. In
 * theatre the channel list is hidden as well, so the last way round was gone
 * too: a television with no way to change channel.
 *
 * So the arrows follow the set-top convention every viewer in this house
 * already has in their hands — UP and DOWN are the channel, LEFT and RIGHT are
 * the volume — and they follow it only where it is true. On a film there is no
 * next channel and there IS a timeline, so up/down stay volume and left/right
 * stay seek; anything else would take the one gesture a film needs and give it
 * to a channel that does not exist.
 *
 * Kept apart from the player for the reason `liveRestore` is: this is the whole
 * rule, it is a table of twelve answers, and none of it should need a renderer
 * or a keyboard to pin.
 */

/** The four, as the remote layer names them (`lib/remoteKeys.ts`). */
export type ArrowIntent = 'up' | 'down' | 'left' | 'right';

export type ArrowAction =
  /** Move the volume by `by`, which is a fraction of full scale. */
  | { do: 'volume'; by: number }
  /** Move the playhead by `by` seconds. */
  | { do: 'seek'; by: number }
  /** Next channel (`1`) or the previous one (`-1`). */
  | { do: 'channel'; by: 1 | -1 }
  /** Nothing here — live has no timeline to move along. */
  | { do: 'nothing' };

/**
 * One notch of volume, and one hop of the playhead.
 *
 * The same numbers the player has always used for the arrow keys — 5% and ten
 * seconds. The remote's own transport buttons are deliberately coarser (±30s,
 * see `act`): a thumb on a rocker presses those repeatedly.
 */
export const VOLUME_STEP = 0.05;
export const SEEK_STEP = 10;

/**
 * @param live      is this a channel rather than a film
 * @param canZap    does this player have somewhere to zap to — both `onPrev`
 *                  and `onNext`. A live stream opened from catch-up or a guide
 *                  has neither, and up/down there must not become a key that
 *                  swallows the press and moves nothing.
 */
export function arrowAction(intent: ArrowIntent, live: boolean, canZap: boolean): ArrowAction {
  if (live && canZap) {
    if (intent === 'up') return { do: 'channel', by: 1 };
    if (intent === 'down') return { do: 'channel', by: -1 };
    /* Volume moves sideways so that nothing is lost: up/down is the only pair
       the channel can have, and left/right is the only pair volume can take. */
    return { do: 'volume', by: intent === 'right' ? VOLUME_STEP : -VOLUME_STEP };
  }
  if (intent === 'up') return { do: 'volume', by: VOLUME_STEP };
  if (intent === 'down') return { do: 'volume', by: -VOLUME_STEP };
  if (live) return { do: 'nothing' };
  return { do: 'seek', by: intent === 'right' ? SEEK_STEP : -SEEK_STEP };
}

/**
 * The arrows while the SEEK BAR itself is the selected control.
 *
 * A separate question from `arrowAction`, which answers for the picture surface.
 * The bar is `role="slider"` with `tabIndex={0}` — a D-pad walks onto it and it
 * draws a focus ring — and it had no key handling at all, so every press while
 * it was selected fell through to focus movement and stepped off the bar. The
 * one control whose whole job is choosing a position could be selected and then
 * only left. "there is no forword and backword i think."
 *
 * Left and right only. Up and down are the way OUT of the bar — the buttons
 * below it, the picture above — and a slider that swallowed all four would be
 * the same dead end one control further in.
 *
 * @returns seconds to move the playhead by, or `null` to leave the press alone.
 */
export function seekBarNudge(intent: ArrowIntent, onSeekBar: boolean): number | null {
  if (!onSeekBar) return null;
  if (intent === 'left') return -SEEK_STEP;
  if (intent === 'right') return SEEK_STEP;
  return null;
}
