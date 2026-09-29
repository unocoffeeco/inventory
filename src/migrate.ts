import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db/pool.js';

const base = new URL('../migrations/', import.meta.url);

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

const files = (await readdir(base)).filter((f) => f.endsWith('.sql')).sort();
const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
const done = new Set(rows.map((r) => r.name));

for (const f of files) {
  if (done.has(f)) {
    console.log(`skip   ${f}`);
    continue;
  }
  const sql = await readFile(new URL(f, base), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    await c.query('COMMIT');
    console.log(`apply  ${f}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`FAILED ${f} (rolled back)`);
    throw e;
  } finally {
    c.release();
  }
}

console.log('schema up to date');
await pool.end();
