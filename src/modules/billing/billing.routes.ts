import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import { conflict, notFound } from '../../shared/errors.js';
import { parseIdempotencyKey } from '../../shared/idempotency.js';
import { authenticate, authenticatePlatform, requireRoles } from '../auth/auth.guard.js';
import { withPlatformIdempotency } from '../platform/platform-idempotency.js';
import { billingProfileSchema, invoiceSchema, moneySchema, cents } from './billing.schemas.js';
import type { BillingProfileRow } from './billing.types.js';
import { createInvoice, invoiceDetail, invoiceSelect, lockInvoice, masterAudit, reconcileFinancialHold,
  recordInvoiceState, registerInvoicePayment, saveBillingProfile } from './billing.service.js';

const idOf=(request:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(request.params).id;
const reasonSchema=z.object({reason:z.string().trim().min(5).max(500)});
export async function billingRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  const master=authenticatePlatform(env,database);
  const manager=[authenticate(env,database),requireRoles('TENANT_MANAGER')];
  const mutate=async(request:FastifyRequest,reply:FastifyReply,operation:string,payload:unknown,
    execute:(client:PoolClient,key:string)=>Promise<unknown>)=>{
    const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,
      operation,payload,async()=>({statusCode:200,body:await execute(client,key)})));
    reply.header('Idempotency-Replayed',String(result.replayed));return reply.code(result.statusCode).send(result.body);
  };
  app.get('/platform/stores/:id/billing',{preHandler:master},async request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const profile=(await client.query<BillingProfileRow>('SELECT * FROM billing_profiles WHERE store_id=$1',[idOf(request)])).rows[0];
    if(!profile)throw notFound();const {tax_id_encrypted,...safe}=profile;
    return {...safe,...decryptPayload<{taxId:string}>(tax_id_encrypted,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER)};
  }));
  app.put('/platform/stores/:id/billing',{preHandler:master},async(request,reply)=>{
    const id=idOf(request);const input=z.object({profile:billingProfileSchema,version:z.number().int().positive().optional(),
      reason:z.string().trim().min(5).max(500)}).parse(request.body);
    return mutate(request,reply,'billing.profile',{id,...input},client=>saveBillingProfile(client,env,request.platformAuth,id,input.profile,input.reason,input.version));
  });
  const list=async(client:PoolClient,query:unknown)=>{
    const filters=z.object({storeId:z.string().uuid().optional(),status:z.enum(['DRAFT','ISSUED','OVERDUE','DELINQUENT','PAID','CANCELLED']).optional(),
      from:z.iso.date().optional(),to:z.iso.date().optional(),limit:z.coerce.number().int().min(1).max(200).default(100),
      offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(query);
    const result=await client.query(`${invoiceSelect} WHERE ($1::uuid IS NULL OR invoice.store_id=$1)
      AND ($2::text IS NULL OR invoice.status=$2) AND ($3::date IS NULL OR invoice.due_date>=$3)
      AND ($4::date IS NULL OR invoice.due_date<=$4) ORDER BY invoice.due_date DESC,invoice.id LIMIT $5 OFFSET $6`,
    [filters.storeId??null,filters.status??null,filters.from??null,filters.to??null,filters.limit,filters.offset]);return {data:result.rows};
  };
  app.get('/platform/invoices',{preHandler:master},request=>withPlatformTransaction(database,request.platformAuth,client=>list(client,request.query)));
  app.get('/me/invoices',{preHandler:manager},request=>withTenantTransaction(database,request.auth,client=>list(client,request.query)));
  app.get('/platform/invoices/:id',{preHandler:master},request=>withPlatformTransaction(database,request.platformAuth,client=>invoiceDetail(client,idOf(request))));
  app.get('/me/invoices/:id',{preHandler:manager},request=>withTenantTransaction(database,request.auth,client=>invoiceDetail(client,idOf(request))));
  app.post('/platform/invoices',{preHandler:master},async(request,reply)=>{
    const input=invoiceSchema.parse(request.body);return mutate(request,reply,'invoice.create',input,client=>createInvoice(client,request.platformAuth,input));
  });
  app.patch('/platform/invoices/:id',{preHandler:master},async(request,reply)=>{
    const id=idOf(request);const input=z.object({invoice:invoiceSchema,version:z.number().int().positive()}).parse(request.body);
    return mutate(request,reply,'invoice.edit',{id,...input},async client=>{
      const before=await lockInvoice(client,id);
      if(before.status!=='DRAFT'||before.version!==input.version)throw conflict('Somente rascunhos atuais podem ser alterados.');
      if(before.store_id!==input.invoice.storeId)throw conflict('Não é permitido transferir uma fatura para outra unidade.');
      await client.query(`UPDATE invoices SET period=$2,charge_type=$3,description=$4,due_date=$5,version=version+1,updated_at=now() WHERE id=$1`,
      [id,input.invoice.period,input.invoice.chargeType,input.invoice.description,input.invoice.dueDate]);
      await client.query('DELETE FROM invoice_items WHERE invoice_id=$1',[id]);
      for(const item of input.invoice.items)await client.query('INSERT INTO invoice_items(tenant_id,invoice_id,description,amount) VALUES($1,$2,$3,$4)',
        [before.tenant_id,id,item.description,item.amount]);
      await masterAudit(client,request.platformAuth,{action:'invoice.edited',entityType:'invoice',entityId:id,tenantId:before.tenant_id,
        before,after:input.invoice,reason:input.invoice.reason});return invoiceDetail(client,id);
    });
  });
  for(const action of ['issue','cancel'] as const) {
    app.post(`/platform/invoices/:id/${action}`,{preHandler:master},async(request,reply)=>{
      const id=idOf(request);const input=reasonSchema.parse(request.body);
      return mutate(request,reply,`invoice.${action}`,{id,...input},async client=>{
        const invoice=await lockInvoice(client,id);const detail=await invoiceDetail(client,id);
        if(action==='issue' && (invoice.status!=='DRAFT'||cents(detail.total)<=0n))throw conflict('Somente rascunho com total positivo pode ser emitido.');
        if(action==='cancel' && (['PAID','CANCELLED'].includes(invoice.status)||cents(detail.paid)>0n))throw conflict('Fatura com pagamento não pode ser cancelada nesta etapa.');
        await recordInvoiceState(client,invoice,action==='issue'?'ISSUED':'CANCELLED',input.reason,request.platformAuth.userId);
        await reconcileFinancialHold(client,invoice.store_id,request.platformAuth.userId);
        await masterAudit(client,request.platformAuth,{action:`invoice.${action}`,entityType:'invoice',entityId:id,tenantId:invoice.tenant_id,
          before:{status:invoice.status},after:{status:action==='issue'?'ISSUED':'CANCELLED'},reason:input.reason});return invoiceDetail(client,id);
      });
    });
  }
  app.post('/platform/invoices/:id/register-payment',{preHandler:master},async(request,reply)=>{
    const id=idOf(request);const input=reasonSchema.extend({amount:moneySchema,paidAt:z.iso.datetime().refine(value=>new Date(value)<=new Date(),
      'O pagamento não pode estar no futuro.'),method:z.string().trim().min(2).max(50),reference:z.string().trim().max(200).optional()}).parse(request.body);
    return mutate(request,reply,'invoice.payment',{id,...input},(client,key)=>registerInvoicePayment(client,request.platformAuth,id,key,input));
  });
  for(const action of ['waive','release'] as const) {
    app.post(`/platform/stores/:id/financial-hold/${action}`,{preHandler:master},async(request,reply)=>{
      const id=idOf(request);const input=reasonSchema.extend({until:z.iso.datetime().refine(value=>new Date(value)>new Date()
        && new Date(value).getTime()-Date.now()<=366*86400000,'Informe um prazo futuro de até um ano.')}).parse(request.body);
      return mutate(request,reply,`billing.${action}`,{id,...input},async client=>{
        const store=(await client.query('SELECT id,tenant_id FROM stores WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!store)throw notFound();
        const before=(await client.query('SELECT * FROM unit_financial_holds WHERE store_id=$1',[id])).rows[0];
        await client.query(`INSERT INTO unit_financial_holds(tenant_id,store_id,waiver_until,released_at,reason,actor_platform_admin_id)
          VALUES($1,$2,$3,now(),$4,$5) ON CONFLICT(store_id) DO UPDATE SET waiver_until=EXCLUDED.waiver_until,released_at=now(),
          reason=EXCLUDED.reason,actor_platform_admin_id=EXCLUDED.actor_platform_admin_id,updated_at=now()`,
        [store.tenant_id,id,input.until,input.reason,request.platformAuth.userId]);
        await masterAudit(client,request.platformAuth,{action:`billing.hold_${action}`,entityType:'store',entityId:id,tenantId:store.tenant_id,
          before,after:input,reason:input.reason});return {releasedUntil:input.until};
      });
    });
  }
  const summary=async(client:PoolClient)=>{
    const totals=await client.query(`SELECT COALESCE(sum(balance) FILTER(WHERE status='ISSUED'),0)::text AS upcoming,
      COALESCE(sum(balance) FILTER(WHERE status IN ('OVERDUE','DELINQUENT')),0)::text AS overdue,
      COALESCE(sum(balance) FILTER(WHERE status='DELINQUENT'),0)::text AS delinquent,
      COALESCE(sum(paid),0)::text AS received FROM (SELECT status,
        COALESCE((SELECT sum(amount) FROM invoice_items WHERE invoice_id=invoices.id),0)-
        COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0) AS balance,
        COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id=invoices.id
          AND paid_at>=date_trunc('month',now())),0) AS paid FROM invoices) totals`);
    const holds=await client.query(`SELECT hold.store_id,store.name AS store_name,hold.scheduled_at,hold.waiver_until,
      (hold.blocked_at IS NOT NULL AND hold.released_at IS NULL AND (hold.waiver_until IS NULL OR hold.waiver_until<=now())) AS blocked
      FROM unit_financial_holds hold JOIN stores store ON store.id=hold.store_id WHERE hold.released_at IS NULL`);
    const notices=await client.query(`${invoiceSelect} WHERE invoice.status='DELINQUENT'
      ORDER BY invoice.suspension_scheduled_at,invoice.id LIMIT 20`);
    return {...totals.rows[0],holds:holds.rows,notices:notices.rows};
  };
  app.get('/platform/billing/summary',{preHandler:master},request=>withPlatformTransaction(database,request.platformAuth,summary));
  app.get('/me/billing-status',{preHandler:manager},request=>withTenantTransaction(database,request.auth,summary));
}
