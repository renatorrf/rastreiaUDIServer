import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction,type Database } from '../../database/pool.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { parseIdempotencyKey,withIdempotency } from '../../shared/idempotency.js';
import { requireCommerceStore } from './commerce.service.js';
import { financeCancel,financeCategory,financeCost,financeEntry,financePage,financePayment,financePeriod,financeReverse } from './finance.schemas.js';
import { cancelFinanceEntry,createFinanceCategory,createFinanceEntry,financeEntries,financeReport,initializeFinanceCost,reverseFinanceSettlement,seedFinanceCategories,settleFinanceEntry } from './finance.service.js';
const ids=z.object({storeId:z.uuid(),id:z.uuid().optional(),paymentId:z.uuid().optional()});
export async function financeRoutes(app:FastifyInstance,db:Database,env:AppEnv){
 const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')],base='/commerce/stores/:storeId/finance';
 const read=(req:FastifyRequest,reply:FastifyReply,run:(c:PoolClient,store:string)=>Promise<unknown>)=>{reply.header('Cache-Control','no-store');const {storeId}=ids.parse(req.params);return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);return run(c,storeId);});};
 const write=(req:FastifyRequest,reply:FastifyReply,operation:string,input:unknown,run:(c:PoolClient,store:string,id:string,paymentId:string)=>Promise<unknown>)=>{
  const p=ids.parse(req.params),key=parseIdempotencyKey(req.headers['idempotency-key']);return withTenantTransaction(db,req.auth,async c=>{
   await requireCommerceStore(c,p.storeId);const result=await withIdempotency(c,req.auth,key,'commerce.finance.'+operation,{...p,input},async()=>({statusCode:200,body:await run(c,p.storeId,p.id??'',p.paymentId??'')}));
   return reply.header('Cache-Control','no-store').header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
  });
 };
 app.get(base+'/report',{preHandler:manager},(req,reply)=>{const f=financePeriod.parse(req.query);return read(req,reply,(c,s)=>financeReport(c,s,f.from,f.to));});
 app.get(base+'/categories',{preHandler:manager},(req,reply)=>read(req,reply,async(c,s)=>({data:(await c.query('SELECT id,name,direction,dre_group AS "dreGroup" FROM commerce_finance_categories WHERE store_id=$1 ORDER BY direction,name',[s])).rows})));
 app.post(base+'/categories/defaults',{preHandler:manager},(req,reply)=>{z.object({}).strict().parse(req.body);return write(req,reply,'defaults',{},(c,s)=>seedFinanceCategories(c,req.auth,s));});
 app.post(base+'/categories',{preHandler:manager},(req,reply)=>{const i=financeCategory.parse(req.body);return write(req,reply,'category',i,(c,s)=>createFinanceCategory(c,req.auth,s,i));});
 app.get(base+'/entries',{preHandler:manager},(req,reply)=>{const f=financePeriod.safeExtend(financePage.shape).parse(req.query);return read(req,reply,(c,s)=>financeEntries(c,s,f.from,f.to,f.limit,f.offset));});
 app.post(base+'/entries',{preHandler:manager},(req,reply)=>{const i=financeEntry.parse(req.body);return write(req,reply,'entry',i,(c,s)=>createFinanceEntry(c,req.auth,s,i));});
 app.post(base+'/entries/:id/cancel',{preHandler:manager},(req,reply)=>{const i=financeCancel.parse(req.body);return write(req,reply,'cancel',i,(c,s,id)=>cancelFinanceEntry(c,req.auth,s,id,i));});
 app.post(base+'/entries/:id/settlements',{preHandler:manager},(req,reply)=>{const i=financePayment.parse(req.body);return write(req,reply,'settle',i,(c,s,id)=>settleFinanceEntry(c,req.auth,s,id,i));});
 app.post(base+'/entries/:id/settlements/:paymentId/reverse',{preHandler:manager},(req,reply)=>{const i=financeReverse.parse(req.body);return write(req,reply,'reverse',i,(c,s,id,p)=>reverseFinanceSettlement(c,req.auth,s,id,p,i));});
 app.get(base+'/entries/:id/settlements',{preHandler:manager},(req,reply)=>read(req,reply,async(c,s)=>({data:(await c.query(`SELECT id,amount_cents::float8 AS "amountCents",paid_date::text AS "paidDate",method,note,reversed_date::text AS "reversedDate",reverse_reason AS "reverseReason" FROM commerce_finance_settlements WHERE store_id=$1 AND entry_id=$2 ORDER BY created_at DESC,id LIMIT 500`,[s,ids.parse(req.params).id])).rows})));
 app.get(base+'/inventory',{preHandler:manager},(req,reply)=>{const f=financePage.parse(req.query);return read(req,reply,async(c,s)=>({data:(await c.query(`SELECT v.id,p.name AS "productName",v.name,v.sku,p.stock_mode AS "stockMode",v.cost_cents AS "estimatedCostCents",v.price_cents AS "priceCents",b.on_hand AS "onHand",b.reserved,b.version,
 b.average_cost_cents::float8 AS "averageCostCents",round(b.on_hand*b.average_cost_cents)::float8 AS "valueCents" FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.store_id=$1 ORDER BY (b.average_cost_cents IS NULL AND p.stock_mode='STOCKED' AND b.on_hand>0) DESC,p.name,v.name,v.id LIMIT $2 OFFSET $3`,[s,f.limit,f.offset])).rows,total:Number((await c.query('SELECT count(*) FROM commerce_variants WHERE store_id=$1',[s])).rows[0]!.count)}));});
 app.post(base+'/inventory/:id/initialize-cost',{preHandler:manager},(req,reply)=>{const i=financeCost.parse(req.body);return write(req,reply,'cost',i,(c,s,id)=>initializeFinanceCost(c,req.auth,s,id,i));});
}
