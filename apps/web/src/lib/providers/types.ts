/**
 * What the app knows about a place to get television from.
 *
 * The kinds are genuinely different, not spellings of one thing: an Xtream panel
 * is an API with categories, films and series behind it; an M3U playlist is a
 * flat channel list with no VOD concept at all; a single stream is one address
 * that plays; a Stalker portal is a middleware API reached with a MAC address. Anything that treats them uniformly ends up pretending a playlist
 * has a Movies tab.
 */
export type ProviderKind = 'xtream' | 'm3u' | 'stream' | 'stalker';

/** Everything a Stalker session needs to skip the handshake next launch. */
export interface StalkerSessionRecord {
  readonly endpoint: string;
  readonly token: string;
  readonly random: string | null;
}

/** Kinds whose whole catalogue is a payload built on the device (no panel to ask). */
export function isPlaylistKind(kind: ProviderKind): boolean {
  return kind === 'm3u' || kind === 'stream';
}

export interface Provider {
  /**
   * Monotonic, never reused.
   *
   * Favourites, history and hidden lists are keyed by provider stream id; if a
   * deleted provider's id were handed to the next one, a viewer's favourites
   * would silently point at somebody else's channels.
   */
  readonly id: number;
  readonly kind: ProviderKind;
  /** What the viewer called it. Never the URL — see `store.ts`. */
  readonly name: string;
  /** Panel base for xtream, playlist address for m3u, the stream address for stream. */
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  /**
   * Xtream only: other hosts the SAME subscription answers on.
   *
   * A reseller hands out several lines for one account. They are not separate
   * subscriptions, they are one account reachable several ways — which is why
   * they live here rather than as sibling providers.
   */
  readonly hosts?: string[];
  /** M3U only: an XMLTV feed (.xml or .xml.gz), joined to channels on `tvg-id`. */
  readonly epgUrl?: string;
  /** M3U only: the guide addresses the playlist's own header named (`url-tvg`). */
  readonly headerGuideUrls?: string[];
  /**
   * Stalker only. `url` is the portal address; these identify the set-top box the
   * provider registered. All of them are secrets (`SECRET_FIELDS` in `store.ts`).
   * `username`/`password` are the portal's optional login.
   */
  readonly mac?: string;
  readonly serial?: string;
  readonly deviceId?: string;
  readonly deviceId2?: string;
  readonly signature?: string;
  /** Stalker only: the last handshake, so a launch need not repeat it. */
  readonly stalkerSession?: StalkerSessionRecord;
  /** False hides it without deleting the credentials. */
  readonly enabled: boolean;
  readonly addedAt: number;
}

/** What `authenticate()` told us last time, cached so a badge need not block. */
export interface Subscription {
  readonly status: string | null;
  readonly expiresAt: number | null;
  readonly trial: boolean;
  readonly activeConnections: number;
  readonly maxConnections: number | null;
  readonly allowedFormats: string[];
  readonly timezone: string | null;
  /** Which host actually answered, so playback and probes agree with the catalogue. */
  readonly host: string;
  readonly checkedAt: number;
}
