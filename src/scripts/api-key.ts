import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { SCOPES, type Scope } from '../auth/apiKeys.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

if (cmd === 'create') {
  const name = arg('name') ?? 'unnamed';
  const scopes = (arg('scopes') ?? 'inventory:read').split(',').map((s) => s.trim());
  const days = arg('days') ? Number(arg('days')) : null;

  const bad = scopes.filter((s) => !SCOPES.includes(s as Scope));
  if (bad.length) {
    console.error(`invalid scopes: ${bad.join(', ')} (allowed: ${SCOPES.join(', ')})`);
    process.exit(1);
  }

  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(secret, 'utf8').digest();

  await pool.query(
    `INSERT INTO api_keys (key_id, name, secret_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4,
       CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)`,
    [keyId, name, hash, scopes, days],
  );

  console.log('\n✅ API key created — copy it now, จะไม่แสดงอีก\n');
  console.log(`  name    : ${name}`);
  console.log(`  key_id  : ${keyId}`);
  console.log(`  scopes  : ${scopes.join(', ')}`);
  console.log(`  expires : ${days ? `in ${days} days` : 'never'}`);
  console.log(`\n  inv1.${keyId}.${secret}\n`);
  console.log('ใช้เป็น:  Authorization: Bearer inv1.<key_id>.<secret>\n');
} else if (cmd === 'revoke') {
  const id = rest[0];
  const r = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL`,
    [id],
  );
  console.log(r.rowCount ? `revoked ${id}` : `no active key with key_id ${id}`);
} else if (cmd === 'list') {
  const r = await pool.query(
    `SELECT key_id, name, scopes, created_at, expires_at, revoked_at
       FROM api_keys ORDER BY created_at DESC`,
  );
  console.table(r.rows);
} else {
  console.error('usage: api-key.ts create --name <n> [--scopes inventory:read,inventory:write] [--days 90]');
  console.error('       api-key.ts revoke <key_id>');
  console.error('       api-key.ts list');
  process.exit(1);
}

await pool.end();
