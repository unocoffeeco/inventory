import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { postOperation } from '../src/inventory/service.js';
import type { Op } from '../src/inventory/schemas.js';

// ---- ของเฉพาะกิจต่อการรัน 1 ครั้ง (กันชนกับข้อมูลเดิม) ----
const run = Date.now();
const sku = `TEST-${run}`;
const codeA = `TA-${run}`;
const codeB = `TB-${run}`;
const MISSING_LOCATION = 999_999_999;

let productId = 0;
let locA = 0;
let locB = 0;
const opIds: number[] = [];
let counter = 0;

const newKey = () => `${sku}-k${++counter}`;

/** เรียก operation + เก็บ opId ไว้ลบตอนจบ */
async function op(kind: Op['kind'], lines: Op['lines'], key = newKey()) {
  const res = await postOperation(key, { kind, lines });
  opIds.push(Number(res.operationId));
  return res;
}

async function getQty(locationId: number): Promise<number> {
  const r = await pool.query(
    `SELECT qty FROM inventory_balances WHERE product_id = $1 AND location_id = $2`,
    [productId, locationId],
  );
  return r.rows[0] ? Number(r.rows[0].qty) : 0;
}

/**
 * ตั้งยอดให้เป็น target "ผ่าน ledger" (ใช้ adjustment) เพื่อคง invariant
 * balance == ledger ทำให้ test ข้อ 7 ใช้ได้ตลอดเวลา
 */
async function setQty(locationId: number, target: number) {
  const delta = target - (await getQty(locationId));
  if (delta !== 0) await op('adjustment', [{ productId, locationId, qty: delta }]);
}

async function movementCount(operationId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM inventory_movements WHERE operation_id = $1`,
    [operationId],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  const p = await pool.query(
    `INSERT INTO products (sku, name, base_unit) VALUES ($1, 'Test Widget', 'pcs') RETURNING id`,
    [sku],
  );
  productId = Number(p.rows[0].id);

  const a = await pool.query(`INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeA]);
  locA = Number(a.rows[0].id);
  const b = await pool.query(`INSERT INTO locations (code) VALUES ($1) RETURNING id`, [codeB]);
  locB = Number(b.rows[0].id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [productId]);
  if (opIds.length) {
    await pool.query(`DELETE FROM inventory_operations WHERE id = ANY($1::bigint[])`, [opIds]);
  }
  await pool.query(`DELETE FROM inventory_balances WHERE product_id = $1`, [productId]);
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await pool.query(`DELETE FROM locations WHERE id = ANY($1::bigint[])`, [[locA, locB]]);
  await pool.end();
});

describe('inventory integration (real DB)', () => {
  // 1 ─────────────────────────────────────────────────────────
  it('1) receipt + issue updates balances correctly', async () => {
    await setQty(locA, 0);
    await op('receipt', [{ productId, locationId: locA, qty: 100 }]);
    expect(await getQty(locA)).toBe(100);
    await op('issue', [{ productId, locationId: locA, qty: 30 }]);
    expect(await getQty(locA)).toBe(70);
  });

  // 2 ─────────────────────────────────────────────────────────
  it('2) rejects an issue that would go negative', async () => {
    await setQty(locA, 10);
    await expect(
      op('issue', [{ productId, locationId: locA, qty: 9999 }]),
    ).rejects.toMatchObject({ message: 'INSUFFICIENT_STOCK', status: 409 });
    expect(await getQty(locA)).toBe(10); // ยอดไม่เปลี่ยน
  });

  // 3 ─────────────────────────────────────────────────────────
  it('3) transfer to a missing destination is atomic (source not debited)', async () => {
    await setQty(locA, 50);
    await expect(
      op('transfer', [{ productId, locationId: locA, toLocationId: MISSING_LOCATION, qty: 5 }]),
    ).rejects.toMatchObject({ message: 'DESTINATION_NOT_FOUND', status: 404 });
    expect(await getQty(locA)).toBe(50); // ของไม่หาย
  });

  // 4 ─────────────────────────────────────────────────────────
  it('4) idempotency: same key+payload returns original, no double write', async () => {
    await setQty(locA, 0);
    const key = newKey();

    const first = await op('receipt', [{ productId, locationId: locA, qty: 10 }], key);
    expect(await getQty(locA)).toBe(10);

    const second = await op('receipt', [{ productId, locationId: locA, qty: 10 }], key);
    expect(Number(second.operationId)).toBe(Number(first.operationId));
    expect(await getQty(locA)).toBe(10); // ไม่บวกซ้ำ
    expect(await movementCount(Number(first.operationId))).toBe(1);

    // key เดิม + payload ต่าง → conflict
    await expect(
      op('receipt', [{ productId, locationId: locA, qty: 99 }], key),
    ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  // 5 ─────────────────────────────────────────────────────────
  it('5) race: 10 concurrent issues from qty=1 → exactly one wins', async () => {
    await setQty(locA, 1);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        op('issue', [{ productId, locationId: locA, qty: 1 }]),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const f of failed) {
      expect(f.reason).toMatchObject({ message: 'INSUFFICIENT_STOCK', status: 409 });
    }
    expect(await getQty(locA)).toBe(0); // ห้ามติดลบ
  });

  // 6 ─────────────────────────────────────────────────────────
  it('6) no deadlock: concurrent opposite transfers all succeed, net zero', async () => {
    await setQty(locA, 50);
    await setQty(locB, 50);

    const tasks = [];
    for (let i = 0; i < 15; i++) {
      tasks.push(op('transfer', [{ productId, locationId: locA, toLocationId: locB, qty: 1 }]));
      tasks.push(op('transfer', [{ productId, locationId: locB, toLocationId: locA, qty: 1 }]));
    }

    const res = await Promise.allSettled(tasks);
    const rejected = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.map((r) => (r.reason as Error)?.message)).toEqual([]); // ไม่มี 40P01

    expect(await getQty(locA)).toBe(50); // ไป-กลับ net 0
    expect(await getQty(locB)).toBe(50);
  });

  // 7 ─────────────────────────────────────────────────────────
  it('7) invariant: sum(balance) === sum(ledger)', async () => {
    const b = await pool.query(
      `SELECT COALESCE(SUM(qty), 0)::bigint AS s FROM inventory_balances WHERE product_id = $1`,
      [productId],
    );
    const l = await pool.query(
      `SELECT COALESCE(SUM(delta), 0)::bigint AS s FROM inventory_movements WHERE product_id = $1`,
      [productId],
    );
    expect(Number(b.rows[0].s)).toBe(Number(l.rows[0].s));
  });
});
