import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTransaction, withTenantTransaction, setTenantContext, type Database } from '../../database/pool.js';
import type { AuthContext } from '../../modules/auth/auth.types.js';
import { applyTransition, createDeliveryInTransaction, loadDelivery, cancelExternalDelivery } from '../../modules/deliveries/delivery.service.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, notFound } from '../../shared/errors.js';
import { decryptPayload, encryptPayload } from '../../shared/encrypted-payload.js';
import type { ExternalEvent, ExternalOrderAction, ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import { IfoodHttpError } from './ifood.client.js';
import { integrationSecret } from './ifood.module.js';
import { deliveryInput, normalizeIfoodOrder } from './ifood.normalizer.js';
import { advancesExternalStatus, externalStatus } from './ifood.status.js';
import { ifoodEventSchema } from './ifood.provider.js';

export interface Connection {
 id: string; tenant_id: string; company_id: string; store_id: string; configured_by: string; merchant_id: string;
 enabled: boolean; auto_import_orders: boolean; auto_create_delivery: boolean; mode: string; events_mode: string;
 delivery_dispatch_mode: 'IMMEDIATE' | 'BEFORE_READY_TIME' | 'MANUAL'; delivery_dispatch_minutes_before: number;
}
interface OrderRow { id: string; external_order_id: string; delivery_id: string | null; external_status: string; external_status_at: Date; own_delivery: boolean; payload_encrypted: string; import_state: string }
interface EventRow { id: string; integration_id: string | null; external_order_id: string; event_code: string; event_full_code: string; event_created_at: Date; attempts: number }
const commandForStatus: Record<string, ExternalOrderAction> = { CONFIRMED:'CONFIRM', PREPARATION_STARTED:'PREPARE', DISPATCHED:'DISPATCH', CANCELLED:'CANCEL' };
const safeError = (error: unknown): string => error instanceof IfoodHttpError ? error.message : error instanceof z.ZodError ? 'IFOOD_INVALID_ORDER_DATA' : error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'IFOOD_PROCESSING_ERROR';
export class IfoodIntegrationService {
  readonly secret: string;
  constructor(readonly db: Database, readonly env: AppEnv, readonly provider: ExternalOrderProvider) { this.secret = integrationSecret(env); }

  async ingest(payload: unknown): Promise<string[]> {
    const values = Array.isArray(payload) ? payload : [payload];
    const events = values.map(value => ({ event: ifoodEventSchema.parse(value), raw: value }));
    await withTransaction(this.db, async client => {
      for (const { event, raw } of events) {
        await client.query(`INSERT INTO integration_events(integration_id,provider,mode,external_event_id,merchant_id,external_order_id,event_code,event_full_code,payload_encrypted,event_created_at)
          VALUES((SELECT id FROM integration_connections WHERE provider='IFOOD' AND mode=$1 AND merchant_id=$2),'IFOOD',$1,$3,$2,$4,$5,$6,$7,$8)
          ON CONFLICT(provider,external_event_id) DO NOTHING`, [this.env.IFOOD_MODE,event.merchantId,event.id,event.orderId,event.code,event.fullCode,encryptPayload(raw,this.secret),event.createdAt]);
        await client.query(`UPDATE integration_connections SET last_event_at=now() WHERE mode=$1 AND merchant_id=$2`, [this.env.IFOOD_MODE,event.merchantId]);
      }
    });
    return events.map(({event}) => event.id); // COMMIT precedes ACK, including duplicates/unknown codes.
  }

  async poll(): Promise<void> {
    if (!this.env.IFOOD_ENABLED || this.env.IFOOD_EVENTS_MODE !== 'polling') return;
    const connections = (await this.db.query<Connection>(`UPDATE integration_connections SET next_poll_at=now()+($2::text||' milliseconds')::interval
      WHERE id IN (SELECT id FROM integration_connections WHERE enabled AND mode=$1 AND events_mode='polling' AND next_poll_at<=now() FOR UPDATE SKIP LOCKED)
      RETURNING *`,[this.env.IFOOD_MODE,this.env.IFOOD_POLLING_INTERVAL_MS])).rows;
    for (let i=0;i<connections.length;i+=100) {
      const batch=connections.slice(i,i+100);
      try {
        const events = await this.provider.pollEvents(batch.map(c=>c.merchant_id));
        const ids = await this.ingest(events);
        await this.provider.acknowledge(ids);
        await this.db.query(`UPDATE integration_connections SET last_success_at=now(),last_error_message=NULL,status='CONNECTED' WHERE id=ANY($1::uuid[])`,[batch.map(c=>c.id)]);
      } catch(error) {
        await this.db.query(`UPDATE integration_connections SET status='ERROR',last_error_at=now(),last_error_message=$2,next_poll_at=GREATEST(next_poll_at,now()+($3::text||' seconds')::interval) WHERE id=ANY($1::uuid[])`,[batch.map(c=>c.id),safeError(error),error instanceof IfoodHttpError?error.retryAfterSeconds:0]);
      }
    }
  }

  async authFor(client: PoolClient, connection: Connection): Promise<AuthContext> {
    const member = (await client.query<{ role: 'TENANT_MANAGER' | 'STORE_OPERATOR' }>(`SELECT m.role FROM tenant_users m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND m.role IN ('TENANT_MANAGER','STORE_OPERATOR')
      AND has_store_access(m.user_id,$3)`,[connection.tenant_id,connection.configured_by,connection.store_id])).rows[0];
    if (!member) throw new Error('IFOOD_CONFIGURATION_ACCESS_REVOKED');
    const auth: AuthContext = { userId:connection.configured_by,tenantId:connection.tenant_id,role:member.role,storeIds:[connection.store_id],sessionId:connection.id };
    await setTenantContext(client,auth);
    return auth;
  }

  async processEvents(limit=25): Promise<number> {
    if (!this.env.IFOOD_ENABLED) return 0;
    await this.db.query(`UPDATE integration_events e SET integration_id=c.id,status='RECEIVED',attempts=0,next_attempt_at=now(),last_error=NULL
      FROM integration_connections c WHERE e.integration_id IS NULL AND c.merchant_id=e.merchant_id AND c.mode=e.mode AND c.provider=e.provider AND c.enabled AND e.mode=$1`,[this.env.IFOOD_MODE]);
    const pending = (await this.db.query<EventRow>(`SELECT e.* FROM integration_events e LEFT JOIN integration_connections c ON c.id=e.integration_id
      WHERE e.mode=$1 AND e.status IN ('RECEIVED','ERROR') AND e.attempts<5 AND e.next_attempt_at<=now()
      AND (c.id IS NULL OR (c.enabled AND (c.auto_import_orders OR EXISTS(SELECT 1 FROM external_orders o WHERE o.integration_id=c.id AND o.external_order_id=e.external_order_id)))) ORDER BY e.event_created_at,e.received_at LIMIT $2`,[this.env.IFOOD_MODE,limit])).rows;
    for (const event of pending) {
      try {
        const status=externalStatus(event.event_code,event.event_full_code);
        const rejected=event.event_full_code==='CANCELLATION_REQUEST_FAILED'||event.event_code==='CANCELLATION_REQUEST_FAILED';
        // Details always obtained from provider, not from event metadata.
        const raw=event.integration_id && status ? await this.provider.getOrder(event.external_order_id) : null;
        if(raw!==null)await this.db.query('UPDATE integration_events SET order_payload_encrypted=$2 WHERE id=$1 AND order_payload_encrypted IS NULL',[event.id,encryptPayload(raw,this.secret)]);
        await withTransaction(this.db,async client=>{
          const locked=(await client.query<EventRow & {status:string}>(`SELECT * FROM integration_events WHERE id=$1 FOR UPDATE`,[event.id])).rows[0]!;
          if (!['RECEIVED','ERROR'].includes(locked.status)) return;
          if(rejected&&event.integration_id){
            await client.query(`UPDATE integration_commands SET status='ERROR',last_error='IFOOD_CANCELLATION_REJECTED',updated_at=now() WHERE operation='CANCEL'
              AND external_order_id IN(SELECT id FROM external_orders WHERE integration_id=$1 AND external_order_id=$2) AND status<>'CONFIRMED'`,[event.integration_id,event.external_order_id]);
            await client.query(`UPDATE integration_events SET status='PROCESSED',processed_at=now() WHERE id=$1`,[event.id]);return;
          }
          if (!status || !event.integration_id) {
            await client.query(`UPDATE integration_events SET status='IGNORED',processed_at=now(),last_error=$2 WHERE id=$1`,[event.id,!event.integration_id?'IFOOD_MERCHANT_NOT_CONFIGURED':'IFOOD_EVENT_NOT_USED']);return;
          }
          const c=(await client.query<Connection>(`SELECT * FROM integration_connections WHERE id=$1 FOR UPDATE`,[event.integration_id])).rows[0]!;
          if (!c.enabled || c.mode!==this.env.IFOOD_MODE) return;
          if (!c.auto_import_orders && !(await client.query('SELECT id FROM external_orders WHERE integration_id=$1 AND external_order_id=$2',[c.id,event.external_order_id])).rowCount) return;
          const auth=await this.authFor(client,c);
          const normalized=normalizeIfoodOrder(raw);
          if (normalized.id!==event.external_order_id || normalized.merchantId!==c.merchant_id) throw new Error('IFOOD_ORDER_MERCHANT_MISMATCH');
          const inserted=await client.query<OrderRow>(`INSERT INTO external_orders(tenant_id,company_id,store_id,integration_id,external_order_id,external_display_id,external_status,external_status_at,own_delivery,payload_encrypted,ready_at,import_state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(integration_id,external_order_id) DO NOTHING RETURNING *`,
            [c.tenant_id,c.company_id,c.store_id,c.id,normalized.id,normalized.displayId,status,event.event_created_at,normalized.ownDelivery,encryptPayload(raw,this.secret),normalized.expectedAt,normalized.ownDelivery?'IMPORTED':'IGNORED_NOT_OWN_DELIVERY']);
          const order=inserted.rows[0] ?? (await client.query<OrderRow>(`SELECT * FROM external_orders WHERE integration_id=$1 AND external_order_id=$2 FOR UPDATE`,[c.id,normalized.id])).rows[0]!;
          const advances=inserted.rowCount || (event.event_created_at>=order.external_status_at && advancesExternalStatus(order.external_status,status));
          if (advances) {
            await client.query(`UPDATE external_orders SET external_status=$2,external_status_at=$3,payload_encrypted=$4,ready_at=$5,updated_at=now() WHERE id=$1`,[order.id,status,event.event_created_at,encryptPayload(raw,this.secret),normalized.expectedAt]);
            order.external_status=status;
          }
          if (normalized.ownDelivery && order.own_delivery && !order.delivery_id && c.auto_create_delivery && !['CANCELLED','CONCLUDED','DISPATCHED'].includes(order.external_status)) {
            const delivery=await createDeliveryInTransaction(client,auth,deliveryInput(normalized,c.store_id),undefined,'DRAFT');
            order.delivery_id=delivery.id;
            await client.query(`UPDATE external_orders SET delivery_id=$2 WHERE id=$1`,[order.id,delivery.id]);
            await client.query(`UPDATE deliveries SET origin='IFOOD',external_order_id=$2 WHERE id=$1`,[delivery.id,order.id]);
          }
          if (advances && order.own_delivery) {
            if (status==='CANCELLED' && order.delivery_id) await cancelExternalDelivery(client,auth,order.delivery_id,`Cancelamento confirmado pelo iFood (${event.id})`);
            if (['CONFIRMED','PREPARATION_STARTED'].includes(status)) {
              await client.query(`UPDATE external_orders SET dispatch_due_at=CASE WHEN $2='IMMEDIATE' THEN now() WHEN $2='BEFORE_READY_TIME' AND ready_at IS NOT NULL
                THEN ready_at-($3::text||' minutes')::interval ELSE NULL END WHERE id=$1 AND dispatch_due_at IS NULL`,[order.id,c.delivery_dispatch_mode,c.delivery_dispatch_minutes_before]);
            }
            const operation=commandForStatus[status];
            if (operation) await client.query(`UPDATE integration_commands SET status='CONFIRMED',confirmed_at=now(),updated_at=now() WHERE external_order_id=$1 AND operation=$2`,[order.id,operation]);
          }
          await client.query(`UPDATE integration_events SET status=$2,attempts=attempts+1,processed_at=now(),last_error=NULL WHERE id=$1`,[event.id,normalized.ownDelivery?'PROCESSED':'IGNORED']);
          await client.query(`UPDATE integration_connections SET last_success_at=now(),last_error_message=NULL,status='CONNECTED' WHERE id=$1`,[c.id]);
          await writeAudit(client,{tenantId:c.tenant_id,actorUserId:null,action:'integration.event.processed',entityType:'external_order',entityId:order.id,
            afterData:{provider:'IFOOD',eventId:event.id,externalStatus:order.external_status,deliveryId:order.delivery_id,ownDelivery:order.own_delivery}});
          await client.query(`INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'external_order',$2,'external-order.changed',$3::jsonb)`,[c.tenant_id,order.id,JSON.stringify({storeId:c.store_id,deliveryId:order.delivery_id})]);
          await client.query(`SELECT pg_notify('rastreia_operation_changed',$1)`,[JSON.stringify({storeId:c.store_id,tenantId:c.tenant_id})]);
        });
      } catch(error) {
        const delay=Math.max(30*2**event.attempts,error instanceof IfoodHttpError?error.retryAfterSeconds:0);
        await this.db.query(`UPDATE integration_events SET status='ERROR',attempts=attempts+1,last_error=$2,next_attempt_at=now()+($3::text||' seconds')::interval WHERE id=$1 AND status IN ('RECEIVED','ERROR')`,[event.id,safeError(error),Math.min(3600,delay)]);
        if(event.integration_id) await this.db.query(`UPDATE integration_connections SET status='ERROR',last_error_at=now(),last_error_message=$2 WHERE id=$1`,[event.integration_id,safeError(error)]);
      }
    }
    return pending.length;
  }

  async releaseDue(): Promise<void> {
    const due=(await this.db.query<{id:string;integration_id:string}>(`SELECT o.id,o.integration_id FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id JOIN deliveries d ON d.id=o.delivery_id
      WHERE c.enabled AND c.mode=$1 AND o.own_delivery
      AND CASE WHEN c.delivery_dispatch_mode='IMMEDIATE' THEN now() WHEN c.delivery_dispatch_mode='BEFORE_READY_TIME' THEN o.ready_at-(c.delivery_dispatch_minutes_before::text||' minutes')::interval ELSE NULL END<=now()
      AND o.external_status IN ('CONFIRMED','PREPARATION_STARTED') AND d.status='DRAFT' LIMIT 25`,[this.env.IFOOD_MODE])).rows;
    for(const order of due) await withTransaction(this.db,async client=>{
      const c=(await client.query<Connection>('SELECT * FROM integration_connections WHERE id=$1 FOR UPDATE',[order.integration_id])).rows[0]!;
      if(!c.enabled)return;
      const auth=await this.authFor(client,c);
      await this.releaseDelivery(client,auth,order.id);
    });
  }
  async releaseDelivery(client:PoolClient,auth:AuthContext,id:string):Promise<void>{
    const order=(await client.query<OrderRow>(`SELECT o.* FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled AND c.mode=$2 FOR UPDATE OF o,c`,[id,this.env.IFOOD_MODE])).rows[0];
    if(!order?.own_delivery||!order.delivery_id)throw conflict('Pedido sem entrega própria criada.');
    if(!['CONFIRMED','PREPARATION_STARTED'].includes(order.external_status))throw conflict('Aguarde a confirmação do pedido pelo iFood.');
    const delivery=await loadDelivery(client,auth,order.delivery_id,true);
    if(delivery.status!=='DRAFT')return;
    await applyTransition(client,auth,delivery,'AWAITING_COURIER','Busca de entregador liberada para pedido externo');
    await client.query(`INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'delivery',$2,'delivery.created',$3::jsonb)`,[auth.tenantId,delivery.id,JSON.stringify({storeId:delivery.storeId})]);
    await client.query(`SELECT pg_notify('rastreia_operation_changed',$1)`,[JSON.stringify({storeId:delivery.storeId,tenantId:auth.tenantId})]);
  }

  async createManualDelivery(client:PoolClient,auth:AuthContext,id:string){
    const order=(await client.query<OrderRow & {store_id:string}>(`SELECT o.* FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled AND c.mode=$2 FOR UPDATE OF o,c`,[id,this.env.IFOOD_MODE])).rows[0];
    if(!order?.own_delivery)throw conflict('Pedido sem logística própria.');
    if(order.delivery_id)return {deliveryId:order.delivery_id};
    if(['CANCELLED','CONCLUDED','DISPATCHED'].includes(order.external_status))throw conflict('Pedido não está disponível para nova entrega.');
    const normalized=normalizeIfoodOrder(decryptPayload(order.payload_encrypted,this.secret));
    const delivery=await createDeliveryInTransaction(client,auth,deliveryInput(normalized,order.store_id),undefined,'DRAFT');
    await client.query('UPDATE external_orders SET delivery_id=$2 WHERE id=$1',[id,delivery.id]);
    await client.query(`UPDATE deliveries SET origin='IFOOD',external_order_id=$2 WHERE id=$1`,[delivery.id,id]);
    return {deliveryId:delivery.id};
  }

  async requestAction(auth:AuthContext,id:string,action:Exclude<ExternalOrderAction,'DISPATCH'>,cancellationCode?:string){
    const order=await withTenantTransaction(this.db,auth,async client=>(await client.query<OrderRow>(`SELECT o.* FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled AND c.mode=$2`,[id,this.env.IFOOD_MODE])).rows[0]);
    if(!order)throw notFound('Pedido externo não encontrado.');
    let payload={};
    if(action==='CANCEL'){
      const reason=(await this.provider.getCancellationReasons(order.external_order_id)).find(item=>item.cancellationCode===cancellationCode);
      if(!reason)throw conflict('Selecione uma razão de cancelamento disponível no iFood.');
      payload=reason;
    }
    return withTenantTransaction(this.db,auth,async client=>{
      const current=(await client.query<OrderRow>(`SELECT o.* FROM external_orders o JOIN integration_connections c ON c.id=o.integration_id WHERE o.id=$1 AND c.enabled AND c.mode=$2 FOR UPDATE OF o,c`,[id,this.env.IFOOD_MODE])).rows[0];
      if(!current?.own_delivery)throw conflict('Somente pedidos de entrega própria podem ser operados aqui.');
      if(['CANCELLED','CONCLUDED'].includes(current.external_status))throw conflict('Pedido externo encerrado.');
      if(action==='CONFIRM'&&current.external_status!=='PLACED')throw conflict('Este pedido já foi confirmado pelo iFood.');
      if(action==='PREPARE'&&!['CONFIRMED','PREPARATION_STARTED'].includes(current.external_status))throw conflict('Aguarde a confirmação do iFood.');
      if(action==='PREPARE') { const normalized=normalizeIfoodOrder(decryptPayload(current.payload_encrypted,this.secret)); if(normalized.readyAt&&Date.parse(normalized.readyAt)>Date.now())throw conflict('Respeite o horário de início do preparo agendado.'); }
      await client.query(`INSERT INTO integration_commands(external_order_id,operation,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(external_order_id,operation) DO NOTHING`,[id,action,JSON.stringify(payload)]);
      await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'integration.command.requested',entityType:'external_order',entityId:id,afterData:{operation:action}});
      return (await client.query('SELECT id,operation,status,last_error FROM integration_commands WHERE external_order_id=$1 AND operation=$2',[id,action])).rows[0];
    });
  }

  async processCommands():Promise<void>{
    // A crash after reserving a mutation is ambiguous: never blindly resend it.
    await this.db.query(`UPDATE integration_commands SET status='UNCERTAIN',last_error='IFOOD_SEND_OUTCOME_UNKNOWN' WHERE status='SENDING' AND updated_at<now()-interval '2 minutes'`);
    for(let n=0;n<25;n++){
      const command=await withTransaction(this.db,async client=>{
        const row=(await client.query<{id:string;external_order_id:string;provider_order_id:string;operation:ExternalOrderAction;payload:{cancellationCode:string;description:string};attempts:number;merchant_id:string}>(`SELECT cmd.*,o.external_order_id AS provider_order_id,c.merchant_id FROM integration_commands cmd JOIN external_orders o ON o.id=cmd.external_order_id JOIN integration_connections c ON c.id=o.integration_id
          WHERE cmd.status='REQUESTED' AND cmd.next_attempt_at<=now() AND cmd.attempts<5 AND c.enabled AND c.mode=$1 AND o.own_delivery
          AND o.external_status NOT IN ('CANCELLED','CONCLUDED') ORDER BY cmd.created_at FOR UPDATE OF cmd SKIP LOCKED LIMIT 1`,[this.env.IFOOD_MODE])).rows[0];
        if(row)await client.query(`UPDATE integration_commands SET status='SENDING',attempts=attempts+1,updated_at=now() WHERE id=$1`,[row.id]);return row;
      });
      if(!command)break;
      try{
        switch(command.operation){
          case 'CONFIRM':await this.provider.confirmOrder(command.provider_order_id);break;
          case 'PREPARE':await this.provider.startPreparation(command.provider_order_id);break;
          case 'DISPATCH':await this.provider.dispatchOrder(command.provider_order_id);break;
          case 'CANCEL':await this.provider.requestCancellation(command.provider_order_id,command.payload);break;
        }
        await this.db.query(`UPDATE integration_commands SET status='REQUEST_SENT',sent_at=now(),updated_at=now(),last_error=NULL WHERE id=$1 AND status='SENDING'`,[command.id]);
        if(this.env.IFOOD_MODE==='mock'){
          const codes={CONFIRM:['CFM','CONFIRMED'],PREPARE:['PRP','PREPARATION_STARTED'],DISPATCH:['DSP','DISPATCHED'],CANCEL:['CAN','CANCELLED']} as const;
          const [code,fullCode]=codes[command.operation];
          const event:ExternalEvent={id:`mock-command-${command.id}`,orderId:command.provider_order_id,merchantId:command.merchant_id,code,fullCode,createdAt:new Date().toISOString()};
          await this.ingest(event);
        }
      }catch(error){
        const knownRejection=error instanceof IfoodHttpError&&[400,401,403,404,409,422,429].includes(error.status);
        const retry=error instanceof IfoodHttpError&&error.status===429&&command.attempts<4;
        await this.db.query(`UPDATE integration_commands SET status=$2,last_error=$3,next_attempt_at=now()+($4::text||' seconds')::interval,updated_at=now() WHERE id=$1 AND status='SENDING'`,[command.id,retry?'REQUESTED':knownRejection?'ERROR':'UNCERTAIN',safeError(error),Math.max(30,error instanceof IfoodHttpError?error.retryAfterSeconds:0)]);
      }
    }
  }
}
