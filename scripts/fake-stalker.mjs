#!/usr/bin/env node
/**
 * Synthetic Stalker / Ministra portal for tests. SYNTHETIC data only.
 *
 *   node scripts/fake-stalker.mjs            # prints the URL, serves until killed
 *   import { startFakePortal } from './fake-stalker.mjs'   // port 0, in tests
 *
 * It checks what a real portal checks: the `mac` cookie on every request and a
 * `Bearer` token on everything after the handshake.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_MAC = '00:1A:79:00:00:01';

const GENRES = [
  { id: '*', title: 'All', alias: 'all', censored: 0 },
  { id: '1', title: 'News', alias: 'news', censored: 0 },
  { id: '2', title: 'Movies', alias: 'movies', censored: 0 },
  { id: '3', title: 'Adult', alias: 'adult', censored: 1 },
];

const CHANNELS = Array.from({ length: 10 }, (_, i) => {
  const id = 101 + i;
  const genre = i < 4 ? '1' : i < 8 ? '2' : '3';
  return {
    id: String(id), name: `Channel ${id}`, number: String(i + 1),
    logo: i % 2 ? `${id}.png` : `http://img.example.com/${id}.png`,
    cmd: `ffrt http://localhost/ch/${id}`, tv_genre_id: genre,
    // one channel flagged censored on its own, in a non-adult genre
    censored: i === 3 ? 1 : 0,
    tv_archive: i === 0 ? 1 : 0, archive_duration: i === 0 ? '48' : '0',
    xmltv_id: `ch${id}.example`,
  };
});

const MOVIES = Array.from({ length: 10 }, (_, i) => ({
  id: String(2001 + i), name: `Movie ${i + 1} (${2010 + i})`, o_name: `Movie ${i + 1}`,
  cmd: `/media/file_${2001 + i}.mpg`, category_id: i < 5 ? '1' : '2',
  screenshot_uri: `/screenshots/${2001 + i}.jpg`, description: 'A synthetic film.',
  rating_imdb: '7.5', year: String(2010 + i), time: '95', added: '2026-01-02 03:04:05',
  is_series: '0',
}));

const SERIES = [{
  id: '500', name: 'Synthetic Show', category_id: '1', cmd: '', is_series: '1',
  screenshot_uri: '/screenshots/500.jpg', description: 'Two seasons.', year: '2020',
}];

export async function startFakePortal(opts = {}) {
  const o = {
    endpoint: '/portal.php', mac: FAKE_MAC, pageSize: 4, allChannels: true, series: true,
    vod: true, login: null, ...opts,
  };
  const tokens = new Set();
  const log = [];
  let authed = new Set(); // tokens that completed do_auth when login is required
  let seq = 0;

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const js = (res, v) => send(res, 200, { js: v });
  const page = (res, list, p) => {
    const start = (p - 1) * o.pageSize;
    js(res, {
      total_items: String(list.length), max_page_items: String(o.pageSize),
      cur_page: String(p), selected_item: 0, data: list.slice(start, start + o.pageSize),
    });
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    log.push({ path: u.pathname, query: q, headers: { ...req.headers } });
    if (u.pathname !== o.endpoint) return send(res, 404, '<html>Not Found</html>', 'text/html');
    const cookie = decodeURIComponent(/(?:^|;\s*)mac=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '');
    if (cookie.toUpperCase() !== o.mac) return send(res, 200, 'Authorization failed.', 'text/plain');
    const { type, action } = q;

    if (type === 'stb' && action === 'handshake') {
      const token = `T${++seq}${Math.random().toString(16).slice(2, 10)}`;
      tokens.add(token);
      return js(res, { token, random: 'r' + seq });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !tokens.has(bearer)) return send(res, 401, 'Authorization failed.', 'text/plain');

    if (type === 'stb' && action === 'get_profile') {
      return js(res, { id: '1', name: 'Synthetic', status: 1, mac: o.mac });
    }
    if (type === 'stb' && action === 'do_auth') {
      if (o.login && q.login === o.login.username && q.password === o.login.password) {
        authed.add(bearer);
        return js(res, true);
      }
      return js(res, false);
    }
    if (o.login && !authed.has(bearer)) return send(res, 200, 'Authorization failed.', 'text/plain');

    const p = Math.max(1, Number(q.p) || 1);
    if (type === 'itv') {
      if (action === 'get_genres') return js(res, GENRES);
      if (action === 'get_all_channels') {
        return o.allChannels ? js(res, { data: CHANNELS }) : js(res, []);
      }
      if (action === 'get_ordered_list') {
        const list = q.genre && q.genre !== '*' ? CHANNELS.filter((c) => c.tv_genre_id === q.genre) : CHANNELS;
        return page(res, list, p);
      }
      if (action === 'create_link') {
        const id = /\/ch\/(\d+)/.exec(q.cmd ?? '')?.[1];
        if (!id) return js(res, { cmd: '' });
        return js(res, { cmd: `ffmpeg http://stream.example.com/live/${id}?token=${++seq}` });
      }
      if (action === 'get_short_epg') {
        const now = Math.floor(Date.now() / 1000);
        const n = Number(q.size) || 10;
        return js(res, Array.from({ length: n }, (_, i) => ({
          id: String(9000 + i), ch_id: q.ch_id, name: `Show ${i}`, descr: i ? '' : 'Now showing',
          start_timestamp: String(now - 600 + i * 1800), stop_timestamp: String(now + 1200 + i * 1800),
          time: '2026-01-01 10:00:00', time_to: '2026-01-01 10:30:00', mark_archive: i === 0 ? 1 : 0,
        })));
      }
      if (action === 'get_epg_info') {
        const now = Math.floor(Date.now() / 1000);
        return js(res, { data: { 101: [{ name: 'Guide A', start_timestamp: now - 60, stop_timestamp: now + 3600 }] } });
      }
    }
    if (type === 'tv_archive' && action === 'create_link') {
      return js(res, { cmd: 'ffmpeg http://stream.example.com/archive/1.m3u8' });
    }
    if (type === 'vod' && o.vod) {
      if (action === 'get_categories') {
        return js(res, [{ id: '1', title: 'Films', censored: 0 }, { id: '2', title: 'Kids', censored: 0 }]);
      }
      if (action === 'get_ordered_list') {
        return page(res, MOVIES.filter((m) => m.category_id === q.category), p);
      }
      if (action === 'create_link') {
        const file = /file_(\d+)/.exec(q.cmd ?? '')?.[1] ?? 'x';
        return js(res, { cmd: `http://stream.example.com/vod/${file}.mp4${q.series ? `?e=${q.series}` : ''}` });
      }
    }
    if (type === 'series' && o.series) {
      if (action === 'get_categories') return js(res, [{ id: '1', title: 'Shows', censored: 0 }]);
      if (action === 'get_ordered_list') {
        if (q.movie_id) {
          if (q.season_id === '0') {
            return page(res, [1, 2].map((n) => ({
              id: `${q.movie_id}:${n}`, name: `Season ${n}`, season_num: String(n), is_season: true,
            })), p);
          }
          const n = Number(q.season_id.split(':')[1]);
          return page(res, [{
            id: q.season_id, cmd: `/media/show_${q.movie_id}_s${n}.mpg`,
            series: n === 1 ? [1, 2, 3] : [1, 2], description: 'Season episodes',
          }], p);
        }
        return page(res, SERIES, p);
      }
    }
    // Unknown module or action: real portals answer with an HTML page.
    send(res, 200, '<html><body>Unknown</body></html>', 'text/html');
  });

  await new Promise((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    log,
    /** Invalidate every issued token: the next call 401s and must re-handshake. */
    revokeTokens: () => tokens.clear(),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portal = await startFakePortal({ port: Number(process.env.PORT) || 0 });
  console.log(`fake stalker portal: ${portal.url}  (MAC ${FAKE_MAC})`);
}
