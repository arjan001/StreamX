/**
 * Binds the server. Everything it is lives in `app.ts`.
 */
import './env.ts';
import { buildApp } from './app.ts';
import { startRetention } from './log.ts';
import { watchLogs } from './logRotate.ts';

const app = await buildApp();

/*
 * Keep our own logs from filling the disk — see `logRotate.ts`. The paths come
 * from the environment rather than from the pm2 config, because a process cannot
 * read the config that started it.
 */
const logPaths = [process.env['LOG_OUT_FILE'], process.env['LOG_ERR_FILE']]
  .filter((p): p is string => typeof p === 'string' && p !== '');
if (logPaths.length > 0) watchLogs(logPaths, (msg) => app.log.warn(msg));

/* Error reports are kept seven days whether or not any more arrive. */
startRetention();

const port = Number(process.env['PORT'] ?? 7500);
const host = process.env['HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
