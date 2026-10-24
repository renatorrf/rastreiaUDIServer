import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import type { adjustmentSchema, storefrontSchema, variantSchema } from './inventory.schemas.js';

export const variantSelect=`SELECT v.id,v.product_id AS "productId",p.name AS "productName",p.stock_mode AS "stockMode",v.name,v.sku,v.attributes,
 v.price_cents AS "priceCents",v.cost_cents AS "costCents",v.minimum_stock AS "minimumStock",v.is_default AS "isDefault",v.active,v.version,
 b.on_hand AS "onHand",b.reserved,b.on_hand-b.reserved AS available,b.version AS "stockVersion"
 FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id JOIN commerce_inventory_balances b ON b.variant_id=v.id`;
export const storefrontSelect=`SELECT slug,title,description,published,version FROM commerce_storefronts`;
export interface VariantRow {id:string;productId:string;productName:string;stockMode?:'STOCKED'|'MADE_TO_ORDER';name:string;sku:string;attributes:Record<string,string>;priceCents:number;costCents:number;minimumStock:number;isDefault:boolean;active:boolean;version:number;onHand:number;reserved:number;available:number;stockVersion:number}
export interface StorefrontRow {slug:string;title:string;description:string;published:boolean;version:number}
export function storefrontPublicUrl(base:string|undefined,slug:string):string|null {
  try { const url=new URL(`/loja/${encodeURIComponent(slug)}`,base);return ['https:','http:'].includes(url.protocol)?url.href:null; }catch{return null;}
}
export function assertVersion(actual:number,expected:number){if(actual!==expected)throw new AppError(409,'VERSION_CONFLICT','Registro alterado. Atualize a tela antes de salvar.');}
export async function saveVariant(client:PoolClient,auth:AuthContext,store:string,product:string,input:z.infer<typeof variantSchema>,id?:string,expected?:number){
  await requireCommerceStore(client,store);
  // Same order as product updates/default-variant synchronization: product, then variant.
  const parent=(await client.query('SELECT id FROM commerce_products WHERE id=$1 AND store_id=$2 FOR UPDATE',[product,store])).rows[0];
  if(!parent)throw notFound();
  if(!id&&(await client.query('SELECT count(*)::int AS count FROM commerce_variants WHERE product_id=$1',[product])).rows[0]!.count>=100)throw conflict('Limite de 100 variantes por produto atingido.');
  const before=id?(await client.query('SELECT * FROM commerce_variants WHERE id=$1 AND product_id=$2 AND store_id=$3 FOR UPDATE',[id,product,store])).rows[0]:undefined;
  if(id&&!before)throw notFound();if(before)assertVersion(Number(before.version),expected!);
  if(before?.is_default&&(before.sku!==input.sku||before.price_cents!==input.priceCents||before.cost_cents!==input.costCents))throw conflict('Edite o SKU, preço e custo da variante padrão no cadastro do produto.');
  const values=[id??auth.tenantId,store,product,input.name,input.sku,JSON.stringify(input.attributes),input.priceCents,input.costCents,input.minimumStock,input.active];
  const row=(await client.query(id?`UPDATE commerce_variants SET name=$4,sku=$5,attributes=$6,price_cents=$7,cost_cents=$8,minimum_stock=$9,active=$10,version=version+1,updated_at=now()
    WHERE id=$1 AND store_id=$2 AND product_id=$3 RETURNING id`
    :`INSERT INTO commerce_variants(tenant_id,store_id,product_id,name,sku,attributes,price_cents,cost_cents,minimum_stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,values)).rows[0]!;
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:id?'commerce.variant.updated':'commerce.variant.created',entityType:'commerce_variant',entityId:row.id,beforeData:before,afterData:input});
  return (await client.query<VariantRow>(`${variantSelect} WHERE v.id=$1`,[row.id])).rows[0];
}
export async function adjustInventory(client:PoolClient,auth:AuthContext,store:string,input:Omit<z.infer<typeof adjustmentSchema>,'confirmationPassword'>){
  await requireCommerceStore(client,store);
  let id:string;
  try {id=(await client.query<{id:string}>('SELECT commerce_adjust_inventory($1,$2,$3,$4,$5,$6) AS id',[input.variantId,store,input.expectedVersion,input.delta,input.kind,input.reason])).rows[0]!.id;}
  catch(error){const code=(error as {code?:string}).code;
    if(code==='40001')throw new AppError(409,'VERSION_CONFLICT','O estoque mudou. Atualize o saldo antes de confirmar.');
    if(code==='23514')throw conflict('O ajuste deixaria o estoque abaixo do reservado ou acima do limite.');
    if(code==='P0002')throw notFound();throw error;
  }
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.inventory.adjusted',entityType:'commerce_inventory_movement',entityId:id,afterData:input});
  return {movementId:id,...(await client.query<VariantRow>(`${variantSelect} WHERE v.id=$1`,[input.variantId])).rows[0]};
}
export async function saveStorefront(client:PoolClient,auth:AuthContext,store:string,input:z.infer<typeof storefrontSchema>){
  await requireCommerceStore(client,store);await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE',[store]);
  const before=(await client.query<StorefrontRow>(`${storefrontSelect} WHERE store_id=$1 FOR UPDATE`,[store])).rows[0];assertVersion(before?.version??0,input.expectedVersion);
  if(before&&before.slug!==input.slug)throw conflict('O endereço do catálogo não pode ser alterado depois de criado.');
  if(before)await client.query('UPDATE commerce_storefronts SET title=$2,description=$3,published=$4,version=version+1,updated_at=now() WHERE store_id=$1',[store,input.title,input.description,input.published]);
  else await client.query('INSERT INTO commerce_storefronts(store_id,tenant_id,slug,title,description,published) VALUES($1,$2,$3,$4,$5,$6)',[store,auth.tenantId,input.slug,input.title,input.description,input.published]);
  await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.storefront.updated',entityType:'store',entityId:store,beforeData:before,afterData:input});
  return (await client.query<StorefrontRow>(`${storefrontSelect} WHERE store_id=$1`,[store])).rows[0];
}
