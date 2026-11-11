/**
 * Somewhere for a television to report from.
 *
 * A set-top box has no console, no devtools and nobody standing in front of it
 * when it fails. Until now the only thing that ever reached this box from a
 * client was a presence heartbeat, so "it stopped playing last night" had no
 * evidence behind it at all — which is the half of "config and logs" that did not
 * exist yet.
 *
 * ── what this is not ──
 *
 * It is not analytics and it is not a session log. It takes what the app decided
 * was worth reporting — a playback failure, a catalogue download that gave up, an
 * engine that could not decode — and keeps it for a week. Nothing here records
 * what somebody watched; the roster already answers "what is on now" and does it
 * in one row per device that is overwritten rather than appended.
 *
 * ── what must never arrive ──
 *
 * A provider URL carries a subscription's username and password in its query
 * string or its path. The client redacts before sending (`providers/store.ts`),
 * and this redacts again on the way in, because one of those two will be wrong
 * eventually and a credential in a log file is a credential that has leaked.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from './db/pool.ts';

/** A week. Long enough to look into a report, short enough not to be a record. */
const KEEP_DAYS = 7;

/**
 * Per device, per minute, counted in ROWS rather than requests.
 *
 * A client in a crash loop must not become the load, and since `/api/log/batch`
 * arrived one request is no longer one line: a flush carries up to
 * `MAX_BATCH_ROWS` of them. Charging per row is the only version of this budget
 * that means the same thing on both routes — a device cannot buy itself thirty
 * times the allowance by posting them together.
 *
 * Sixty rather than the original twenty because the automatic reporter exists
 * now: it folds repeats before sending and flushes every few minutes, so sixty
 * lines a minute is far above anything it produces and still bounds a broken
 * client to something this box does not notice.
 */
const BURST = 60;
const WINDOW_MS = 60_000;
const seen = new Map<string, { n: number; until: number }>();

/**
 * The most lines one flush may carry.
 *
 * The client caps its own queue at the same number (`errorReports.ts`), so this
 * is the second half of one rule rather than a different one. A television that
 * produces more than thirty DISTINCT errors in a flush window is not going to be
 * diagnosed from line thirty-one.
 */
const MAX_BATCH_ROWS = 30;

const LEVELS = new Set(['error', 'warn', 'info']);

/**
 * Strip anything that identifies a subscription.
 *
 * The same rule as the client's `redact`, applied again here. Belt and braces on
 * purpose: these two will disagree one day, and the safe direction to be wrong in
 * is "redacted twice".
 */
/*
 * One separator, two spellings.
 *
 * A provider path puts the credentials between slashes — `/movie/<user>/<pass>/…`
 * — and the rule for that was written for literal slashes. The app then grew a
 * relay: when a television cannot fetch a film itself, the URL is handed to this
 * box as a QUERY PARAMETER, and a query parameter is percent-encoded. So the same
 * credentials came back as
 *
 *     /api/relay?u=http%3A%2F%2Fhost%2Fmovie%2F<user>%2F<pass>%2F123.mp4
 *
 * and nothing matched: there is not a single `/` between `movie` and the id.
 *
 * Photographed twice off a television, in the app's own debug panel, which is the
 * screen a viewer is invited to send to support. So the separator is now either
 * spelling, and a segment is anything that is not one.
 */
const SEP = '(?:\\/|%2[Ff])';
const SEG = `(?:(?!${SEP})[^\\s])+`;
const CREDS = new RegExp(`${SEP}(live|movie|series|timeshift)${SEP}${SEG}${SEP}${SEG}${SEP}`, 'gi');

export function redact(text: string): string {
  return text
    .replace(/([?&](?:username|password|pass|user|token|mac|serial|sn|device_?id|key|auth)=)[^&\s]*/gi, '$1<redacted>')
    /* The same pair, percent-encoded, which is how they arrive inside `?u=`. */
    .replace(/((?:username|password|pass|user|token|mac|serial|sn|device_?id|key|auth)%3D)(?:(?!%26)[^&\s])*/gi, '$1<redacted>')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@')
    /* The Xtream path form: /live/<user>/<pass>/<id>.ext — credentials as path
       segments, which no query-string rule would catch, in either spelling of
       the separator. */
    .replace(CREDS, '/$1/<redacted>/<redacted>/');
}

function allowed(deviceId: string, now: number, cost = 1): boolean {
  const hit = seen.get(deviceId);
  if (hit === undefined || now > hit.until) {
    seen.set(deviceId, { n: cost, until: now + WINDOW_MS });
    /* Bounded, so a stream of invented device ids cannot grow this map for ever. */
    if (seen.size > 5_000) {
      for (const [k, v] of seen) if (now > v.until) seen.delete(k);
    }
    return true;
  }
  if (hit.n >= BURST) return false;
  hit.n += cost;
  return true;
}

/* ── what a flush is allowed to be ─────────────────────────────────────────── */

/** One stored line, already validated and clamped. Exported for the test. */
export interface BatchRow {
  level: string;
  message: string;
  context: string;
}

/**
 * Turn a flush body into rows, or refuse it.
 *
 * Pure, and separate from the route, because everything that can go wrong here
 * is a shape rather than a database: a client on an old build sending a field
 * this one does not have, a `level` that is not one, a text long enough to be a
 * denial of service, a `count` that arrived as a string. The route below is then
 * three lines of plumbing around it.
 *
 * Every message is prefixed with its tag — `player`, `native`, `fetch`, `page`,
 * `console` — because the admin screen groups on the first ninety characters and
 * the tag is the first thing that separates "the decoder refused" from "a request
 * did not come back".
 */
export function batchRows(raw: unknown, device: Record<string, unknown> | null): BatchRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: BatchRow[] = [];
  for (const item of raw.slice(0, MAX_BATCH_ROWS)) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const text = String(e['text'] ?? '').trim();
    if (text === '') continue;
    const tag = String(e['tag'] ?? '').trim().slice(0, 24) || 'app';
    const level = LEVELS.has(String(e['level'])) ? String(e['level']) : 'error';
    /* How many times this same line happened inside the window. The client folds
       repeats rather than sending each one, so a loop costs one row and still
       says how big the loop was. */
    const n = Math.min(Math.max(Math.trunc(Number(e['count'] ?? 1)) || 1, 1), 9_999);
    /* How long before the flush it happened. The client's own clock is not
       trusted for `at` — a television with the wrong date would file its errors
       in the wrong week — so the age is carried as a number of seconds and the
       row is stamped by this box. */
    const ago = Math.min(Math.max(Math.trunc(Number(e['ago'] ?? 0)) || 0, 0), 86_400);
    rows.push({
      level,
      message: redact(`${tag}: ${text}`).slice(0, 2_000),
      context: JSON.stringify({
        auto: true, tag, count: n, agoSeconds: ago,
        ...(device === null ? {} : { device }),
      }).slice(0, 4_000),
    });
  }
  return rows;
}

let sweptAt = 0;

export function registerLog(app: FastifyInstance): void {
  app.post<{
    Body: {
      deviceId?: string; level?: string; message?: string;
      context?: Record<string, unknown> | null;
      version?: string; platform?: string;
    };
  }>('/api/log', async (req, reply) => {
    const b = req.body ?? {};
    const deviceId = String(b.deviceId ?? '').slice(0, 64);
    const message = String(b.message ?? '').trim();
    if (deviceId === '' || message === '') return reply.code(400).send({ error: 'bad request' });

    const now = Date.now();
    if (!allowed(deviceId, now)) {
      /* 202, not 429. A client that is failing should not also have to handle
         being told off for saying so; it has nothing useful to do with the
         refusal and retrying would make it worse. */
      return reply.code(202).send({ ok: true, dropped: true });
    }

    const level = LEVELS.has(String(b.level)) ? String(b.level) : 'error';
    await pool.query(
      `INSERT INTO client_log (device_id, level, message, context, app_version, platform)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        deviceId, level,
        redact(message).slice(0, 2_000),
        b.context == null ? null : JSON.stringify(b.context).slice(0, 4_000),
        String(b.version ?? '').slice(0, 32) || null,
        String(b.platform ?? '').slice(0, 32) || null,
      ],
    );

    sweep(now);
    return { ok: true };
  });

  /**
   * A handful of errors at once, sent by the app rather than by a person.
   *
   * ── why a second route ──
   *
   * `/api/log` above is one report that somebody chose to send: it carries a
   * whole debug buffer in `context` and it is worth a row of its own. This is the
   * opposite shape — many small lines, none of them chosen, arriving on a timer
   * from a device nobody is standing in front of. Squeezing that through the
   * single-report route would mean one HTTP request per failure from a television
   * that is failing, which is the one moment to ask least of it.
   *
   * ── what it stores ──
   *
   * One row per DISTINCT error, not one per flush. The admin screen already
   * groups reports by message and counts devices (`/api/admin/logs`), and that
   * grouping is the view anybody actually reads; a flush stored as a single blob
   * would be invisible to it. Repeats are folded by the client before they are
   * sent, so a set-top box in a loop is one row with a count rather than four
   * hundred rows.
   *
   * ── what still cannot arrive ──
   *
   * The same redaction as everything else, applied in `batchRows`. The client
   * redacts first; this is the second pass, on the stated grounds that one of the
   * two will be wrong eventually.
   */
  app.post<{
    Body: {
      deviceId?: string;
      entries?: unknown;
      device?: Record<string, unknown> | null;
      version?: string; platform?: string;
    };
  }>('/api/log/batch', async (req, reply) => {
    const b = req.body ?? {};
    const deviceId = String(b.deviceId ?? '').slice(0, 64);
    if (deviceId === '') return reply.code(400).send({ error: 'bad request' });

    const rows = batchRows(b.entries, b.device ?? null);
    if (rows.length === 0) return { ok: true, stored: 0 };

    const now = Date.now();
    /* 202 rather than 429, for the reason the single route gives: a client that
       is failing should not also have to handle being told off for saying so. */
    if (!allowed(deviceId, now, rows.length)) {
      return reply.code(202).send({ ok: true, stored: 0, dropped: rows.length });
    }

    const version = String(b.version ?? '').slice(0, 32) || null;
    const platform = String(b.platform ?? '').slice(0, 32) || null;
    /*
     * One statement, however many lines. `unnest` expands the arrays into rows
     * server-side, so a flush of thirty is a single round trip rather than thirty
     * — which matters here because these arrive from every television at once
     * rather than from one person pressing a button.
     */
    await pool.query(
      `INSERT INTO client_log (device_id, level, message, context, app_version, platform)
       SELECT $1, l, m, c::jsonb, $5, $6
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(l, m, c)`,
      [
        deviceId,
        rows.map((r) => r.level),
        rows.map((r) => r.message),
        rows.map((r) => r.context),
        version, platform,
      ],
    );

    sweep(now);
    return { ok: true, stored: rows.length };
  });
}

/* Swept on writes as well as on a timer. The timer (`startRetention`) is what
   keeps the seven-day promise when reports stop arriving, for instance after the
   operator switches error reports off: a table nobody writes to would otherwise
   keep its last week for ever. At most once an hour either way. */
function sweep(now: number): void {
  if (now - sweptAt <= 3_600_000) return;
  sweptAt = now;
  void purgeOld();
}

/** Delete every report older than the retention. Returns how many went. */
export async function purgeOld(): Promise<number> {
  try {
    const r = await pool.query(`DELETE FROM client_log WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    return r.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** Purge now and then hourly. The timer does not keep the process alive. */
export function startRetention(): void {
  void purgeOld();
  setInterval(() => { void purgeOld(); }, 3_600_000).unref();
}
