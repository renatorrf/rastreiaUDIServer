import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { AuthContext, PlatformAuthContext } from '../auth/auth.types.js';
import { masterAudit } from '../billing/billing.service.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import type { categorySchema, planSchema, productSchema, subscriptionSchema } from './commerce.schemas.js';

export const productSelect = `SELECT p.id,p.store_id AS "storeId",p.name,p.sku,p.barcode,p.description,
 (SELECT i.id FROM commerce_product_images i WHERE i.product_id=p.id AND NOT i.archived ORDER BY i.position,i.id LIMIT 1) AS "coverImageId",
 p.category_id AS "categoryId",c.name AS "categoryName",p.price_cents AS "priceCents",
 p.cost_cents AS "costCents",p.active,p.published,p.version FROM commerce_products p
 LEFT JOIN commerce_categories c ON c.id=p.category_id`;
export const planSelect = `SELECT p.id,p.code,p.version,p.revision,p.name,p.available,
 p.monthly_price_cents AS "monthlyPriceCents",p.monthly_live_limit AS "monthlyLiveLimit",
 p.max_duration_minutes AS "maxDurationMinutes",p.max_concurrent_viewers AS "maxConcurrentViewers"
 FROM live_plan_versions p`;
export const subscriptionSelect = `SELECT s.id,s.store_id AS "storeId",s.plan_version_id AS "planVersionId",
 p.name AS "planName",p.code AS "planCode",p.version AS "planVersion",
 p.monthly_price_cents AS "monthlyPriceCents",p.monthly_live_limit AS "monthlyLiveLimit",
 p.max_duration_minutes AS "maxDurationMinutes",p.max_concurrent_viewers AS "maxConcurrentViewers",
 s.starts_at AS "startsAt",s.ends_at AS "endsAt",s.version,
 CASE WHEN s.status='CANCELLED' THEN 'CANCELLED' WHEN s.ends_at<=now() THEN 'EXPIRED'
 WHEN s.starts_at>now() THEN 'SCHEDULED' ELSE 'ACTIVE' END AS status
 FROM store_live_subscriptions s JOIN live_plan_versions p ON p.id=s.plan_version_id`;

export async function requireCommerceStore(client: PoolClient, storeId: string) {
  const row = (await client.query<{allowed:boolean}>('SELECT commerce_manage_store($1) AS allowed', [storeId])).rows[0];
  if (!row?.allowed) throw notFound('Unidade indisponível para gestão comercial.');
}
function checkVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError(409, 'VERSION_CONFLICT', 'Este registro foi alterado. Atualize a tela antes de salvar.');
}
export async function saveCategory(client: PoolClient, auth: AuthContext, storeId: string,
  input: z.infer<typeof categorySchema>, id?: string, expectedVersion?: number) {
  await requireCommerceStore(client, storeId);
  const before = id ? (await client.query('SELECT * FROM commerce_categories WHERE id=$1 AND store_id=$2 FOR UPDATE', [id,storeId])).rows[0] : undefined;
  if (id && !before) throw notFound();
  if (before) checkVersion(before.version as number, expectedVersion!);
  const row = (await client.query(id
    ? 'UPDATE commerce_categories SET name=$3,active=$4,version=version+1,updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id'
    : 'INSERT INTO commerce_categories(tenant_id,store_id,name,active) VALUES($1,$2,$3,$4) RETURNING id',
  [id ?? auth.tenantId,storeId,input.name,input.active])).rows[0]!;
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:id?'commerce.category.updated':'commerce.category.created',
    entityType:'commerce_category',entityId:row.id as string,beforeData:before,afterData:input});
  return row;
}
export async function saveProduct(client: PoolClient, auth: AuthContext, storeId: string,
  input: z.infer<typeof productSchema>, id?: string, expectedVersion?: number) {
  await requireCommerceStore(client,storeId);
  const before = id ? (await client.query('SELECT * FROM commerce_products WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,storeId])).rows[0] : undefined;
  if (id && !before) throw notFound();
  if (before) checkVersion(before.version as number,expectedVersion!);
  if (input.categoryId && !(await client.query('SELECT id FROM commerce_categories WHERE id=$1 AND store_id=$2',[input.categoryId,storeId])).rowCount)
    throw conflict('Selecione uma categoria desta unidade.');
  const values=[id ?? auth.tenantId,storeId,input.name,input.sku,input.description,input.categoryId,input.priceCents,input.costCents,input.active,input.barcode===undefined?(before?.barcode??null):input.barcode];
  const row=(await client.query(id ? `UPDATE commerce_products SET name=$3,sku=$4,description=$5,category_id=$6,
    price_cents=$7,cost_cents=$8,active=$9,barcode=$10,version=version+1,updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id`
    : `INSERT INTO commerce_products(tenant_id,store_id,name,sku,description,category_id,price_cents,cost_cents,active,barcode)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,values)).rows[0]!;
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:id?'commerce.product.updated':'commerce.product.created',
    entityType:'commerce_product',entityId:row.id as string,beforeData:before,afterData:input});
  return (await client.query(`${productSelect} WHERE p.id=$1`,[row.id])).rows[0];
}
export async function createPlanVersion(client: PoolClient, auth: PlatformAuthContext, input: z.infer<typeof planSchema>) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`live-plan:${input.code}`]);
  const latest=(await client.query<{version:number}>('SELECT version FROM live_plan_versions WHERE code=$1 ORDER BY version DESC LIMIT 1',[input.code])).rows[0];
  checkVersion(latest?.version ?? 0,input.expectedVersion);
  // Historical subscribers retain the old immutable terms.
  await client.query('UPDATE live_plan_versions SET available=false,revision=revision+1 WHERE code=$1 AND available',[input.code]);
  const row=(await client.query<{id:string}>(`INSERT INTO live_plan_versions(code,version,name,monthly_price_cents,
    monthly_live_limit,max_duration_minutes,max_concurrent_viewers,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
  [input.code,input.expectedVersion+1,input.name,input.monthlyPriceCents,input.monthlyLiveLimit,input.maxDurationMinutes,input.maxConcurrentViewers,auth.userId])).rows[0]!;
  await masterAudit(client,auth,{action:'live_plan.version_created',entityType:'live_plan',entityId:row.id,after:input,reason:input.reason});
  return (await client.query(`${planSelect} WHERE p.id=$1`,[row.id])).rows[0];
}
export async function subscribeStore(client: PoolClient, auth: PlatformAuthContext, storeId: string, input: z.infer<typeof subscriptionSchema>) {
  const store=(await client.query<{tenant_id:string}>(`SELECT s.tenant_id FROM stores s
    JOIN tenants t ON t.id=s.tenant_id JOIN companies c ON c.id=s.company_id
    WHERE s.id=$1 AND s.status='ACTIVE' AND t.status='ACTIVE' AND c.status='ACTIVE' FOR UPDATE OF s`,[storeId])).rows[0];
  if (!store) throw notFound('Unidade ativa não encontrada.');
  if (!(await client.query('SELECT id FROM live_plan_versions WHERE id=$1 AND available FOR SHARE',[input.planVersionId])).rowCount)
    throw conflict('O pacote não está disponível para novas contratações.');
  if (new Date(input.endsAt).getTime()<=Date.now()) throw conflict('A vigência deve terminar no futuro.');
  if ((await client.query(`SELECT id FROM store_live_subscriptions WHERE store_id=$1 AND status='ACTIVE'
    AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz`,[storeId,input.startsAt,input.endsAt])).rowCount)
    throw conflict('Já existe um pacote neste período. Cancele o vínculo anterior ou escolha uma vigência sem sobreposição.');
  const row=(await client.query<{id:string}>(`INSERT INTO store_live_subscriptions(tenant_id,store_id,plan_version_id,starts_at,ends_at,reason,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[store.tenant_id,storeId,input.planVersionId,input.startsAt,input.endsAt,input.reason,auth.userId])).rows[0]!;
  await masterAudit(client,auth,{action:'live_subscription.created',entityType:'live_subscription',entityId:row.id,
    tenantId:store.tenant_id,after:{storeId,...input},reason:input.reason});
  return (await client.query(`${subscriptionSelect} WHERE s.id=$1`,[row.id])).rows[0];
}
export async function cancelSubscription(client: PoolClient, auth: PlatformAuthContext, id: string, expectedVersion: number, reason: string) {
  const before=(await client.query('SELECT * FROM store_live_subscriptions WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if (!before) throw notFound();
  checkVersion(before.version as number,expectedVersion);
  if (before.status==='CANCELLED') throw conflict('Este vínculo já foi cancelado.');
  await client.query("UPDATE store_live_subscriptions SET status='CANCELLED',cancelled_at=now(),version=version+1 WHERE id=$1",[id]);
  await masterAudit(client,auth,{action:'live_subscription.cancelled',entityType:'live_subscription',entityId:id,
    tenantId:before.tenant_id as string,before,after:{status:'CANCELLED'},reason});
  return {id};
}
