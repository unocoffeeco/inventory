import { z } from 'zod';

export const productCreateSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  baseUnit: z.string().trim().min(1).max(32),
});
export const productUpdateSchema = productCreateSchema.partial();

export const locationCreateSchema = z.object({
  code: z.string().trim().min(1).max(32),
});
export const locationUpdateSchema = locationCreateSchema.partial();

