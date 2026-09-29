import { z } from 'zod';

/**
 * id จาก DB เป็น bigint → pg คืนเป็น **string** เสมอ (เหมือน operationId)
 * จึงต้อง coerce เพื่อให้ client เอา id ที่เพิ่ง GET มาใช้ต่อได้เลย
 */
const idRef = z.coerce.number().int().positive();

export const lineSchema = z.object({
  productId: idRef,
  locationId: idRef,
  toLocationId: idRef.optional(),
  qty: z.number().int(), // adjustment อนุญาตค่าลบ, ชนิดอื่นบังคับ > 0 ด้านล่าง
});

export const opSchema = z
  .object({
    kind: z.enum(['receipt', 'issue', 'transfer', 'adjustment']),
    lines: z.array(lineSchema).min(1),
  })
  .refine(
    (op) =>
      op.kind !== 'transfer' ||
      op.lines.every((l) => l.toLocationId && l.toLocationId !== l.locationId),
    { message: 'transfer requires toLocationId different from locationId' },
  )
  .refine(
    (op) =>
      op.kind === 'adjustment'
        ? op.lines.every((l) => l.qty !== 0)
        : op.lines.every((l) => l.qty > 0),
    { message: 'qty must be a positive integer (adjustment may be negative, not zero)' },
  );

export type Op = z.infer<typeof opSchema>;

/** GET /inventory/:productId/movements — paging params (default limit=100 = พฤติกรรมเดิม) */
export const movementListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
