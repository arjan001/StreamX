/**
 * Live captions: mints a short-lived Soniox key for the app.
 *
 * The audio never comes through here. The app opens its own WebSocket straight
 * to Soniox with a five-minute key, because relaying PCM through this server
 * would add a hop to something that has to keep up with real time, and would
 * put the sound on a machine that has no business holding it.
 *
 * The publisher's own account key (`SONIOX_API_KEY`) stays in this process and
 * never reaches a device. With no key set, captions report "unavailable" and the
 * app greys the switch out.
 *
 * Soniox keys are region-scoped: an EU key is refused by the global host and the
 * other way round. `SONIOX_API_BASE` names the REST host that matches the key
 * (default `https://api.soniox.com`, EU `https://api.eu.soniox.com`), and the
 * realtime socket host is derived from it unless `SONIOX_WS_URL` says otherwise.
 */
import type { FastifyInstance } from 'fastify';
import { makeLimiter } from './rateLimit.ts';

const KEY_TTL_SECONDS = 300;
/** Per address: a viewer who changes channel restarts captions, so this is generous. */
const SESSIONS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60_000;

function apiBase(): string {
  return (process.env['SONIOX_API_BASE'] ?? '').trim().replace(/\/+$/, '') || 'https://api.soniox.com';
}

function wsUrl(): string {
  const given = (process.env['SONIOX_WS_URL'] ?? '').trim();
  if (given !== '') return given;
  try {
    const host = new URL(apiBase()).hostname;
    return `wss://${host.replace(/^api\./, 'stt-rt.')}/transcribe-websocket`;
  } catch {
    return 'wss://stt-rt.soniox.com/transcribe-websocket';
  }
}

const model = (): string => (process.env['SONIOX_MODEL'] ?? '').trim() || 'stt-rt-v5';
const accountKey = (): string => (process.env['SONIOX_API_KEY'] ?? '').trim();

export function registerCaptions(app: FastifyInstance): void {
  const limiter = makeLimiter(SESSIONS_PER_WINDOW, WINDOW_MS);

  /* No call to Soniox: a health check the app makes every time the popover opens
     must not cost a request upstream. Configured or not is the whole answer. */
  app.get('/api/captions/health', async (_req, reply) => {
    if (accountKey() === '') {
      return reply.code(503).send({ available: false, message: 'Live captions are not set up on this server.' });
    }
    return { available: true, model: model() };
  });

  app.post('/api/captions/session', async (req, reply) => {
    const key = accountKey();
    if (key === '') {
      return reply.code(503).send({ error: 'unavailable', message: 'Live captions are not set up on this server.' });
    }
    if (!limiter.hit(req.ip)) {
      return reply.code(429).header('retry-after', String(limiter.retryAfter(req.ip)))
        .send({ error: 'rate_limited', message: 'Too many caption sessions from this address. Try again in a few minutes.' });
    }
    let r: Response;
    try {
      r = await fetch(`${apiBase()}/v1/auth/temporary-api-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: KEY_TTL_SECONDS }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return reply.code(503).send({ error: 'unavailable', message: 'The caption service could not be reached.' });
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof body['api_key'] !== 'string') {
      /* The upstream body is not echoed: it can name the account. The status is
         enough for the operator, and goes to the log rather than to a device. */
      req.log.warn({ status: r.status }, 'soniox refused to mint a temporary key');
      return reply.code(502).send({ error: 'mint_failed', message: 'The caption service refused to start a session.' });
    }
    /* Single-purpose and expires in minutes, so it is handed over as it is. */
    return {
      apiKey: body['api_key'],
      websocketUrl: wsUrl(),
      model: model(),
      expiresAt: body['expires_at'] ?? Math.floor(Date.now() / 1000) + KEY_TTL_SECONDS,
    };
  });
}
