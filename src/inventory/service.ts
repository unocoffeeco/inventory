import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Op } from './schemas.js';

export class AppError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** เทียบ payload แบบ canonical (jsonb ไม่คงลำดับ key จึงต้องเรียงก่อนเทียบ) */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** ปรับยอดแบบ atomic — delta ลบจะถูกปฏิเสธถ้ายอดไม่พอ */
async function applyDelta(c: PoolClient, productId: number, locationId: number, delta: number) {
  if (delta === 0) return;

  if (delta > 0) {
    await c.query(
      `INSERT INTO inventory_balances (product_id, location_id, qty)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, location_id)
       DO UPDATE SET qty = inventory_balances.qty + EXCLUDED.qty`,
      [productId, locationId, delta],
    );
    return;
  }

  const r = await c.query(
    `UPDATE inventory_balances
        SET qty = qty + $3
      WHERE product_id = $1 AND location_id = $2 AND qty + $3 >= 0`,
    [productId, locationId, delta],
  );
  if (r.rowCount === 0) throw new AppError('INSUFFICIENT_STOCK', 409);
}

async function addMovement(
  c: PoolClient, opId: number, lineNo: number,
  productId: number, locationId: number, delta: number,
) {
  await c.query(
    `INSERT INTO inventory_movements (operation_id, line_no, product_id, location_id, delta)
     VALUES ($1, $2, $3, $4, $5)`,
    [opId, lineNo, productId, locationId, delta],
  );
}

export async function postOperation(idempotencyKey: string, input: Op) {
  const c = await pool.connect(); // ใช้ connection เดียวตลอด transaction
  try {
    await c.query('BEGIN');

    const ins = await c.query(
      `INSERT INTO inventory_operations (idempotency_key, kind, request)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [idempotencyKey, input.kind, input],
    );

    // ส่งซ้ำด้วย key เดิม
    if (ins.rowCount === 0) {
      const prev = await c.query(
        `SELECT request, result FROM inventory_operations WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const row = prev.rows[0];
      if (canon(row.request) !== canon(input)) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      await c.query('COMMIT');
      return row.result;
    }

    const opId: number = ins.rows[0].id;
    // 1) ตรวจปลายทาง + รวมคีย์ทั้งหมดก่อนแตะข้อมูล (ทำครั้งเดียว)
    const keys: { productId: number; locationId: number }[] = [];
    for (const l of input.lines) {
      keys.push({ productId: l.productId, locationId: l.locationId });
      if (input.kind === 'transfer') {
        const dst = await c.query('SELECT 1 FROM locations WHERE id = $1', [l.toLocationId!]);
        if (dst.rowCount === 0) throw new AppError('DESTINATION_NOT_FOUND', 404);
        keys.push({ productId: l.productId, locationId: l.toLocationId! });
      }
    }
    // 2) ล็อกทุกแถวตามลำดับ global → กัน deadlock
    await lockBalances(c, keys);

    let line = 0;

    for (const l of input.lines) {
      if (input.kind === 'receipt') {
        await applyDelta(c, l.productId, l.locationId, l.qty);
        await addMovement(c, opId, ++line, l.productId, l.locationId, l.qty);
      } else if (input.kind === 'issue') {
        await applyDelta(c, l.productId, l.locationId, -l.qty);
        await addMovement(c, opId, ++line, l.productId, l.locationId, -l.qty);
      } else if (input.kind === 'adjustment') {
        await applyDelta(c, l.productId, l.locationId, l.qty);
        await addMovement(c, opId, ++line, l.productId, l.locationId, l.qty);
      } else {
        // transfer: ตรวจปลายทางให้มีจริงก่อน แล้วจึงตัดต้นทาง + เพิ่มปลายทาง
        const dst = await c.query('SELECT 1 FROM locations WHERE id = $1', [l.toLocationId!]);
        if (dst.rowCount === 0) throw new AppError('DESTINATION_NOT_FOUND', 404);

        await applyDelta(c, l.productId, l.locationId, -l.qty);
        await applyDelta(c, l.productId, l.toLocationId!, l.qty);
        await addMovement(c, opId, ++line, l.productId, l.locationId, -l.qty);
        await addMovement(c, opId, ++line, l.productId, l.toLocationId!, l.qty);
      }

    }

    const result = { operationId: opId, kind: input.kind, status: 'committed' };
    await c.query(`UPDATE inventory_operations SET result = $2 WHERE id = $1`, [opId, result]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
/** ล็อกทุกแถวที่จะแตะ ในลำดับ (product_id, location_id) เดียวกันเสมอ → ไม่มี cycle → ไม่ deadlock */
async function lockBalances(c: PoolClient, keys: { productId: number; locationId: number }[]) {
  const unique = [...new Map(keys.map((k) => [`${k.productId}:${k.locationId}`, k])).values()]
    .sort((a, b) => a.productId - b.productId || a.locationId - b.locationId);

  for (const k of unique) {           // สร้างแถวยอด 0 ให้ครบ (ลำดับเดียวกัน)
    await c.query(
      `INSERT INTO inventory_balances (product_id, location_id, qty)
       VALUES ($1, $2, 0) ON CONFLICT (product_id, location_id) DO NOTHING`,
      [k.productId, k.locationId],
    );
  }
  await c.query(
    `WITH requested AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[]) AS x(product_id, location_id)
     )
     SELECT b.product_id, b.location_id
       FROM inventory_balances b JOIN requested r USING (product_id, location_id)
      ORDER BY b.product_id, b.location_id
      FOR UPDATE OF b`,
    [unique.map((k) => k.productId), unique.map((k) => k.locationId)],
  );
}
