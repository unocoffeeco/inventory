import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const run = Date.now();
const sku = `ATTR-${run}`;
const codeA = `XA-${run}`;

const app = createApp();
const keyIds: string[] = [];
let productId = 0;
let locA = 0;
let counter = 0;

const idem = () => `attr-${run}-${++counter}`;
const body = () => ({ kind: 'receipt', lines: [{ productId, locationId: locA, qty: 1 }] });

async function makeKey(name: string, scopes = ['inventory:read', 'inventory:write']) {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO api_keys (key_id, name, secret_hash, scopes) VALUES ($1, $2, $3, $4)`,
    [keyId, name, createHash('sha256').update(secret, 'utf8').digest(), scopes],
  );
  keyIds.push(keyId);
  return { keyId, plaintext: `inv1.${keyId}.${secret}` };
}

async function attributionOf(k: string) {
  const r = await pool.query(
    `SELECT api_key_id, actor FROM inventory_operations WHERE idempotency_key = $1`,
    [k],
  );
  return r.rows[0] as { api_key_id: string | null; actor: string | null } | undefined;
}

beforeAll(async () => {
  productId = Number((await pool.query(
    `INSERT INTO products (sku, name, base_unit) VALUES ($1, 'Attr Test', 'pcs') RETURNING id`, [sku],
  )).rows[0].id);
  locA = Number((await pool.query(
    `INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeA],
  )).rows[0].id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [productId]);
  await pool.query(`DELETE FROM inventory_operations WHERE idempotency_key LIKE $1`, [`attr-${run}-%`]);
  await pool.query(`DELETE FROM inventory_balances WHERE product_id = $1`, [productId]);
  if (keyIds.length) await pool.query(`DELETE FROM api_keys WHERE key_id = ANY($1::uuid[])`, [keyIds]);
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await pool.query(`DELETE FROM locations WHERE id = $1`, [locA]);
});

describe('actor attribution', () => {
  it('falls back to the API key name when X-Actor is absent', async () => {
    const { keyId, plaintext } = await makeKey('warehouse-app');
    const key = idem();
    await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', key).send(body()).expect(200);

    const row = await attributionOf(key);
    expect(row?.api_key_id).toBe(keyId);
    expect(row?.actor).toBe('warehouse-app');
  });

  it('records X-Actor verbatim alongside the key that performed it', async () => {
    const { keyId, plaintext } = await makeKey('scanner-01');
    const key = idem();
    await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('X-Actor', 'EMP-4821')
      .set('Idempotency-Key', key).send(body()).expect(200);

    const row = await attributionOf(key);
    expect(row?.api_key_id).toBe(keyId);
    expect(row?.actor).toBe('EMP-4821');
  });

  it('rejects an over-long X-Actor with 400 and writes nothing', async () => {
    const { plaintext } = await makeKey('long-actor');
    const key = idem();
    await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('X-Actor', 'x'.repeat(101))
      .set('Idempotency-Key', key).send(body()).expect(400);

    expect(await attributionOf(key)).toBeUndefined();
  });

  it('keeps the original attribution on idempotent replay', async () => {
    const { plaintext } = await makeKey('replay-key');
    const key = idem();

    const first = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`).set('X-Actor', 'EMP-0001')
      .set('Idempotency-Key', key).send(body());
    expect(first.status).toBe(200);

    const replay = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`).set('X-Actor', 'EMP-9999')
      .set('Idempotency-Key', key).send(body());
    expect(replay.status).toBe(200);
    expect(replay.body.operationId).toBe(first.body.operationId);

    expect((await attributionOf(key))?.actor).toBe('EMP-0001');
  });

  it('exposes actor on the movements endpoint', async () => {
    const { plaintext } = await makeKey('reader-key');
    await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`).set('X-Actor', 'EMP-7777')
      .set('Idempotency-Key', idem()).send(body()).expect(200);

    const mv = await request(app).get(`/inventory/${productId}/movements`)
      .set('Authorization', `Bearer ${plaintext}`).expect(200);

    expect(mv.body.some((m: { actor?: string }) => m.actor === 'EMP-7777')).toBe(true);
  });
});
