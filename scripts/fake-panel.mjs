/**
 * A provider that answers on this machine, with a catalogue made up on the spot.
 *
 * It exists so the app can be driven end to end — sign in, browse, play — without
 * anybody's real subscription, and with no network at all. Nothing in it is real
 * data: every name, logo and programme is generated, and every stream is a
 * two-second test pattern.
 *
 * What it serves:
 *   Xtream API    /player_api.php        any username and password
 *                 /xmltv.php             the whole guide as XMLTV
 *                 /live|movie|series/<user>/<pass>/<id>.<ext>
 *                 /streaming/timeshift.php  and  /timeshift/...   catch-up
 *   Playlists     /playlist.m3u          the same live channels, header carries url-tvg
 *                 /playlist-noguide.m3u  the same without a guide address
 *                 /get.php               the "M3U link" a reseller hands out
 *   Guide files   /xmltv.xml  /xmltv.xml.gz (a plain download)  /xmltv-ce.xml (Content-Encoding)
 *   Streams       /stream/<id>.m3u8      an endless test channel (HLS)
 *                 /stream/<id>/<n>.ts    its segments
 *   Other         /logo/<id>.png  /__rename?id=&name=
 *
 * Usage:  node scripts/fake-panel.mjs [--port N] [--host H] [--adult] [--expired]
 *   --port N    default 0: the system picks a free one; the URL is printed
 *   --host H    the address to bind, default 127.0.0.1. Use the bridge address
 *               (not 0.0.0.0) for an emulator.
 *   --adult     adds adult-flagged rows, a `18|` live category and an
 *               `XXX Movies` category — all of which the app must keep out of
 *               every list, search and guide
 *   --expired   a line that authenticates but has lapsed
 * Sign in with any username and password, e.g. http://demo:demo@127.0.0.1:<port>
 */
import { createServer } from 'node:http';
import { gzipSync, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const HOST = argOf('--host') ?? '127.0.0.1';
const REQUESTED_PORT = Number(argOf('--port')) || 0;
const ADULT = process.argv.includes('--adult');
const EXPIRED = process.argv.includes('--expired');

const CLIP = readFileSync(join(HERE, 'fake-panel-clip.mpegts'));
const FILM = readFileSync(join(HERE, 'fake-panel-film.mp4'));

/* ── the catalogue ──────────────────────────────────────────────────────── */

const MARKETS = [
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'DE', name: 'Germany' },
];
const LIVE_GROUPS = ['News', 'Sport', 'Movies', 'Kids'];
const VOD_GROUPS = ['Drama', 'Comedy', 'Action', 'Family'];
const SERIES_GROUPS = ['Drama', 'Comedy', 'Documentary', 'Family'];
const NOW = Math.floor(Date.now() / 1000);

/** Category ids are strings, as a panel sends them. */
const liveCats = [];
const vodCats = [];
const seriesCats = [];
let catId = 100;
for (const m of MARKETS) {
  for (const g of LIVE_GROUPS) liveCats.push({ id: String(catId++), name: `${m.code}| ${g}`, market: m, group: g });
  for (const g of VOD_GROUPS) vodCats.push({ id: String(catId++), name: `${m.code}| ${g}`, market: m, group: g });
  for (const g of SERIES_GROUPS) seriesCats.push({ id: String(catId++), name: `${m.code}| ${g}`, market: m, group: g });
}

const live = [];
const films = [];
const series = [];
let nextId = 1000;

/* 3 markets x 4 groups x 17 = 204 channels. Every tenth keeps a catch-up window. */
for (const cat of liveCats) {
  for (let n = 1; n <= 17; n++) {
    const id = nextId++;
    live.push({
      id, cat, name: `${cat.market.code} ${cat.group} ${n}`, tvgId: `ch${id}.test`,
      archive: id % 10 === 0, adult: false,
    });
  }
}
for (const cat of vodCats) {
  for (let n = 1; n <= 8; n++) {
    const id = nextId++;
    films.push({ id, cat, name: `Sample Film ${id - 999} (${2000 + (id % 25)})`, adult: false });
  }
}
/* 20 series, three seasons each — "10" is a season key on purpose, because
   string-keyed season order is a trap clients fall into. */
for (let i = 0; i < 20; i++) {
  const cat = seriesCats[i % seriesCats.length];
  series.push({ id: nextId++, cat, name: `Sample Series ${i + 1}`, adult: false });
}

if (ADULT) {
  const adultLive = { id: '900', name: '18| FOR ADULTS', market: MARKETS[0], group: 'Adult' };
  const adultVod = { id: '901', name: 'XXX Movies', market: MARKETS[0], group: 'Adult' };
  liveCats.push(adultLive);
  vodCats.push(adultVod);
  for (let n = 1; n <= 10; n++) {
    live.push({ id: nextId++, cat: adultLive, name: `XXX Night Channel ${n}`, tvgId: `adult${n}.test`, archive: false, adult: true });
  }
  for (let n = 1; n <= 30; n++) {
    films.push({ id: nextId++, cat: adultVod, name: `[X] Late Feature ${n}`, adult: true });
  }
}

/* ── the guide ──────────────────────────────────────────────────────────── */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
const dateTime = (ts) => stamp(ts).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A short, stable schedule: 6 hours back to 12 ahead, one-hour programmes. */
function schedule(channel) {
  const hour = 3600;
  const first = Math.floor(NOW / hour) * hour - 6 * hour;
  const out = [];
  for (let k = 0; k < 18; k++) {
    const start = first + k * hour;
    out.push({ start, stop: start + hour, title: `${channel.name} Show ${k + 1}`, desc: `Programme ${k + 1} on ${channel.name}.` });
  }
  return out;
}

function listings(streamId) {
  const channel = live.find((c) => c.id === streamId);
  if (channel === undefined) return [];
  return schedule(channel).map((p) => ({
    title: b64(p.title),
    description: b64(p.desc),
    start: dateTime(p.start),
    end: dateTime(p.stop),
    start_timestamp: String(p.start),
    stop_timestamp: String(p.stop),
    now_playing: p.start <= NOW && NOW < p.stop ? 1 : 0,
    has_archive: channel.archive && p.stop <= NOW ? 1 : 0,
  }));
}

function xmltv() {
  const parts = ['<?xml version="1.0" encoding="utf-8" ?><tv generator-info-name="fake-panel">'];
  for (const c of live) {
    parts.push(`<channel id="${esc(c.tvgId)}"><display-name>${esc(c.name)}</display-name></channel>`);
  }
  for (const c of live) {
    for (const p of schedule(c)) {
      parts.push(`<programme start="${stamp(p.start)} +0000" stop="${stamp(p.stop)} +0000" channel="${esc(c.tvgId)}">`
        + `<title lang="en">${esc(p.title)} (guide file)</title><desc lang="en">${esc(p.desc)}</desc></programme>`);
    }
  }
  parts.push('</tv>');
  return parts.join('');
}

/* ── Xtream rows ────────────────────────────────────────────────────────── */

const origin = (req) => `http://${req.headers.host ?? `${HOST}:${port}`}`;

const liveRow = (c, n, base) => ({
  num: n + 1,
  name: c.name,
  stream_type: 'live',
  stream_id: c.id,
  stream_icon: `${base}/logo/${c.id}.png`,
  epg_channel_id: c.tvgId,
  added: String(NOW - 86400),
  category_id: c.cat.id,
  /* Strings, not booleans: real panels send "1"/"0" and the coercion layer
     exists because of it. */
  tv_archive: c.archive ? 1 : 0,
  tv_archive_duration: c.archive ? 3 : 0,
  is_adult: c.adult ? '1' : '0',
  direct_source: '',
});

const vodRow = (f, n, base) => ({
  num: n + 1,
  name: f.name,
  stream_type: 'movie',
  stream_id: f.id,
  stream_icon: `${base}/logo/${f.id}.png`,
  year: '',
  rating: 6 + (f.id % 4),
  added: String(NOW - 86400 * (f.id % 90)),
  category_id: f.cat.id,
  container_extension: 'mp4',
  is_adult: f.adult ? '1' : '0',
  direct_source: '',
});

const seriesRow = (s, n, base) => ({
  num: n + 1,
  name: s.name,
  series_id: s.id,
  cover: `${base}/logo/${s.id}.png`,
  plot: `${s.name}: a generated series.`,
  cast: 'Ada Example, Alan Sample',
  director: '',
  genre: s.cat.group,
  releaseDate: String(2005 + (s.id % 18)),
  rating: 7,
  last_modified: String(NOW - 86400),
  backdrop_path: [],
  category_id: s.cat.id,
});

function seriesInfo(id, base) {
  const s = series.find((x) => x.id === Number(id));
  const episodes = {};
  for (const season of [1, 2, 10]) {
    episodes[String(season)] = Array.from({ length: 4 }, (_, k) => ({
      id: String(Number(id) * 100 + season * 10 + k + 1),
      episode_num: k + 1,
      title: `S${season}E${k + 1}`,
      container_extension: 'mp4',
      season,
      info: { plot: 'A generated episode.', duration_secs: 12, duration: '00:00:12', movie_image: `${base}/logo/${id}.png` },
    }));
  }
  return {
    info: { name: s?.name ?? '', cover: `${base}/logo/${id}.png`, plot: 'A generated series.', genre: s?.cat.group ?? '', rating: 7 },
    seasons: [],
    episodes,
  };
}

function vodInfo(id, base) {
  const f = films.find((x) => x.id === Number(id));
  return {
    info: {
      movie_image: `${base}/logo/${id}.png`, plot: 'A generated film.', genre: f?.cat.group ?? '',
      duration_secs: 12, duration: '00:00:12', rating: 7,
      video: { codec_name: 'h264' }, audio: { codec_name: 'aac' },
    },
    movie_data: { stream_id: Number(id), name: f?.name ?? '', container_extension: 'mp4' },
  };
}

function auth() {
  const exp = EXPIRED ? NOW - 2 * 86400 : NOW + 365 * 86400;
  return {
    user_info: {
      username: 'demo', password: 'demo', auth: 1,
      status: EXPIRED ? 'Expired' : 'Active',
      exp_date: String(exp), is_trial: '0', active_cons: '0', max_connections: '2',
      allowed_output_formats: ['ts', 'm3u8'],
    },
    server_info: {
      /* Left blank on purpose: a client must stay on the address it was given. */
      url: '', port: String(port), https_port: '', server_protocol: 'http',
      timezone: 'Europe/London', timestamp_now: NOW, time_now: new Date().toISOString(),
    },
  };
}

const catList = (list) => list.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));
const inCat = (rows, q) => (q.get('category_id') === null ? rows : rows.filter((r) => r.cat.id === q.get('category_id')));

const ACTIONS = {
  get_live_categories: () => catList(liveCats),
  get_vod_categories: () => catList(vodCats),
  get_series_categories: () => catList(seriesCats),
  get_live_streams: (q, b) => inCat(live, q).map((c, n) => liveRow(c, n, b)),
  get_vod_streams: (q, b) => inCat(films, q).map((f, n) => vodRow(f, n, b)),
  get_series: (q, b) => inCat(series, q).map((s, n) => seriesRow(s, n, b)),
  get_series_info: (q, b) => seriesInfo(q.get('series_id'), b),
  get_vod_info: (q, b) => vodInfo(q.get('vod_id'), b),
  get_short_epg: (q) => ({ epg_listings: listings(Number(q.get('stream_id'))) }),
  get_simple_data_table: (q) => ({ epg_listings: listings(Number(q.get('stream_id'))) }),
};

/* ── playlists ──────────────────────────────────────────────────────────── */

function playlist(base, withGuide) {
  const head = withGuide ? `#EXTM3U url-tvg="${base}/xmltv.php?username=demo&password=demo"` : '#EXTM3U';
  const lines = [head];
  live.forEach((c, i) => {
    lines.push(`#EXTINF:-1 tvg-id="${c.tvgId}" tvg-name="${c.name}" tvg-logo="${base}/logo/${c.id}.png" group-title="${c.cat.name}",${c.name}`);
    /* One channel carries player options, so the parser's header path is used. */
    if (i === 0) lines.push('#EXTVLCOPT:http-user-agent=FakePanelPlayer/1.0');
    lines.push(`${base}/stream/${c.id}.m3u8`);
  });
  return lines.join('\n');
}

/* ── generated logos ────────────────────────────────────────────────────── */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── the server ─────────────────────────────────────────────────────────── */

const renames = new Map();
let port = 0;

/** Serve bytes, honouring Range the way a content server does. */
function sendBytes(req, res, body, type) {
  const head = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range === null) {
    res.writeHead(200, { ...head, 'content-length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const start = range[1] === '' ? 0 : Number(range[1]);
  const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
  if (start > end) {
    res.writeHead(416, { ...head, 'content-range': `bytes */${body.length}` });
    return res.end();
  }
  res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}` });
  return res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
}

const server = createServer((req, res) => {
  const base = origin(req);
  const u = new URL(req.url, base);
  const send = (body, type = 'application/json', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'access-control-allow-origin': '*', ...extra });
    res.end(buf);
  };
  const missing = () => {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end('no');
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    });
    return res.end();
  }

  if (u.pathname === '/player_api.php') {
    const action = u.searchParams.get('action');
    if (action === null) return send(auth());
    const fn = ACTIONS[action];
    /* An unknown action answers `[]`, not 404: the client retries a 404 with
       backoff, which would turn a typo here into a stall that looks like a fault. */
    const rows = fn ? fn(u.searchParams, base) : [];
    if (Array.isArray(rows) && action === 'get_live_streams') {
      for (const r of rows) if (renames.has(r.stream_id)) r.name = renames.get(r.stream_id);
    }
    return send(rows);
  }

  if (u.pathname === '/xmltv.php' || u.pathname === '/xmltv.xml') return send(xmltv(), 'application/xml');
  /* A guide file that is only NAMED .gz — no Content-Encoding, so nothing
     undoes it for the client. */
  if (u.pathname === '/xmltv.xml.gz') return send(gzipSync(xmltv()), 'application/gzip');
  /* The same file with the header a CDN would add. */
  if (u.pathname === '/xmltv-ce.xml') return send(gzipSync(xmltv()), 'application/xml', { 'content-encoding': 'gzip' });

  if (u.pathname === '/playlist.m3u') return send(playlist(base, true), 'audio/x-mpegurl');
  if (u.pathname === '/playlist-noguide.m3u') return send(playlist(base, false), 'audio/x-mpegurl');
  if (u.pathname === '/get.php') return send(playlist(base, true), 'audio/x-mpegurl');

  /* An endless test channel: a sliding window of segments, all the same two
     seconds of pattern, each marked as a discontinuity so the player does not
     expect their timestamps to continue. */
  const hls = /^\/stream\/(\d+)\.m3u8$/.exec(u.pathname);
  if (hls) {
    const seq = Math.floor(Date.now() / 2000);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${seq}`];
    for (let k = 0; k < 4; k++) {
      lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:2.0,', `/stream/${hls[1]}/${seq + k}.ts`);
    }
    return send(lines.join('\n'), 'application/vnd.apple.mpegurl', { 'cache-control': 'no-store' });
  }
  if (/^\/stream\/\d+\/\d+\.ts$/.test(u.pathname) || /^\/stream\/\d+\.ts$/.test(u.pathname)) {
    return send(CLIP, 'video/mp2t');
  }

  /* Catch-up, both URL families a panel uses. */
  if (u.pathname === '/streaming/timeshift.php' || u.pathname.startsWith('/timeshift/')) {
    return sendBytes(req, res, CLIP, 'video/mp2t');
  }

  const media = /^\/(live|movie|series)\/[^/]+\/[^/]+\/(\d+)(\.\w+)?$/.exec(u.pathname);
  if (media) {
    if (media[1] === 'live') {
      /* The way a load balancer hands a player on. */
      const ext = media[3] === '.ts' ? 'ts' : 'm3u8';
      res.writeHead(302, { location: `/stream/${media[2]}.${ext}`, 'access-control-allow-origin': '*' });
      return res.end();
    }
    return sendBytes(req, res, FILM, 'video/mp4');
  }

  const logo = /^\/logo\/(\d+)\.png$/.exec(u.pathname);
  if (logo) {
    const n = Number(logo[1]);
    return send(solidPng(64, 64, [(n * 37) % 200 + 30, (n * 91) % 200 + 30, (n * 53) % 200 + 30]), 'image/png');
  }

  /* What a PPV feed does every day: same id, new name. */
  if (u.pathname === '/__rename') {
    const id = Number(u.searchParams.get('id'));
    if (!live.some((c) => c.id === id)) return missing();
    renames.set(id, u.searchParams.get('name') ?? '');
    return send(`renamed ${id}\n`, 'text/plain');
  }

  return missing();
});

server.listen(REQUESTED_PORT, HOST, () => {
  port = server.address().port;
  const url = `http://${HOST}:${port}`;
  console.log(`fake panel on ${url}`);
  console.log(`  ${live.length} live · ${films.length} films · ${series.length} series${ADULT ? ' (with adult rows)' : ''}`);
  console.log(`  Xtream:    ${url}   (any username and password, or http://demo:demo@${HOST}:${port})`);
  console.log(`  Playlist:  ${url}/playlist.m3u   (guide inside: url-tvg)   ${url}/playlist-noguide.m3u`);
  console.log(`  Guide:     ${url}/xmltv.xml   ${url}/xmltv.xml.gz   ${url}/xmltv-ce.xml`);
  console.log(`  Stream:    ${url}/stream/1000.m3u8`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
