import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const run = Date.now();
const sku = `MD-${run}`;
const code = `ML-${run}`;
const locCode = `ML2-${run}`;

const app = createApp();
const keyIds: string[] = [];
let locId = 0;
let counter = 0;

const idem = () => `md-${run}-${++counter}`;

async function makeKey(scopes: string[]) {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO api_keys (key_id, name, secret_hash, scopes) VALUES ($1, $2, $3, $4)`,
    [keyId, `md-${scopes.join('+')}`, createHash('sha256').update(secret, 'utf8').digest(), scopes],
  );
  keyIds.push(keyId);
  return { keyId, plaintext: `inv1.${keyId}.${secret}` };
}

beforeAll(async () => {
  locId = Number((await pool.query(
    `INSERT INTO locations (code) VALUES ($1) RETURNING id`, [locCode],
  )).rows[0].id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM inventory_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE $1)`, [`MD-${run}%`]);
  await pool.query(`DELETE FROM inventory_operations WHERE idempotency_key LIKE $1`, [`md-${run}-%`]);
  await pool.query(`DELETE FROM inventory_balances WHERE product_id IN (SELECT id FROM products WHERE sku LIKE $1)`, [`MD-${run}%`]);
  await pool.query(`DELETE FROM products WHERE sku LIKE $1`, [`MD-${run}%`]);
  await pool.query(`DELETE FROM locations WHERE code LIKE $1`, [`ML%${run}%`]);
  if (keyIds.length) await pool.query(`DELETE FROM api_keys WHERE key_id = ANY($1::uuid[])`, [keyIds]);
});

describe('master data over HTTP', () => {
  it('POST /products without key -> 401', async () => {
    await request(app).post('/products')
      .send({ sku, name: 'X', baseUnit: 'pcs' }).expect(401);
  });

  it('POST /products with read-only key -> 403', async () => {
    const { plaintext } = await makeKey(['inventory:read']);
    await request(app).post('/products')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ sku, name: 'X', baseUnit: 'pcs' }).expect(403);
  });

  it('POST /products with write key -> 201 and listed', async () => {
    const { plaintext } = await makeKey(['inventory:read', 'inventory:write']);
    const created = await request(app).post('/products')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ sku, name: 'Widget', baseUnit: 'pcs' });
    expect(created.status).toBe(201);
    expect(created.body.sku).toBe(sku);

    const list = await request(app).get('/products')
      .set('Authorization', `Bearer ${plaintext}`);
    expect(list.status).toBe(200);
    expect(list.body.some((p: { sku: string }) => p.sku === sku)).toBe(true);
  });

  it('duplicate sku -> 409 DUPLICATE', async () => {
    const { plaintext } = await makeKey(['inventory:write']);
    const res = await request(app).post('/products')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ sku, name: 'dup', baseUnit: 'pcs' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE');
  });

  it('empty sku -> 400 VALIDATION_FAILED', async () => {
    const { plaintext } = await makeKey(['inventory:write']);
    const res = await request(app).post('/products')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ sku: '  ', name: 'x', baseUnit: 'pcs' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('PATCH renames, empty body 400, unknown id 404', async () => {
    const { plaintext } = await makeKey(['inventory:read', 'inventory:write']);
    const list = await request(app).get('/products').set('Authorization', `Bearer ${plaintext}`);
    const id = list.body.find((p: { sku: string }) => p.sku === sku).id;

    const ok = await request(app).patch(`/products/${id}`)
      .set('Authorization', `Bearer ${plaintext}`).send({ name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Renamed');

    await request(app).patch(`/products/${id}`)
      .set('Authorization', `Bearer ${plaintext}`).send({}).expect(400);
    await request(app).patch('/products/999999999')
      .set('Authorization', `Bearer ${plaintext}`).send({ name: 'x' }).expect(404);
  });

  it('POST /locations duplicate code -> 409', async () => {
    const { plaintext } = await makeKey(['inventory:write']);
    await request(app).post('/locations').set('Authorization', `Bearer ${plaintext}`)
      .send({ code }).expect(201);
    const dup = await request(app).post('/locations').set('Authorization', `Bearer ${plaintext}`)
      .send({ code });
    expect(dup.status).toBe(409);
  });

  it('archived product leaves GET /products but stays visible in stock', async () => {
    const { plaintext } = await makeKey(['inventory:read', 'inventory:write']);

    const receipt = await request(app).post('/inventory/operations')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Idempotency-Key', idem())
      .send({ kind: 'receipt', lines: [{ productId: (await productIdOf(plaintext)), locationId: locId, qty: 5 }] });
    expect(receipt.status).toBe(200);

    const list = await request(app).get('/products').set('Authorization', `Bearer ${plaintext}`);
    const id = list.body.find((p: { sku: string }) => p.sku === sku).id;

    await request(app).delete(`/products/${id}`)
      .set('Authorization', `Bearer ${plaintext}`).expect(204);

    const after = await request(app).get('/products').set('Authorization', `Bearer ${plaintext}`);
    expect(after.body.some((p: { sku: string }) => p.sku === sku)).toBe(false);

    const archived = await request(app).get('/products?include_archived=1')
      .set('Authorization', `Bearer ${plaintext}`);
    expect(archived.body.some((p: { sku: string }) => p.sku === sku)).toBe(true);

    // ยอดคงเหลือต้องยังเห็น (สต็อกไม่หายจากจอ)
    const stock = await request(app).get(`/inventory?location_id=${locId}`)
      .set('Authorization', `Bearer ${plaintext}`);
    expect(stock.body.some((b: { sku: string }) => b.sku === sku)).toBe(true);
  });
});

async function productIdOf(plaintext: string) {
  const list = await request(app).get('/products').set('Authorization', `Bearer ${plaintext}`);
  return list.body.find((p: { sku: string }) => p.sku === sku).id;
}
