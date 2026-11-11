/**
 * Which feed of a live channel to play.
 *
 * The panel publishes FHD / HD / HEVC / RAW as separate channels. Auto picks
 * from measured downlink (Mbps); a named quality is an explicit lock.
 */
import type { Variant } from './api';

export function downlinkMbps(): number | null {
  const c = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  if (!c || typeof c.downlink !== 'number' || !Number.isFinite(c.downlink)) return null;
  return c.downlink;
}

function baseQuality(label: string): string {
  return label.replace(/ RAW$/i, '').replace(/ #\d+$/, '');
}

function autoOrder(mbps: number | null): string[] {
  if (mbps !== null && mbps >= 18) {
    return ['4K', 'HEVC', 'FHD', 'HD', 'RAW', 'SD', 'VIP', 'SOURCE'];
  }
  if (mbps === null || mbps >= 6) {
    return ['HEVC', 'FHD', 'HD', '4K', 'RAW', 'SD', 'VIP', 'SOURCE'];
  }
  if (mbps >= 2.5) {
    return ['HD', 'HEVC', 'FHD', 'SD', 'RAW', 'VIP', 'SOURCE'];
  }
  return ['SD', 'HD', 'HEVC', 'FHD', 'RAW', 'VIP', 'SOURCE'];
}

export function pickVariant(
  variants: Variant[],
  want: string,
  mbps: number | null,
): Variant {
  if (variants.length === 0) {
    throw new Error('no feeds to pick from');
  }
  if (want !== 'auto') {
    const exact = variants.find((v) => v.quality === want);
    if (exact) return exact;
    const base = variants.find((v) => baseQuality(v.quality) === baseQuality(want));
    if (base) return base;
  }
  for (const label of autoOrder(want === 'auto' ? mbps : null)) {
    const hit = variants.find((v) => baseQuality(v.quality) === label);
    if (hit) return hit;
  }
  return variants[0]!;
}
