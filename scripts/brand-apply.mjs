/**
 * Rebrand the whole product from `brand.config.json`. One command.
 *
 * The asset scripts draw the icons; this writes the NAME into the places code and
 * markup have to carry it, so nothing is left saying the old one:
 *
 *   apps/web/src/brand.ts        the app's own header, sheets and titles
 *   apps/web/index.html          <title>, description, theme colour, the splash
 *   android/.../strings.xml      the launcher label and the task name
 *   android/app/build.gradle     applicationId (the ONLY writer of it)
 *   apps/mobile/capacitor.config appId (same value, written with it)
 *   android/.../AndroidManifest  the screen orientation, which is a brand choice
 *                                here: this is a television app
 *
 * Every generated block is fenced with a marker comment and rewritten in place,
 * so running it twice changes nothing and a hand edit inside a fence is a hand
 * edit that will be lost — which is what the fence is for.
 *
 * Usage: pnpm brand
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, brandRev, loadBrand } from './brand-kit.mjs';

const B = loadBrand();
/* Changes when the artwork does, and never otherwise — see `brandRev`. It goes
   into every stable-named brand URL so the day-long cache on those files stops
   being a day-long stale splash. */
const REV = brandRev(B);
const done = [];

/**
 * A three-letter code from a wordmark, when the brand does not name one.
 *
 * First letter, then the next two consonants — STREAMIX -> STR, BRAVO -> BRV —
 * falling back to the first three characters for a name with too few of them.
 */
function codeFrom(wordmark) {
  const up = String(wordmark).toUpperCase().replace(/[^A-Z]/g, '');
  const rest = up.slice(1).replace(/[AEIOU]/g, '');
  const out = (up.slice(0, 1) + rest).slice(0, 3);
  return out.length === 3 ? out : up.slice(0, 3).padEnd(3, 'X');
}

/** Replace between `<!-- brand:start --> … <!-- brand:end -->` style fences. */
function fence(text, open, close, body) {
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  if (i === -1 || j === -1) throw new Error(`missing fence ${open}`);
  return text.slice(0, i + open.length) + body + text.slice(j);
}

/* ── the app's own copy of its identity ─────────────────────────────────── */
writeFileSync(join(ROOT, 'apps/web/src/brand.ts'), `/**
 * Generated from brand.config.json by scripts/brand-apply.mjs. Do not hand-edit.
 *
 * The app imports its own name from here rather than spelling it out, which is
 * what makes the product white-label: one JSON edit, one logo file, one command.
 */
export const BRAND = {
  /** Title case, for sentences: "Streamix could not reach the panel". */
  name: ${JSON.stringify(B.name)},
  /** The header lockup, which is set in the mono face and usually upper case. */
  wordmark: ${JSON.stringify(B.wordmark)},
  tagline: ${JSON.stringify(B.tagline ?? '')},
  /**
   * The prefix on every diagnostic code this app prints.
   *
   * Branded, because a viewer reads it out and searches for it: "LVX-999" was
   * still being shown by a product called Streamix, which is a rename that was
   * never finished. Three letters, from brand.config.json, derived from the
   * wordmark when it is not given.
   */
  code: ${JSON.stringify(B.code ?? codeFrom(B.wordmark))},
  /**
   * Relative on purpose: the wrapper build is served from a file path, not a root.
   *
   * And version-stamped, because these names are stable and the server gives
   * anything unhashed a day of cache — so without the query a new logo cannot
   * reach a device that has seen the old one until tomorrow. Measured: the
   * splash kept the previous artwork while the server was serving the new file.
   * See brandRev in scripts/brand-kit.mjs.
   */
  logo: 'brand-logo.png?v=${REV}',
  mark: 'brand-mark.png?v=${REV}',
  /** The generated room behind the first run and the launcher. Same reasoning. */
  backdrop: 'backdrop.jpg?v=${REV}',
  /** The artwork revision itself, for anything that has to build its own URL. */
  rev: ${JSON.stringify(REV)},
  accent: ${JSON.stringify(B.accent)},
  /**
   * Who publishes the app, for the legal screens. Empty strings until the owner
   * fills the \`publisher\` block of brand.config.json; the screens then show a
   * visible "[to be filled in]" marker rather than a blank.
   */
  publisher: {
    name: ${JSON.stringify(B.publisher?.name ?? '')},
    email: ${JSON.stringify(B.publisher?.email ?? '')},
    address: ${JSON.stringify(B.publisher?.address ?? '')},
    website: ${JSON.stringify((B.publisher?.website ?? '').replace(/\/+$/, ''))},
    governingLaw: ${JSON.stringify(B.publisher?.governingLaw ?? '')},
    termsEffectiveDate: ${JSON.stringify(B.publisher?.termsEffectiveDate ?? '')},
    privacyEffectiveDate: ${JSON.stringify(B.publisher?.privacyEffectiveDate ?? '')},
  },
  /** The live-caption provider the privacy text names. */
  captions: {
    provider: ${JSON.stringify(B.captions?.provider ?? '')},
    privacyUrl: ${JSON.stringify(B.captions?.privacyUrl ?? '')},
  },
} as const;
`);
done.push('apps/web/src/brand.ts');

/* ── index.html: what a tab, a share card and a cold start show ─────────── */
{
  const p = join(ROOT, 'apps/web/index.html');
  let html = readFileSync(p, 'utf8');
  const desc = B.description ?? B.tagline ?? '';
  const title = `${B.name} — ${(B.tagline ?? '').replace(/\.$/, '')}`;

  /* Whole TAGS are replaced, not the value inside them: these are pretty-printed
     across several lines, so a `content="[^"]*"` pattern matches nothing. */
  const tag = (pattern, replacement) => {
    if (!pattern.test(html)) throw new Error(`index.html: nothing matched ${pattern}`);
    html = html.replace(pattern, replacement);
  };

  tag(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  tag(/<meta\s+name="description"[\s\S]*?\/>/, `<meta name="description" content="${desc}" />`);
  tag(/<meta property="og:site_name"[\s\S]*?\/>/, `<meta property="og:site_name" content="${B.name}" />`);
  tag(/<meta property="og:title"[\s\S]*?\/>/, `<meta property="og:title" content="${title}" />`);
  tag(/<meta\s+property="og:description"[\s\S]*?\/>/, `<meta property="og:description" content="${desc}" />`);
  tag(/<meta property="og:image:alt"[\s\S]*?\/>/, `<meta property="og:image:alt" content="${B.name} — ${B.tagline ?? ''}" />`);
  tag(/<meta name="twitter:title"[\s\S]*?\/>/, `<meta name="twitter:title" content="${title}" />`);
  tag(/<meta\s+name="twitter:description"[\s\S]*?\/>/, `<meta name="twitter:description" content="${desc}" />`);
  html = html.replace(/<meta name="theme-color" content="[^"]*"/g, `<meta name="theme-color" content="${B.ground}"`);
  html = html.replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"/, `<meta name="apple-mobile-web-app-title" content="${B.name}"`);

  /* The splash block, regenerated so a rebrand changes the cold-start screen too:
     its background is the brand ground and its bar is the brand accent. */
  html = fence(html, '<!-- brand:splash:start -->', '<!-- brand:splash:end -->', `
    <!--
      The splash, in the document rather than in the app.

      A React splash cannot be a splash: it appears after the bundle has parsed,
      which is the exact interval it exists to cover. This is plain markup with
      inline styles, so it is on screen with the first paint — before any script —
      and \`main.tsx\` takes it away once the app has actually rendered.

      Generated from brand.config.json by scripts/brand-apply.mjs. Do not hand-edit
      inside the fence.
    -->
    <style>
      #splash{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;
        background:${B.ground};transition:opacity .32s ease-out}
      #splash.is-gone{opacity:0;pointer-events:none}
      #splash .art{display:flex;flex-direction:column;align-items:center;gap:1.1rem}
      #splash img{width:min(38vw,190px);height:auto;
        animation:splash-in .55s cubic-bezier(.2,.8,.2,1) both}
      /* A bar rather than a spinner: it says "loading" without pretending to know
         how much is left, and it reads across a room. */
      #splash .bar{width:min(30vw,150px);height:2px;overflow:hidden;
        background:rgba(255,255,255,.08);border-radius:2px}
      #splash .bar span{display:block;width:40%;height:100%;background:${B.accent};
        animation:splash-sweep 1.15s ease-in-out infinite}
      @keyframes splash-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
      @keyframes splash-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}
      @media (prefers-reduced-motion:reduce){
        #splash img,#splash .bar span{animation:none}
        #splash .bar span{width:100%}
      }
    </style>
    <div id="splash" role="status" aria-label="Loading ${B.name}">
      <div class="art">
        <img src="%BASE_URL%brand-logo.png?v=${REV}" alt="" />
        <div class="bar"><span></span></div>
      </div>
    </div>
    `);

  writeFileSync(p, html);
  done.push('apps/web/index.html (title, description, social card, theme colour, splash)');
}

/* ── Android: the label, and the orientation ────────────────────────────── */
{
  const p = join(ROOT, 'apps/mobile/android/app/src/main/res/values/strings.xml');
  let xml = readFileSync(p, 'utf8');
  xml = xml.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${B.name}$2`);
  xml = xml.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${B.name}$2`);
  writeFileSync(p, xml);
  done.push('strings.xml (app_name, title_activity_main)');

  const mp = join(ROOT, 'apps/mobile/android/app/src/main/AndroidManifest.xml');
  let man = readFileSync(mp, 'utf8');
  const want = B.android?.orientation;
  if (typeof want === 'string' && want !== '') {
    man = /android:screenOrientation="[^"]*"/.test(man)
      ? man.replace(/android:screenOrientation="[^"]*"/, `android:screenOrientation="${want}"`)
      : man.replace(/(\s+)android:name="\.MainActivity"/, `$1android:screenOrientation="${want}"$1android:name=".MainActivity"`);
    writeFileSync(mp, man);
    done.push(`AndroidManifest.xml (screenOrientation=${want})`);
  }
}

/* ── Android: the application id, written to every place that carries it ── */
{
  const id = B.android?.applicationId;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id)) {
    throw new Error('brand.config.json: android.applicationId must be a package name like com.example.app');
  }
  const gp = join(ROOT, 'apps/mobile/android/app/build.gradle');
  writeFileSync(gp, fence(readFileSync(gp, 'utf8'),
    '// brand:applicationId:start', '// brand:applicationId:end', `\n        applicationId ${JSON.stringify(id)}\n        `));
  const cp = join(ROOT, 'apps/mobile/capacitor.config.ts');
  writeFileSync(cp, fence(readFileSync(cp, 'utf8'),
    '// brand:appId:start', '// brand:appId:end', `\n  appId: ${JSON.stringify(id).replace(/"/g, "'")},\n  `));
  const sp = join(ROOT, 'apps/mobile/android/app/src/main/res/values/strings.xml');
  let xml = readFileSync(sp, 'utf8');
  xml = xml.replace(/(<string name="package_name">)[^<]*(<\/string>)/, `$1${id}$2`);
  xml = xml.replace(/(<string name="custom_url_scheme">)[^<]*(<\/string>)/, `$1${id}$2`);
  writeFileSync(sp, xml);
  done.push(`build.gradle + capacitor.config.ts + strings.xml (applicationId=${id})`);
}

/* ── the artwork ────────────────────────────────────────────────────────── */
for (const script of ['apps/web/scripts/brand.mjs', 'apps/mobile/scripts/brand-assets.mjs']) {
  execFileSync('node', [join(ROOT, script)], { cwd: ROOT, stdio: 'inherit' });
}

console.log(`\n${B.name}: rebranded from brand.config.json`);
for (const d of done) console.log(`  ${d}`);
console.log('  (run `pnpm build` for the web app and `pnpm apk` for the shell)');
