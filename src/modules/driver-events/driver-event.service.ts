import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { createEventSchema, eventPolicies, recentEventLocation, type CreateEventInput, type DriverEvent,
  type DriverEventPublisher, type DriverEventUpdate } from './driver-event.types.js';

const activeStatuses = ['ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','RETURN_STARTED'];
export const eventSelect = `SELECT event.id,event.tenant_id AS "tenantId",event.company_id AS "companyId",event.store_id AS "storeId",
 event.courier_profile_id AS "courierId",person.name AS "courierName",event.delivery_id AS "deliveryId",event.batch_id AS "batchId",
 event.current_delivery_id AS "currentDeliveryId",delivery.external_reference AS "deliveryReference",batch.label AS "batchLabel",
 event.event_type AS "eventType",event.scope,event.severity,event.status,event.description,event.latitude,event.longitude,
 event.location_captured_at AS "locationCapturedAt",event.occurred_at AS "occurredAt",event.resolved_at AS "resolvedAt",
 event.resolved_by_user_id AS "resolvedByUserId",event.created_by AS "createdBy",event.customer_visibility AS "customerVisibility",event.affects_eta AS "affectsEta"
 FROM driver_operational_events event JOIN courier_profiles profile ON profile.id=event.courier_profile_id
 JOIN users person ON person.id=profile.user_id LEFT JOIN deliveries delivery ON delivery.id=event.current_delivery_id
 LEFT JOIN routes batch ON batch.id=event.batch_id`;
export const labelEvent = (row:DriverEvent):DriverEvent => ({...row,label:eventPolicies[row.eventType].label});
async function readEvent(client:PoolClient,id:string,lock=false):Promise<DriverEvent> {
  const row=(await client.query<DriverEvent>(`${eventSelect} WHERE event.id=$1 ${lock?'FOR UPDATE OF event':''}`,[id])).rows[0];
  if(!row)throw notFound('Ocorrência não encontrada.');return labelEvent(row);
}
interface DeliveryContext {id:string;storeId:string;companyId:string;batchId:string|null;status:string}
export async function eventContext(client:PoolClient,auth:AuthContext,input:Pick<CreateEventInput,'deliveryId'|'batchId'>) {
  if(auth.role!=='COURIER')throw forbidden('Somente o entregador registra uma ocorrência operacional.');
  const profile=(await client.query<{id:string}>(`SELECT id FROM courier_profiles WHERE user_id=$1 AND status='ACTIVE' FOR UPDATE`,[auth.userId])).rows[0];
  if(!profile)throw notFound('Entregador ativo não encontrado.');
  const deliveries=(await client.query<DeliveryContext>(`SELECT delivery.id,delivery.store_id AS "storeId",store.company_id AS "companyId",
    delivery.route_id AS "batchId",delivery.status FROM deliveries delivery JOIN stores store ON store.id=delivery.store_id
    WHERE delivery.courier_profile_id=$1 AND delivery.status::text=ANY($2::text[]) ORDER BY delivery.created_at,delivery.id FOR SHARE OF delivery`,
  [profile.id,activeStatuses])).rows;
  let selected:DeliveryContext|undefined;
  let batchId=input.batchId;
  if(input.deliveryId) {
    selected=deliveries.find(row=>row.id===input.deliveryId);
    if(!selected)throw notFound('Pedido ativo do entregador não encontrado.');
    if(batchId&&selected.batchId!==batchId)throw conflict('Pedido e lote não correspondem.');
    batchId=selected.batchId??undefined;
  }
  if(!selected&&!batchId) {
    const operations=new Set(deliveries.map(row=>row.batchId??row.id));
    if(!operations.size)throw conflict('Não há entrega ou lote ativo para registrar a ocorrência.');
    if(operations.size!==1)throw conflict('Há mais de uma operação ativa. Abra a entrega ou o lote correspondente.');
    batchId=deliveries[0]!.batchId??undefined;
    if(!batchId)selected=deliveries[0];
  }
  if(batchId) {
    const batch=(await client.query(`SELECT id FROM routes WHERE id=$1 AND courier_profile_id=$2 AND status IN ('DRAFT','ACTIVE') FOR SHARE`,[batchId,profile.id])).rows[0];
    if(!batch)throw notFound('Lote ativo do entregador não encontrado.');
    // The next pending stop is authoritative; a client cannot substitute an arbitrary current order.
    const next=(await client.query<{deliveryId:string}>(`SELECT delivery_id AS "deliveryId" FROM route_stops WHERE route_id=$1 AND status='PENDING' ORDER BY sequence LIMIT 1`,[batchId])).rows[0];
    selected=deliveries.find(row=>row.id===next?.deliveryId);
    if(!selected)throw conflict('O lote não possui uma parada atual ativa.');
    if(input.deliveryId&&input.deliveryId!==selected.id)throw conflict('Este pedido não é a parada atual do lote. Abra a parada atual.');
  }
  if(!selected)throw conflict('Não foi possível determinar a operação atual.');
  return {courierId:profile.id,delivery:selected,batchId:batchId??null,
    batchDeliveryIds:deliveries.filter(row=>row.batchId===batchId).map(row=>row.id)};
}

async function recordChange(client:PoolClient,auth:AuthContext,event:DriverEvent,action:DriverEventUpdate['action'],ip?:string) {
  await client.query(`INSERT INTO driver_operational_event_history(tenant_id,event_id,status,actor_user_id) VALUES($1,$2,$3,$4)`,
    [auth.tenantId,event.id,event.status,auth.userId]);
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:`driver-event.${action}`,entityType:'driver_operational_event',
    entityId:event.id,afterData:{status:event.status,eventType:event.eventType,scope:event.scope,deliveryId:event.deliveryId,batchId:event.batchId,
      currentDeliveryId:event.currentDeliveryId,latitude:event.latitude,longitude:event.longitude,locationCapturedAt:event.locationCapturedAt},
    ...(ip?{ip}:{})});
  await client.query(`INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,'driver_operational_event',$2,$3,$4::jsonb)`,[auth.tenantId,event.id,`driver-event.${action}`,
    JSON.stringify({eventId:event.id,storeId:event.storeId,severity:event.severity})]);
}
async function publishCommitted(database:Database,auth:AuthContext,id:string,action:DriverEventUpdate['action'],publisher:DriverEventPublisher) {
  // Read the latest state, including on idempotent retries after a lost response/publication.
  const update=await withTenantTransaction(database,auth,async client=>({action,event:await readEvent(client,id),
    deliveryIds:(await client.query<{id:string}>('SELECT delivery_id AS id FROM driver_event_deliveries WHERE event_id=$1',[id])).rows.map(row=>row.id)}));
  await publisher.publishEvent({...update,action:update.event.status==='OPEN'?action:update.event.status==='RESOLVED'?'resolved':'updated'});
}
export async function createDriverEvent(database:Database,auth:AuthContext,key:string,raw:CreateEventInput,publisher:DriverEventPublisher,ip?:string) {
  const input=createEventSchema.parse(raw);
  const result=await withTenantTransaction(database,auth,client=>withIdempotency(client,auth,key,'driver-event.create',input,async()=>{
    const encoding=(await client.query<{encoding:string}>("SELECT current_setting('server_encoding') AS encoding")).rows[0]?.encoding;
    if(encoding==='LATIN1'&&Array.from(input.description??'').some(char=>char.codePointAt(0)!>255))
      throw new AppError(400,'UNSUPPORTED_DESCRIPTION_CHARACTERS','Esta base ainda usa LATIN1. Escreva a observação sem emojis ou caracteres especiais não latinos.');
    const context=await eventContext(client,auth,input);const policy=eventPolicies[input.eventType];
    const scope=policy.deliverySpecific?'DELIVERY':context.batchId?'BATCH':'DRIVER';
    const duplicate=await client.query(`SELECT id FROM driver_operational_events WHERE courier_profile_id=$1 AND event_type=$2
      AND status='OPEN' AND scope=$3 AND COALESCE(delivery_id,batch_id,current_delivery_id)=$4`,
      [context.courierId,input.eventType,scope,scope==='DELIVERY'?context.delivery.id:context.batchId??context.delivery.id]);
    if(duplicate.rowCount)throw conflict('Este tipo de ocorrência já está aberto nesta operação. Resolva a anterior antes de registrar outra.');
    const stored=(await client.query<{latitude:number;longitude:number;accuracy:number;capturedAt:Date}>(
      `SELECT latitude,longitude,accuracy,captured_at AS "capturedAt" FROM courier_last_locations
       WHERE courier_profile_id=$1 AND store_id=$2`,[context.courierId,context.delivery.storeId])).rows[0];
    const local=input.location?recentEventLocation({...input.location,capturedAt:new Date(input.location.capturedAt)}):null;
    const last=recentEventLocation(stored);const location=local&&(!last||local.capturedAt>last.capturedAt)?local:last;
    const id=randomUUID();
    await client.query(`INSERT INTO driver_operational_events(id,tenant_id,company_id,store_id,courier_profile_id,delivery_id,batch_id,
      current_delivery_id,event_type,scope,severity,description,latitude,longitude,location_captured_at,created_by,customer_visibility,affects_eta,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
    [id,auth.tenantId,context.delivery.companyId,context.delivery.storeId,context.courierId,scope==='DELIVERY'?context.delivery.id:null,
      context.batchId,context.delivery.id,input.eventType,scope,policy.severity,input.description||null,
      location?.latitude??null,location?.longitude??null,location?.capturedAt??null,auth.userId,policy.customerVisibility,policy.affectsEta,
      JSON.stringify({locationSource:location?(location===local?'TRACKING_SERVICE':'SERVER_LAST_LOCATION'):'UNAVAILABLE',locationAccuracy:location?.accuracy??null})]);
    const affected=scope==='BATCH'?context.batchDeliveryIds:[context.delivery.id];
    await client.query(`INSERT INTO driver_event_deliveries(tenant_id,event_id,delivery_id) SELECT $1,$2,unnest($3::uuid[])`,[auth.tenantId,id,affected]);
    const event=await readEvent(client,id);await recordChange(client,auth,event,'created',ip);
    return {statusCode:201,body:event};
  }));
  await publishCommitted(database,auth,result.body.id,'created',publisher);return result;
}
export async function closeDriverEvent(database:Database,auth:AuthContext,key:string,id:string,status:'RESOLVED'|'CANCELLED',publisher:DriverEventPublisher,ip?:string) {
  const result=await withTenantTransaction(database,auth,client=>withIdempotency(client,auth,key,'driver-event.close',{id,status},async()=>{
    const event=await readEvent(client,id,true);
    if(event.status===status)return {statusCode:200,body:event};
    if(event.status!=='OPEN')throw conflict('Esta ocorrência já foi encerrada.');
    if(status==='CANCELLED'&&auth.role==='COURIER')throw forbidden('Somente a operação pode cancelar uma ocorrência.');
    await client.query(`UPDATE driver_operational_events SET status=$2,resolved_at=now(),resolved_by_user_id=$3 WHERE id=$1`,[id,status,auth.userId]);
    const updated=await readEvent(client,id);await recordChange(client,auth,updated,status==='RESOLVED'?'resolved':'updated',ip);
    return {statusCode:200,body:updated};
  }));
  await publishCommitted(database,auth,id,status==='RESOLVED'?'resolved':'updated',publisher);return result;
}
export interface EventFilters {status?:string|undefined;deliveryId?:string|undefined;batchId?:string|undefined;storeId?:string|undefined;limit?:number|undefined}
interface EventTimelineRow {id:string;eventId:string|null;status:string;actorUserId:string|null;actorName:string;occurredAt:Date;kind?:string}
export async function listDriverEventsInTransaction(client:PoolClient,filters:EventFilters={}) {
  return (await client.query<DriverEvent>(`${eventSelect} WHERE ($1::text IS NULL OR event.status=$1)
    AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM driver_event_deliveries affected WHERE affected.event_id=event.id AND affected.delivery_id=$2))
    AND ($3::uuid IS NULL OR event.batch_id=$3) AND ($4::uuid IS NULL OR event.store_id=$4)
    ORDER BY CASE event.status WHEN 'OPEN' THEN 0 ELSE 1 END,CASE event.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,event.occurred_at DESC LIMIT $5`,
  [filters.status??null,filters.deliveryId??null,filters.batchId??null,filters.storeId??null,filters.limit??200])).rows.map(labelEvent);
}
export async function listDriverEvents(database:Database,auth:AuthContext,filters:EventFilters) {
  return withTenantTransaction(database,auth,async client=>{
    const data=await listDriverEventsInTransaction(client,filters);
    const timeline=(await client.query<EventTimelineRow>(`SELECT history.id,history.event_id AS "eventId",history.status,history.actor_user_id AS "actorUserId",
      actor.name AS "actorName",history.occurred_at AS "occurredAt" FROM driver_operational_event_history history JOIN users actor ON actor.id=history.actor_user_id
      WHERE history.event_id=ANY($1::uuid[]) ORDER BY history.occurred_at,history.id`,[data.map(event=>event.id)])).rows;
    if(filters.deliveryId)timeline.push(...(await client.query<EventTimelineRow>(`SELECT history.id,NULL::uuid AS "eventId",history.to_status AS status,
      history.actor_user_id AS "actorUserId",COALESCE(actor.name,'Sistema') AS "actorName",history.created_at AS "occurredAt",'DELIVERY' AS kind
      FROM delivery_status_history history JOIN deliveries delivery ON delivery.id=history.delivery_id LEFT JOIN users actor ON actor.id=history.actor_user_id
      WHERE delivery.id=$1 AND ($2::text<>'COURIER' OR EXISTS(SELECT 1 FROM courier_profiles profile WHERE profile.id=delivery.courier_profile_id AND profile.user_id=$3))`,
    [filters.deliveryId,auth.role,auth.userId])).rows);
    else if(filters.batchId)timeline.push(...(await client.query<EventTimelineRow>(`SELECT history.id,NULL::uuid AS "eventId",history.event_type AS status,
      history.actor_user_id AS "actorUserId",COALESCE(actor.name,'Sistema') AS "actorName",history.created_at AS "occurredAt",'BATCH' AS kind
      FROM route_events history JOIN routes route ON route.id=history.route_id LEFT JOIN users actor ON actor.id=history.actor_user_id
      WHERE route.id=$1 AND ($2::text<>'COURIER' OR EXISTS(SELECT 1 FROM courier_profiles profile WHERE profile.id=route.courier_profile_id AND profile.user_id=$3))`,
    [filters.batchId,auth.role,auth.userId])).rows);
    timeline.sort((a,b)=>new Date(a.occurredAt).getTime()-new Date(b.occurredAt).getTime());
    return {data,timeline};
  });
}
