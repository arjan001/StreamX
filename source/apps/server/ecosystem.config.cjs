/**
 * pm2 process definition.
 *
 * One process serves the API and, when `WEB_DIST` points at one, the built web
 * app on the same port — so there is no proxy hop and no CORS between the app
 * and its own backend.
 *
 * Node runs the TypeScript sources directly via type stripping (Node 22+), so
 * there is no server build step. The flags must be passed via
 * `interpreter_args`, not `node_args`, for pm2 to forward them.
 *
 * pm2 does not read `.env`, so it is loaded here — including `WEB_DIST`, which is
 * how this repository finds what the app repository
 * built. See `src/paths.ts`.
 */
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '.env');
const env = { NODE_ENV: 'production' };
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
}
env.PORT = env.PORT || '7500';
env.HOST = env.HOST || '0.0.0.0';

module.exports = {
  apps: [
    {
      name: 'streamix',
      script: 'src/server.ts',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-strip-types --no-warnings',
      env: {
        ...env,
        LOG_OUT_FILE: `${__dirname}/logs/streamix-out.log`,
        LOG_ERR_FILE: `${__dirname}/logs/streamix-err.log`,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      max_memory_restart: '600M',
      merge_logs: true,
      time: true,
      /*
       * Beside the app, not in `/tmp`.
       *
       * `/tmp` is cleared on a reboot, so the log of whatever went wrong
       * before a restart is exactly the log that is not there afterwards. It
       * is also the same root filesystem, which on 2026-09-23 was at 88% with
       * 2.3 GB of this file on it. `logs/` is gitignored, and `logRotate.ts`
       * caps both of these at 128 MB — the environment names them so the
       * process can find the files pm2 opened for it.
       */
      out_file: `${__dirname}/logs/streamix-out.log`,
      error_file: `${__dirname}/logs/streamix-err.log`,
    },
  ],
};
