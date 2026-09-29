import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const run = Date.now();
const sku = `AUTH-${run}`;
const codeA = `AA-${run}`;
const codeB = `AB-${run}`;

const app = createApp();
const keyIds: string[] = [];
let productId = 0;
let locA = 0;
let locB = 0;
let counter = 0;

const idem = () => `auth-${run}-${++counter}`;
const receiptBody = () => ({
  kind: 'receipt',
  lines: [{ productId, locationId: locA, qty: 1 }],
});
const b64 = () => randomBytes(32).toString('base64url');

/** สร้าง key จริงใน DB แล้วคืน plaintext — ไม่ต้อง copy มือ */
async function makeKey(scopes: string[], opts: { expiresAt?: Date } = {}) {
  const keyId = randomUUID();
  const secret = b64();
  await pool.query(
    `INSERT INTO api_keys (key_id, name, secret_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [keyId, `test-${scopes.join('+')}`, createHash('sha256').update(secret, 'utf8').digest(),
     scopes, opts.expiresAt ?? null],
  );
  keyIds.push(keyId);
  return { keyId, plaintext: `inv1.${keyId}.${secret}` };
}

beforeAll(async () => {
  const p = await pool.query(
    `INSERT INTO products (sku, name, base_unit) VALUES ($1, 'Auth Test', 'pcs') RETURNING id`,
    [sku],
  );
  productId = Number(p.rows[0].id);
  locA = Number((await pool.query(`INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeA])).rows[0].id);
  locB = Number((await pool.query(`INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeB])).rows[0].id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [productId]);
  await pool.query(`DELETE FROM inventory_operations WHERE idempotency_key LIKE $1`, [`auth-${run}-%`]);
  await pool.query(`DELETE FROM inventory_balances WHERE product_id = $1`, [productId]);
  if (keyIds.length) await pool.query(`DELETE FROM api_keys WHERE key_id = ANY($1::uuid[])`, [keyIds]);
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await pool.query(`DELETE FROM locations WHERE id = ANY($1::bigint[])`, [[locA, locB]]);
});

describe('auth over HTTP', () => {
  it('/health stays public', async () => {
    await request(app).get('/health').expect(200);
  });

  it('POST without Authorization -> 401', async () => {
    const res = await request(app).post('/inventory/operations')
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('GET /inventory without Authorization -> 401', async () => {
    const res = await request(app).get(`/inventory?location_id=${locA}`);
    expect(res.status).toBe(401);
  });

  it('GET movements without Authorization -> 401', async () => {
    const res = await request(app).get(`/inventory/${productId}/movements`);
    expect(res.status).toBe(401);
  });

  it('malformed Authorization -> 401', async () => {
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', 'Bearer not-a-key')
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
  });

  it('valid key_id with wrong secret -> 401', async () => {
    const { keyId } = await makeKey(['inventory:write']);
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer inv1.${keyId}.${b64()}`)
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
  });

  it('expired key -> 401', async () => {
    const { plaintext } = await makeKey(['inventory:write'], {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
  });

  it('revoked key -> 401', async () => {
    const { keyId, plaintext } = await makeKey(['inventory:write']);
    await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE key_id = $1`, [keyId]);
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
  });

  it('write key can POST', async () => {
    const { plaintext } = await makeKey(['inventory:read', 'inventory:write']);
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('committed');
  });

  it('write key can transfer', async () => {
    const { plaintext } = await makeKey(['inventory:write']);
    const res = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem())
      .send({ kind: 'transfer', lines: [{ productId, locationId: locA, toLocationId: locB, qty: 1 }] });
    expect(res.status).toBe(200);
  });

  it('read key: GET 200 but POST 403', async () => {
    const { plaintext } = await makeKey(['inventory:read']);

    const ok = await request(app).get(`/inventory?location_id=${locA}`)
      .set('Authorization', `Bearer ${plaintext}`);
    expect(ok.status).toBe(200);

    const forbidden = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('FORBIDDEN');
  });

  it('failed auth writes nothing', async () => {
    const count = () => pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_operations WHERE idempotency_key LIKE $1`,
      [`auth-${run}-%`],
    );
    const before = (await count()).rows[0].n;
    const res = await request(app).post('/inventory/operations')
      .set('Idempotency-Key', idem()).send(receiptBody());
    expect(res.status).toBe(401);
    expect((await count()).rows[0].n).toBe(before);
  });
});
