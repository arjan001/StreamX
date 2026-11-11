/**
 * The soft keyboard, and the part of the screen it leaves.
 *
 * Reported from a television with a screenshot: press a text field, the
 * platform IME rises over the lower half of the picture, and the app does not
 * move — the field being typed into sits behind the keys. The Android activity
 * now asks for `adjustResize`, which is the proper fix: the WebView itself
 * shrinks and the layout reflows because every height in this app is `100%`.
 *
 * This is the half for when the window does NOT shrink. Android 15 draws
 * edge-to-edge and ignores `adjustResize` unless the insets are handled; some
 * vendor keyboards float; and a browser on a phone never resizes its window for
 * the IME at all. In all of those the visual viewport still tells the truth, so
 * the covered band is measured from it and published as `--kbd-h`. `index.css`
 * takes that off the root's height, which is the same reflow the window would
 * have done, and the focused field is scrolled into the part that is left.
 *
 * Nothing here runs unless a viewport actually changed size, and a change of
 * under 120px is a browser bar, not a keyboard.
 */
import { isTypingTarget } from './keys.ts';

const KEYBOARD_MIN_PX = 120;

function covered(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  /* innerHeight is the layout viewport; the visual viewport is what is not
     under the keyboard. offsetTop covers the case where the page was pushed. */
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

function revealFocused(): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !isTypingTarget(el)) return;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
}

export function installSoftKeyboard(): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const px = covered();
    const open = px >= KEYBOARD_MIN_PX;
    root.style.setProperty('--kbd-h', open ? `${px}px` : '0px');
    root.dataset['keyboard'] = open ? 'open' : 'closed';
    if (open) revealFocused();
  };
  const schedule = () => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(apply);
  };
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  /* When the window DOES resize (adjustResize), `covered()` reads zero and the
     layout has already moved — the field still has to be brought into view. */
  window.addEventListener('resize', schedule, { passive: true });
  /* The IME takes a moment to rise; measuring on focus alone sees the old
     viewport. One late look catches keyboards that fire no resize at all. */
  document.addEventListener('focusin', (e) => {
    if (!isTypingTarget(e.target)) return;
    window.setTimeout(() => { schedule(); revealFocused(); }, 320);
  });
  apply();
}
