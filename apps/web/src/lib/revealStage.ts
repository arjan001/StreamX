/**
 * Pressing PLAY should put the picture in front of you, and the remote on it.
 *
 * Reported from the living room as "when I play something it doesn't scroll to
 * window". Both detail pages already called `scrollIntoView`, so the bug was not
 * a missing call — it was two things about the call:
 *
 * 1. `behavior: 'smooth'` animates over several hundred milliseconds, and the
 *    hero artwork underneath is still loading during exactly that window. A
 *    layout shift mid-animation leaves the scroll somewhere between where it
 *    started and where it was going, which reads as "it didn't scroll". A jump
 *    is the correct behaviour when a viewer has just asked for a picture; there
 *    is nothing to follow with the eye, because what they want is already there.
 *
 * 2. The player mounts a frame or two AFTER the flag flips — it renders as a
 *    placeholder until the engine reports a phase — so a single call fires
 *    against a box that has not reached its final height. Hence the retry.
 *
 * And focus moves with it. On a television the scroll alone is half an answer:
 * the remote is still pointed at the PLAY button that is now off-screen, so the
 * next press does something invisible. `VideoPlayer` makes its shell focusable
 * as soon as it has something on screen (`.stage[tabindex]`), and landing there
 * wakes the controls, so the press after PLAY reaches the player.
 */

/** Frames to keep looking for the player before giving up on focusing it. */
const TRIES = 12;

/**
 * Scroll `box` to the top of its scroller and move focus into the player inside.
 *
 * Safe to call with null, and safe to call when the player never appears — it
 * stops after `TRIES` frames rather than polling for ever.
 */
export function revealStage(box: HTMLElement | null): void {
  if (box === null) return;

  const pin = (): void => {
    box.scrollIntoView({ block: 'start' });
    /* Entrance motion (`.anim-rise` starts at translateY(6px)) makes the first
       scrollIntoView aim at a box that then settles 6px higher, leaving the
       scroller one step under an in-flow header. Pin to the top when the stage
       is meant to lead the page. */
    let n: HTMLElement | null = box.parentElement;
    while (n) {
      if (n.scrollHeight > n.clientHeight + 4) {
        if (box.offsetTop <= 8) n.scrollTop = 0;
        break;
      }
      n = n.parentElement;
    }
  };

  pin();
  let left = TRIES;
  const look = (): void => {
    /* Only the shell that has something on screen is focusable; while the engine
       is still opening there is nothing here to land on. */
    const target = box.querySelector<HTMLElement>('.stage[tabindex]');
    if (target === null) {
      if (--left > 0) requestAnimationFrame(look);
      return;
    }
    /* `preventScroll`, then scroll deliberately: focusing scrolls the element
       into view by whatever rule the browser likes, which on a nested scroller
       is `block: 'nearest'` and leaves the player half off the top. */
    target.focus({ preventScroll: true });
    pin();
  };
  requestAnimationFrame(look);
  window.setTimeout(pin, 220);
}
