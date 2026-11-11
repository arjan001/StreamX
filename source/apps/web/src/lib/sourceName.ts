/**
 * What a source is called when its owner typed no name.
 *
 * "Playlist", "Playlist 2", "Server" told five sources apart by their type,
 * which is the one thing they all share. The address is what differs, so the
 * name comes from it: the host ("panel.example.com"), or for a single stream the
 * last part of its path ("news"), which says which stream it is. Never the query
 * string — that is where a viewer's own username and password live.
 *
 * No imports, so the store, the panel and the add form can all use it.
 */

/** The host, with its port when it has one: two servers on one machine differ by it. */
function hostOf(url: URL): string {
  return url.host.replace(/^www\./, '');
}

/** `typed` when it has text; else something distinguishing from the address. */
export function sourceName(
  typed: string | undefined,
  address: string,
  kind: 'xtream' | 'm3u' | 'stream' | 'stalker',
  taken: readonly string[] = [],
): string {
  const given = (typed ?? '').trim();
  if (given !== '') return given;
  let base = '';
  try {
    const u = new URL(address.trim());
    base = hostOf(u);
    if (kind === 'stream') {
      const last = u.pathname.split('/').filter((s) => s !== '').pop() ?? '';
      let seg = last;
      try { seg = decodeURIComponent(last); } catch { /* keep it as typed */ }
      seg = seg.replace(/\.(m3u8?|ts|mp4|mkv|mpd|php)$/i, '');
      if (seg !== '' && !/^(index|playlist|stream|live|master)$/i.test(seg)) base = seg;
    }
  } catch { /* not an address: fall through to the type */ }
  if (base === '') {
    base = kind === 'xtream' ? 'Server' : kind === 'm3u' ? 'Playlist' : kind === 'stalker' ? 'Portal' : 'Stream';
  }
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }
}
