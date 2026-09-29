import { Router } from 'express';
import { ZodError } from 'zod';
import { pool } from '../db/pool.js';
import { AppError, postOperation } from './service.js';
import { opSchema } from './schemas.js';
import { requireScope } from '../auth/apiKeys.js';

export const router = Router();

router.post('/operations', requireScope('inventory:write'), async (req, res) => {
  try {
    const key = req.header('Idempotency-Key');
    if (!key) throw new AppError('Idempotency-Key header is required', 400);
    const input = opSchema.parse(req.body);
    res.json(await postOperation(key, input));
  } catch (e) {
    if (e instanceof AppError) return res.status(e.status).json({ error: e.message });
    if (e instanceof ZodError) return res.status(400).json({ error: 'VALIDATION_FAILED', details: e.issues });
    if ((e as any)?.code === '23503') return res.status(409).json({ error: 'FOREIGN_KEY_VIOLATION' });
    if ((e as any)?.code === '40P01') return res.status(409).json({ error: 'DEADLOCK_RETRY' });
    console.error(e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/', requireScope('inventory:read'), async (req, res) => {
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
});

router.get('/:productId/movements', requireScope('inventory:read'), async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId)) return res.status(400).json({ error: 'invalid product id' });
  const r = await pool.query(
    `SELECT m.location_id, m.delta, m.created_at, o.kind
       FROM inventory_movements m
       JOIN inventory_operations o ON o.id = m.operation_id
      WHERE m.product_id = $1
      ORDER BY m.created_at DESC, m.line_no DESC
      LIMIT 100`,
    [productId],
  );
  res.json(r.rows);
});
