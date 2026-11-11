process.env['LOG_LEVEL'] = 'silent';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/* A stand-in for Soniox on an ephemeral port: it records what it was asked and
   answers like the real temporary-key endpoint. */
let stub: Server;
let base = '';
const seen: { auth: string; body: Record<string, unknown> }[] = [];
let status = 200;

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/v1/auth/temporary-api-key') {
        seen.push({ auth: String(req.headers['authorization']), body: JSON.parse(raw) });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 200 ? JSON.stringify({ api_key: 'temp:abc', expires_at: '2030-01-01T00:00:00Z' }) : '{"error":"nope","account":"secret"}');
      } else { res.writeHead(404).end(); }
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
after(() => { stub.close(); });

async function app() {
  const { buildApp } = await import('./app.ts');
  return buildApp();
}

test('with no SONIOX_API_KEY captions report unavailable and never call out', async () => {
  process.env['SONIOX_API_BASE'] = base;
  const a = await app();
  /* After the import, which loads a local .env and would put the key back. */
  delete process.env['SONIOX_API_KEY'];
  const h = await a.inject('/api/captions/health');
  assert.equal(h.statusCode, 503);
  assert.equal(h.json().available, false);
  const s = await a.inject({ method: 'POST', url: '/api/captions/session' });
  assert.equal(s.statusCode, 503);
  assert.equal(s.json().error, 'unavailable');
  assert.equal(seen.length, 0);
  await a.close();
});

test('a session mints a five-minute key with the publisher key, and returns only the temporary one', async () => {
  process.env['SONIOX_API_KEY'] = 'account-secret';
  process.env['SONIOX_API_BASE'] = base;
  const a = await app();
  assert.equal((await a.inject('/api/captions/health')).json().available, true);
  const r = await a.inject({ method: 'POST', url: '/api/captions/session' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.apiKey, 'temp:abc');
  assert.equal(j.model, 'stt-rt-v5');
  assert.equal(j.websocketUrl, 'wss://127.0.0.1/transcribe-websocket');
  assert.equal(r.body.includes('account-secret'), false);
  assert.deepEqual(seen.at(-1), { auth: 'Bearer account-secret', body: { usage_type: 'transcribe_websocket', expires_in_seconds: 300 } });
  await a.close();
});

test('the realtime host follows the region of the key', async () => {
  process.env['SONIOX_API_KEY'] = 'k';
  process.env['SONIOX_API_BASE'] = base;
  process.env['SONIOX_WS_URL'] = 'wss://stt-rt.eu.soniox.com/transcribe-websocket';
  const a = await app();
  const j = (await a.inject({ method: 'POST', url: '/api/captions/session' })).json();
  assert.equal(j.websocketUrl, 'wss://stt-rt.eu.soniox.com/transcribe-websocket');
  delete process.env['SONIOX_WS_URL'];
  await a.close();
});

test('a refusal upstream is a 502 that does not echo the upstream body', async () => {
  process.env['SONIOX_API_KEY'] = 'k';
  process.env['SONIOX_API_BASE'] = base;
  status = 401;
  const a = await app();
  const r = await a.inject({ method: 'POST', url: '/api/captions/session' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.includes('secret'), false);
  status = 200;
  await a.close();
});

test('sessions are rate limited per address', async () => {
  process.env['SONIOX_API_KEY'] = 'k';
  process.env['SONIOX_API_BASE'] = base;
  const a = await app();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await a.inject({ method: 'POST', url: '/api/captions/session' })).statusCode;
  assert.equal(last, 429);
  await a.close();
});
