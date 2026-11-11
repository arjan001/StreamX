/**
 * Keep this service's own pm2 log from filling the disk.
 *
 * ── the measurement that made this necessary ──
 *
 * On 2026-09-23 `/tmp/iptv-pm2-out.log` was **2.3 GB** on a root filesystem at
 * 88%. Seventy per cent of it was one client: an admin console left open with
 * a token the server no longer accepted, reconnecting to `/api/admin/ws` every
 * four seconds and costing two log lines an attempt, for days. Both ends of
 * that are fixed — the console backs off now, the route logs at `warn` — but a
 * log with no ceiling is a disk waiting for the next such loop, and the next
 * one will be something nobody predicted.
 *
 * ── why not pm2-logrotate ──
 *
 * It is a pm2 MODULE: installing it changes how all twenty-eight services on
 * this box write their logs, several of which belong to other people and one
 * of which has 4.4 GB of its own. That is not a decision this repository gets
 * to make on their behalf. This rotates one file — the one named in this
 * repository's own `ecosystem.config.cjs` — and touches nothing else.
 *
 * ── why truncating in place is safe ──
 *
 * pm2 holds the file open in append mode. An `O_APPEND` write always goes to
 * the current end, so shortening the file underneath it moves where the next
 * line lands and loses nothing in flight. Renaming it would NOT be safe: pm2
 * would go on writing to the renamed inode and the new file would stay empty
 * until a restart, which is the classic way a log "stops working" after a
 * rotation nobody tested.
 */
import { open, stat, truncate } from 'node:fs/promises';

/** Rotate when it passes this. */
const CEILING = 128 * 1024 * 1024;

/** How much of the tail to keep — enough to still be able to read what happened. */
const KEEP = 16 * 1024 * 1024;

/** How often to look. Cheap: one `stat` unless it is over. */
const EVERY_MS = 60 * 60 * 1000;

/** Trim one file to its last `KEEP` bytes. Returns what it did, for the log. */
export async function rotateOnce(
  path: string,
  ceiling = CEILING,
  keep = KEEP,
): Promise<{ was: number; now: number } | null> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return null; /* not there yet, or not ours */
  }
  if (size <= ceiling) return null;

  /* Read the tail BEFORE shortening anything, so a failure anywhere below
     leaves the file exactly as it was. */
  const tail = Buffer.alloc(Math.min(keep, size));
  const fd = await open(path, 'r');
  try {
    await fd.read(tail, 0, tail.length, size - tail.length);
  } finally {
    await fd.close();
  }

  /* Start at the first whole line, so the file never opens mid-JSON. */
  const nl = tail.indexOf(0x0a);
  const body = nl >= 0 && nl + 1 < tail.length ? tail.subarray(nl + 1) : tail;

  const w = await open(path, 'r+');
  try {
    await w.write(body, 0, body.length, 0);
  } finally {
    await w.close();
  }
  await truncate(path, body.length);
  return { was: size, now: body.length };
}

/**
 * Watch this service's own logs for as long as it runs.
 *
 * `unref`, so a log check is never the reason the process stays alive.
 */
export function watchLogs(
  paths: string[],
  say: (msg: string) => void,
  everyMs = EVERY_MS,
): () => void {
  let stopped = false;
  const sweep = async (): Promise<void> => {
    for (const p of paths) {
      try {
        const did = await rotateOnce(p);
        if (did !== null) {
          say(`log rotated: ${p} ${Math.round(did.was / 1048576)}MB -> ${Math.round(did.now / 1048576)}MB`);
        }
      } catch (e) {
        say(`log rotation failed for ${p}: ${String((e as Error)?.message ?? e)}`);
      }
    }
  };
  void sweep();
  const timer = setInterval(() => { if (!stopped) void sweep(); }, everyMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
