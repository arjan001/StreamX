import '../env.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  for (const f of ['schema.sql', 'alters.sql', 'indices.sql']) {
    const sql = await readFile(join(here, f), 'utf8');
    await pool.query(sql);
    console.log(`applied ${f}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  await pool.end();
}
