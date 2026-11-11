import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logUrl, maskIp } from './logUrl.ts';

test('the rescue and relay routes lose their query, which is where the subscription is', () => {
  assert.equal(logUrl('/api/panel?u=http%3A%2F%2Fh%2Fplayer_api.php%3Fusername%3Da%26password%3Db'), '/api/panel?[redacted]');
  assert.equal(logUrl('/api/relay?u=http%3A%2F%2Fh%2Fmovie%2Fa%2Fb%2F1.mkv'), '/api/relay?[redacted]');
  assert.equal(logUrl('/api/img?u=http%3A%2F%2Fh%2Fx.png&w=112'), '/api/img?[redacted]');
});

test('elsewhere, credentials are masked and the rest kept', () => {
  assert.equal(logUrl('/api/app-config?version=1.47.0&build=185'), '/api/app-config?version=1.47.0&build=185');
  assert.equal(logUrl('/x?username=a&password=b&c=1'), '/x?username=[redacted]&password=[redacted]&c=1');
  assert.equal(logUrl('/movie/alice/secret/123.mkv'), '/movie/<user>/<pass>/123.mkv');
  assert.equal(logUrl('/api/health'), '/api/health');
});

test('an address is logged as its network, never whole', () => {
  assert.equal(maskIp('203.0.113.57'), '203.0.113.0/24');
  assert.equal(maskIp('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
  assert.equal(maskIp('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(maskIp('::1'), '0:0:0::/48');
  assert.equal(maskIp('not-an-ip'), '');
  assert.equal(maskIp(''), '');
});
