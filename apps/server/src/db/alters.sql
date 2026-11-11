/*
 * The two tables that survived, and nothing else.
 *
 * This file used to carry generated columns for the catalogue, trigram indexes,
 * a backfill for filler rows and the credential columns on `source` — and, until
 * 2026-10-01, the presence roster and its history. All of those tables are
 * dropped by schema.sql; what remains is written to be re-runnable, so applying
 * it to a database that already has these tables changes nothing.
 */

CREATE TABLE IF NOT EXISTS app_config (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision   bigint      NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO app_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
/*
 * Somewhere for a television to report from.
 *
 * See src/log.ts. Bounded by a seven-day sweep rather than by size: a client in
 * a crash loop is rate-limited before it reaches here, so the row count follows
 * the number of devices having a bad week and not the number of times they
 * retried.
 *
 * `device_id` is not a device: since 2026-10-01 the app sends a name it invents
 * at every launch and keeps only in memory, so the rate limit in log.ts still
 * has something to count by and no two launches can be joined.
 */
CREATE TABLE IF NOT EXISTS client_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  device_id   text        NOT NULL,
  level       text        NOT NULL DEFAULT 'error',
  message     text        NOT NULL,
  context     jsonb,
  app_version text,
  platform    text
);
CREATE INDEX IF NOT EXISTS ix_client_log_at ON client_log (at DESC);
CREATE INDEX IF NOT EXISTS ix_client_log_device ON client_log (device_id, at DESC);
