import { z } from 'zod';

export const lineSchema = z.object({
  productId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  toLocationId: z.number().int().positive().optional(),
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
