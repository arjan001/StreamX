/**
 * A fixed-window counter per key, in memory.
 *
 * Enough for one process behind one reverse proxy: the two places that need it
 * (caption keys, admin sign-in) are low-volume and a restart forgetting the
 * counts is harmless. The map is swept when it grows so invented keys cannot
 * grow it for ever.
 */
export interface Limiter {
  /** Count one hit for `key`. False once `max` hits have landed inside the window. */
  hit(key: string, now?: number): boolean;
  /** Seconds until `key` may try again, 0 when it may now. */
  retryAfter(key: string, now?: number): number;
}

export function makeLimiter(max: number, windowMs: number): Limiter {
  const seen = new Map<string, { n: number; until: number }>();
  return {
    hit(key, now = Date.now()) {
      const h = seen.get(key);
      if (h === undefined || now > h.until) {
        seen.set(key, { n: 1, until: now + windowMs });
        if (seen.size > 5_000) for (const [k, v] of seen) if (now > v.until) seen.delete(k);
        return true;
      }
      if (h.n >= max) return false;
      h.n += 1;
      return true;
    },
    retryAfter(key, now = Date.now()) {
      const h = seen.get(key);
      return h === undefined || now > h.until || h.n < max ? 0 : Math.ceil((h.until - now) / 1000);
    },
  };
}
