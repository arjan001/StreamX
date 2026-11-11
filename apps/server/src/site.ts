/**
 * The website: a landing page and the legal pages.
 *
 * Plain server-rendered HTML with inline CSS. No script, no external asset, no
 * tracker, so the pages are readable on a phone, in a store reviewer's browser,
 * and with everything blocked. The wording is the same `legal/*.md` the app
 * bundles, filled from the `publisher` block of brand.config.json; a value that is
 * not filled in shows a visible marker rather than raw braces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BRAND } from './brand.ts';
import { legalDir } from './paths.ts';
import { listDownloads, serveDownload, type DownloadFile, type Platform } from './downloads.ts';
import { demoEnabled, demoPlaylist } from './demo.ts';
import { LEGAL_TITLES, renderLegal, renderMarkdown, type LegalDoc } from '../../../legal/render.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Strict: the pages load nothing and run nothing. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#14181b;--mute:#586068;--rule:#d9dee2;--accent:#b8620a;--mark:#fff1b8}
@media(prefers-color-scheme:dark){:root{--bg:#0b1013;--fg:#e8ecef;--mute:#9aa4ac;--rule:#27313a;--accent:#f09018;--mark:#4a3a08}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main,header,footer{max-width:46rem;margin:0 auto;padding:0 1.1rem}
header{padding-top:1.2rem;padding-bottom:.6rem;border-bottom:1px solid var(--rule);display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;align-items:baseline}
header a.brand{font-weight:700;letter-spacing:.06em;text-decoration:none;color:var(--fg)}
nav a{margin-right:1rem;font-size:.92rem}
a{color:var(--accent)}
h1{font-size:1.8rem;line-height:1.25;margin:1.6rem 0 .8rem}
h2{font-size:1.2rem;margin:1.8rem 0 .4rem}
p,li{max-width:42rem}
pre{overflow:auto;background:color-mix(in srgb,var(--fg) 6%,transparent);padding:.8rem;font-size:.8rem;line-height:1.4;white-space:pre-wrap}
code{font-size:.9em}
mark.todo{background:var(--mark);color:inherit;padding:0 .2em;border-radius:.2em}
.note{border-left:3px solid var(--accent);padding:.1rem 0 .1rem .9rem;margin:1.4rem 0;color:var(--fg)}
.badges a{display:inline-block;margin:0 .6rem .6rem 0;padding:.55rem .9rem;border:1px solid var(--rule);border-radius:.5rem;text-decoration:none;color:var(--fg)}
footer{border-top:1px solid var(--rule);margin-top:3rem;padding-top:1rem;padding-bottom:2rem;color:var(--mute);font-size:.9rem}
footer a{margin-right:1rem}
`;

/* No contact block on the pages themselves: the publisher's contact lives in the
   Terms, Privacy and Copyright texts, where it is required, and nowhere else. */
function layout(title: string, body: string): string {
  const links = ['<a href="/about">About</a>', '<a href="/download">Download</a>', ...(['terms', 'privacy', 'copyright', 'licenses'] as const)
    .map((k) => `<a href="/${k}">${esc(LEGAL_TITLES[k])}</a>`)].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<header><a class="brand" href="/">${esc(BRAND.wordmark || BRAND.name)}</a><nav>${links}</nav></header>
<main>
${body}
</main>
</body></html>
`;
}

const cache = new Map<string, string>();
function readLegal(file: string): string {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const text = readFileSync(join(legalDir(), file), 'utf8');
  cache.set(file, text);
  return text;
}

function send(reply: FastifyReply, html: string): FastifyReply {
  return reply
    .header('content-security-policy', CSP)
    .header('cache-control', 'no-cache')
    .header('x-frame-options', 'DENY')
    .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
    .type('text/html; charset=utf-8')
    .send(html);
}

export function landingHtml(webAppPresent: boolean): string {
  const name = esc(BRAND.name);
  const playUrl = BRAND.playStoreUrl;
  const iosUrl = BRAND.appStoreUrl;
  const badges = [
    playUrl === '' ? '' : `<a href="${esc(playUrl)}" rel="noopener">Get it on Google Play</a>`,
    iosUrl === '' ? '' : `<a href="${esc(iosUrl)}" rel="noopener">Download on the App Store</a>`,
    `<a href="/download">Download</a>`,
    webAppPresent ? `<a href="/home">Open in your browser</a>` : '',
  ].join('');
  const body = `
<h1>${name} is a player for your own sources</h1>
<p>${name} plays video from the sources you add yourself: a playlist link, a stream link, or the login a TV service you subscribe to has given you. It runs on phones, tablets, Android TV, Samsung and LG televisions.</p>
${badges === '' ? '' : `<p class="badges">${badges}</p>`}
<h2>Your information</h2>
<p>No accounts, no ads, no analytics. What you type into the app stays on your device. Read the <a href="/privacy">Privacy Policy</a>, the <a href="/terms">Terms of Use</a> and the <a href="/copyright">Copyright</a> notice, or see the <a href="/licenses">open-source licences</a>.</p>`;
  return layout(`${BRAND.name} — a player for your own sources`, body);
}

const PLATFORM_TITLE: Record<Platform, string> = {
  android: 'Android phone, tablet and Android TV',
  samsung: 'Samsung TV (Tizen)',
  lg: 'LG TV (webOS)',
};

const ABI_NOTE: Record<string, string> = {
  'arm64-v8a': 'most phones and tablets made since 2017, and most Android TV boxes',
  'armeabi-v7a': 'older 32-bit phones, tablets and TV boxes',
  universal: 'every device, larger download',
  x86_64: 'emulators and some Chromebooks',
  x86: 'older emulators',
};

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileRow(f: DownloadFile): string {
  const bits = [f.version === null ? '' : `version ${esc(f.version)}`, f.abi === null ? '' : esc(f.abi), size(f.size)]
    .filter((b) => b !== '').join(' · ');
  const note = f.abi !== null && ABI_NOTE[f.abi] !== undefined ? `<br><small>${esc(ABI_NOTE[f.abi]!)}</small>` : '';
  return `<li><a href="/download/${encodeURIComponent(f.name)}">${esc(f.name)}</a><br>${bits}${note}<br><small>SHA-256 <code>${f.sha256}</code></small></li>`;
}

const HOWTO: Record<Platform, string> = {
  android: `<p>Open the file on your device. Android asks you to allow installing apps from this source (your browser or file manager); allow it, then install. You can turn the permission off again afterwards.</p>
<p><strong>Android TV:</strong> install a downloader app from the TV's store, open it, and enter this page's address. Download the file and choose Install.</p>`,
  samsung: `<p>Samsung TVs install apps that are not in the store through developer mode: switch it on in the Apps panel, enter your computer's address, then install the <code>.wgt</code> with Tizen Studio or the <code>tizen</code> command line tool. Checking the SHA-256 below first is a good idea.</p>`,
  lg: `<p>LG TVs install apps that are not in the store through the Developer Mode app and the webOS command line tools: enable Developer Mode on the TV, add it with <code>ares-setup-device</code>, then run <code>ares-install</code> on the <code>.ipk</code>.</p>`,
};

export async function downloadHtml(origin: string): Promise<string> {
  const name = esc(BRAND.name);
  const files = await listDownloads();
  const stores = [
    BRAND.playStoreUrl === '' ? '' : `<a href="${esc(BRAND.playStoreUrl)}" rel="noopener">Get it on Google Play</a>`,
    BRAND.appStoreUrl === '' ? '' : `<a href="${esc(BRAND.appStoreUrl)}" rel="noopener">Download on the App Store</a>`,
  ].join('');
  let body = `<h1>Download ${name}</h1>
<p>${name} is a player for your own sources.</p>
${stores === '' ? '' : `<h2>From a store</h2><p class="badges">${stores}</p>`}`;
  if (files.length === 0) {
    body += `<p class="note">${stores === '' ? `The app will be listed in the app stores. Check back here for the link.` : `There are no direct downloads on this page. Use the store link${BRAND.playStoreUrl !== '' && BRAND.appStoreUrl !== '' ? 's' : ''} above.`}</p>`;
  } else {
    body += '<h2>Direct downloads</h2>';
    for (const platform of ['android', 'samsung', 'lg'] as Platform[]) {
      const group = files.filter((f) => f.platform === platform);
      if (group.length === 0) continue;
      body += `<h2>${esc(PLATFORM_TITLE[platform])}</h2><ul>${group.map(fileRow).join('')}</ul>${HOWTO[platform].replace('this page\'s address', `this page's address (<code>${esc(origin)}/download</code>)`)}`;
    }
    body += '<p><small>Only install files from this page if you trust its address. Compare the SHA-256 shown with the one of the file you downloaded.</small></p>';
  }
  return layout(`Download — ${BRAND.name}`, body);
}

export function registerSite(app: FastifyInstance, opts: { webApp?: () => boolean } = {}): void {
  const hasWeb = opts.webApp ?? (() => true);

  /* A visitor lands in the app itself, where a source is added; the short
     description of the app lives at /about. Without a web build there is no
     app to land in, so the description stays at / as well. */
  app.get('/', async (_req, reply) => (hasWeb() ? reply.redirect('/home', 302) : send(reply, landingHtml(false))));
  app.get('/about', async (_req, reply) => send(reply, landingHtml(hasWeb())));

  /* The download page and its files. Website only: the apps never read these. */
  const page = async (req: FastifyRequest, reply: FastifyReply) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim() === 'https' ? 'https' : 'http';
    const origin = BRAND.site ?? `${proto}://${req.headers.host ?? 'localhost'}`;
    return send(reply, await downloadHtml(origin.replace(/\/+$/, '')));
  };
  for (const path of ['/download', '/download/', '/get', '/get/']) app.get(path, page);
  const file = async (req: FastifyRequest, reply: FastifyReply) =>
    serveDownload(req, reply, (req.params as { file: string }).file);
  app.get('/download/:file', file);
  /* Anything deeper is never a download, and must not fall through to the web
     app's catch-all page, which would answer 200 with the app's HTML. */
  app.get('/download/*', async (_req, reply) => reply.code(404).type('text/plain').send('Not found'));

  for (const doc of ['terms', 'privacy', 'copyright'] as LegalDoc[]) {
    app.get(`/${doc}`, async (_req, reply) => {
      const html = renderLegal(readLegal(`${doc}.md`), BRAND, doc);
      return send(reply, layout(`${LEGAL_TITLES[doc]} — ${BRAND.name}`, html));
    });
  }

  app.get('/licenses', async (_req, reply) => {
    const html = renderMarkdown(readLegal('licenses.md'), {});
    return send(reply, layout(`${LEGAL_TITLES.licenses} — ${BRAND.name}`, html));
  });

  /* Off unless the operator turns it on: a playlist nobody asked for is a surface. */
  app.get('/demo/playlist.m3u', async (_req, reply) => {
    if (!demoEnabled()) return reply.code(404).type('application/json').send({ error: 'not found' });
    const m3u = demoPlaylist();
    if (m3u === null) {
      return reply.code(404).type('application/json')
        .send({ error: 'not configured', message: 'The demo list has no entry with a url yet.' });
    }
    return reply.header('cache-control', 'no-cache').type('audio/x-mpegurl; charset=utf-8').send(m3u);
  });
}


