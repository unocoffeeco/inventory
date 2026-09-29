import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const run = Date.now();
const sku = `MV-${run}`;
const codeA = `MA-${run}`;
// qty ไม่ซ้ำกัน → map ลำดับ operation_id ผ่าน delta ได้ (endpoint ไม่ expose operation_id)
const QTYS = [11, 22, 33, 44, 55];

const app = createApp();
const keyIds: string[] = [];
let productId = 0;
let locA = 0;
let counter = 0;
let plaintext = '';

const idem = () => `mv-${run}-${++counter}`;

/** สร้าง key จริงใน DB แล้วคืน plaintext — ไม่ต้อง copy มือ */
async function makeKey(name: string, scopes = ['inventory:read', 'inventory:write']) {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO api_keys (key_id, name, secret_hash, scopes) VALUES ($1, $2, $3, $4)`,
    [keyId, name, createHash('sha256').update(secret, 'utf8').digest(), scopes],
  );
  keyIds.push(keyId);
  return `inv1.${keyId}.${secret}`;
}

const auth = () => ['Authorization', `Bearer ${plaintext}`] as const;

async function getMovements(query: Record<string, unknown>) {
  const [name, value] = auth();
  const res = await request(app)
    .get(`/inventory/${productId}/movements`)
    .set(name, value)
    .query(query)
    .expect(200);
  return res.body as Array<Record<string, unknown>>;
}

/** ลำดับความจริงจาก DB: operation_id DESC, line_no DESC */
async function expectedDeltas(): Promise<number[]> {
  const r = await pool.query(
    `SELECT m.delta
       FROM inventory_movements m
       JOIN inventory_operations o ON o.id = m.operation_id
      WHERE m.product_id = $1
      ORDER BY o.id DESC, m.line_no DESC`,
    [productId],
  );
  return r.rows.map((row: { delta: string }) => Number(row.delta));
}

beforeAll(async () => {
  productId = Number((await pool.query(
    `INSERT INTO products (sku, name, base_unit) VALUES ($1, 'Movements Test', 'pcs') RETURNING id`,
    [sku],
  )).rows[0].id);
  locA = Number((await pool.query(
    `INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeA],
  )).rows[0].id);

  plaintext = await makeKey('movements-test');

  // 5 operations → 5 movements (1 แถวต่อ operation) เรียงจากน้อยไปมาก
  for (const qty of QTYS) {
    await request(app).post('/inventory/operations')
      .set(...auth())
      .set('X-Actor', 'EMP-MV')
      .set('Idempotency-Key', idem())
      .send({ kind: 'receipt', lines: [{ productId, locationId: locA, qty }] })
      .expect(200);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [productId]);
  await pool.query(`DELETE FROM inventory_operations WHERE idempotency_key LIKE $1`, [`mv-${run}-%`]);
  await pool.query(`DELETE FROM inventory_balances WHERE product_id = $1`, [productId]);
  if (keyIds.length) await pool.query(`DELETE FROM api_keys WHERE key_id = ANY($1::uuid[])`, [keyIds]);
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await pool.query(`DELETE FROM locations WHERE id = $1`, [locA]);
  await pool.end();
});

describe('GET /inventory/:productId/movements pagination', () => {
  it('default (no params) keeps old behavior: newest first, original columns intact', async () => {
    const rows = await getMovements({});
    expect(rows).toHaveLength(QTYS.length);
    expect(rows[0].delta).toBe(String(QTYS[QTYS.length - 1])); // op ล่าสุดก่อน
    for (const row of rows) {
      // คอลัมน์เดิมทุกตัวยังอยู่ครบ (รวม o.actor, o.api_key_id)
      expect(Object.keys(row).sort()).toEqual(
        ['actor', 'api_key_id', 'created_at', 'delta', 'kind', 'location_id'].sort(),
      );
    }
    expect(rows[0].actor).toBe('EMP-MV');
    expect(rows[0].api_key_id).toBe(keyIds[0]);
  });

  it('equal created_at → order is decided by operation_id DESC, not insertion luck', async () => {
    // force created_at เท่ากันทั้งหมดสำหรับ product ของเทสต์นี้
    await pool.query(`UPDATE inventory_movements SET created_at = now() WHERE product_id = $1`, [productId]);

    const rows = await getMovements({});
    expect(rows.map((r) => Number(r.delta))).toEqual(await expectedDeltas());
  });

  it('limit=2 paging over equal created_at → 5 unique complete rows ordered by operation_id DESC', async () => {
    // force created_at เท่ากันอีกครั้งกัน case เทสต์ก่อนหน้าไม่ถูกรัน
    await pool.query(`UPDATE inventory_movements SET created_at = now() WHERE product_id = $1`, [productId]);

    const expected = await expectedDeltas(); // [55, 44, 33, 22, 11]

    // เดินเป็นหน้า: offset = page * limit (0, 2, 4) → ครบทุกแถว
    const page0 = await getMovements({ limit: 2, offset: 0 });
    const page1 = await getMovements({ limit: 2, offset: 2 });
    const page2 = await getMovements({ limit: 2, offset: 4 });

    expect(page0).toHaveLength(2);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1); // แถวสุดท้าย

    const all = [...page0, ...page1, ...page2];
    const deltas = all.map((r) => Number(r.delta));
    expect(deltas).toEqual(expected);          // ครบ + เรียง operation_id DESC
    expect(new Set(deltas).size).toBe(QTYS.length); // ไม่ซ้ำ/ไม่หลุด
    expect(deltas).toEqual([...QTYS].reverse());

    // sliding window (offset 0,1,2 ตามสเปกตัวอย่าง): หน้าติดกันต้องทับกันตรงขอบ
    // → พิสูจน์ว่า ordering เสถียร ไม่สั่นระหว่างหน้า
    const s0 = await getMovements({ limit: 2, offset: 0 });
    const s1 = await getMovements({ limit: 2, offset: 1 });
    const s2 = await getMovements({ limit: 2, offset: 2 });
    expect(s1[0]).toEqual(s0[1]); // แถวที่ 2
    expect(s2[0]).toEqual(s1[1]); // แถวที่ 3
  });

  it('offset past the end returns an empty array', async () => {
    expect(await getMovements({ limit: 2, offset: 99 })).toEqual([]);
  });

  it('rejects invalid limit/offset with 400', async () => {
    const [name, value] = auth();
    for (const query of [{ limit: 0 }, { limit: 501 }, { limit: 'abc' }, { offset: -1 }]) {
      const res = await request(app)
        .get(`/inventory/${productId}/movements`)
        .set(name, value)
        .query(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
    }
  });
});
