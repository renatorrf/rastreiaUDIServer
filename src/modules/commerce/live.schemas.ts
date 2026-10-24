import { z } from 'zod';

export const liveInput = z.object({
  title:z.string().trim().min(2).max(160), scheduledAt:z.iso.datetime({offset:true}).nullable().default(null),
  productIds:z.array(z.uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,'Não repita produtos na sessão.'),
}).strict();
export const liveVersion = z.object({expectedVersion:z.number().int().positive()}).strict();
export const liveHighlight = liveVersion.extend({action:z.enum(['SELECT','NEXT','PREVIOUS','HIDE']),productId:z.uuid().optional()})
  .refine(input=>(input.action==='SELECT')===!!input.productId,'Informe um produto somente para a ação SELECT.');
export const liveList = z.object({status:z.enum(['ACTIVE','ALL']).default('ACTIVE'),limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(100000).default(0)});
