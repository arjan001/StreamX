/**
 * The operator's side of the box.
 *
 * Asked for as: "make an admin area — for now just a user and password in the env
 * that are changeable, and there is no hash, OK, so it's OK — and a proper admin
 * area and a proper app config as well".
 *
 * ── the credentials ──
 *
 * `ADMIN_USERNAME` and `ADMIN_PASSWORD`, in plain text in `.env`, compared
 * directly. That is a deliberate choice the operator made, and the honest thing
 * is to say exactly what it does and does not give you rather than to dress it up:
 *
 *  - Anyone who can read `.env` on this box is already the operator.
 *  - Anyone who can read the TLS traffic can read the password. The site is
 *    HTTPS, so that means "anyone with the server", which is the same person.
 *  - There is no reset flow, no lockout beyond the rate limit below, and no audit
 *    of who logged in. If this ever guards more than one household, it needs
 *    replacing rather than patching.
 *
 * What it does NOT do is ship an unchangeable default: with no `ADMIN_PASSWORD`
 * set, admin is switched off entirely rather than falling back to "admin/admin".
 * A default credential is a published credential.
 *
 * The comparison is still constant-time and still rate-limited. Those cost two
 * lines and remove the two attacks that work against a plain-text password over a
 * network; skipping them would be laziness rather than simplicity.
 *
 * ── sessions ──
 *
 * A random 32-byte token, in memory, eight hours. Not a hash of anything and not
 * a cookie: the admin screen holds it and sends it as a header. In-memory means a
 * restart signs everyone out, which for one operator on one box is a feature.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db/pool.ts';
import { BRAND } from './brand.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_TTL_MS = 8 * 3600_000;
const tokens = new Map<string, number>();

const WINDOW_MS = 60_000;
const MAX_TRIES = 8;
const tries = new Map<string, { n: number; until: number }>();

function throttled(ip: string, now = Date.now()): boolean {
  const rec = tries.get(ip);
  if (rec === undefined || now > rec.until) {
    tries.set(ip, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  rec.n += 1;
  return rec.n > MAX_TRIES;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function issue(): string {
  const t = randomBytes(32).toString('base64url');
  tokens.set(t, Date.now() + TOKEN_TTL_MS);
  // Swept here rather than on a timer, for the same reason as the sign-in limiter.
  for (const [k, exp] of tokens) if (exp < Date.now()) tokens.delete(k);
  return t;
}

export function tokenValid(token: string, now = Date.now()): boolean {
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < now) { tokens.delete(token); return false; }
  return true;
}

function adminCredentials(): { username: string; password: string } | null {
  const username = process.env['ADMIN_USERNAME'] ?? '';
  const password = process.env['ADMIN_PASSWORD'] ?? '';
  // No password configured means admin is OFF, not "admin/admin".
  return password === '' ? null : { username: username === '' ? 'admin' : username, password };
}

/* ── the config document ──────────────────────────────────────────────────── */

/**
 * What an operator can change without a deploy.
 *
 * Every field is optional and every reader supplies its own default, so an empty
 * document is a valid one and a field added later does not break an older client.
 */
export interface AppConfig {
  /**
   * The oldest build allowed to run.
   *
   * A client older than this shows a screen it cannot dismiss, which sends the
   * viewer to the store. That is a serious thing to be able to do from a text
   * field, so treat it with care.
   */
  minVersion?: string;
  /** What the pop-up says. A sentence, not a changelog. */
  updateMessage?: string;
  /** A message shown to everyone, e.g. planned maintenance. Empty means none. */
  notice?: string;
  /**
   * Stop Android TVs routing films through their own loopback relay.
   *
   * The relay (`OneConnectionRelay.java`) is what makes seeking and resuming
   * work on a line that allows one connection. It is new, it sits in front of
   * every film on every television, and it could only be tested against a fake
   * one-connection panel — so it ships with this off-switch, which reaches a
   * running television the next time it reads `/api/app-config`.
   */
  deviceRelayOff?: boolean;
  /** Make the on-device catalogue the default for new installs. */
  localCatalogueDefault?: boolean;
  /**
   * Send every error a client raises to this box, without anybody pressing
   * anything.
   *
   * Asked for as: "i want you to send all errors to the server, and in admin add
   * a config toggle or something that marks it enabled".
   *
   * Off by default and deliberately not the other way round. A television that
   * cannot play a channel currently reports NOTHING unless a viewer finds the
   * diagnostics screen behind five taps and a PIN, which is why `client_log` had
   * two rows across two days. Turning this on makes every failure arrive by
   * itself — and that is exactly why it is a switch rather than the behaviour:
   * it is telemetry, it costs the viewer bandwidth, and an operator should have
   * to decide to collect it rather than discover later that it was on.
   *
   * What travels is the error LINE, redacted twice (client and server), never a
   * URL with credentials and never what anybody watched. What the client does
   * with this flag is in `apps/web/src/lib/errorReports.ts`; the batching is
   * there too, because errors arrive in bursts and a device in a loop must cost
   * one request every few minutes rather than one per failure.
   */
  errorReports?: boolean;
}

export async function readConfig(): Promise<{ revision: number; updatedAt: Date; config: AppConfig }> {
  const { rows } = await pool.query(
    'SELECT revision, updated_at, payload FROM app_config WHERE id = 1',
  );
  const r = rows[0];
  return {
    revision: Number(r?.revision ?? 0),
    updatedAt: (r?.updated_at as Date) ?? new Date(0),
    config: (r?.payload ?? {}) as AppConfig,
  };
}

/**
 * Compare two dotted version strings.
 *
 * Returns <0 when a is older. Missing parts count as zero, so "1.4" and "1.4.0"
 * are the same version — which matters because the two spellings both appear in
 * the wild and treating them as different would force-update everybody once.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Public app-config body for `GET /api/app-config`.
 *
 * The version comes from the query string. An unknown version never forces an update.
 */
export async function publicAppConfig(
  versionRaw: string | null | undefined,
): Promise<{
  updatedAt: Date | null;
  brand: string;
  mustUpdate: boolean;
  minVersion: string | null;
  updateMessage: string | null;
  notice: string | null;
  deviceRelayOff: boolean;
  localCatalogueDefault: boolean;
  errorReports: boolean;
}> {
  const { config, updatedAt } = await readConfig();
  const version = String(versionRaw ?? '').trim();
  const min = config.minVersion ?? '';

  const known = /^\d+(\.\d+)*$/.test(version);
  const mustUpdate = known && min !== '' && compareVersions(version, min) < 0;

  return {
    updatedAt,
    brand: BRAND.name,
    mustUpdate,
    minVersion: min || null,
    updateMessage: config.updateMessage ?? null,
    notice: config.notice ?? null,
    deviceRelayOff: config.deviceRelayOff === true,
    localCatalogueDefault: config.localCatalogueDefault === true,
    errorReports: config.errorReports === true,
  };
}

/* ── one answer, however many people are looking ──────────────────────────── */

/**
 * A short-lived memo in front of the aggregates.
 *
 * The overview runs a few aggregates over the report log and the screen polls it.
 * With one operator that is nothing; with three tabs open on two machines it is
 * the same scans every few seconds, for a page whose numbers cannot meaningfully
 * change inside the poll interval anyway.
 *
 * The in-flight map matters as much as the TTL. Without it, N requests arriving
 * in the same millisecond on a cold key each start their own query — the
 * stampede that caching is supposed to prevent — so callers past the first await
 * the promise the first one made rather than making their own.
 *
 * Deliberately not Redis, or a table, or a library. It is a Map with a timestamp,
 * it lives for as long as the process, and a restart simply means the next reader
 * pays for one query. Anything more would be more infrastructure than the thing
 * it is protecting.
 */
const TTL_MS = 8_000;
const memo = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, fn: () => Promise<T>, ttl = TTL_MS): Promise<T> {
  const hit = memo.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttl) return Promise.resolve(hit.value as T);

  const running = inflight.get(key);
  if (running !== undefined) return running as Promise<T>;

  const p = fn()
    .then((value) => { memo.set(key, { at: Date.now(), value }); return value; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Called after anything that writes, so the next read is not a stale one. */
export function dropCache(): void {
  memo.clear();
}

export type Query = Record<string, string | undefined>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const PAGE_MAX = 200;
export function paging(q: Query): { limit: number; offset: number; page: number; size: number } {
  const size = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(str(q['size']), 10) || 50));
  const page = Math.max(0, Number.parseInt(str(q['page']), 10) || 0);
  return { limit: size, offset: page * size, page, size };
}

export function registerAdmin(app: FastifyInstance): void {
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const token = String(req.headers['x-admin-token'] ?? '');
    if (token === '' || !tokenValid(token)) {
      await reply.code(401).send({ error: 'unauthorised', message: 'Sign in again.' });
      return false;
    }
    return true;
  };

  /** Whether an admin area exists here at all, so the screen can say so. */
  app.get('/api/admin', async () => ({ enabled: adminCredentials() !== null, brand: BRAND.name }));

  app.post<{ Body: { username?: string; password?: string } }>('/api/admin/login', async (req, reply) => {
    if (throttled(req.ip ?? 'unknown')) {
      return reply.code(429).send({ error: 'too many attempts', message: 'Wait a minute.' });
    }
    const cred = adminCredentials();
    if (cred === null) {
      return reply.code(503).send({
        error: 'disabled',
        message: 'No ADMIN_PASSWORD is set on this server, so the admin area is switched off.',
      });
    }
    const u = String(req.body?.username ?? '');
    const p = String(req.body?.password ?? '');
    /* Both compared even when the first fails — the timing difference between
       "wrong user" and "wrong password" is information. */
    const okU = sameSecret(u, cred.username);
    const okP = sameSecret(p, cred.password);
    if (!(okU && okP)) {
      return reply.code(401).send({ error: 'rejected', message: 'Wrong username or password.' });
    }
    return { token: issue(), expiresInMs: TOKEN_TTL_MS };
  });

  app.post('/api/admin/logout', async (req) => {
    tokens.delete(String(req.headers['x-admin-token'] ?? ''));
    return { ok: true };
  });

  /**
   * Everything the dashboard paints at once.
   *
   * Deliberately small: the box keeps no record of who is watching or who is
   * signed in, so there is nothing of that kind to summarise. What is left is the
   * box itself (`health`), the error reports clients sent (`logs`), the builds
   * that are published, and the config document.
   *
   * It sits behind `cached()` so that several open tabs polling it cost one
   * round of queries rather than one each.
   */
  async function buildHealth(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { rows } = await pool.query(
      `SELECT pg_database_size(current_database())::bigint AS db_bytes,
              (SELECT count(*)::int FROM client_log)    AS logs,
              (SELECT count(*)::int FROM pg_stat_activity
                WHERE application_name = 'iptv-api')    AS connections,
              now() AS db_now`,
    );
    const mem = process.memoryUsage();
    return {
      db: { ...rows[0], roundTripMs: Date.now() - started },
      process: {
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        rssBytes: mem.rss,
        heapBytes: mem.heapUsed,
      },
    };
  }

  async function buildOverview(): Promise<unknown> {
    /* Error counts from the report log, by window and by level. */
    const logStats = pool.query(
      `SELECT count(*)::int AS held,
              count(*) FILTER (WHERE level = 'error')::int AS errors,
              count(*) FILTER (WHERE at > now() - interval '1 day')::int AS day,
              count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week,
              count(*) FILTER (WHERE level = 'error'
                                 AND at > now() - interval '1 day')::int AS errors_day,
              count(*) FILTER (WHERE level = 'error'
                                 AND at > now() - interval '7 days')::int AS errors_week,
              max(at) AS newest
         FROM client_log`,
    );
    const levels = pool.query(
      `SELECT level, count(*)::int AS n
         FROM client_log WHERE at > now() - interval '7 days'
        GROUP BY level ORDER BY n DESC`,
    );

    const [ls, lv, cfg, health] = await Promise.all([logStats, levels, readConfig(), buildHealth()]);

    return {
      brand: BRAND,
      now: new Date(),
      health,
      logs: { ...ls.rows[0], levels: lv.rows },
      config: cfg,
    };
  }

  app.get('/api/admin/overview', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    return await cached('overview', buildOverview);
  });

  /**
   * What clients reported, paged — and the same reports grouped by message.
   *
   * Grouped is the view that is actually read: forty rows of the same failure
   * from one television in a loop is one problem, and the ungrouped list makes it
   * look like forty. Both are returned because the individual rows carry the
   * build, which is what a report is followed up with.
   */

  app.get<{ Querystring: Query }>('/api/admin/logs', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    const { limit, offset, page, size } = paging(req.query);
    const params: unknown[] = [];
    const clauses: string[] = [];
    const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    const level = str(req.query['level']);
    if (level !== '' && level !== 'all') clauses.push(`level = ${p(level)}`);
    const text = str(req.query['q']);
    if (text !== '') { const t = p(`%${text}%`); clauses.push(`(message ILIKE ${t} OR app_version ILIKE ${t})`); }
    const dev = str(req.query['device']);
    if (dev !== '') clauses.push(`device_id LIKE ${p(`${dev}%`)}`);
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

    const [{ rows: count }, { rows }, { rows: groups }] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM client_log ${where}`, params),
      pool.query(
        `SELECT id, at, device_id, level, message, context, app_version, platform
           FROM client_log ${where} ORDER BY at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      /* Grouped on the first ninety characters. A message that carries a URL or an
         id differs after its prefix while being the same failure, and a GROUP BY on
         the whole string puts every one of them in its own bucket — which is the
         same as not grouping at all. */
      pool.query(
        `SELECT left(message, 90) AS message,
                count(*)::int AS n,
                count(DISTINCT device_id)::int AS devices,
                min(level) AS level,
                max(at) AS newest,
                array_agg(DISTINCT coalesce(app_version, 'unknown')) AS builds
           FROM client_log ${where} GROUP BY 1 ORDER BY n DESC, newest DESC LIMIT 40`,
        params,
      ),
    ]);
    return { total: count[0]?.n ?? 0, page, size, rows, groups };
  });

  app.get('/api/admin/health', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    return buildHealth();
  });

  /**
   * Take a copy of everything this box decides.
   *
   * "Somewhere I can reset stuff or back them up." What is actually worth backing
   * up here is small and specific: the config document is the ONLY thing on this
   * box that cannot be re-derived. The error log sweeps itself weekly, so it is
   * included only when asked for, and is explicitly not what restore puts back.
   *
   * A plain JSON document rather than a database dump, so it can be read, diffed
   * and edited by a person, and so restoring it needs nothing but this endpoint.
   */
  app.get<{ Querystring: Query }>('/api/admin/backup', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    const cfg = await readConfig();
    const withLogs = str(req.query['logs']) === '1';

    const [counts, logs] = await Promise.all([
      pool.query(`SELECT count(*)::int AS logs FROM client_log`),
      withLogs
        ? pool.query('SELECT * FROM client_log ORDER BY at DESC')
        : Promise.resolve({ rows: [] }),
    ]);

    const doc = {
      /* Stamped so a file found in a downloads folder in six months can say what
         it is and what it came from without anyone having to guess. */
      kind: 'streamix-admin-backup',
      formatVersion: 1,
      brand: BRAND,
      takenAt: new Date().toISOString(),
      counts: counts.rows[0],
      config: { revision: cfg.revision, updatedAt: cfg.updatedAt, payload: cfg.config },
      logs: logs.rows,
    };
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    void reply.header('content-disposition',
      `attachment; filename="${BRAND.name.toLowerCase()}-admin-${stamp}.json"`);
    return doc;
  });

  /**
   * Put a saved config back.
   *
   * Config only, and deliberately. A backup carries the error log when asked to,
   * but writing that back would be wrong: it describes what happened, and you do
   * not restore history from a file.
   *
   * The revision is not taken from the file. Restoring is a new edit made now,
   * not a rewind to an old one, and giving it the file's revision number would
   * make the next optimistic save collide against a number from the past.
   */
  app.post<{ Body: { config?: AppConfig; kind?: string; formatVersion?: number } }>(
    '/api/admin/restore',
    async (req, reply) => {
      if (!await guard(req, reply)) return reply;
      const body = req.body ?? {};
      /* A file picker will happily hand over a holiday photo. */
      if (body.kind !== undefined && body.kind !== 'streamix-admin-backup') {
        return reply.code(400).send({ error: 'not a backup', message: 'That file is not an admin backup.' });
      }
      const payload = (body.config as { payload?: AppConfig } | undefined)?.payload ?? body.config;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return reply.code(400).send({ error: 'no config', message: 'That backup has no config in it.' });
      }
      const { rows } = await pool.query(
        `UPDATE app_config SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
          WHERE id = 1 RETURNING revision, updated_at, payload`,
        [JSON.stringify(payload)],
      );
      dropCache();
      req.log.warn({ keys: Object.keys(payload) }, 'admin restored the config from a backup');
      return { revision: Number(rows[0].revision), updatedAt: rows[0].updated_at, config: rows[0].payload };
    },
  );

  /**
   * Put something back to empty, having said how much that is first.
   *
   * `dryRun` is the default, the screen always asks that way before it offers a
   * button, and the button then names the number it is about to remove. A destructive control whose
   * consequences are invisible from the thing you type into is a trap, however
   * clearly it is labelled.
   *
   * `config` is a reset to an EMPTY document rather than a delete, because every
   * reader supplies its own default and the row is `CHECK (id = 1)` — deleting it
   * would leave the box with no config row at all, which is a different and worse
   * state than a config that says nothing.
   */
  app.post<{ Body: { what?: string; dryRun?: boolean } }>('/api/admin/reset', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    const what = String(req.body?.what ?? '');
    if (!['config', 'logs'].includes(what)) {
      return reply.code(400).send({ error: 'unknown target', message: 'Nothing here is called that.' });
    }
    const dry = req.body?.dryRun !== false;

    if (what === 'config') {
      const cfg = await readConfig();
      const set = Object.keys(cfg.config).filter((k) => {
        const v = (cfg.config as Record<string, unknown>)[k];
        return v !== '' && v !== false && v !== null && v !== undefined;
      });
      if (dry) return { dryRun: true, what, matched: set.length, detail: set.join(', ') };
      const { rows } = await pool.query(
        `UPDATE app_config SET payload = '{}'::jsonb, revision = revision + 1, updated_at = now()
          WHERE id = 1 RETURNING revision`,
      );
      dropCache();
      req.log.warn({ cleared: set }, 'admin reset the app config');
      return { dryRun: false, what, cleared: set.length, revision: Number(rows[0].revision) };
    }

    const table = 'client_log';
    if (dry) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      return { dryRun: true, what, matched: rows[0]?.n ?? 0 };
    }
    /* TRUNCATE rather than DELETE: the table is being emptied entirely, and
       TRUNCATE reclaims the space instead of leaving it for a later VACUUM. */
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    await pool.query(`TRUNCATE ${table}`);
    dropCache();
    req.log.warn({ table, rows: rows[0]?.n ?? 0 }, 'admin emptied a table');
    return { dryRun: false, what, deleted: rows[0]?.n ?? 0 };
  });

  app.put<{ Body: { revision?: number; config?: AppConfig } }>('/api/admin/config', async (req, reply) => {
    if (!await guard(req, reply)) return reply;
    const next = (req.body?.config ?? {}) as AppConfig;
    const revision = Number(req.body?.revision ?? 0);

    /* Same single-statement optimistic update `viewer_state` uses: read-then-write
       across two statements is the race that loses one admin tab's edit. */
    const { rows } = await pool.query(
      `UPDATE app_config
          SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
        WHERE id = 1 AND revision = $2
        RETURNING revision, updated_at, payload`,
      [JSON.stringify(next), revision],
    );
    if (rows.length === 0) {
      const current = await readConfig();
      return reply.code(409).send({
        error: 'stale',
        message: 'Someone else saved first. Here is the current version.',
        ...current,
      });
    }
    dropCache();
    return {
      revision: Number(rows[0].revision),
      updatedAt: rows[0].updated_at,
      config: rows[0].payload as AppConfig,
    };
  });

  /**
   * What every client reads, signed in or not.
   *
   * Public on purpose: a build that is too old to be allowed in has to be told so
   * BEFORE it can sign in, or the forced update cannot reach the one case it
   * exists for — a client so old that its sign-in call no longer works.
   *
   * Clients fetch this themselves; nothing is pushed to them when config changes.
   */
  app.get<{ Querystring: { version?: string } }>('/api/app-config', async (req) => {
    try {
      return await publicAppConfig(req.query.version);
    } catch (e) {
      /* No database is a server with nothing configured, not a broken one: the
         app gets the all-off document (error reports off, nobody forced to update). */
      req.log.warn({ err: String(e) }, 'app-config: database unavailable, serving defaults');
      return {
        updatedAt: null, brand: BRAND.name, mustUpdate: false, minVersion: null, updateMessage: null,
        notice: null, deviceRelayOff: false, localCatalogueDefault: false, errorReports: false,
      };
    }
  });
}