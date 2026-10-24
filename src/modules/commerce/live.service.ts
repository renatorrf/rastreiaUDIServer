import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { requireCommerceStore } from './commerce.service.js';
import { assertVersion } from './inventory.service.js';
import type { liveInput, liveHighlight } from './live.schemas.js';

export const liveSelect=`SELECT l.id,l.store_id AS "storeId",l.title,l.scheduled_at AS "scheduledAt",l.status,l.version,
 l.current_product_id AS "currentProductId",l.started_at AS "startedAt",l.deadline_at AS "deadlineAt",l.ended_at AS "endedAt",
 l.end_reason AS "endReason",l.created_at AS "createdAt",l.public_token AS "publicToken",f.slug,
 (commerce_public_store(f.slug) IS NOT NULL) AS "storePublished"
 FROM commerce_live_sessions l LEFT JOIN commerce_storefronts f ON f.store_id=l.store_id AND f.tenant_id=l.tenant_id`;

export const expiredLivePredicate=`l.status='LIVE' AND (l.deadline_at<=now() OR NOT EXISTS(SELECT 1 FROM store_live_subscriptions s
 WHERE s.id=l.subscription_id AND s.tenant_id=l.tenant_id AND s.store_id=l.store_id AND s.status='ACTIVE' AND s.starts_at<=now() AND s.ends_at>now()))`;
export async function expireLiveStore(c:PoolClient,store:string) {
  await c.query(`UPDATE commerce_live_sessions l SET status='ENDED',ended_at=LEAST(now(),deadline_at),end_reason='LIMIT_OR_SUBSCRIPTION',version=version+1,updated_at=now()
    WHERE l.store_id=$1 AND ${expiredLivePredicate}`,[store]);
}
export async function liveEntitlement(c:PoolClient,store:string) {
  const plan=(await c.query<{id:string;name:string;limit:number;duration:number;viewers:number;endsAt:string}>(`SELECT s.id,p.name,p.monthly_live_limit AS limit,p.max_duration_minutes AS duration,
    p.max_concurrent_viewers AS viewers,s.ends_at AS "endsAt" FROM store_live_subscriptions s JOIN live_plan_versions p ON p.id=s.plan_version_id
    WHERE s.store_id=$1 AND s.status='ACTIVE' AND s.starts_at<=now() AND s.ends_at>now() ORDER BY s.starts_at DESC,s.id LIMIT 1`,[store])).rows[0]??null;
  const usage=(await c.query<{used:number;periodStart:string;periodEnd:string}>(`SELECT count(*)::int AS used,
    date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS "periodStart",
    (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month') AT TIME ZONE 'America/Sao_Paulo' AS "periodEnd"
    FROM commerce_live_sessions WHERE store_id=$1 AND started_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
    AND started_at < (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month') AT TIME ZONE 'America/Sao_Paulo'`,[store])).rows[0]!;
  return {plan,usage:{...usage,limit:plan?.limit??0,remaining:Math.max(0,(plan?.limit??0)-usage.used)},streamingAvailable:false};
}
async function requirePlan(c:PoolClient,store:string) {
  const entitlement=await liveEntitlement(c,store);
  if(!entitlement.plan)throw new AppError(403,'LIVE_ADDON_REQUIRED','Esta unidade precisa de um pacote de lives vigente.');
  return entitlement;
}
// Locks the store before the session, serializing starts and quota checks across sessions.
export async function lockLiveStore(c:PoolClient,store:string) {
  await requireCommerceStore(c,store);
  if(!(await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE',[store])).rowCount)throw notFound();
  await expireLiveStore(c,store);
}
async function lockSession(c:PoolClient,store:string,id:string) {
  const row=(await c.query<{id:string;status:string;version:number;current_product_id:string|null}>('SELECT id,status,version,current_product_id FROM commerce_live_sessions WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])).rows[0];
  if(!row)throw notFound('Sessão não encontrada nesta unidade.');return row;
}
async function requirePublishedStore(c:PoolClient,store:string) {
  if(!(await c.query('SELECT store_id FROM commerce_storefronts WHERE store_id=$1 AND commerce_public_store(slug) IS NOT NULL',[store])).rowCount)
    throw conflict('Publique o catálogo de uma unidade ativa antes de iniciar a sessão.');
}
const productEligibility=`p.active AND p.published AND (category.id IS NULL OR category.active)
 AND EXISTS(SELECT 1 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)`;
async function validateProducts(c:PoolClient,store:string,ids:string[]) {
  const result=await c.query(`SELECT p.id FROM commerce_products p LEFT JOIN commerce_categories category ON category.id=p.category_id
    WHERE p.store_id=$1 AND p.id=ANY($2::uuid[]) AND ${productEligibility} FOR SHARE OF p`,[store,ids]);
  if(result.rows.length!==ids.length)throw conflict('Selecione apenas produtos ativos, publicados e com variantes ativas desta unidade.');
}
export async function liveDetail(c:PoolClient,store:string,id:string) {
  const row=(await c.query(`${liveSelect} WHERE l.store_id=$1 AND l.id=$2`,[store,id])).rows[0];if(!row)throw notFound();
  const items=(await c.query(`SELECT i.product_id AS "productId",i.position,p.name,p.sku,(${productEligibility}) AS eligible
    FROM commerce_live_items i JOIN commerce_products p ON p.id=i.product_id AND p.store_id=i.store_id AND p.tenant_id=i.tenant_id
    LEFT JOIN commerce_categories category ON category.id=p.category_id WHERE i.live_id=$1 AND i.store_id=$2 ORDER BY i.position`,[id,store])).rows;
  return {...row,items,streamingAvailable:false};
}
export async function saveLive(c:PoolClient,auth:AuthContext,store:string,input:z.infer<typeof liveInput>,id?:string,version?:number) {
  await lockLiveStore(c,store);await requirePlan(c,store);
  const before=id?await lockSession(c,store,id):null;
  if(before){assertVersion(before.version,version!);if(before.status!=='WAITING')throw conflict('Só é possível editar os dados e a lista antes de iniciar.');}
  await validateProducts(c,store,input.productIds);
  const row=(await c.query<{id:string}>(id
    ?'UPDATE commerce_live_sessions SET title=$3,scheduled_at=$4,version=version+1,updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id'
    :'INSERT INTO commerce_live_sessions(tenant_id,store_id,title,scheduled_at,public_token,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    id?[id,store,input.title,input.scheduledAt]:[auth.tenantId,store,input.title,input.scheduledAt,randomBytes(32).toString('hex'),auth.userId])).rows[0]!;
  if(id)await c.query('DELETE FROM commerce_live_items WHERE live_id=$1',[id]);
  for(const [position,productId] of input.productIds.entries())await c.query('INSERT INTO commerce_live_items(live_id,tenant_id,store_id,product_id,position) VALUES($1,$2,$3,$4,$5)',[row.id,auth.tenantId,store,productId,position]);
  await writeAudit(c,{tenantId:auth.tenantId,actorUserId:auth.userId,action:id?'commerce.live.updated':'commerce.live.created',entityType:'commerce_live',entityId:row.id,beforeData:before,afterData:input});
  return liveDetail(c,store,row.id);
}
export async function startLive(c:PoolClient,auth:AuthContext,store:string,id:string,version:number) {
  await lockLiveStore(c,store);const before=await lockSession(c,store,id);assertVersion(before.version,version);
  if(before.status!=='WAITING')throw conflict('Esta sessão já foi iniciada ou encerrada. Atualize a tela.');
  const entitlement=await requirePlan(c,store);
  // Cancel/renew cannot race the start after this point. Recheck with the locked subscription.
  const subscription=(await c.query<{id:string;ends_at:string}>('SELECT * FROM commerce_lock_live_subscription($1,$2)',[store,entitlement.plan!.id])).rows[0];
  if(!subscription)throw new AppError(403,'LIVE_ADDON_REQUIRED','O pacote não está mais vigente.');
  if(!entitlement.usage.remaining)throw new AppError(409,'LIVE_QUOTA_EXHAUSTED','A cota de sessões deste mês foi utilizada.');
  if((await c.query("SELECT id FROM commerce_live_sessions WHERE store_id=$1 AND status='LIVE'",[store])).rowCount)throw conflict('Esta unidade já possui uma sessão em andamento.');
  await requirePublishedStore(c,store);
  const items=(await c.query<{product_id:string}>('SELECT product_id FROM commerce_live_items WHERE live_id=$1 ORDER BY position',[id])).rows;
  if(!items.length)throw conflict('Inclua produtos antes de iniciar.');
  await validateProducts(c,store,items.map(i=>i.product_id));
  await c.query(`UPDATE commerce_live_sessions SET status='LIVE',started_at=now(),deadline_at=LEAST(now()+make_interval(mins=>$2),$3::timestamptz),
    subscription_id=$4,current_product_id=$5,version=version+1,updated_at=now() WHERE id=$1`,[id,entitlement.plan!.duration,subscription.ends_at,subscription.id,items[0]!.product_id]);
  await writeAudit(c,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.live.started',entityType:'commerce_live',entityId:id,afterData:{subscriptionId:subscription.id,commercialOnly:true}});
  return liveDetail(c,store,id);
}
export async function highlightLive(c:PoolClient,auth:AuthContext,store:string,id:string,input:z.infer<typeof liveHighlight>) {
  await lockLiveStore(c,store);const before=await lockSession(c,store,id);assertVersion(before.version,input.expectedVersion);
  if(before.status!=='LIVE')throw conflict('O destaque só pode mudar durante uma sessão em andamento.');
  await requirePublishedStore(c,store);
  const items=(await c.query<{product_id:string;eligible:boolean}>(`SELECT i.product_id,(${productEligibility}) AS eligible FROM commerce_live_items i
    JOIN commerce_products p ON p.id=i.product_id LEFT JOIN commerce_categories category ON category.id=p.category_id WHERE i.live_id=$1 ORDER BY i.position`,[id])).rows;
  let next:string|null=null;
  if(input.action==='SELECT')next=input.productId!;
  else if(input.action!=='HIDE'){
    const index=items.findIndex(i=>i.product_id===before.current_product_id);
    const candidates=input.action==='NEXT'?items.slice(index+1):(index<0?items:items.slice(0,index)).slice().reverse();
    next=candidates.find(i=>i.eligible)?.product_id??null;
    if(!next)throw conflict('Não há outro produto disponível nessa direção.');
  }
  if(next){if(!items.some(i=>i.product_id===next))throw notFound('Produto não pertence à lista desta sessão.');await validateProducts(c,store,[next]);}
  if(next!==before.current_product_id){
    await c.query('UPDATE commerce_live_sessions SET current_product_id=$2,version=version+1,updated_at=now() WHERE id=$1',[id,next]);
    await writeAudit(c,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.live.highlighted',entityType:'commerce_live',entityId:id,beforeData:{productId:before.current_product_id},afterData:{productId:next}});
  }
  return liveDetail(c,store,id);
}
export async function endLive(c:PoolClient,auth:AuthContext,store:string,id:string,version:number) {
  await lockLiveStore(c,store);const before=await lockSession(c,store,id);assertVersion(before.version,version);
  if(before.status==='ENDED')return liveDetail(c,store,id);
  await c.query("UPDATE commerce_live_sessions SET status='ENDED',ended_at=now(),end_reason='MANUAL',version=version+1,updated_at=now() WHERE id=$1",[id]);
  await writeAudit(c,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.live.ended',entityType:'commerce_live',entityId:id,beforeData:{status:before.status},afterData:{status:'ENDED'}});
  return liveDetail(c,store,id);
}
