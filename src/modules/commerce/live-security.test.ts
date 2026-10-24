import { randomUUID } from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { createTokenPair } from '../auth/token.service.js';
import type { TenantRole } from '../auth/auth.types.js';
import { liveRoutes } from './live.routes.js';

describe('live session HTTP boundaries',()=>{
  const store=randomUUID(),id=randomUUID(),product=randomUUID(),userId=randomUUID(),tenantId=randomUUID();
  const env={NODE_ENV:'test',JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
  const query=vi.fn(),db={connect:async()=>({query,release:()=>{}}),query} as unknown as Database;
  const base=`/commerce/stores/${store}/lives`;
  let app:FastifyInstance;
  const headers=async(role:TenantRole='TENANT_MANAGER')=>({authorization:`Bearer ${(await createTokenPair(env,{userId,tenantId,role,storeIds:[store]})).accessToken}`,'idempotency-key':'live-security-test'});
  beforeEach(async()=>{
    query.mockReset();query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:[],rowCount:0}));
    app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(error instanceof ZodError?422:e.statusCode??500).send({message:e.message});});
    await app.register(rateLimit,{global:false});await liveRoutes(app,db,env);await app.ready();
  });
  afterEach(()=>app.close());
  it('requires authentication on every management operation',async()=>{
    for(const [method,url] of [['GET',base],['POST',base],['GET',`${base}/${id}`],['PATCH',`${base}/${id}`],...['start','end','current-product'].map(a=>['POST',`${base}/${id}/${a}`])] as const){
      expect((await app.inject({method:method as 'GET'|'POST'|'PATCH',url})).statusCode).toBe(401);
    }
  });
  it.each(['COURIER','STORE_OPERATOR'] as const)('denies %s before accessing commercial sessions',async role=>{
    const h=await headers(role);
    expect((await app.inject({url:base,headers:h})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`${base}/${id}/start`,headers:h,payload:{expectedVersion:1}})).statusCode).toBe(403);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('commerce_live_sessions'))).toBe(false);
  });
  it('validates tenant access before reading a session or replaying a response',async()=>{
    const h=await headers();
    expect((await app.inject({url:`${base}/${id}`,headers:h})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:base,headers:h,payload:{title:'Seleção',productIds:[product]}})).statusCode).toBe(404);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('idempotency_keys'))).toBe(false);
  });
  it('checks session ownership even when store access is valid',async()=>{
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('commerce_manage_store')?[{allowed:true}]:[],rowCount:0}));
    expect((await app.inject({method:'POST',url:`${base}/${id}/end`,headers:await headers(),payload:{expectedVersion:1}})).statusCode).toBe(404);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('idempotency_keys'))).toBe(false);
  });
  it('rejects duplicate products, extra tenant fields and invalid highlight actions',async()=>{
    const h=await headers();
    for(const payload of [{title:'Seleção',productIds:[product,product]},{title:'Seleção',productIds:[product],tenantId},{title:'Seleção',productIds:[]}])
      expect((await app.inject({method:'POST',url:base,headers:h,payload})).statusCode).toBe(422);
    for(const payload of [{action:'SELECT',expectedVersion:1},{action:'NEXT',productId:product,expectedVersion:1},{action:'HIDE',expectedVersion:0}])
      expect((await app.inject({method:'POST',url:`${base}/${id}/current-product`,headers:h,payload})).statusCode).toBe(422);
  });
  it('only exposes the public projection with no-store, without authentication',async()=>{
    const snapshot={id,sequence:1,store:{slug:'loja',title:'Loja'},title:'Seleção',status:'WAITING',featuredProduct:null};
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('commerce_public_live')?[{data:snapshot}]:[],rowCount:0}));
    const response=await app.inject({url:`/public/lives/${'a'.repeat(64)}`});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({...snapshot,videoEnabled:false});expect(response.headers['cache-control']).toBe('no-store');
    expect(query.mock.calls.some(([sql])=>/FROM commerce_live_sessions/i.test(String(sql)))).toBe(false);
    query.mockResolvedValue({rows:[{data:null}],rowCount:1});expect((await app.inject({url:`/public/lives/${'b'.repeat(64)}`})).statusCode).toBe(404);
    expect((await app.inject({url:'/public/lives/guess'})).statusCode).toBe(422);
  });
});
