/**
 * The whole visual identity, generated from one definition.
 *
 * The app shipped with no favicon, no manifest and no social card at all: a
 * shared link showed a bare URL, a bookmark showed a blank page icon, and
 * "add to home screen" produced a screenshot of the page. None of that is
 * cosmetic — it is the difference between a product and a localhost tab.
 *
 * Everything here comes from `brand.config.json` and the artwork it names — see
 * `scripts/brand-kit.mjs`. It used to come from a mark DRAWN in this file (an
 * amber tile with a letter L) and duplicated as a second drawing routine in the
 * Android script, which made "change the logo" a code change in two places. Now
 * the phone icon, the browser tab and the social card are the same image file,
 * and rebranding is one JSON edit plus one PNG.
 *
 * Rendered through headless Chromium rather than by hand-plotting pixels. The
 * alternative was a hand-rolled bitmap font, and a social card is mostly
 * typography — this way the card uses real text layout, and the icons come from
 * one SVG scaled properly instead of five drawings that nearly match.
 *
 * Usage: node apps/web/scripts/brand.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, decodePng, loadBrand, logoSvg, markSvg as kitMark } from '../../../scripts/brand-kit.mjs';

const BRAND = loadBrand();
const LOGO = decodePng(join(ROOT, BRAND.logo));

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
mkdirSync(PUBLIC, { recursive: true });

/* The palette, from index.css's Midnight theme. Stated as literals because this
   script runs outside the bundler and cannot read CSS variables. */
const GROUND = BRAND.ground;
const PANEL = '#131a1e';
const AMBER = BRAND.accent;
const INK = '#e9eef1';
const INK3 = '#6b7a83';

const SITE = BRAND.site ?? '';

/**
 * The mark: the configured logo, cropped to its symbol.
 *
 * `inset` is the fraction of the canvas left empty on each side. A favicon wants
 * almost none — 16px is small enough already — while a maskable icon wants a
 * fifth, because a launcher may crop it to a circle and nothing in the outer 20%
 * is guaranteed to survive. `brand-kit` finds where the symbol ends and the
 * wordmark begins, and clips the wordmark out: an app icon carrying the name in
 * 4px letters is a smudge, and the launcher writes the name underneath anyway.
 */
function markSvg({ size = 512, inset = 0.06, ground = null } = {}) {
  return kitMark(BRAND, LOGO, { size, inset, ...(ground === null ? {} : { ground }) });
}

/* ── favicon.svg ───────────────────────────────────────────────────────────
   An SVG favicon is the one that stays sharp on every display and in every tab
   size, and it is what every current browser prefers. The PNGs below exist for
   the ones that do not, and for the places that cannot take an SVG at all —
   Apple's touch icon and the web manifest. */


/* ── the social card ───────────────────────────────────────────────────────
   1200x630 is the size every platform crops from, and the one to design for.
   Deliberately plain: the mark, the name, one line of what it is, and three
   facts. A card crammed with UI screenshots is unreadable at the size it is
   actually shown, which is about 500px wide in a chat window. */
function ogHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px}
  body{
    background:
      radial-gradient(900px 500px at 88% 8%, rgba(232,163,74,.14), transparent 60%),
      radial-gradient(700px 420px at 6% 96%, rgba(43,191,143,.10), transparent 62%),
      ${GROUND};
    color:${INK};
    font-family:'Noto Sans','DejaVu Sans',sans-serif;
    display:flex;flex-direction:column;justify-content:center;
    padding:0 84px;position:relative;overflow:hidden;
  }
  /* A faint grid, because the interface is built on rules and this should look
     like the same product rather than a generic dark gradient. */
  .grid{position:absolute;inset:0;opacity:.5;
    background-image:linear-gradient(${PANEL} 1px,transparent 1px),linear-gradient(90deg,${PANEL} 1px,transparent 1px);
    background-size:60px 60px;mask-image:radial-gradient(80% 70% at 50% 50%,#000 30%,transparent 100%)}
  .row{display:flex;align-items:center;gap:22px;position:relative}
  .mark{width:92px;height:92px;display:grid;place-items:center;
    filter:drop-shadow(0 18px 40px rgba(240,144,24,.45))}
  .mark svg{width:92px;height:92px}
  .name{font-family:'DejaVu Sans Mono',monospace;font-size:60px;font-weight:700;letter-spacing:-.5px}
  h1{font-size:66px;line-height:1.06;font-weight:600;letter-spacing:-1.6px;margin-top:40px;max-width:16ch}
  h1 em{font-style:normal;color:${AMBER}}
  p{font-family:'DejaVu Sans Mono',monospace;font-size:23px;color:${INK3};margin-top:26px;letter-spacing:.2px}
  .facts{display:flex;gap:14px;margin-top:44px;position:relative}
  .fact{font-family:'DejaVu Sans Mono',monospace;font-size:19px;color:${INK};
    border:1px solid #26313700;background:${PANEL};border-radius:999px;padding:11px 20px}
  .fact b{color:${AMBER};font-weight:600}
  .edge{position:absolute;left:0;right:0;top:0;height:5px;
    background:linear-gradient(90deg,${AMBER},#2bbf8f 60%,transparent)}
  </style></head><body>
    <div class="grid"></div><div class="edge"></div>
    <div class="row">
      <span class="mark">${markSvg({ size: 92, inset: 0.02 })}</span>
      <span class="name">${BRAND.wordmark}</span>
    </div>
    <!--
      What a pasted link says about this app, and what it must not say.

      It read "Your subscription, finally usable" — so every link shared in a chat
      advertised a subscription, which is not what this is. The app opens on free
      public channels with no account at all; attaching a line is something a
      person does by hand, later, in Settings. A share card is the most public
      surface there is, and it should describe the thing everyone gets.
    -->
    <h1>Free channels, <em>on every screen</em>.</h1>
    <p>Live TV &middot; films and series &middot; guide &middot; every codec</p>
    <div class="facts">
      <span class="fact"><b>10,000+</b> free channels</span>
      <span class="fact">phone &middot; tablet &middot; desktop &middot; TV</span>
      <span class="fact">nothing to sign up for</span>
    </div>
  </body></html>`;
}

/* ── render ────────────────────────────────────────────────────────────────── */
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core is not installed — favicon.svg and the manifest were written, '
    + 'but the PNGs and the social card need a browser to rasterise.');
  process.exit(0);
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });

/** Rasterise one SVG at one size. */
async function pngFromSvg(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;`
    + 'overflow:hidden;background:transparent}svg{display:block}</style>' + svg,
  );
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

const ICONS = [
  // Tab and bookmark sizes, for browsers that will not take the SVG.
  { name: 'favicon-16.png', size: 16, inset: 0.02, radius: 0.24 },
  { name: 'favicon-32.png', size: 32, inset: 0.03, radius: 0.24 },
  { name: 'favicon-48.png', size: 48, inset: 0.04, radius: 0.22 },
  // Apple's touch icon is composited on a WHITE ground if it has transparency,
  // so it carries its own dark background and no rounding — iOS masks it itself.
  { name: 'apple-touch-icon.png', size: 180, inset: 0.16, radius: 0.24, ground: GROUND },
  // Manifest icons: one plain, one maskable with the 20% safe margin a launcher
  // may crop into.
  { name: 'icon-192.png', size: 192, inset: 0.06, radius: 0.22 },
  { name: 'icon-512.png', size: 512, inset: 0.06, radius: 0.22 },
  { name: 'icon-512-maskable.png', size: 512, inset: 0.22, radius: 0.22, ground: GROUND },
];

const written = [];
for (const { name, size, inset, radius, ground } of ICONS) {
  const buf = await pngFromSvg(markSvg({ size, inset, radius, ground: ground ?? null }), size);
  writeFileSync(join(PUBLIC, name), buf);
  written.push(`${name} (${buf.length}B)`);
}

/* ── favicon.ico ───────────────────────────────────────────────────────────
   Still worth shipping: it is what a bare `/favicon.ico` request gets, which is
   what several feed readers, chat clients and older browsers ask for before they
   read any HTML. An .ico is just a directory of PNGs, so no encoder is needed —
   the PNGs above are the payload. */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type 1 = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const at = i * 16;
    dir[at] = size >= 256 ? 0 : size;   // 0 means 256
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0;                    // palette
    dir[at + 3] = 0;                    // reserved
    dir.writeUInt16LE(1, at + 4);       // colour planes
    dir.writeUInt16LE(32, at + 6);      // bits per pixel
    dir.writeUInt32LE(buf.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

const icoBuf = ico(await Promise.all([16, 32, 48].map(async (size) => ({
  size,
  buf: await pngFromSvg(markSvg({ size, inset: 0.03, radius: 0.24 }), size),
}))));
writeFileSync(join(PUBLIC, 'favicon.ico'), icoBuf);
written.push(`favicon.ico (${icoBuf.length}B, 3 sizes)`);

/* Wrapping the full-resolution artwork would make this a 153KB favicon — measured,
   and fetched on every page load. The SVG carries a 128px rendering of the mark
   instead: still sharp at every tab size anyone will ever see, at a tenth of the
   weight.

   The header mark used to be markSvg() itself — a 256px SVG that embedded the
   whole source PNG as base64 (~153KB) for a ~28px toolbar image. Same 128px
   raster, as a real PNG next to brand-logo.png. */
{
  const small = await pngFromSvg(markSvg({ size: 128, inset: 0.02 }), 128);
  writeFileSync(join(PUBLIC, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
    + `<image width="128" height="128" href="data:image/png;base64,${small.toString('base64')}"/>`
    + '</svg>');
  writeFileSync(join(PUBLIC, 'brand-mark.png'), small);
  written.push(`brand-mark.png (${small.length}B, the symbol alone)`);
}

/* the card */
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(ogHtml());
  await page.waitForTimeout(250);
  const buf = await page.screenshot();
  writeFileSync(join(PUBLIC, 'og.png'), buf);
  written.push(`og.png (${(buf.length / 1024).toFixed(0)}KB, 1200x630)`);
  await page.close();
}
await browser.close();

/* ── the manifest ──────────────────────────────────────────────────────────
   What turns "add to home screen" from a bookmark with a screenshot for an icon
   into something that opens standalone with the app's own name and colours. */
const manifest = {
  name: BRAND.name,
  short_name: BRAND.name,
  description: BRAND.description ?? BRAND.tagline ?? '',
  id: '/',
  start_url: '/home',
  scope: '/',
  display: 'standalone',
  orientation: 'landscape',
  background_color: GROUND,
  theme_color: GROUND,
  categories: ['entertainment', 'video'],
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};
writeFileSync(join(PUBLIC, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
written.push('manifest.webmanifest');

/* The artwork itself, for the app's own header and the splash screen. Copied
   rather than imported through the bundler so `index.html` can reference it
   before any JavaScript has run — which is the whole point of a splash. */
copyFileSync(join(ROOT, BRAND.logo), join(PUBLIC, 'brand-logo.png'));
written.push('brand-logo.png (the source artwork)');

console.log(`brand assets in apps/web/public (site ${SITE}):`);
for (const w of written) console.log(`  ${w}`);

/* ── the room ──────────────────────────────────────────────────────────────
   The backdrop behind the first run and the modern launcher is composed from
   this brand's accent, so it has to be redrawn when the brand changes. A
   separate script because it is a separate kind of asset — one large image
   rather than a family of icons — and because it is worth being able to
   re-render just that while looking at it.

   Spawned rather than imported: it is written as a program with its own browser
   and its own exit, and importing it would run all of that as a side effect of
   loading a module. */
execFileSync('node', [join(HERE, 'backdrop.mjs')], { stdio: 'inherit' });
