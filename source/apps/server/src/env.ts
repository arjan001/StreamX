/**
 * Load .env inside the process.
 *
 * Deliberately not left to the process manager: `pm2 restart` does not re-read
 * the ecosystem file, so a value added to .env after the first `pm2 start` never
 * arrives. That silently broke RELAY_SECRET, which made the relay key fall back
 * to a per-PID value — so every restart invalidated the tokens already held by
 * open pages and every stream 403'd.
 *
 * Imported for its side effect, before anything reads process.env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  process.env['ENV_FILE'],
  resolve(here, '../.env'),
  join(process.cwd(), '.env'),
]) {
  if (candidate && existsSync(candidate)) {
    Object.assign(process.env, parseEnv(readFileSync(candidate, 'utf8')));
    break;
  }
}
