/**
 * The product's name and mark, in one place.
 *
 * There were three of these — the shell header, the classic launcher and the
 * profile chooser — each written out longhand as a rounded amber tile with the
 * single letter in it and the name beside it. Three copies of an identity is
 * how a rebrand becomes a grep, and the ask was the opposite: white-label, so the
 * name and the artwork can change any time.
 *
 * Both now come from `brand.ts`, which `scripts/brand-apply.mjs` generates from
 * `brand.config.json`. The mark is a real image rather than a drawn letter,
 * because supplied artwork is a shape with gradients and a glow, and no amount of
 * `<span>` will be that.
 *
 * ── two forms, and which one goes where ──
 *
 * "Plays for a header area and like areas that have space please show the whole
 * logo with its text and everything. Now for the stuff like loading and like
 * areas where only the icon is needed show only the icon."
 *
 * So there are exactly two: the LOCKUP (`full`), which is the supplied artwork
 * complete with the name and the tagline, and the MARK, which is the symbol
 * cropped out of that same artwork by `brand-kit`'s `markRect`. A header has
 * room for the first; a spinner, a tab and a 32px favicon do not, and a name set
 * in 4px letters is a smudge.
 *
 * ── why the lockup carries a typed fallback beside it ──
 *
 * The supplied artwork sets the name in WHITE. That is right on the ground this
 * app is designed for and wrong on the one it also offers: `data-mode='light'` is
 * a real, reachable setting, and a white wordmark on a white panel is an invisible
 * header. Rather than filter the artwork — which would invert the orange symbol
 * along with the text — both are rendered and CSS shows one: `.brand-full` on a
 * dark ground, `.brand-typed` (the mark plus the name as text, which takes its
 * colour from `--color-ink`) on a light one. See `index.css`.
 *
 * `BASE_URL` rather than a leading slash: the wrapper build is served from a file
 * path, where `/brand-mark.png` is the root of the device.
 */
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';

const SIZES = {
  sm: { box: 'h-7 w-7', logo: 'h-7 tv:h-10', text: 'text-[length:var(--t-lg)]' },
  md: { box: 'h-8 w-8', logo: 'h-8 tv:h-12', text: 'text-[length:var(--t-lg)]' },
  lg: { box: 'h-11 w-11', logo: 'h-10 tv:h-14', text: 'text-[1.5rem]' },
} as const;

export function Wordmark({
  size = 'sm', to = '/home', className, children, full = false,
}: {
  size?: keyof typeof SIZES;
  /** Omit to render as plain content rather than a link. */
  to?: string | null;
  className?: string;
  /** Anything that sits after the mark. */
  children?: React.ReactNode;
  /**
   * Show the whole lockup — artwork, name and tagline — rather than the symbol
   * alone. For anywhere with horizontal room: the shell header, the first run,
   * the profile chooser. Off for spinners, tabs and tight rows.
   */
  full?: boolean;
}) {
  const s = SIZES[size];
  const inner = full ? (
    <>
      <img
        src={`${import.meta.env.BASE_URL}${BRAND.logo}`}
        alt={BRAND.wordmark}
        className={`brand-full ${s.logo} w-auto shrink-0 object-contain object-left`}
      />
      {/* The light-ground form. Hidden on a dark one — see the note above. */}
      <span className="brand-typed items-center gap-2">
        <img
          src={`${import.meta.env.BASE_URL}${BRAND.mark}`}
          alt=""
          aria-hidden
          className={`${s.box} shrink-0 object-contain`}
        />
        <span className={`font-mono ${s.text} font-semibold tracking-tight text-ink`}>
          {BRAND.wordmark}
        </span>
      </span>
      {children}
    </>
  ) : (
    <>
      <img
        src={`${import.meta.env.BASE_URL}${BRAND.mark}`}
        alt={BRAND.wordmark}
        className={`${s.box} shrink-0 object-contain`}
      />
      {children}
    </>
  );
  const cls = `flex shrink-0 items-center gap-2${className ? ` ${className}` : ''}`;
  return to === null
    ? <span className={cls}>{inner}</span>
    /* Named, because the artwork is an image and a link whose only content is an
       image is an unnamed stop for a remote. */
    : (
      <Link to={to} aria-label={`${BRAND.wordmark} — home`} className={`${cls} focus-visible:outline-offset-4`}>
        {inner}
      </Link>
    );
}
