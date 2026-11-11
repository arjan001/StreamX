/**
 * What the server is.
 *
 * It does a handful of things and nothing else:
 *
 *   website     a landing page and the legal pages (terms, privacy, copyright,
 *               open-source licences), plus the built web app when there is one
 *   logging     somewhere for a television with no console to report from
 *   config      a setting that can change after an APK has been signed
 *   captions    a short-lived Soniox key, because the account key must not ship
 *               inside a download anyone can unzip
 *   demo        an optional playlist of Creative Commons films, for store reviewers
 *
 * It holds no channels, no catalogue and no credentials of anyone's provider, and
 * knows nothing about who is watching. Every one of the optional parts degrades to
 * OFF rather than to an error: a device that cannot reach this box is a working
 * player with fewer menu entries.
 *
 * `buildApp` returns the instance without listening so tests can drive it on an
 * ephemeral port; `server.ts` is the one that binds.
 */
import './env.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { logUrl, maskIp } from './logUrl.ts';
import { registerAdmin } from './admin.ts';
import { webDist as webDistDir } from './paths.ts';
import { registerCaptions } from './captions.ts';
import { registerLog } from './log.ts';
import { registerSite } from './site.ts';
import { allowedOrigins, originAllowed } from './cors.ts';
import { BRAND } from './brand.ts';
import { pool } from './db/pool.ts';
import { staticCacheControl } from './staticCache.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const trust = (process.env['TRUST_PROXY'] ?? '127.0.0.1').trim();
  const app = Fastify({
    /* Every log line says which product it came from. */
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      base: { brand: BRAND.name, app: BRAND.applicationId ?? BRAND.name },
      /*
       * No credentials in the log, and no full IP address. The URL is cut by
       * `logUrl`, and the address is reduced to its network by `maskIp`. Request
       * headers and bodies are never logged, so neither is the admin password or
       * a caption key.
       */
      serializers: {
        req: (req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
          method: req.method,
          url: logUrl(req.url ?? ''),
          hostname: req.hostname,
          remoteAddress: maskIp(req.ip ?? ''),
          remotePort: req.socket?.remotePort,
        }),
      },
    },
    /* Small: the largest body anything sends is a batch of log lines, so a runaway
       client is a 413 rather than a memory problem. */
    bodyLimit: 512 * 1024,
    /*
     * Who may name the client's address through X-Forwarded-For. Loopback by
     * default (a reverse proxy on the same machine); set TRUST_PROXY to the
     * proxy's address or CIDR, or to `true`/`false`, when it is somewhere else —
     * a Docker network, say. Wrongly trusting it lets a client pick its own
     * address and walk round the rate limits.
     */
    trustProxy: trust === 'true' ? true : trust === 'false' ? false : trust,
  });

  /* ── CORS: the app's own origins, not the whole web ── */
  const allowed = allowedOrigins(process.env, [BRAND.publisher.website]);
  const dev = process.env['NODE_ENV'] !== 'production';
  await app.register(cors, {
    origin: (origin, cb) => cb(null, originAllowed(origin, allowed, dev)),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    maxAge: 600,
  });

  /* ── headers every response gets; the HTML pages add a strict CSP in site.ts ── */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (req.headers['x-forwarded-proto'] === 'https') {
      reply.header('strict-transport-security', 'max-age=15552000');
    }
    return payload;
  });

  registerCaptions(app);
  registerLog(app);
  registerAdmin(app);
  registerSite(app, { webApp: () => existsSync(join(webDistDir(), 'index.html')) });

  /* Liveness: answers with no database, for a container or a proxy's health check. */
  app.get('/healthz', async () => ({ ok: true }));

  /* Readiness: the same, plus whether Postgres answers. 503 when it does not, so
     an orchestrator can tell; the legal pages and captions work either way. */
  app.get('/api/health', async (_req, reply) => {
    try {
      await pool.query('select 1 as ok');
      return { ok: true, db: 'up' };
    } catch {
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });

  /* 4xx that a route raised is 4xx that a client sees; Fastify's default turns
     any thrown error into a 500. */
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: e.message ?? 'bad request' });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: 'internal error' });
  });

  /* The built web app, from the same origin. One process, one port. */
  const webDist = webDistDir();
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      /* The landing page owns `/`; the app's own home is /home. */
      index: false,
      /* Off, or `send` writes its own `max-age=0` over `setHeaders` below. */
      cacheControl: false,
      setHeaders(res, path) {
        res.setHeader('cache-control', staticCacheControl(path));
      },
    });
    /* History-mode fallback: /live, /series/:id etc. are client routes, not files.
       Anything under /api that reached here is a genuine 404 and must stay JSON. */
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).type('application/json').send({ error: 'not found' });
      }
      /* A missing FILE (/x.apk, /assets/old-chunk.js) is a 404, not the app's
         page: no client route ends in an extension, and a stale chunk answered
         with HTML is harder to recover from than a plain not-found. */
      const last = (req.raw.url ?? '/').split('?')[0]!.split('/').pop() ?? '';
      if (/\.[a-z0-9]{1,5}$/i.test(last)) {
        return reply.code(404).type('text/plain').send('Not found');
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`serving web app from ${webDist}`);
  } else {
    app.log.warn(`no web build at ${webDist} — run "pnpm build" (landing and legal pages only)`);
  }

  return app;
}
