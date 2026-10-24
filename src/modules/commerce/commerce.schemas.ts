import { z } from 'zod';

const cents = z.number().int().min(0).max(100_000_000);
export const listSchema = z.object({
  search: z.string().trim().max(160).default(''),
  status: z.enum(['all', 'active', 'archived']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const categorySchema = z.object({ name: z.string().trim().min(2).max(100), active: z.boolean() }).strict();
export const productSchema = z.object({
  name: z.string().trim().min(2).max(160), sku: z.string().trim().min(1).max(80),
  barcode: z.string().regex(/^[0-9]{8,14}$/).nullable().optional(),
  description: z.string().trim().max(2000).default(''), categoryId: z.string().uuid().nullable(),
  priceCents: cents, costCents: cents, active: z.boolean(),
  stockMode: z.enum(['STOCKED', 'MADE_TO_ORDER']).optional(),
  acceptsNotes: z.boolean().optional(),
}).strict();
export const planSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120), monthlyPriceCents: cents,
  monthlyLiveLimit: z.number().int().min(1).max(1000),
  maxDurationMinutes: z.number().int().min(1).max(120),
  maxConcurrentViewers: z.number().int().min(1).max(200),
  expectedVersion: z.number().int().min(0), reason: z.string().trim().min(5).max(500),
}).strict();
export const subscriptionSchema = z.object({
  planVersionId: z.string().uuid(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  reason: z.string().trim().min(5).max(500),
}).strict().refine(value => new Date(value.endsAt) > new Date(value.startsAt), {
  path: ['endsAt'], message: 'O fim da vigência deve ser posterior ao início.',
});
export const cancellationSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(500) }).strict();
