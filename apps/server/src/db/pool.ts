import pg from 'pg';

// Postgres returns bigint as string by default to avoid precision loss. Our ids
// fit comfortably in a JS number, and downstream code expects numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  ...(process.env['PGHOST']
    ? {
        host: process.env['PGHOST'],
        port: Number(process.env['PGPORT'] ?? 5432),
        database: process.env['PGDATABASE'],
        user: process.env['PGUSER'],
        password: process.env['PGPASSWORD'],
      }
    : {
        connectionString: process.env['DATABASE_URL'],
      }),
  max: Number(process.env['PG_POOL_MAX'] ?? 10),
  application_name: 'iptv-api',
});

export type Db = pg.Pool | pg.PoolClient;

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
