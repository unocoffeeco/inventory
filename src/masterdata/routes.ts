import { Router } from 'express';
import { pool } from '../db/pool.js';
import { AppError } from '../inventory/service.js';
import { requireScope } from '../auth/apiKeys.js';
import { fail } from '../http/fail.js';
import {
  locationCreateSchema, locationUpdateSchema,
  productCreateSchema, productUpdateSchema,
} from './schemas.js';

export const productsRouter = Router();
export const locationsRouter = Router();

// ---------------- products ----------------
productsRouter.get('/', requireScope('inventory:read'), async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1';
    const r = await pool.query(
      `SELECT id, sku, name, base_unit, archived_at
         FROM products
        WHERE ($1::boolean OR archived_at IS NULL)
        ORDER BY sku`,
      [includeArchived],
    );
    res.json(r.rows);
  } catch (e) { fail(res, e); }
});

productsRouter.post('/', requireScope('inventory:write'), async (req, res) => {
  try {
    const b = productCreateSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO products (sku, name, base_unit)
       VALUES ($1, $2, $3)
       RETURNING id, sku, name, base_unit, archived_at`,
      [b.sku, b.name, b.baseUnit],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { fail(res, e); }
});

productsRouter.patch('/:id', requireScope('inventory:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('invalid product id', 400);
    const b = productUpdateSchema.parse(req.body);
    if (Object.keys(b).length === 0) throw new AppError('NOTHING_TO_UPDATE', 400);

    const r = await pool.query(
      `UPDATE products
          SET sku       = COALESCE($2, sku),
              name      = COALESCE($3, name),
              base_unit = COALESCE($4, base_unit)
        WHERE id = $1 AND archived_at IS NULL
        RETURNING id, sku, name, base_unit, archived_at`,
      [id, b.sku ?? null, b.name ?? null, b.baseUnit ?? null],
    );
    if (r.rowCount === 0) throw new AppError('PRODUCT_NOT_FOUND', 404);
    res.json(r.rows[0]);
  } catch (e) { fail(res, e); }
});

productsRouter.delete('/:id', requireScope('inventory:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('invalid product id', 400);
    const r = await pool.query(
      `UPDATE products SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    if (r.rowCount === 0) throw new AppError('PRODUCT_NOT_FOUND', 404);
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

// ---------------- locations ----------------
locationsRouter.get('/', requireScope('inventory:read'), async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1';
    const r = await pool.query(
      `SELECT id, code, archived_at
         FROM locations
        WHERE ($1::boolean OR archived_at IS NULL)
        ORDER BY code`,
      [includeArchived],
    );
    res.json(r.rows);
  } catch (e) { fail(res, e); }
});

locationsRouter.post('/', requireScope('inventory:write'), async (req, res) => {
  try {
    const b = locationCreateSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO locations (code) VALUES ($1) RETURNING id, code, archived_at`,
      [b.code],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { fail(res, e); }
});

locationsRouter.patch('/:id', requireScope('inventory:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('invalid location id', 400);
    const b = locationUpdateSchema.parse(req.body);
    if (Object.keys(b).length === 0) throw new AppError('NOTHING_TO_UPDATE', 400);

    const r = await pool.query(
      `UPDATE locations SET code = COALESCE($2, code)
        WHERE id = $1 AND archived_at IS NULL
        RETURNING id, code, archived_at`,
      [id, b.code ?? null],
    );
    if (r.rowCount === 0) throw new AppError('LOCATION_NOT_FOUND', 404);
    res.json(r.rows[0]);
  } catch (e) { fail(res, e); }
});

locationsRouter.delete('/:id', requireScope('inventory:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('invalid location id', 400);
    const r = await pool.query(
      `UPDATE locations SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    if (r.rowCount === 0) throw new AppError('LOCATION_NOT_FOUND', 404);
    res.status(204).end();
  } catch (e) { fail(res, e); }
});
