import { api, linkId, type Item, type PlaybackTarget, type Variant } from './api.ts';
import { localPlay, localVariants } from './localRead.ts';
import { downlinkMbps, pickVariant as chooseFeed } from './liveQuality.ts';
import { getPrefs } from './prefs.ts';
import { subscription } from './providers/index.ts';

/**
 * Turn a channel row into something the player can open.
 *
 * Written once for every screen that plays live television — Live TV and Sports
 * TV — because the choices in it are not cosmetic and two copies drift:
 *
 *   * **Which feed.** A channel is often published several times (SD, HD, FHD,
 *     4K). The viewer's quality setting and the measured downlink pick one, the
 *     same way on every screen.
 *   * **Built on the device.** `localPlay` builds the stream URL from the
 *     catalogue and the credentials this device holds; nothing about playback
 *     asks our server.
 *   * **The codec hint.** A panel publishes no codec for a live channel, so the
 *     channel's own name is the only hint there is — `AR| BEIN SPORTS 7 HEVC`.
 *     A wrong guess costs one channel on the native surface instead of the page.
 *
 * The caller owns cancellation: check its own generation counter after the
 * await, exactly as `Live.open` did before this was lifted out of it.
 */
export interface ResolvedChannel {
  target: PlaybackTarget;
  /** The feed actually chosen — may differ from the row that was pressed. */
  chosen: { id: number; name: string; ref: string | null };
  /** Every feed of this channel; empty when the channel has only itself. */
  feeds: Variant[];
}

export async function resolveLiveTarget(item: Item, ext: 'ts' | 'm3u8'): Promise<ResolvedChannel> {
  const id = linkId(item);
  const pack = localVariants(id) ?? await api.variants(id);
  const feeds = pack.variants;
  const chosen = feeds.length > 0
    ? chooseFeed(feeds, getPrefs().liveQuality, downlinkMbps())
    : { id: item.id, name: item.name, ref: item.ref };
  const chosenId = linkId(chosen);
  const target = localPlay(chosenId, ext) ?? await api.play(chosenId, ext);
  if (target.codec == null && /hevc|h\.?265|ʰᵉᵛᶜ/i.test(item.name)) {
    target.codec = 'hevc';
  }
  return { target, chosen: { id: chosen.id, name: chosen.name, ref: chosen.ref ?? null }, feeds };
}

/**
 * The one failure a viewer can actually act on.
 *
 * Measured on the line this app was tested against: an account one day past its
 * `exp_date` still authenticates, still lists every channel, and answers every
 * stream with an EMPTY playlist — so the player reported "the panel did not
 * answer with a playable URL" for the whole catalogue, which reads as the app
 * being broken. The badge in the header knew the account had lapsed; the error
 * did not say so. This is the sentence that should come first whenever it is true.
 */
export function expiredHint(): string | null {
  const sub = subscription();
  if (sub === null) return null;
  const lapsed = (sub.status !== null && /expired|disabled|banned/i.test(sub.status))
    || (sub.expiresAt !== null && sub.expiresAt < Date.now());
  if (!lapsed) return null;
  const when = sub.expiresAt === null ? '' : ` on ${new Date(sub.expiresAt).toLocaleDateString()}`;
  return `This source's account expired${when}. The server still lists its channels but no longer plays them. Check with your provider, or add another source.`;
}
