/**
 * Playing from a Stalker portal.
 *
 * A portal row is a `cmd`, not a URL. `create_link` turns it into a link with a
 * token inside, valid for a short while and for one viewer — so the link is
 * asked for immediately before playback, every time, and handed to the player
 * together with a way to ask again (`reresolve`). The player calls that once
 * when the first link fails to open: a link that expired between the answer and
 * the first byte is the commonest reason a portal channel "does nothing".
 *
 * Nothing in this file stores a link.
 */
import { Kind } from '@iptv/core-xtream';
import type { ArchiveTarget, PlaybackTarget } from './api.ts';
import { localItem } from './localRead.ts';
import { episodeRef, stalkerRefFor } from './playSide.ts';
import { stalkerMessage, withStalker } from './providers/index.ts';

/** What the player needs to know about a link it has no extension for. */
export function containerOf(url: string, live: boolean): PlaybackTarget['container'] {
  const lower = url.toLowerCase().split('?')[0] ?? '';
  if (lower.includes('.m3u8')) return 'hls';
  if (lower.endsWith('.ts') || live) return 'mpegts';
  return 'file';
}

function targetOf(url: string, live: boolean): PlaybackTarget {
  return { url, container: containerOf(url, live), direct: true, notes: [] };
}

/** Ask the portal, then say so in words if it will not. */
async function ask<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) { throw new Error(stalkerMessage(err)); }
}

/**
 * A channel or film, resolved now. `reresolve` asks the portal again for a
 * fresh link and is what the player runs once on an open error.
 */
export async function stalkerPlay(id: number | string): Promise<PlaybackTarget> {
  const item = localItem(id);
  const ref = item === null ? null : stalkerRefFor(item.kind, item.streamId);
  if (item === null || ref === null) throw new Error('This item is not on the portal any more. Refresh the source.');
  const live = item.kind === Kind.Live;
  const resolve = async (): Promise<PlaybackTarget> => {
    const url = await ask(() => withStalker((c) => (live ? c.resolveLiveUrl(ref) : c.resolveVodUrl(ref))));
    return targetOf(url, live);
  };
  return { ...(await resolve()), reresolve: resolve };
}

/** One episode: its `cmd` and the `series=` value were remembered when the series was opened. */
export async function stalkerEpisodePlay(episodeId: number): Promise<PlaybackTarget> {
  const ref = episodeRef(episodeId);
  if (ref === null) throw new Error('Open the series again, then choose the episode.');
  const resolve = async (): Promise<PlaybackTarget> => {
    const url = await ask(() => withStalker((c) => c.resolveVodUrl({ cmd: ref.cmd }, ref.seriesParam)));
    return targetOf(url, false);
  };
  return { ...(await resolve()), reresolve: resolve };
}

/**
 * Catch-up. UNVERIFIED against a real portal: `core-stalker` documents that the
 * archive `cmd` shape is a guess. It is only attempted for a channel that says it
 * keeps an archive (`localArchivePlay` applies the same gate Xtream catch-up uses, first), and a refusal reads as
 * what it is rather than as an app fault.
 */
export function archiveCmd(remoteId: string, startTs: number): string {
  return `auto /media/archive/${remoteId}/${Math.floor(startTs)}.mpg`;
}

export async function stalkerArchivePlay(
  itemId: number | string, startTs: number, stopTs: number,
): Promise<ArchiveTarget | null> {
  const item = localItem(itemId);
  const ref = item === null ? null : stalkerRefFor(item.kind, item.streamId);
  if (item === null || ref === null) return null;
  const minutes = Math.max(1, Math.round((stopTs - startTs) / 60));
  const resolve = async (): Promise<ArchiveTarget> => {
    const url = await ask(() => withStalker((c) => c.resolveArchiveUrl(archiveCmd(ref.remoteId, startTs))));
    return {
      ...targetOf(url, false),
      container: containerOf(url, true),
      notes: [`archive: ${minutes} min from the portal`],
      isLive: false,
      minutes,
    };
  };
  return { ...(await resolve()), reresolve: resolve };
}
