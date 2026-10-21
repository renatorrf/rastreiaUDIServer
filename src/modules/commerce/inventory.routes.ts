import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction,withTenantTransaction,type Database } from '../../database/pool.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { confirmManagerPassword } from '../auth/confirm-manager-password.js';
import { parseIdempotencyKey,withIdempotency } from '../../shared/idempotency.js';
import { writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { listSchema } from './commerce.schemas.js';
import { requireCommerceStore } from './commerce.service.js';
import { adjustmentSchema,slugSchema,storefrontSchema,variantSchema } from './inventory.schemas.js';
import { adjustInventory,assertVersion,saveStorefront,saveVariant,storefrontPublicUrl,storefrontSelect,variantSelect } from './inventory.service.js';

const storeParams=z.object({storeId:z.uuid()});const productParams=storeParams.extend({productId:z.uuid()});const variantParams=productParams.extend({id:z.uuid()});
export async function inventoryRoutes(app:FastifyInstance,database:Database,env:AppEnv){
  const manager=[authenticate(env,database),requireRoles('TENANT_MANAGER')];
  const write=async(req:FastifyRequest,reply:FastifyReply,operation:string,payload:unknown,run:(client:PoolClient)=>Promise<unknown>)=>{
    const key=parseIdempotencyKey(req.headers['idempotency-key']);
    const result=await withTenantTransaction(database,req.auth,c=>withIdempotency(c,req.auth,key,operation,payload,async()=>({statusCode:200,body:await run(c)})));
    return reply.header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
  };
  app.get('/commerce/stores/:storeId/products/:productId/variants',{preHandler:manager},req=>withTenantTransaction(database,req.auth,async c=>{
    const {storeId,productId}=productParams.parse(req.params);await requireCommerceStore(c,storeId);
    return {data:(await c.query(`${variantSelect} WHERE v.store_id=$1 AND v.product_id=$2 ORDER BY v.is_default DESC,v.name,v.id`,[storeId,productId])).rows};
  }));
  app.post('/commerce/stores/:storeId/products/:productId/variants',{preHandler:manager},(req,reply)=>{
    const ids=productParams.parse(req.params),input=variantSchema.parse(req.body);
    return write(req,reply,'commerce.variant.create',{...ids,...input},c=>saveVariant(c,req.auth,ids.storeId,ids.productId,input));
  });
  app.patch('/commerce/stores/:storeId/products/:productId/variants/:id',{preHandler:manager},(req,reply)=>{
    const ids=variantParams.parse(req.params),{expectedVersion,...input}=variantSchema.extend({expectedVersion:z.number().int().positive()}).parse(req.body);
    return write(req,reply,'commerce.variant.update',{...ids,expectedVersion,...input},c=>saveVariant(c,req.auth,ids.storeId,ids.productId,input,ids.id,expectedVersion));
  });
  app.get('/commerce/stores/:storeId/inventory',{preHandler:manager},req=>withTenantTransaction(database,req.auth,async c=>{
    const {storeId}=storeParams.parse(req.params);await requireCommerceStore(c,storeId);
    const f=listSchema.extend({stock:z.enum(['all','low','empty']).default('all'),productId:z.uuid().optional()}).parse(req.query);
    const where=`v.store_id=$1 AND ($2='' OR position(lower($2) in lower(p.name||' '||v.name||' '||v.sku))>0)
      AND ($3='all' OR v.active=($3='active')) AND ($4='all' OR ($4='low' AND b.on_hand-b.reserved<=v.minimum_stock) OR ($4='empty' AND b.on_hand=b.reserved)) AND ($5::uuid IS NULL OR v.product_id=$5)`;
    const values=[storeId,f.search,f.status,f.stock,f.productId??null];
    const data=(await c.query(`${variantSelect} WHERE ${where} ORDER BY p.name,v.name,v.id LIMIT $6 OFFSET $7`,[...values,f.limit,f.offset])).rows;
    const total=(await c.query(`SELECT count(*)::int AS total FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE ${where}`,values)).rows[0]!.total;
    return {data,total};
  }));
  app.get('/commerce/stores/:storeId/inventory/:id/movements',{preHandler:manager},req=>withTenantTransaction(database,req.auth,async c=>{
    const {storeId,id}=storeParams.extend({id:z.uuid()}).parse(req.params),f=listSchema.parse(req.query);await requireCommerceStore(c,storeId);
    const values=[storeId,id];const data=(await c.query(`SELECT m.id,m.kind,m.delta,m.before_quantity AS "beforeQuantity",m.after_quantity AS "afterQuantity",m.reason,m.created_at AS "createdAt",u.name AS "actorName"
      FROM commerce_inventory_movements m LEFT JOIN users u ON u.id=m.actor_user_id WHERE m.store_id=$1 AND m.variant_id=$2 ORDER BY m.created_at DESC,m.id LIMIT $3 OFFSET $4`,[...values,f.limit,f.offset])).rows;
    return {data,total:(await c.query('SELECT count(*)::int AS total FROM commerce_inventory_movements WHERE store_id=$1 AND variant_id=$2',values)).rows[0]!.total};
  }));
  app.post('/commerce/stores/:storeId/inventory-adjustments',{preHandler:[...manager,confirmManagerPassword(database)],config:{rateLimit:{max:10,timeWindow:'1 minute'}}},(req,reply)=>{
    const {storeId}=storeParams.parse(req.params);const parsed=adjustmentSchema.parse(req.body);
    const {confirmationPassword:_,...input}=parsed;void _; // Never persist/hash the confirmation secret in an idempotency payload or audit.
    return write(req,reply,'commerce.inventory.adjust',{storeId,...input},c=>adjustInventory(c,req.auth,storeId,input));
  });
  app.get('/commerce/stores/:storeId/storefront',{preHandler:manager},req=>withTenantTransaction(database,req.auth,async c=>{
    const {storeId}=storeParams.parse(req.params);await requireCommerceStore(c,storeId);const data=(await c.query(`${storefrontSelect} WHERE store_id=$1`,[storeId])).rows[0];return {data:data?{...data,publicUrl:storefrontPublicUrl(env.PUBLIC_TRACKING_BASE_URL,String(data.slug))}:null};
  }));
  app.post('/commerce/stores/:storeId/storefront',{preHandler:manager},(req,reply)=>{
    const {storeId}=storeParams.parse(req.params),input=storefrontSchema.parse(req.body);
    return write(req,reply,'commerce.storefront.save',{storeId,...input},async c=>{const data=await saveStorefront(c,req.auth,storeId,input);return {...data,publicUrl:storefrontPublicUrl(env.PUBLIC_TRACKING_BASE_URL,data!.slug)};});
  });
  app.patch('/commerce/stores/:storeId/products/:productId/publication',{preHandler:manager},(req,reply)=>{
    const ids=productParams.parse(req.params),input=z.object({published:z.boolean(),expectedVersion:z.number().int().positive()}).strict().parse(req.body);
    return write(req,reply,'commerce.product.publish',{...ids,...input},async c=>{
      await requireCommerceStore(c,ids.storeId);const row=(await c.query<{published:boolean;version:number}>('SELECT published,version FROM commerce_products WHERE id=$1 AND store_id=$2 FOR UPDATE',[ids.productId,ids.storeId])).rows[0];if(!row)throw notFound();assertVersion(row.version,input.expectedVersion);
      await c.query('UPDATE commerce_products SET published=$2,version=version+1,updated_at=now() WHERE id=$1',[ids.productId,input.published]);
      await writeAudit(c,{tenantId:req.auth.tenantId,actorUserId:req.auth.userId,action:'commerce.product.publication',entityType:'commerce_product',entityId:ids.productId,beforeData:row,afterData:input});return {published:input.published};
    });
  });
  const publicQuery=z.object({search:z.string().trim().max(160).default(''),categoryId:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(100000).default(0)});
  for(const products of [false,true])app.get(`/public/commerce/stores/:slug${products?'/products':''}`,{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {slug}=z.object({slug:slugSchema}).parse(req.params),q=publicQuery.parse(req.query);reply.header('Cache-Control','no-store');
    return withRuntimeTransaction(database,async c=>{
      const store=(await c.query('SELECT commerce_public_store($1) AS data',[slug])).rows[0]?.data;if(!store)throw notFound('Catálogo indisponível.');
      return products?(await c.query('SELECT commerce_public_products($1,$2,$3,$4,$5) AS data',[slug,q.search,q.categoryId??null,q.limit,q.offset])).rows[0]!.data:store;
    });
  });
}
