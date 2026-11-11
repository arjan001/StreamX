import { BRAND } from '../brand';

/**
 * The brand mark, breathing, instead of a spinner.
 *
 * Asked for as "instead of ciruler loading show logo as loading with
 * animation". A generic spinner says "something is happening"; the mark says
 * whose. On a television that matters more than on a laptop, because the screen
 * is across the room and a 28px ring at three metres is barely there at all.
 *
 * ── why the keyframes are here and not in index.css ──
 *
 * They are three declarations used by one component, and `index.css` is the
 * shared animation vocabulary — putting a one-off there invites the next person
 * to reach for it from somewhere it was never designed for. A `<style>` beside
 * the markup keeps them together. It is emitted once per mount and the browser
 * de-duplicates identical rules, so a second loader costs nothing.
 *
 * ── it is deliberately NOT `animation-fill-mode: both` ──
 *
 * `both` makes an element report `opacity: 0` from the moment it mounts until
 * the animation actually starts ticking, and `lib/spatialNav.ts` decides what
 * can hold focus with `checkVisibility({opacityProperty: true})`. That exact
 * pair cost a day: the film page's hero faded in with `both` and for 481ms the
 * remote refused to land on PLAY, choosing the poster rail underneath instead.
 * Nothing here is focusable, but the rule is worth keeping whole.
 */
export function LoadingMark({
  label,
  size = 'md',
}: {
  /** What is being waited for. Omitted where the surrounding text says it. */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const box = size === 'lg' ? 'h-20 w-20' : size === 'sm' ? 'h-9 w-9' : 'h-14 w-14';
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      <style>{`
        @keyframes mark-breathe {
          0%, 100% { transform: scale(1);    opacity: .55; }
          50%      { transform: scale(1.08); opacity: 1; }
        }
        @keyframes mark-halo {
          0%       { transform: scale(.85); opacity: .45; }
          70%      { transform: scale(1.5); opacity: 0; }
          100%     { transform: scale(1.5); opacity: 0; }
        }
        /* Motion is decoration here — the label already says what is happening,
           so somebody who has asked for less of it loses nothing. */
        @media (prefers-reduced-motion: reduce) {
          .mark-breathe, .mark-halo { animation: none; }
          .mark-halo { opacity: 0; }
        }
      `}</style>
      <span className="relative grid place-items-center">
        {/* A slow ring leaving the mark, so the wait reads as progress rather
            than as a still picture that might be a frozen app. */}
        <span
          aria-hidden
          className="mark-halo pointer-events-none absolute inset-0 rounded-full border border-tally"
          style={{ animation: 'mark-halo 2.2s ease-out infinite' }}
        />
        <img
          src={`${import.meta.env.BASE_URL}${BRAND.mark}`}
          alt=""
          aria-hidden
          className={`mark-breathe ${box} object-contain`}
          style={{ animation: 'mark-breathe 1.8s ease-in-out infinite' }}
        />
      </span>
      {label !== undefined && (
        <p className="max-w-[24rem] font-mono text-[length:var(--t-xs)] leading-relaxed text-ink-2">
          {label}
        </p>
      )}
      {/* Announced once, for a screen reader that cannot see either of the
          above. `polite` so it waits for a gap rather than interrupting. */}
      <span className="sr-only" role="status" aria-live="polite">
        {label ?? `Loading ${BRAND.name}`}
      </span>
    </div>
  );
}
