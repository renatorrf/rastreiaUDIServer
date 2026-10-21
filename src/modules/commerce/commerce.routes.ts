import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import { authenticate, authenticatePlatform, requireRoles } from '../auth/auth.guard.js';
import { withPlatformIdempotency } from '../platform/platform-idempotency.js';
import { parseIdempotencyKey, withIdempotency } from '../../shared/idempotency.js';
import { conflict, notFound } from '../../shared/errors.js';
import { masterAudit } from '../billing/billing.service.js';
import { cancellationSchema, categorySchema, listSchema, planSchema, productSchema, subscriptionSchema } from './commerce.schemas.js';
import { cancelSubscription, createPlanVersion, planSelect, productSelect, requireCommerceStore, saveCategory, saveProduct, subscribeStore, subscriptionSelect } from './commerce.service.js';

const storeParams = z.object({storeId:z.string().uuid()});
const itemParams = storeParams.extend({id:z.string().uuid()});
const idParams = z.object({id:z.string().uuid()});
export async function commerceRoutes(app: FastifyInstance, database: Database, env: AppEnv) {
  const manager=[authenticate(env,database),requireRoles('TENANT_MANAGER')];
  const master=authenticatePlatform(env,database);
  const mutate=async(request:FastifyRequest,reply:FastifyReply,platform:boolean,operation:string,payload:unknown,
    execute:(client:PoolClient)=>Promise<unknown>)=>{
    const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=platform
      ? await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,operation,payload,async()=>({statusCode:200,body:await execute(client)})))
      : await withTenantTransaction(database,request.auth,client=>withIdempotency(client,request.auth,key,operation,payload,async()=>({statusCode:200,body:await execute(client)})));
    return reply.header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
  };
  for (const platform of [false,true]) {
    app.get(platform?'/platform/live-stores':'/commerce/stores',{preHandler:platform?master:manager},request=>{
      const f=listSchema.parse(request.query);
      const run=async(client:PoolClient)=>({data:(await client.query(`SELECT s.id,s.name,c.name AS "companyName"
        FROM stores s JOIN companies c ON c.id=s.company_id
        WHERE ${platform?'true':'commerce_manage_store(s.id)'} AND ($1='' OR position(lower($1) in lower(s.name||' '||c.name))>0)
        ORDER BY s.name,s.id LIMIT $2 OFFSET $3`,[f.search,f.limit,f.offset])).rows});
      return platform?withPlatformTransaction(database,request.platformAuth,run):withTenantTransaction(database,request.auth,run);
    });
  }
  app.get('/commerce/stores/:storeId/products',{preHandler:manager},request=>withTenantTransaction(database,request.auth,async client=>{
    const {storeId}=storeParams.parse(request.params);const f=listSchema.parse(request.query);
    await requireCommerceStore(client,storeId);
    const predicate=`p.store_id=$1 AND ($2='' OR position(lower($2) in lower(p.name||' '||p.sku))>0)
      AND ($3='all' OR p.active=($3='active'))`;
    const values=[storeId,f.search,f.status];
    const data=(await client.query(`${productSelect} WHERE ${predicate} ORDER BY p.name,p.id LIMIT $4 OFFSET $5`,[...values,f.limit,f.offset])).rows;
    const total=(await client.query<{total:number}>(`SELECT count(*)::int AS total FROM commerce_products p WHERE ${predicate}`,values)).rows[0]!.total;
    return {data,total};
  }));
  app.post('/commerce/stores/:storeId/products',{preHandler:manager},(request,reply)=>{
    const {storeId}=storeParams.parse(request.params);const input=productSchema.parse(request.body);
    return mutate(request,reply,false,'commerce.product.create',{storeId,...input},client=>saveProduct(client,request.auth,storeId,input));
  });
  app.patch('/commerce/stores/:storeId/products/:id',{preHandler:manager},(request,reply)=>{
    const {storeId,id}=itemParams.parse(request.params);
    const {expectedVersion,...input}=productSchema.extend({expectedVersion:z.number().int().positive()}).parse(request.body);
    return mutate(request,reply,false,'commerce.product.update',{storeId,id,expectedVersion,...input},client=>saveProduct(client,request.auth,storeId,input,id,expectedVersion));
  });
  app.get('/commerce/stores/:storeId/categories',{preHandler:manager},request=>withTenantTransaction(database,request.auth,async client=>{
    const {storeId}=storeParams.parse(request.params);await requireCommerceStore(client,storeId);
    return {data:(await client.query('SELECT id,name,active,version FROM commerce_categories WHERE store_id=$1 ORDER BY name,id LIMIT 500',[storeId])).rows};
  }));
  app.post('/commerce/stores/:storeId/categories',{preHandler:manager},(request,reply)=>{
    const {storeId}=storeParams.parse(request.params);const input=categorySchema.parse(request.body);
    return mutate(request,reply,false,'commerce.category.create',{storeId,...input},client=>saveCategory(client,request.auth,storeId,input));
  });
  app.patch('/commerce/stores/:storeId/categories/:id',{preHandler:manager},(request,reply)=>{
    const {storeId,id}=itemParams.parse(request.params);
    const {expectedVersion,...input}=categorySchema.extend({expectedVersion:z.number().int().positive()}).parse(request.body);
    return mutate(request,reply,false,'commerce.category.update',{storeId,id,expectedVersion,...input},client=>saveCategory(client,request.auth,storeId,input,id,expectedVersion));
  });
  app.get('/platform/live-plans',{preHandler:master},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const f=listSchema.parse(request.query);
    return {data:(await client.query(`${planSelect} WHERE ($1='' OR position(lower($1) in lower(p.name||' '||p.code))>0)
      AND ($4='all' OR p.available=($4='active'))
      ORDER BY p.code,p.version DESC LIMIT $2 OFFSET $3`,[f.search,f.limit,f.offset,f.status])).rows};
  }));
  app.post('/platform/live-plans',{preHandler:master},(request,reply)=>{
    const input=planSchema.parse(request.body);
    return mutate(request,reply,true,'live_plan.create',input,client=>createPlanVersion(client,request.platformAuth,input));
  });
  app.patch('/platform/live-plans/:id/availability',{preHandler:master},(request,reply)=>{
    const {id}=idParams.parse(request.params);
    const input=z.object({available:z.boolean(),expectedRevision:z.number().int().positive(),reason:z.string().trim().min(5).max(500)}).strict().parse(request.body);
    return mutate(request,reply,true,'live_plan.availability',{id,...input},async client=>{
      const code=(await client.query<{code:string}>('SELECT code FROM live_plan_versions WHERE id=$1',[id])).rows[0]?.code;
      if(!code)throw notFound();
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`live-plan:${code}`]);
      const row=(await client.query('SELECT * FROM live_plan_versions WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
      if(row.revision!==input.expectedRevision)throw conflict('Pacote alterado. Atualize a tela.');
      if(input.available && (await client.query('SELECT id FROM live_plan_versions WHERE code=$1 AND version>$2',[code,row.version])).rowCount)
        throw conflict('Somente a versão mais recente pode ser oferecida.');
      await client.query('UPDATE live_plan_versions SET available=$2,revision=revision+1 WHERE id=$1',[id,input.available]);
      await masterAudit(client,request.platformAuth,{action:'live_plan.availability',entityType:'live_plan',entityId:id,
        before:{available:row.available},after:{available:input.available},reason:input.reason});return {id};
    });
  });
  app.get('/platform/stores/:storeId/live-subscriptions',{preHandler:master},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const {storeId}=storeParams.parse(request.params);
    return {data:(await client.query(`${subscriptionSelect} WHERE s.store_id=$1 ORDER BY s.starts_at DESC,s.id LIMIT 100`,[storeId])).rows};
  }));
  app.post('/platform/stores/:storeId/live-subscriptions',{preHandler:master},(request,reply)=>{
    const {storeId}=storeParams.parse(request.params);const input=subscriptionSchema.parse(request.body);
    return mutate(request,reply,true,'live_subscription.create',{storeId,...input},client=>subscribeStore(client,request.platformAuth,storeId,input));
  });
  app.patch('/platform/live-subscriptions/:id/cancel',{preHandler:master},(request,reply)=>{
    const {id}=idParams.parse(request.params);const input=cancellationSchema.parse(request.body);
    return mutate(request,reply,true,'live_subscription.cancel',{id,...input},client=>cancelSubscription(client,request.platformAuth,id,input.expectedVersion,input.reason));
  });
  app.get('/commerce/stores/:storeId/live-entitlement',{preHandler:manager},request=>withTenantTransaction(database,request.auth,async client=>{
    const {storeId}=storeParams.parse(request.params);await requireCommerceStore(client,storeId);
    const data=(await client.query(`${subscriptionSelect} WHERE s.store_id=$1 ORDER BY s.starts_at DESC,s.id LIMIT 100`,[storeId])).rows;
    return {data,streamingAvailable:false,usage:null};
  }));
}
