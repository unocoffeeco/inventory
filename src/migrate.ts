import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from './db/pool.js';

const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
await pool.query(sql);
await pool.end();
console.log('✔ migration applied');
