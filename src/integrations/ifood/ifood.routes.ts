import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { confirmManagerPassword } from '../../modules/auth/confirm-manager-password.js';
import { authenticate, requireRoles } from '../../modules/auth/auth.guard.js';
import { companyServiceConfigured,resolveCompanyService } from '../../modules/company-settings/company-settings.service.js';
import { AppError, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import { createIfoodProvider,createIfoodProviderForCompany,ifoodConfigForCompany } from './ifood.module.js';
import { IfoodIntegrationService, type Connection } from './ifood.integration.js';
import { mockOrder } from './ifood.mock.js';
import { normalizeIfoodOrder } from './ifood.normalizer.js';

export function validIfoodSignature(raw: Buffer, signature: unknown, secret: string): boolean {
  if (!secret || typeof signature!=='string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256',secret).update(raw).digest(),Buffer.from(signature,'hex'));
}
const configSchema=z.object({storeId:z.uuid(),merchantId:z.uuid(),enabled:z.boolean(),autoImportOrders:z.boolean(),autoCreateDelivery:z.boolean(),
  deliveryDispatchMode:z.enum(['IMMEDIATE','BEFORE_READY_TIME','MANUAL']),deliveryDispatchMinutesBefore:z.number().int().min(0).max(120)}).strict();
const idSchema=z.object({id:z.uuid()});
export async function ifoodRoutes(app:FastifyInstance,db:Database,env:AppEnv):Promise<void>{
  const provider=createIfoodProvider(db,env),service=new IfoodIntegrationService(db,env,provider,
    (companyId,mode)=>createIfoodProviderForCompany(db,env,companyId,mode));
  const auth=authenticate(env,db),staff=[auth,requireRoles('TENANT_MANAGER','STORE_OPERATOR')],manager=[auth,requireRoles('TENANT_MANAGER')];
  const protectedManager=[...manager,confirmManagerPassword(db)];
  const confirmationLimit={rateLimit:{max:5,timeWindow:'1 minute'}};
  app.get('/integrations/ifood/health',{preHandler:manager},async request=>withTenantTransaction(db,request.auth,async client=>({
    enabled:true,mode:'company',
    data:(await client.query(`SELECT c.id,c.store_id,c.status,c.last_worker_at,c.last_event_at,c.last_success_at,c.last_error_at,c.last_error_message,
      CASE WHEN NOT c.enabled THEN 'DISABLED' WHEN c.last_worker_at>now()-interval '90 seconds' THEN 'RUNNING' ELSE 'WORKER_NOT_SEEN' END AS worker_status,
      (SELECT count(*)::int FROM integration_events e WHERE e.integration_id=c.id AND e.status IN ('RECEIVED','ERROR')) AS pending_events
      FROM integration_connections c`)).rows,
  })));
  app.get('/integrations/ifood',{preHandler:manager},async request=>withTenantTransaction(db,request.auth,async client=>({
    enabled:true,mode:'company',eventsMode:'company',
    canSimulate:env.NODE_ENV==='development',
    data:(await client.query(`SELECT c.*,s.name AS store_name,
      (SELECT count(*)::int FROM external_orders o WHERE o.integration_id=c.id AND o.created_at>=(date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')) AS imported_today,
      (SELECT count(*)::int FROM integration_events e WHERE e.integration_id=c.id AND e.status='ERROR') AS errors,
      (SELECT count(*)::int FROM integration_commands cmd JOIN external_orders o ON o.id=cmd.external_order_id WHERE o.integration_id=c.id AND cmd.status IN ('ERROR','UNCERTAIN')) AS command_errors
      FROM integration_connections c JOIN stores s ON s.id=c.store_id ORDER BY s.name`)).rows,
  })));
  app.put('/integrations/ifood/connection',{preHandler:protectedManager,config:confirmationLimit},async request=>{
    const body={...(request.body as Record<string,unknown>)};delete body['confirmationPassword'];
    const input=configSchema.parse(body);
    return withTenantTransaction(db,request.auth,async client=>{
      const store=(await client.query<{company_id:string}>('SELECT company_id FROM stores WHERE id=$1 AND integration_in_scope(id)',[input.storeId])).rows[0];
      if(!store)throw notFound('Unidade não encontrada.');
      const settings=await resolveCompanyService(client,env,store.company_id,'IFOOD');
      if(!companyServiceConfigured(settings))throw conflict('Configure e ative o iFood para esta empresa antes de vincular a unidade.');
      const mode=String(settings.values['mode']??env.IFOOD_MODE);
      const eventsMode=String(settings.values['eventsMode']??env.IFOOD_EVENTS_MODE);
      const existing=(await client.query<Connection>('SELECT * FROM integration_connections WHERE store_id=$1 AND mode=$2',[input.storeId,mode])).rows[0];
      if(existing&&existing.merchant_id!==input.merchantId)throw conflict('Uma conexão existente não pode ser redirecionada para outro merchant.');
      const result=(await client.query(`INSERT INTO integration_connections(tenant_id,company_id,store_id,provider,mode,merchant_id,enabled,auto_import_orders,auto_create_delivery,events_mode,delivery_dispatch_mode,delivery_dispatch_minutes_before,configured_by,status)
        VALUES($1,$2,$3,'IFOOD',$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $6 THEN 'PENDING' ELSE 'DISABLED' END)
        ON CONFLICT(store_id,provider,mode) DO UPDATE SET enabled=EXCLUDED.enabled,auto_import_orders=EXCLUDED.auto_import_orders,auto_create_delivery=EXCLUDED.auto_create_delivery,
        delivery_dispatch_mode=EXCLUDED.delivery_dispatch_mode,delivery_dispatch_minutes_before=EXCLUDED.delivery_dispatch_minutes_before,events_mode=EXCLUDED.events_mode,
        configured_by=EXCLUDED.configured_by,status=EXCLUDED.status,updated_at=now() RETURNING id`,[request.auth.tenantId,store.company_id,input.storeId,mode,input.merchantId,input.enabled,input.autoImportOrders,input.autoCreateDelivery,eventsMode,input.deliveryDispatchMode,input.deliveryDispatchMinutesBefore,request.auth.userId])).rows[0];
      await writeAudit(client,{tenantId:request.auth.tenantId,actorUserId:request.auth.userId,action:'integration.configured',entityType:'integration_connection',entityId:result.id,afterData:input});return result;
    });
  });
  app.post('/integrations/ifood/:id/test',{preHandler:protectedManager,config:confirmationLimit},async request=>{
    const {id}=idSchema.parse(request.params);
    const c=await withTenantTransaction(db,request.auth,async client=>(await client.query<Connection>('SELECT * FROM integration_connections WHERE id=$1',[id])).rows[0]);
    if(!c)throw notFound('Integração não encontrada.');
    try{const companyProvider=await service.providerForCompany(c.company_id,c.mode);const merchant=await companyProvider.getMerchant(c.merchant_id);if(merchant.id!==c.merchant_id)throw new Error('merchant mismatch');
      await withTenantTransaction(db,request.auth,client=>client.query(`UPDATE integration_connections SET status=CASE WHEN enabled THEN 'CONNECTED' ELSE 'DISABLED' END,last_success_at=now(),last_error_message=NULL WHERE id=$1`,[id]));
      return {mode:c.mode,merchant,message:c.mode==='mock'?'Simulação pronta. Nenhuma conexão real realizada.':'Merchant autorizado.'};
    }catch{await withTenantTransaction(db,request.auth,client=>client.query(`UPDATE integration_connections SET status='ERROR',last_error_at=now(),last_error_message='IFOOD_CONNECTION_TEST_FAILED' WHERE id=$1`,[id]));throw new AppError(502,'IFOOD_CONNECTION_TEST_FAILED','Não foi possível validar o merchant. Confira credenciais e permissões.');}
  });
  app.get('/integrations/ifood/:id/events',{preHandler:manager},async request=>{
    const {id}=idSchema.parse(request.params);return withTenantTransaction(db,request.auth,async client=>({data:(await client.query(`SELECT id,external_event_id,external_order_id,event_code,event_full_code,status,attempts,last_error,received_at,processed_at FROM integration_events WHERE integration_id=$1 ORDER BY received_at DESC LIMIT 100`,[id])).rows}));
  });
  app.post('/integrations/ifood/events/:id/reprocess',{preHandler:protectedManager,config:confirmationLimit},async request=>{
    const {id}=idSchema.parse(request.params);return withTenantTransaction(db,request.auth,async client=>{
      const updated=await client.query(`UPDATE integration_events SET status='RECEIVED',attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1 AND status='ERROR' RETURNING id`,[id]);
      if(!updated.rowCount)throw notFound('Evento com erro não encontrado.');
      await writeAudit(client,{tenantId:request.auth.tenantId,actorUserId:request.auth.userId,action:'integration.event.reprocess',entityType:'integration_event',entityId:id});return {queued:true};
    });
  });
  app.get('/external-orders',{preHandler:staff},async request=>{
    const query=z.object({storeId:z.uuid().optional()}).parse(request.query);
    return withTenantTransaction(db,request.auth,async client=>({data:(await client.query(`SELECT o.id,o.external_display_id,o.external_status,o.delivery_id,o.own_delivery,o.import_state,o.created_at,s.name AS store_name,d.status AS delivery_status
      FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id JOIN stores s ON s.id=o.store_id LEFT JOIN deliveries d ON d.id=o.delivery_id
      WHERE ($1::uuid IS NULL OR o.store_id=$1) ORDER BY o.created_at DESC LIMIT 100`,[query.storeId??null])).rows}));
  });
  app.get('/external-orders/:id',{preHandler:staff},async request=>{
    const {id}=idSchema.parse(request.params);return withTenantTransaction(db,request.auth,async client=>{
      const row=(await client.query<{payload_encrypted:string;integration_id:string;external_order_id:string;external_status:string;delivery_id:string|null}>('SELECT * FROM external_orders WHERE id=$1',[id])).rows[0];if(!row)throw notFound('Pedido não encontrado.');
      const order=normalizeIfoodOrder(decryptPayload(row.payload_encrypted,service.secret));
      const commands=(await client.query('SELECT id,operation,status,attempts,last_error,created_at,sent_at,confirmed_at FROM integration_commands WHERE external_order_id=$1 ORDER BY created_at',[id])).rows;
      const events=(await client.query('SELECT event_full_code,status,received_at,processed_at,last_error FROM integration_events WHERE integration_id=$1 AND external_order_id=$2 ORDER BY event_created_at',[row.integration_id,row.external_order_id])).rows;
      return {id,order,externalStatus:row.external_status,deliveryId:row.delivery_id,commands,events};
    });
  });
  app.get('/external-orders/:id/cancellation-reasons',{preHandler:staff},async request=>{
    const {id}=idSchema.parse(request.params);
    const row=await withTenantTransaction(db,request.auth,async client=>(await client.query<{external_order_id:string;company_id:string;mode:string}>(`SELECT o.external_order_id,c.company_id,c.mode FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled`,[id])).rows[0]);
    if(!row)throw notFound('Pedido não encontrado.');
    const companyProvider=await service.providerForCompany(row.company_id,row.mode);
    return {data:await companyProvider.getCancellationReasons(row.external_order_id)};
  });
  app.post('/external-orders/:id/actions',{preHandler:staff},async request=>{
    const {id}=idSchema.parse(request.params);const input=z.object({action:z.enum(['CONFIRM','PREPARE','CANCEL','RELEASE_DELIVERY','CREATE_DELIVERY']),cancellationCode:z.string().max(40).optional()}).strict().parse(request.body);
    await withTenantTransaction(db,request.auth,async client=>{const visible=await client.query(`SELECT o.id FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled`,[id]);if(!visible.rowCount)throw notFound('Pedido ativo não encontrado.');});
    if(input.action==='RELEASE_DELIVERY')return withTenantTransaction(db,request.auth,async client=>{await service.releaseDelivery(client,request.auth,id);return {status:'RELEASED'};});
    if(input.action==='CREATE_DELIVERY')return withTenantTransaction(db,request.auth,async client=>{
      return service.createManualDelivery(client,request.auth,id);
    });
    return service.requestAction(request.auth,id,input.action,input.cancellationCode);
  });
  if(env.NODE_ENV==='development'&&env.IFOOD_MODE==='mock')app.post('/integrations/ifood/:id/simulate',{preHandler:protectedManager,config:confirmationLimit},async(request,reply)=>{
    const body={...(request.body as Record<string,unknown>)};delete body['confirmationPassword'];
    const {id}=idSchema.parse(request.params);const {scenario}=z.object({scenario:z.enum(['own','ifood','cash','prepaid','cancelled','duplicate'])}).strict().parse(body);
    const c=await withTenantTransaction(db,request.auth,async client=>(await client.query<Connection>(`SELECT * FROM integration_connections WHERE id=$1 AND mode='mock' AND enabled`,[id])).rows[0]);
    if(!c)throw notFound('Conexão de simulação ativa não encontrada.');
    const order=mockOrder(scenario,c.merchant_id);const event={id:`mock-${randomUUID()}`,orderId:order.id,merchantId:c.merchant_id,code:'PLC',fullCode:'PLACED',createdAt:new Date().toISOString(),mockOrder:order};
    await service.ingest(event,'mock');if(scenario==='duplicate')await service.ingest([event,{...event,id:`mock-${randomUUID()}`}],'mock');
    if(scenario==='cancelled')await service.ingest({...event,id:`mock-${randomUUID()}`,code:'CAN',fullCode:'CANCELLED',createdAt:new Date(Date.now()+1).toISOString()},'mock');
    return reply.status(202).send({queued:true,externalOrderId:order.id});
  });
  app.post('/integrations/ifood/webhook',{config:{rawBody:true},bodyLimit:1_048_576},async(request,reply)=>{
    const events=Array.isArray(request.body)?request.body:[request.body];
    const merchantId=z.uuid().parse((events[0] as {merchantId?:unknown}|undefined)?.merchantId);
    const connection=(await db.query<{company_id:string;mode:string}>(`SELECT company_id,mode FROM integration_connections
      WHERE provider='IFOOD' AND merchant_id=$1 AND enabled AND events_mode='webhook' ORDER BY updated_at DESC LIMIT 1`,[merchantId])).rows[0];
    if(!connection)throw notFound('Webhook não habilitado para este merchant.');
    const settings=await ifoodConfigForCompany(db,env,connection.company_id);
    if(!companyServiceConfigured(settings)||settings.values['webhookEnabled']!==true||settings.values['eventsMode']!=='webhook')throw notFound('Webhook não habilitado.');
    const secret=String(settings.values['webhookSecret']||settings.values['clientSecret']||'');
    if(!Buffer.isBuffer(request.rawBody)||!validIfoodSignature(request.rawBody,request.headers['x-ifood-signature'],secret))throw unauthorized('Assinatura inválida.');
    await service.ingest(request.body,connection.mode);return reply.status(202).send({persisted:true});
  });
}
