process.env['LOG_LEVEL'] = 'silent';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { abiOf, parseRange, versionOf } from './downloads.ts';

let app: FastifyInstance;
const dir = mkdtempSync(join(tmpdir(), 'dl-test-'));
const dl = join(dir, 'downloads');
const apk = Buffer.from('0123456789abcdefghij'.repeat(10));

before(async () => {
  mkdirSync(dl);
  writeFileSync(join(dl, 'streamix-1.63.0-arm64-v8a.apk'), apk);
  writeFileSync(join(dl, 'streamix-1.63.0-armeabi-v7a.apk'), 'armv7');
  writeFileSync(join(dl, 'streamix-1.63.0-universal.apk'), 'uni');
  writeFileSync(join(dl, 'streamix-1.63.0.wgt'), 'wgt');
  writeFileSync(join(dl, 'streamix.ipk'), 'ipk');
  writeFileSync(join(dl, 'version.json'), JSON.stringify({ version: '1.62.9' }));
  writeFileSync(join(dl, 'notes.txt'), 'not offered');
  writeFileSync(join(dir, 'secret.apk'), 'outside');
  symlinkSync(join(dir, 'secret.apk'), join(dl, 'linked.apk'));
  mkdirSync(join(dl, 'sub'));
  writeFileSync(join(dl, 'sub', 'inner.apk'), 'nested');
  process.env['DOWNLOAD_DIR'] = dl;
  process.env['WEB_DIST'] = join(dir, 'none');
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Streamix', publisher: {} }));
  process.env['BRAND_CONFIG'] = join(dir, 'brand.json');
  const { buildApp } = await import('./app.ts');
  app = await buildApp();
});
after(async () => { await app.close(); });

test('names carry their ABI and version', () => {
  assert.equal(abiOf('streamix-1.2.3-arm64-v8a.apk'), 'arm64-v8a');
  assert.equal(abiOf('streamix-1.2.3-armeabi-v7a.apk'), 'armeabi-v7a');
  assert.equal(abiOf('streamix-1.2.3-universal.apk'), 'universal');
  assert.equal(abiOf('streamix-1.2.3.apk'), null);
  assert.equal(versionOf('streamix-1.2.3-arm64-v8a.apk', null), '1.2.3');
  assert.equal(versionOf('streamix.ipk', '9.9.9'), '9.9.9');
});

test('range headers parse, and a bad one is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9]);
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=50-500', 100), [50, 99]);
  assert.equal(parseRange('bytes=100-', 100), 'bad');
  assert.equal(parseRange('bytes=9-2', 100), 'bad');
  assert.equal(parseRange(undefined, 100), null);
});

test('/download and /get list the packages with size, version and checksum', async () => {
  for (const path of ['/download', '/get']) {
    const r = await app.inject(path);
    assert.equal(r.statusCode, 200, path);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
    for (const n of ['streamix-1.63.0-arm64-v8a.apk', 'streamix-1.63.0-armeabi-v7a.apk', 'streamix-1.63.0-universal.apk', 'streamix-1.63.0.wgt', 'streamix.ipk']) {
      assert.ok(r.body.includes(`href="/download/${n}"`), `${path} lacks ${n}`);
    }
    assert.ok(r.body.includes(createHash('sha256').update(apk).digest('hex')));
    assert.match(r.body, /version 1\.63\.0 · arm64-v8a · 1 KB/);
    assert.match(r.body, /version 1\.62\.9/, 'a name with no version uses version.json');
    assert.match(r.body, /Android TV/);
    assert.equal(/notes\.txt|secret|linked|inner/.test(r.body), false, 'only real package files are listed');
    assert.equal(/<script|<link|<img|\ssrc=/i.test(r.body), false);
  }
});

test('a file downloads whole with the right type and disposition', async () => {
  const r = await app.inject('/download/streamix-1.63.0-arm64-v8a.apk');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="streamix-1.63.0-arm64-v8a.apk"');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.rawPayload.equals(apk), true);
  const w = await app.inject('/download/streamix-1.63.0.wgt');
  assert.equal(w.headers['content-type'], 'application/octet-stream');
  assert.equal((await app.inject({ method: 'HEAD', url: '/download/streamix-1.63.0.wgt' })).headers['content-length'], '3');
});

test('ranges are honoured', async () => {
  const r = await app.inject({ url: '/download/streamix-1.63.0-arm64-v8a.apk', headers: { range: 'bytes=10-19' } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.headers['content-range'], `bytes 10-19/${apk.length}`);
  assert.equal(r.rawPayload.equals(apk.subarray(10, 20)), true);
  const tail = await app.inject({ url: '/download/streamix-1.63.0-arm64-v8a.apk', headers: { range: 'bytes=-5' } });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.rawPayload.equals(apk.subarray(apk.length - 5)), true);
  const bad = await app.inject({ url: '/download/streamix-1.63.0-arm64-v8a.apk', headers: { range: `bytes=${apk.length}-` } });
  assert.equal(bad.statusCode, 416);
});

test('nothing else is reachable: no listing, no traversal, no symlinks, no other types', async () => {
  const paths = [
    '/download/notes.txt', '/download/version.json', '/download/linked.apk', '/download/sub', '/download/sub/inner.apk',
    '/download/..%2fsecret.apk', '/download/%2e%2e%2fsecret.apk', '/download/..%5csecret.apk', '/download/../secret.apk',
    '/download/.hidden.apk', '/download/missing.apk', '/download/streamix.ipk%00.txt',
  ];
  for (const p of paths) {
    const r = await app.inject(p);
    assert.ok(r.statusCode === 404 || r.statusCode === 400, `${p} -> ${r.statusCode}`);
    assert.equal(r.body.includes('outside') || r.body.includes('nested') || r.body.includes('not offered'), false, p);
  }
});

test('an empty or missing folder says the app will be listed in the stores', async () => {
  process.env['DOWNLOAD_DIR'] = join(dir, 'nonexistent');
  const r = await app.inject('/download');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /will be listed in the app stores/);
  assert.equal(r.body.includes('Direct downloads'), false);
  assert.equal((await app.inject('/download/streamix.ipk')).statusCode, 404);
});
