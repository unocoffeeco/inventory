import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pool } from '../db/pool.js';

export const SCOPES = ['inventory:read', 'inventory:write'] as const;
export type Scope = (typeof SCOPES)[number];

/** inv1.<uuid key_id>.<secret base64url> */
const KEY_RE = /^Bearer\s+inv1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function requireScope(scope: Scope): RequestHandler {
  return async (req, res, next) => {
    const unauthorized = () => {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    };

    const m = KEY_RE.exec(req.header('authorization') ?? '');
    if (!m) return unauthorized();

    try {
      const [, keyId, secret] = m;
      const r = await pool.query<{ secret_hash: Buffer; scopes: string[] }>(
        `SELECT secret_hash, scopes
           FROM api_keys
          WHERE key_id = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())`,
        [keyId],
      );
      const row = r.rows[0];
      if (!row) return unauthorized();

      const given = sha256(secret);
      const stored = Buffer.from(row.secret_hash);
      // timingSafeEqual ต้องยาวเท่ากัน ไม่งั้นมัน throw
      if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
        return unauthorized();
      }

      if (!row.scopes.includes(scope)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      next();
    } catch (e) {
      // fail CLOSED เสมอ — DB ล่มต้องไม่กลายเป็นประตูเปิด
      console.error('[auth] api key lookup failed', e);
      return res.status(503).json({ error: 'AUTH_UNAVAILABLE' });
    }
  };
}
