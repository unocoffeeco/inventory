import type { Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../inventory/service.js';

/** map error → HTTP response ใช้ร่วมกันทุก router */
export function fail(res: Response, e: unknown) {
  if (e instanceof AppError) return res.status(e.status).json({ error: e.message });
  if (e instanceof ZodError) return res.status(400).json({ error: 'VALIDATION_FAILED', details: e.issues });

  const code = (e as { code?: string } | null)?.code;
  if (code === '23505') {
    return res.status(409).json({
      error: 'DUPLICATE',
      constraint: (e as { constraint?: string }).constraint,
    });
  }
  if (code === '23503') return res.status(409).json({ error: 'FOREIGN_KEY_VIOLATION' });
  if (code === '40P01') return res.status(409).json({ error: 'DEADLOCK_RETRY' });

  console.error(e);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}
