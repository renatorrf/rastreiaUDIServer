import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction,withTenantTransaction,type Database } from '../../database/pool.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { parseIdempotencyKey,withIdempotency } from '../../shared/idempotency.js';
import { notFound } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import { liveInput,liveHighlight,liveList,liveVersion } from './live.schemas.js';
import { saveLive,startLive,highlightLive,endLive,liveDetail,liveSelect,liveEntitlement,expireLiveStore } from './live.service.js';

const storeParams=z.object({storeId:z.uuid()}), itemParams=storeParams.extend({id:z.uuid()});
export async function liveRoutes(app:FastifyInstance,db:Database,env:AppEnv) {
  const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
  const write=async(req:FastifyRequest,reply:FastifyReply,operation:string,store:string,id:string|undefined,payload:unknown,run:(c:PoolClient)=>Promise<unknown>)=>{
    const key=parseIdempotencyKey(req.headers['idempotency-key']);
    const result=await withTenantTransaction(db,req.auth,async c=>{
      // Revalidate access before replaying a cached administrative response.
      await requireCommerceStore(c,store);
      if(id&&!(await c.query('SELECT id FROM commerce_live_sessions WHERE id=$1 AND store_id=$2',[id,store])).rowCount)throw notFound();
      return withIdempotency(c,req.auth,key,operation,payload,async()=>({statusCode:200,body:await run(c)}));
    });
    return reply.header('Cache-Control','no-store').header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
  };
  app.get('/commerce/stores/:storeId/lives',{preHandler:manager},(req,reply)=>withTenantTransaction(db,req.auth,async c=>{
    reply.header('Cache-Control','no-store');const {storeId}=storeParams.parse(req.params),query=liveList.parse(req.query);
    await requireCommerceStore(c,storeId);await expireLiveStore(c,storeId);
    const where="l.store_id=$1 AND ($2='ALL' OR l.status<>'ENDED')";
    const data=(await c.query(`${liveSelect} WHERE ${where} ORDER BY l.created_at DESC,l.id LIMIT $3 OFFSET $4`,[storeId,query.status,query.limit,query.offset])).rows;
    const total=(await c.query(`SELECT count(*)::int AS total FROM commerce_live_sessions l WHERE ${where}`,[storeId,query.status])).rows[0]!.total;
    return {data,total,entitlement:await liveEntitlement(c,storeId)};
  }));
  app.get('/commerce/stores/:storeId/lives/:id',{preHandler:manager},(req,reply)=>withTenantTransaction(db,req.auth,async c=>{
    reply.header('Cache-Control','no-store');const {storeId,id}=itemParams.parse(req.params);await requireCommerceStore(c,storeId);await expireLiveStore(c,storeId);return liveDetail(c,storeId,id);
  }));
  app.post('/commerce/stores/:storeId/lives',{preHandler:manager},(req,reply)=>{
    const {storeId}=storeParams.parse(req.params),input=liveInput.parse(req.body);
    return write(req,reply,'commerce.live.create',storeId,undefined,{storeId,...input},c=>saveLive(c,req.auth,storeId,input));
  });
  app.patch('/commerce/stores/:storeId/lives/:id',{preHandler:manager},(req,reply)=>{
    const {storeId,id}=itemParams.parse(req.params),{expectedVersion,...input}=liveInput.extend(liveVersion.shape).parse(req.body);
    return write(req,reply,'commerce.live.update',storeId,id,{storeId,id,expectedVersion,...input},c=>saveLive(c,req.auth,storeId,input,id,expectedVersion));
  });
  for(const action of ['start','end','current-product'] as const)app.post(`/commerce/stores/:storeId/lives/:id/${action}`,{preHandler:manager},(req,reply)=>{
    const {storeId,id}=itemParams.parse(req.params);
    if(action==='current-product'){
      const input=liveHighlight.parse(req.body);return write(req,reply,'commerce.live.highlight',storeId,id,{storeId,id,...input},c=>highlightLive(c,req.auth,storeId,id,input));
    }
    const input=liveVersion.parse(req.body);
    return write(req,reply,`commerce.live.${action}`,storeId,id,{storeId,id,...input},c=>(action==='start'?startLive:endLive)(c,req.auth,storeId,id,input.expectedVersion));
  });
  // 200 viewers behind a shared NAT may poll every five seconds.
  app.get('/public/lives/:publicToken',{config:{rateLimit:{max:3000,timeWindow:'1 minute'}}},async(req,reply)=>{
    reply.header('Cache-Control','no-store');const {publicToken}=z.object({publicToken:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.params);
    return withRuntimeTransaction(db,async c=>{const data=(await c.query('SELECT commerce_public_live($1) AS data',[publicToken])).rows[0]?.data;
      if(!data)throw notFound('Esta live não está disponível.');return {...data,videoEnabled:env.IVS_ENABLED===true};});
  });
}
