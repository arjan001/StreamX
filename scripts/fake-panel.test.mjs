import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function start(...args) {
  const child = spawn(process.execPath, [join(HERE, 'fake-panel.mjs'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (d) => {
      text += d;
      const m = /fake panel on (http:\/\/\S+)/.exec(text);
      if (m) resolve(m[1]);
    });
    child.once('exit', () => reject(new Error('fake panel exited')));
  });
  return { child, url };
}

const running = [];
after(() => { for (const c of running) c.kill(); });

test('it generates an Xtream catalogue on an ephemeral port, offline', async () => {
  const p = start();
  running.push(p.child);
  const url = await p.url;
  assert.ok(!/:7529$/.test(url), 'not a fixed port');
  const get = (path) => fetch(`${url}${path}`).then((r) => r.json());
  const auth = await get('/player_api.php?username=x&password=y');
  assert.equal(auth.user_info.auth, 1);
  const cats = await get('/player_api.php?action=get_live_categories');
  assert.equal(cats.length, 12);
  const live = await get('/player_api.php?action=get_live_streams');
  assert.ok(live.length >= 200, `${live.length} channels`);
  assert.ok(live.some((c) => c.tv_archive === 1));
  assert.ok(live.every((c) => c.is_adult === '0'));
  const films = await get('/player_api.php?action=get_vod_streams');
  assert.ok(films.length >= 90);
  const series = await get('/player_api.php?action=get_series');
  assert.equal(series.length, 20);
  const info = await get(`/player_api.php?action=get_series_info&series_id=${series[0].series_id}`);
  assert.deepEqual(Object.keys(info.episodes).sort(), ['1', '10', '2']);
  const epg = await get(`/player_api.php?action=get_short_epg&stream_id=${live[0].stream_id}`);
  assert.ok(epg.epg_listings.length > 0);
});

test('it serves the same channels as an M3U with its own guide, guide files, and streams', async () => {
  const p = start();
  running.push(p.child);
  const url = await p.url;
  const m3u = await (await fetch(`${url}/playlist.m3u`)).text();
  assert.match(m3u.split('\n')[0], new RegExp(`^#EXTM3U url-tvg="${url}/xmltv.php`));
  assert.ok(m3u.includes('#EXTVLCOPT:http-user-agent='));
  assert.ok(!(await (await fetch(`${url}/playlist-noguide.m3u`)).text()).includes('url-tvg'));
  const xml = await (await fetch(`${url}/xmltv.xml`)).text();
  assert.ok(xml.includes('<programme'));
  const gz = Buffer.from(await (await fetch(`${url}/xmltv.xml.gz`)).arrayBuffer());
  assert.equal(gunzipSync(gz).toString(), xml);
  const hls = await (await fetch(`${url}/stream/1000.m3u8`)).text();
  assert.ok(hls.startsWith('#EXTM3U'));
  const seg = hls.split('\n').find((l) => l.endsWith('.ts'));
  const bytes = Buffer.from(await (await fetch(`${url}${seg}`)).arrayBuffer());
  assert.equal(bytes[0], 0x47, 'an MPEG-TS packet');
  /* The Xtream live URL hands over to the same test stream. */
  const hop = await fetch(`${url}/live/u/p/1000.m3u8`, { redirect: 'manual' });
  assert.equal(hop.headers.get('location'), '/stream/1000.m3u8');
});

test('--adult adds rows the app must hide, and nothing else changes shape', async () => {
  const p = start('--adult');
  running.push(p.child);
  const url = await p.url;
  const cats = await (await fetch(`${url}/player_api.php?action=get_live_categories`)).json();
  assert.ok(cats.some((c) => c.category_name.startsWith('18|')));
  const vcats = await (await fetch(`${url}/player_api.php?action=get_vod_categories`)).json();
  assert.ok(vcats.some((c) => c.category_name === 'XXX Movies'));
  const live = await (await fetch(`${url}/player_api.php?action=get_live_streams`)).json();
  assert.ok(live.some((c) => c.is_adult === '1'));
});
