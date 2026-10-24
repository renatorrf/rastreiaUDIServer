import { z } from 'zod';
import { confirmationPasswordSchema } from '../auth/confirm-manager-password.js';
export const variantSchema=z.object({
  name:z.string().trim().min(1).max(120),sku:z.string().trim().min(1).max(80),
  attributes:z.object({color:z.string().trim().max(60).default(''),size:z.string().trim().max(60).default('')}).strict(),
  priceCents:z.number().int().min(0).max(100000000),costCents:z.number().int().min(0).max(100000000),
  minimumStock:z.number().int().min(0).max(1000000),active:z.boolean(),
}).strict();
export const adjustmentSchema=z.object({variantId:z.uuid(),expectedVersion:z.number().int().positive(),
  delta:z.number().int().min(-1000000).max(1000000).refine(n=>n!==0),
  kind:z.enum(['ENTRY','EXIT','LOSS','CONSUMPTION','RETURN','ADJUSTMENT']),reason:z.string().trim().min(5).max(500),
  confirmationPassword:confirmationPasswordSchema,
  unitCostCents:z.number().int().min(0).max(100000000).optional(),
}).strict().refine(v=>!(['ENTRY','RETURN'].includes(v.kind)&&v.delta<0)&&!(['EXIT','LOSS','CONSUMPTION'].includes(v.kind)&&v.delta>0),{path:['delta'],message:'Confira o sinal da quantidade para o tipo de movimentação.'});
export const slugSchema=z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
export const storefrontSchema=z.object({slug:slugSchema,title:z.string().trim().min(2).max(120),description:z.string().trim().max(1000),published:z.boolean(),expectedVersion:z.number().int().min(0)}).strict();
