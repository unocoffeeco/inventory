import { Router } from 'express';
import { pool } from '../db/pool.js';
import { AppError, postOperation } from './service.js';
import { movementListSchema, opSchema } from './schemas.js';
import { requireScope } from '../auth/apiKeys.js';
import { fail } from '../http/fail.js';

export const router = Router();

/** map error → response ใช้ร่วมกันทุก handler */
router.post('/operations', requireScope('inventory:write'), async (req, res) => {
  try {
    const key = req.header('Idempotency-Key');
    if (!key) throw new AppError('Idempotency-Key header is required', 400);

    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHORIZED', 401);

    // actor: ค่าจาก client ถ้าส่งมา ไม่งั้น fallback เป็นชื่อ key (ไม่มีทางว่าง)
    const actor = (req.header('X-Actor') ?? '').trim() || auth.name;
    if (actor.length > 100) throw new AppError('X-Actor must be at most 100 characters', 400);

    const input = opSchema.parse(req.body);
    res.json(await postOperation(key, input, { apiKeyId: auth.keyId, actor }));
  } catch (e) {
    fail(res, e);
  }
});

router.get('/', requireScope('inventory:read'), async (req, res) => {
  try {
    const locationId = Number(req.query.location_id);
    if (!Number.isInteger(locationId)) return res.status(400).json({ error: 'location_id required' });
    const r = await pool.query(
      `SELECT b.product_id, p.sku, b.location_id, b.qty
         FROM inventory_balances b
         JOIN products p ON p.id = b.product_id
        WHERE b.location_id = $1
        ORDER BY p.sku`,
      [locationId],
    );
    res.json(r.rows);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/:productId/movements', requireScope('inventory:read'), async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId)) return res.status(400).json({ error: 'invalid product id' });
    const q = movementListSchema.parse(req.query);
    const r = await pool.query(
      `SELECT m.location_id, m.delta, m.created_at, o.kind, o.actor, o.api_key_id
         FROM inventory_movements m
         JOIN inventory_operations o ON o.id = m.operation_id
        WHERE m.product_id = $1
        ORDER BY m.created_at DESC, m.operation_id DESC, m.line_no DESC
        LIMIT $2 OFFSET $3`,
      [productId, q.limit, q.offset],
    );
    res.json(r.rows);
  } catch (e) {
    fail(res, e);
  }
});
