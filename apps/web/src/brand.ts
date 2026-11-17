/**
 * Generated from brand.config.json by scripts/brand-apply.mjs. Do not hand-edit.
 *
 * The app imports its own name from here rather than spelling it out, which is
 * what makes the product white-label: one JSON edit, one logo file, one command.
 */
export const BRAND = {
  /** Title case, for sentences: "Streamix could not reach the panel". */
  name: "Streamix",
  /** The header lockup, which is set in the mono face and usually upper case. */
  wordmark: "STREAMIX",
  tagline: "A player for your own sources.",
  /**
   * The prefix on every diagnostic code this app prints.
   *
   * Branded, because a viewer reads it out and searches for it: "LVX-999" was
   * still being shown by a product called Streamix, which is a rename that was
   * never finished. Three letters, from brand.config.json, derived from the
   * wordmark when it is not given.
   */
  code: "STX",
  /**
   * Relative on purpose: the wrapper build is served from a file path, not a root.
   *
   * And version-stamped, because these names are stable and the server gives
   * anything unhashed a day of cache — so without the query a new logo cannot
   * reach a device that has seen the old one until tomorrow. Measured: the
   * splash kept the previous artwork while the server was serving the new file.
   * See brandRev in scripts/brand-kit.mjs.
   */
  logo: 'brand-logo.png?v=a5407aa234',
  mark: 'brand-mark.png?v=a5407aa234',
  /** The generated room behind the first run and the launcher. Same reasoning. */
  backdrop: 'backdrop.jpg?v=a5407aa234',
  /** The adult content icon for the header bunny button. */
  adultIcon: 'brand/adult.png?v=a5407aa234',
  /** Sport background images for blurred background effect. */
  sportBackgrounds: {
    boxing: 'brand/sport-boxing.jpeg?v=a5407aa234',
    motorsport: 'brand/sport-motorsport.jpeg?v=a5407aa234',
    basketball: 'brand/sport-basketball.jpeg?v=a5407aa234',
    football: 'brand/sport-football.jpeg?v=a5407aa234',
    tennis: 'brand/sport-tennis.jpeg?v=a5407aa234',
    golf: 'brand/sport-golf.jpeg?v=a5407aa234',
    icehockey: 'brand/sport-icehockey.jpeg?v=a5407aa234',
    rugby: 'brand/sport-rugby.jpeg?v=a5407aa234',
    cricket: 'brand/sport-cricket.jpeg?v=a5407aa234',
    horseracing: 'brand/sport-horseracing.jpeg?v=a5407aa234',
    darts: 'brand/sport-darts.jpeg?v=a5407aa234',
    snooker: 'brand/sport-snooker.jpeg?v=a5407aa234',
    athletics: 'brand/sport-athletics.jpeg?v=a5407aa234',
    cycling: 'brand/sport-cycling.jpeg?v=a5407aa234',
    nfl: 'brand/sport-nfl.jxl?v=a5407aa234',
  },
  /** The artwork revision itself, for anything that has to build its own URL. */
  rev: "a5407aa234",
  accent: "#f09018",
  /**
   * Who publishes the app, for the legal screens. Empty strings until the owner
   * fills the `publisher` block of brand.config.json; the screens then show a
   * visible "[to be filled in]" marker rather than a blank.
   */
  publisher: {
    name: "Streamix",
    email: "streamix24.com",
    address: "",
    website: "https://streamix24.com",
    governingLaw: "",
    termsEffectiveDate: "2026-10-01",
    privacyEffectiveDate: "2026-10-01",
  },
  /** The live-caption provider the privacy text names. */
  captions: {
    provider: "Soniox",
    privacyUrl: "https://soniox.com/policies/privacy-policy",
  },
} as const;
