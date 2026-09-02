import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { authenticate, requireRoles } from '../../modules/auth/auth.guard.js';
import { AppError, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import { createIfoodProvider } from './ifood.module.js';
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
  const provider=createIfoodProvider(db,env),service=new IfoodIntegrationService(db,env,provider);
  const auth=authenticate(env,db),staff=[auth,requireRoles('TENANT_MANAGER','STORE_OPERATOR')],manager=[auth,requireRoles('TENANT_MANAGER')];
  const assertEnabled=()=>{if(!env.IFOOD_ENABLED)throw conflict('Ative IFOOD_ENABLED no backend para utilizar a integração.');};
  app.get('/integrations/ifood/health',{preHandler:staff},async request=>withTenantTransaction(db,request.auth,async client=>({
    enabled:env.IFOOD_ENABLED,mode:env.IFOOD_MODE,
    data:(await client.query(`SELECT c.id,c.store_id,c.status,c.last_worker_at,c.last_event_at,c.last_success_at,c.last_error_at,c.last_error_message,
      CASE WHEN NOT c.enabled THEN 'DISABLED' WHEN c.last_worker_at>now()-interval '90 seconds' THEN 'RUNNING' ELSE 'WORKER_NOT_SEEN' END AS worker_status,
      (SELECT count(*)::int FROM integration_events e WHERE e.integration_id=c.id AND e.status IN ('RECEIVED','ERROR')) AS pending_events
      FROM integration_connections c WHERE c.mode=$1`,[env.IFOOD_MODE])).rows,
  })));
  app.get('/integrations/ifood',{preHandler:staff},async request=>withTenantTransaction(db,request.auth,async client=>({
    enabled:env.IFOOD_ENABLED,mode:env.IFOOD_MODE,eventsMode:env.IFOOD_EVENTS_MODE,
    canSimulate:env.IFOOD_ENABLED&&env.IFOOD_MODE==='mock'&&env.NODE_ENV==='development',
    data:(await client.query(`SELECT c.*,s.name AS store_name,
      (SELECT count(*)::int FROM external_orders o WHERE o.integration_id=c.id AND o.created_at>=(date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')) AS imported_today,
      (SELECT count(*)::int FROM integration_events e WHERE e.integration_id=c.id AND e.status='ERROR') AS errors,
      (SELECT count(*)::int FROM integration_commands cmd JOIN external_orders o ON o.id=cmd.external_order_id WHERE o.integration_id=c.id AND cmd.status IN ('ERROR','UNCERTAIN')) AS command_errors
      FROM integration_connections c JOIN stores s ON s.id=c.store_id WHERE c.mode=$1 ORDER BY s.name`,[env.IFOOD_MODE])).rows,
  })));
  app.put('/integrations/ifood/connection',{preHandler:manager},async request=>{
    const input=configSchema.parse(request.body);
    return withTenantTransaction(db,request.auth,async client=>{
      const store=(await client.query<{company_id:string}>('SELECT company_id FROM stores WHERE id=$1 AND integration_in_scope(id)',[input.storeId])).rows[0];
      if(!store)throw notFound('Unidade não encontrada.');
      const existing=(await client.query<Connection>('SELECT * FROM integration_connections WHERE store_id=$1 AND mode=$2',[input.storeId,env.IFOOD_MODE])).rows[0];
      if(existing&&existing.merchant_id!==input.merchantId)throw conflict('Uma conexão existente não pode ser redirecionada para outro merchant.');
      const result=(await client.query(`INSERT INTO integration_connections(tenant_id,company_id,store_id,provider,mode,merchant_id,enabled,auto_import_orders,auto_create_delivery,events_mode,delivery_dispatch_mode,delivery_dispatch_minutes_before,configured_by,status)
        VALUES($1,$2,$3,'IFOOD',$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $6 THEN 'PENDING' ELSE 'DISABLED' END)
        ON CONFLICT(store_id,provider,mode) DO UPDATE SET enabled=EXCLUDED.enabled,auto_import_orders=EXCLUDED.auto_import_orders,auto_create_delivery=EXCLUDED.auto_create_delivery,
        delivery_dispatch_mode=EXCLUDED.delivery_dispatch_mode,delivery_dispatch_minutes_before=EXCLUDED.delivery_dispatch_minutes_before,events_mode=EXCLUDED.events_mode,
        configured_by=EXCLUDED.configured_by,status=EXCLUDED.status,updated_at=now() RETURNING id`,[request.auth.tenantId,store.company_id,input.storeId,env.IFOOD_MODE,input.merchantId,input.enabled,input.autoImportOrders,input.autoCreateDelivery,env.IFOOD_EVENTS_MODE,input.deliveryDispatchMode,input.deliveryDispatchMinutesBefore,request.auth.userId])).rows[0];
      await writeAudit(client,{tenantId:request.auth.tenantId,actorUserId:request.auth.userId,action:'integration.configured',entityType:'integration_connection',entityId:result.id,afterData:input});return result;
    });
  });
  app.post('/integrations/ifood/:id/test',{preHandler:manager},async request=>{
    assertEnabled();const {id}=idSchema.parse(request.params);
    const c=await withTenantTransaction(db,request.auth,async client=>(await client.query<Connection>('SELECT * FROM integration_connections WHERE id=$1 AND mode=$2',[id,env.IFOOD_MODE])).rows[0]);
    if(!c)throw notFound('Integração não encontrada.');
    try{const merchant=await provider.getMerchant(c.merchant_id);if(merchant.id!==c.merchant_id)throw new Error('merchant mismatch');
      await withTenantTransaction(db,request.auth,client=>client.query(`UPDATE integration_connections SET status=CASE WHEN enabled THEN 'CONNECTED' ELSE 'DISABLED' END,last_success_at=now(),last_error_message=NULL WHERE id=$1`,[id]));
      return {mode:env.IFOOD_MODE,merchant,message:env.IFOOD_MODE==='mock'?'Simulação pronta. Nenhuma conexão real realizada.':'Merchant autorizado.'};
    }catch{await withTenantTransaction(db,request.auth,client=>client.query(`UPDATE integration_connections SET status='ERROR',last_error_at=now(),last_error_message='IFOOD_CONNECTION_TEST_FAILED' WHERE id=$1`,[id]));throw new AppError(502,'IFOOD_CONNECTION_TEST_FAILED','Não foi possível validar o merchant. Confira credenciais e permissões.');}
  });
  app.get('/integrations/ifood/:id/events',{preHandler:staff},async request=>{
    const {id}=idSchema.parse(request.params);return withTenantTransaction(db,request.auth,async client=>({data:(await client.query(`SELECT id,external_event_id,external_order_id,event_code,event_full_code,status,attempts,last_error,received_at,processed_at FROM integration_events WHERE integration_id=$1 ORDER BY received_at DESC LIMIT 100`,[id])).rows}));
  });
  app.post('/integrations/ifood/events/:id/reprocess',{preHandler:manager},async request=>{
    assertEnabled();const {id}=idSchema.parse(request.params);return withTenantTransaction(db,request.auth,async client=>{
      const updated=await client.query(`UPDATE integration_events SET status='RECEIVED',attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1 AND status='ERROR' RETURNING id`,[id]);
      if(!updated.rowCount)throw notFound('Evento com erro não encontrado.');
      await writeAudit(client,{tenantId:request.auth.tenantId,actorUserId:request.auth.userId,action:'integration.event.reprocess',entityType:'integration_event',entityId:id});return {queued:true};
    });
  });
  app.get('/external-orders',{preHandler:staff},async request=>{
    const query=z.object({storeId:z.uuid().optional()}).parse(request.query);
    return withTenantTransaction(db,request.auth,async client=>({data:(await client.query(`SELECT o.id,o.external_display_id,o.external_status,o.delivery_id,o.own_delivery,o.import_state,o.created_at,s.name AS store_name,d.status AS delivery_status
      FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id JOIN stores s ON s.id=o.store_id LEFT JOIN deliveries d ON d.id=o.delivery_id
      WHERE c.mode=$1 AND ($2::uuid IS NULL OR o.store_id=$2) ORDER BY o.created_at DESC LIMIT 100`,[env.IFOOD_MODE,query.storeId??null])).rows}));
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
    assertEnabled();const {id}=idSchema.parse(request.params);
    const row=await withTenantTransaction(db,request.auth,async client=>(await client.query<{external_order_id:string}>(`SELECT o.external_order_id FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.mode=$2 AND c.enabled`,[id,env.IFOOD_MODE])).rows[0]);
    if(!row)throw notFound('Pedido não encontrado.');return {data:await provider.getCancellationReasons(row.external_order_id)};
  });
  app.post('/external-orders/:id/actions',{preHandler:staff},async request=>{
    assertEnabled();const {id}=idSchema.parse(request.params);const input=z.object({action:z.enum(['CONFIRM','PREPARE','CANCEL','RELEASE_DELIVERY','CREATE_DELIVERY']),cancellationCode:z.string().max(40).optional()}).strict().parse(request.body);
    await withTenantTransaction(db,request.auth,async client=>{const visible=await client.query(`SELECT o.id FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled AND c.mode=$2`,[id,env.IFOOD_MODE]);if(!visible.rowCount)throw notFound('Pedido ativo não encontrado.');});
    if(input.action==='RELEASE_DELIVERY')return withTenantTransaction(db,request.auth,async client=>{await service.releaseDelivery(client,request.auth,id);return {status:'RELEASED'};});
    if(input.action==='CREATE_DELIVERY')return withTenantTransaction(db,request.auth,async client=>{
      return service.createManualDelivery(client,request.auth,id);
    });
    return service.requestAction(request.auth,id,input.action,input.cancellationCode);
  });
  if(env.NODE_ENV==='development'&&env.IFOOD_MODE==='mock')app.post('/integrations/ifood/:id/simulate',{preHandler:manager,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
    assertEnabled();const {id}=idSchema.parse(request.params);const {scenario}=z.object({scenario:z.enum(['own','ifood','cash','prepaid','cancelled','duplicate'])}).strict().parse(request.body);
    const c=await withTenantTransaction(db,request.auth,async client=>(await client.query<Connection>(`SELECT * FROM integration_connections WHERE id=$1 AND mode='mock' AND enabled`,[id])).rows[0]);
    if(!c)throw notFound('Conexão de simulação ativa não encontrada.');
    const order=mockOrder(scenario,c.merchant_id);const event={id:`mock-${randomUUID()}`,orderId:order.id,merchantId:c.merchant_id,code:'PLC',fullCode:'PLACED',createdAt:new Date().toISOString(),mockOrder:order};
    await service.ingest(event);if(scenario==='duplicate')await service.ingest([event,{...event,id:`mock-${randomUUID()}`}]);
    if(scenario==='cancelled')await service.ingest({...event,id:`mock-${randomUUID()}`,code:'CAN',fullCode:'CANCELLED',createdAt:new Date(Date.now()+1).toISOString()});
    return reply.status(202).send({queued:true,externalOrderId:order.id});
  });
  app.post('/integrations/ifood/webhook',{config:{rawBody:true},bodyLimit:1_048_576},async(request,reply)=>{
    if(!env.IFOOD_ENABLED||!env.IFOOD_WEBHOOK_ENABLED||env.IFOOD_EVENTS_MODE!=='webhook')throw notFound('Webhook não habilitado.');
    const secret=env.IFOOD_MODE==='mock'?(env.IFOOD_WEBHOOK_SECRET||env.IFOOD_CLIENT_SECRET):env.IFOOD_CLIENT_SECRET;
    if(!Buffer.isBuffer(request.rawBody)||!validIfoodSignature(request.rawBody,request.headers['x-ifood-signature'],secret))throw unauthorized('Assinatura inválida.');
    await service.ingest(request.body);return reply.status(202).send({persisted:true});
  });
}
