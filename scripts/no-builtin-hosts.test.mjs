/**
 * Nothing is built in.
 *
 * The app ships with no provider hosts, no playlists and no channel lists: the
 * viewer adds their own source. This gate fails if a built-in host list comes
 * back, or if a public IP address or a non-example host is written into the
 * sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sources(full, out); continue; }
    if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const files = [
  ...sources(join(root, 'apps/web/src')),
  ...sources(join(root, 'apps/server/src')),
];

/* The publisher's contact details (an address, a domain) are allowed in exactly
   one place: the generated brand.ts, which copies them from brand.config.json.
   Every other source stays free of them. */
const BRAND_TS = join(root, 'apps/web/src/brand.ts');
const brandConfig = JSON.parse(readFileSync(join(root, 'brand.config.json'), 'utf8'));
const publisher = brandConfig.publisher ?? {};
/* The app's own name is everywhere by design; a publisher name equal to it is not a detail to hide. */
const PUBLISHER_VALUES = [publisher.website, publisher.email, publisher.address, publisher.name]
  .filter((v) => typeof v === 'string' && v.trim() !== '' && v !== brandConfig.name);
const scrub = (f, src) => (f === BRAND_TS ? PUBLISHER_VALUES.reduce((s, v) => s.split(v).join(''), src) : src);

test('publisher details live only in brand.config.json and the generated brand.ts', () => {
  assert.match(readFileSync(BRAND_TS, 'utf8'), /Generated from brand\.config\.json/);
  for (const f of files) {
    const src = scrub(f, readFileSync(f, 'utf8'));
    for (const v of PUBLISHER_VALUES) assert.equal(src.includes(v), false, `${f.slice(root.length)} repeats a publisher detail`);
  }
});

test('there is no built-in host list module', () => {
  assert.equal(existsSync(join(root, 'apps/web/src/lib/providers/mirrors.ts')), false);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/BUILT_IN\s*=\s*\[/.test(src), false, `${f} declares a built-in list`);
    assert.equal(/VITE_XTREAM_HOSTS/.test(src), false, `${f} reads a build-time host list`);
  }
});

test('the first launch seeds no provider and fetches no public list', () => {
  for (const f of files) {
    if (f.endsWith('.test.ts') || f.endsWith('.test.mjs')) continue;
    const src = readFileSync(f, 'utf8');
    assert.equal(/seedDefault|DEFAULT_PROVIDER|PUBLIC_PLAYLIST/.test(src), false, `${f} seeds a provider`);
    assert.equal(/iptv-org\.github\.io|Free-TV\/IPTV/.test(src), false, `${f} fetches a public channel list`);
  }
});

test('no public IPv4 address is written into the sources', () => {
  const ip = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
  /* Private, loopback and documentation ranges are fine. */
  const fine = (a, b, c) =>
    a === 10 || a === 127 || a === 0 || a === 255
    || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a === 1 && b === 1 && c === 1) || (a === 8 && b === 8) || (a === 1 && b === 2 && c === 3);
  const bad = [];
  for (const f of files) {
    const src = scrub(f, readFileSync(f, 'utf8'));
    for (const m of src.matchAll(ip)) {
      const [a, b, c, d] = m.slice(1).map(Number);
      if ([a, b, c, d].some((n) => n > 255)) continue;
      /* Version strings (1.4.0.0, Chrome 140.0.0.0, codec 09.00.10.08) are not hosts. */
      if (m.slice(1).some((o) => o.length > 1 && o.startsWith('0')) || (c === 0 && d === 0)) continue;
      if (!fine(a, b, c)) bad.push(`${f.slice(root.length)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});
