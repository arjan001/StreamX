/**
 * How much live video to hold ahead of the playhead.
 *
 * Two layers, on purpose:
 *   • a global default (Settings › Playback) for every live channel
 *   • an optional per-channel override (player › Stream) — preset or a custom
 *     seconds value — for feeds that stall or that the viewer wants closer to live
 *
 * Engines only ever see a resolved `BufferProfile`. The named presets and the
 * custom slider both compile to that shape.
 */
import { kv } from './kv.ts';

export type BufferMode = 'minimal' | 'balanced' | 'smooth';

export interface BufferProfile {
  /** KB held before the demuxer starts; larger absorbs network jitter. */
  stashInitialSize: number;
  /** Lag the catch-up controller aims for, in seconds. */
  targetLag: number;
  /** Ceiling for the catch-up speed-up. 1 disables it for this profile. */
  maxRate: number;
  /** Seconds of video fetched ahead of the playhead (HLS path). */
  maxBufferS: number;
  /** Hard ceiling on the same, for a very low-bitrate stream. */
  maxMaxBufferS: number;
  /** Bytes allowed in the forward buffer regardless of seconds. */
  maxBufferBytes: number;
  label: string;
  hint: string;
}

/**
 * A stored choice: one of the named presets, or an explicit forward-buffer length.
 *
 * Custom is a seconds value only — stash, catch-up rate and byte cap are derived
 * so the UI stays one slider, not five knobs.
 */
export type BufferChoice =
  | { kind: 'preset'; mode: BufferMode }
  | { kind: 'custom'; seconds: number };

export const BUFFER_CUSTOM_MIN = 2;
export const BUFFER_CUSTOM_MAX = 90;

export const BUFFER_PROFILES: Record<BufferMode, BufferProfile> = {
  /*
   * Byte caps follow a reference IPTV app's rule of thumb (~2 MB/s of video): a
   * seconds-only ceiling is ignored by hls.js when maxBufferSize is hit first,
   * and the old 32–48 MB defaults alone exceeded a low-end TV's whole heap.
   */
  minimal: {
    stashInitialSize: 64, targetLag: 1.5, maxRate: 1.12,
    maxBufferS: 10, maxMaxBufferS: 20, maxBufferBytes: 8 * 1024 * 1024,
    label: 'Minimal',
    hint: 'Closest to live (~1-2s). Least RAM; can stall on a weak connection.',
  },
  balanced: {
    stashInitialSize: 384, targetLag: 3, maxRate: 1.08,
    maxBufferS: 20, maxMaxBufferS: 40, maxBufferBytes: 16 * 1024 * 1024,
    label: 'Balanced',
    hint: '~3s behind live. Catches up by playing fractionally faster, never by skipping.',
  },
  smooth: {
    stashInitialSize: 768, targetLag: 8, maxRate: 1.04,
    maxBufferS: 40, maxMaxBufferS: 80, maxBufferBytes: 24 * 1024 * 1024,
    label: 'Smooth',
    hint: '~8s behind live. Rides out jitter; use on an unstable connection.',
  },
};

const GLOBAL_KEY = 'iptv.bufferMode';
const CHANNEL_KEY = 'iptv.buffer.channels';
/** Cap so a long-lived install cannot grow an unbounded map. */
const CHANNEL_MAX = 200;

function read(key: string): string | null {
  try {
    return kv.get(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    kv.set(key, value);
  } catch {
    /* private mode */
  }
}

export function clampBufferSeconds(n: number): number {
  if (!Number.isFinite(n)) return BUFFER_CUSTOM_MIN;
  return Math.min(BUFFER_CUSTOM_MAX, Math.max(BUFFER_CUSTOM_MIN, Math.round(n)));
}

/** Compile a custom seconds value into the shape engines consume. */
export function customBufferProfile(seconds: number): BufferProfile {
  const s = clampBufferSeconds(seconds);
  /* Map 2..90s onto the same envelope the named presets span. */
  const t = (s - BUFFER_CUSTOM_MIN) / (BUFFER_CUSTOM_MAX - BUFFER_CUSTOM_MIN);
  const stash = Math.round(128 + t * (1024 - 128));
  /* The seconds ARE the lag: "40 seconds" means forty seconds in hand behind
     live. This mapped 40 onto 5.7, which is how a viewer set a big buffer and
     saw no difference at all. */
  const targetLag = s;
  const maxRate = Math.round((1.12 - t * 0.09) * 1000) / 1000;
  const mb = 4 + t * 28;
  return {
    stashInitialSize: stash,
    targetLag,
    maxRate,
    maxBufferS: s,
    maxMaxBufferS: Math.min(180, s * 2),
    maxBufferBytes: Math.round(mb * 1024 * 1024),
    label: `Custom (${s}s)`,
    hint: `Holds about ${s}s of video ahead. Higher survives jitter; lower stays closer to live.`,
  };
}

/**
 * How much to have in hand before a LIVE picture starts, in seconds.
 *
 * A forward buffer cannot fill on a live channel — it arrives at the rate it
 * plays — so a bigger "buffer" only exists if playback starts that far behind
 * and stays there. Minimal and Balanced start at once, as they always did;
 * Smooth and any custom length of four seconds or more wait for their reserve.
 * Capped for the WebView, whose buffer lives in the page's memory; libVLC takes
 * the full length (see `nativeCachingMs`).
 */
export const WEB_RESERVE_MAX_S = 30;
export function liveReserveS(p: BufferProfile): number {
  return p.targetLag >= 4 ? Math.min(WEB_RESERVE_MAX_S, p.targetLag) : 0;
}

/** libVLC's `network-caching` for a live stream: the profile's lag, 1.5s–60s. */
export function nativeCachingMs(p: BufferProfile): number {
  return Math.max(1500, Math.min(60_000, Math.round(p.targetLag * 1000)));
}

export function profileFromChoice(choice: BufferChoice): BufferProfile {
  return choice.kind === 'preset'
    ? BUFFER_PROFILES[choice.mode]
    : customBufferProfile(choice.seconds);
}

export function encodeBufferChoice(c: BufferChoice): string {
  return c.kind === 'preset' ? c.mode : `custom:${clampBufferSeconds(c.seconds)}`;
}

export function parseBufferChoice(raw: string | null | undefined): BufferChoice | null {
  if (raw == null || raw === '') return null;
  if (raw === 'minimal' || raw === 'balanced' || raw === 'smooth') {
    return { kind: 'preset', mode: raw };
  }
  const m = /^custom:(\d+)$/.exec(raw);
  if (m) return { kind: 'custom', seconds: clampBufferSeconds(Number(m[1])) };
  return null;
}

export function getGlobalBufferChoice(): BufferChoice {
  return parseBufferChoice(read(GLOBAL_KEY)) ?? { kind: 'preset', mode: 'minimal' };
}

export function setGlobalBufferChoice(c: BufferChoice): void {
  write(GLOBAL_KEY, encodeBufferChoice(c));
}

/** @deprecated Prefer getGlobalBufferChoice — kept for callers that only know presets. */
export function getBufferMode(): BufferMode {
  const c = getGlobalBufferChoice();
  return c.kind === 'preset' ? c.mode : 'balanced';
}

/** @deprecated Prefer setGlobalBufferChoice. */
export function setBufferMode(m: BufferMode): void {
  setGlobalBufferChoice({ kind: 'preset', mode: m });
}

function channelMap(): Record<string, string> {
  try {
    const raw = read(CHANNEL_KEY);
    if (raw == null || raw === '') return {};
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && parseBufferChoice(val) !== null) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function writeChannelMap(map: Record<string, string>): void {
  write(CHANNEL_KEY, JSON.stringify(map));
}

/** Per-channel override, or null to inherit the global default. */
export function getChannelBufferChoice(channelKey: string): BufferChoice | null {
  if (channelKey === '') return null;
  return parseBufferChoice(channelMap()[channelKey] ?? null);
}

export function setChannelBufferChoice(channelKey: string, choice: BufferChoice | null): void {
  if (channelKey === '') return;
  const map = channelMap();
  if (choice === null) {
    delete map[channelKey];
  } else {
    map[channelKey] = encodeBufferChoice(choice);
    const keys = Object.keys(map);
    if (keys.length > CHANNEL_MAX) {
      /* Drop oldest insertion order entries until under the cap. */
      for (const k of keys.slice(0, keys.length - CHANNEL_MAX)) delete map[k];
    }
  }
  writeChannelMap(map);
}

/**
 * Profile that applies right now: channel override if set, otherwise global.
 *
 * Pass the same `key` handed to `player.load` (`1.<streamId>` / catalogue ref).
 */
export function resolveBufferProfile(channelKey?: string | null): BufferProfile {
  if (channelKey != null && channelKey !== '') {
    const over = getChannelBufferChoice(channelKey);
    if (over !== null) return profileFromChoice(over);
  }
  return profileFromChoice(getGlobalBufferChoice());
}

export function bufferChoiceLabel(c: BufferChoice): string {
  return profileFromChoice(c).label;
}
