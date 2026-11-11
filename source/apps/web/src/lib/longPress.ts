/**
 * Hold to act — the second gesture a row can carry without growing a button.
 *
 * A channel row used to end in a star `<button>`, inside the row's own
 * `<button>`. Nested interactive elements are invalid HTML, and the damage was
 * not theoretical: a D-pad moving RIGHT out of the list hit the star instead of
 * the player, so the picture could not be reached from the list at all, and the
 * star swallowed presses meant for the row. Reported exactly that way — "this
 * star messes up, going to the right side is not very clear, I cannot move to
 * full screen options" — with the fix alongside it: "normally how it works for
 * favourites is LONG CLICK".
 *
 * So the row is one control again. Holding it fires the second action; a normal
 * press still opens the channel; and the star that remains is a mark, not a
 * target. On a remote the dedicated STAR/BOOKMARK key does the same job through
 * the key registry, which reads `data-stream-id` off whatever row has focus.
 *
 * The click that follows a completed hold is suppressed — a pointer release
 * always fires `click`, and without this a long press both favourited the row
 * and opened the channel.
 */
import { useCallback, useRef } from 'react';

/**
 * Long enough not to fire on a normal press, short enough to feel deliberate.
 *
 * It was 550ms, and "the hold delay to like one second more" — on a remote an
 * OK held a moment too long while deciding opened the menu instead of the row.
 * A second more makes a hold something you mean.
 */
const HOLD_MS = 1550;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onKeyUp: (e: React.KeyboardEvent) => void;
}

/**
 * `hold` runs after HOLD_MS of a press that has not moved on.
 *
 * Also wired to the keyboard: holding SELECT on a remote repeats `keydown`, so a
 * held OK counts as a hold too, which is how this gesture is reachable without a
 * touchscreen.
 */
export function useLongPress(hold: () => void): LongPressHandlers {
  const timer = useRef(0);
  const fired = useRef(false);
  const holdRef = useRef(hold);
  holdRef.current = hold;

  const start = useCallback(() => {
    window.clearTimeout(timer.current);
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      holdRef.current();
    }, HOLD_MS);
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
  }, []);

  return {
    onPointerDown: (e) => {
      /* Primary button / touch only: a right-click or a stylus barrel press is
         not a hold, and starting a timer on one leaves it running. */
      if (e.button !== undefined && e.button !== 0) return;
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClickCapture: (e) => {
      if (!fired.current) return;
      /* The hold already acted; the release must not also open the row. */
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      /* `repeat` marks the held-down repeats; the first press starts the clock. */
      if (e.repeat) return;
      /*
       * Take the default, or there is no hold on a remote at all.
       *
       * Chromium activates a link or a button on Enter KEYDOWN, not on release.
       * So starting a timer here and doing nothing else meant the tile opened
       * the instant the button went down, the route changed, and 550ms later the
       * timer fired against a page that had already gone — the favourite landing
       * on the title you had just left, if it landed anywhere. The pointer path
       * was fine, which is why this survived: on glass the click comes on
       * RELEASE and `onClickCapture` could swallow it.
       *
       * "Please add holding actions, like on hold add to fav and so on" — it was
       * there, and it could not work on the one device it was for.
       *
       * Taking the default costs nothing, because the release below does exactly
       * what the browser would have done.
       */
      e.preventDefault();
      start();
    },
    onKeyUp: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      window.clearTimeout(timer.current);
      /* The hold already acted. Swallow the release rather than also opening the
         thing that was held — the pointer path's `onClickCapture` in miniature. */
      if (fired.current) {
        fired.current = false;
        return;
      }
      /* A short press is an ordinary press, performed here because the keydown's
         default was taken above. `currentTarget` is the element this handler is
         attached to, so this activates the tile and not whatever is under it. */
      const el = e.currentTarget as HTMLElement | null;
      el?.click();
    },
  };
}
