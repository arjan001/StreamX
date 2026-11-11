process.env['LOG_LEVEL'] = 'silent';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const dir = mkdtempSync(join(tmpdir(), 'site-test-'));

before(async () => {
  writeFileSync(join(dir, 'streams.json'), JSON.stringify({
    group: 'Demo', entries: [
      { name: 'Film A (c) X | CC BY 3.0', url: 'https://cdn.example.com/a.mp4' },
      { name: 'Film B', url: '' },
      { name: 'Bad "quote"\nname', url: 'https://cdn.example.com/b.mp4' },
      { name: 'Script', url: 'javascript:alert(1)' },
    ],
  }));
  process.env['DEMO_STREAMS_FILE'] = join(dir, 'streams.json');
  process.env['WEB_DIST'] = join(dir, 'none');
  process.env['PUBLIC_SITE_ORIGIN'] = 'https://streamix.example.com';
  /* An unfilled publisher block, to see the markers; the real config is filled. */
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Streamix', wordmark: 'STREAMIX', publisher: {} }));
  process.env['BRAND_CONFIG'] = join(dir, 'brand.json');
  const { buildApp } = await import('./app.ts');
  app = await buildApp();
});
after(async () => { await app.close(); });

test('the legal pages and the landing page render, with a strict policy and no scripts', async () => {
  for (const path of ['/about', '/terms', '/privacy', '/copyright', '/licenses']) {
    const r = await app.inject(path);
    assert.equal(r.statusCode, 200, path);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(/<script|<link|<img|<iframe|<object|\ssrc=/i.test(r.body), false, `${path} loads something`);
    assert.equal(/\{\{[A-Z_]+\}\}/.test(r.body), false, `${path} has a placeholder`);
  }
});

test('the landing page says what the app is, and leaves the disclaimers to the Terms', async () => {
  const b = (await app.inject('/about')).body;
  assert.match(b, /a player for your own sources/i);
  assert.doesNotMatch(b, /contains no (channels|content)|right to use/i);
  assert.match(b, /href="\/privacy"/);
  assert.equal(b.includes('Google Play'), false, 'an empty store link must not render a badge');
});

test('unfilled publisher values show the marker', async () => {
  assert.match((await app.inject('/terms')).body, /\[to be filled in\]/);
});

test('the landing page and header link to the download page', async () => {
  for (const path of ['/about', '/terms']) assert.match((await app.inject(path)).body, /href="\/download"/, path);
});

test('the demo playlist is off unless DEMO_ENABLED=1', async () => {
  delete process.env['DEMO_ENABLED'];
  assert.equal((await app.inject('/demo/playlist.m3u')).statusCode, 404);
  process.env['DEMO_ENABLED'] = '1';
  const r = await app.inject('/demo/playlist.m3u');
  assert.equal(r.statusCode, 200);
  const lines = r.body.trim().split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines.filter((l) => l.startsWith('#EXTINF')).length, 2, 'empty and non-http urls are skipped');
  assert.match(r.body, /group-title="Demo",Film A \(c\) X \| CC BY 3\.0\nhttps:\/\/cdn\.example\.com\/a\.mp4/);
  assert.equal(/javascript:/.test(r.body), false);
  delete process.env['DEMO_ENABLED'];
});

test('the shipped demo list credits the three Blender films', async () => {
  const { demoFile } = await import('./demo.ts');
  const saved = process.env['DEMO_STREAMS_FILE'];
  delete process.env['DEMO_STREAMS_FILE'];
  const shipped = JSON.parse((await import('node:fs')).readFileSync(demoFile(), 'utf8'));
  process.env['DEMO_STREAMS_FILE'] = saved;
  const names: string[] = shipped.entries.map((e: { name: string }) => e.name);
  for (const [film, site] of [['Big Buck Bunny', 'peach.blender.org'], ['Sintel', 'durian.blender.org'], ['Tears of Steel', 'mango.blender.org']]) {
    assert.equal(names.some((n) => n.includes(film!) && n.includes(site!) && n.includes('CC BY 3.0')), true, film);
  }
});

test('CORS: the app origins pass, a stranger gets no header', async () => {
  const ask = async (origin: string) =>
    (await app.inject({ method: 'GET', url: '/api/captions/health', headers: { origin } })).headers['access-control-allow-origin'];
  for (const o of ['capacitor://localhost', 'http://localhost', 'https://localhost', 'null', 'https://streamix.example.com']) {
    assert.equal(await ask(o), o, o);
  }
  assert.equal(await ask('https://evil.example.org'), undefined);
});

test('liveness needs no database', async () => {
  assert.equal((await app.inject('/healthz')).statusCode, 200);
});

test('the admin area does not exist without ADMIN_PASSWORD', async () => {
  delete process.env['ADMIN_PASSWORD'];
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: '' } });
  assert.equal(r.statusCode, 503);
});

test('admin sign-in is rate limited', async () => {
  process.env['ADMIN_PASSWORD'] = 'right';
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'wrong' } })).statusCode;
  }
  assert.equal(last, 429);
  delete process.env['ADMIN_PASSWORD'];
});

test('with no database the remote config is the all-off document, not an error', async () => {
  const r = await app.inject('/api/app-config');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().errorReports, false);
  assert.equal(r.json().mustUpdate, false);
});

test('a visitor lands in the app; the description lives at /about', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerSite } = await import('./site.ts');
  for (const web of [true, false]) {
    const f = Fastify();
    registerSite(f, { webApp: () => web });
    const r = await f.inject('/');
    if (web) {
      assert.equal(r.statusCode, 302);
      assert.equal(r.headers['location'], '/home');
    } else {
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /a player for your own sources/i);
    }
    assert.equal((await f.inject('/about')).statusCode, 200);
    await f.close();
  }
});
