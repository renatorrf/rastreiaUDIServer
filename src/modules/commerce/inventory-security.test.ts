import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Fastify,{type FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { afterEach,beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { createTokenPair } from '../auth/token.service.js';
import type { TenantRole } from '../auth/auth.types.js';
import { inventoryRoutes } from './inventory.routes.js';
describe('inventory route security',()=>{
  const store=randomUUID(),variant=randomUUID(),product=randomUUID(),userId=randomUUID(),tenantId=randomUUID();
  const env={NODE_ENV:'test',JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
  const query=vi.fn();const db={connect:async()=>({query,release:()=>{}}),query} as unknown as Database;
  let app:FastifyInstance,hash:string;
  const headers=async(role:TenantRole='TENANT_MANAGER')=>({authorization:`Bearer ${(await createTokenPair(env,{userId,tenantId,role,storeIds:[store]})).accessToken}`,'idempotency-key':'stock-security-test'});
  beforeAll(async()=>{hash=await argon2.hash('test-only-confirmation');});
  beforeEach(async()=>{
    query.mockReset();query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('SELECT u.password_hash')?[{password_hash:hash}]:[],rowCount:0}));
    app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(error instanceof ZodError?422:e.statusCode??500).send({message:e.message});});
    await app.register(rateLimit,{global:false});await inventoryRoutes(app,db,env);await app.ready();
  });
  afterEach(()=>app.close());
  it('requires authentication for stock, variants and publication',async()=>{
    for(const path of ['inventory','storefront',`products/${product}/variants`])expect((await app.inject({url:`/commerce/stores/${store}/${path}`})).statusCode).toBe(401);
  });
  it.each(['COURIER','STORE_OPERATOR'] as const)('denies %s access even when linked to the store',async role=>{
    for(const path of ['inventory','storefront',`products/${product}/variants`])expect((await app.inject({url:`/commerce/stores/${store}/${path}`,headers:await headers(role)})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`/commerce/stores/${store}/inventory-adjustments`,headers:await headers(role),payload:{}})).statusCode).toBe(403);
  });
  it('requires the actual manager password before any mutation',async()=>{
    const route={method:'POST' as const,url:`/commerce/stores/${store}/inventory-adjustments`,headers:await headers()};
    expect((await app.inject({...route,payload:{}})).statusCode).toBe(422);
    expect((await app.inject({...route,payload:{confirmationPassword:'wrong'}})).statusCode).toBe(403);
    expect(query.mock.calls.some(([sql])=>typeof sql==='string'&&(/^(INSERT|UPDATE|DELETE)/.test(sql)||sql.includes('commerce_adjust_inventory')))).toBe(false);
  });
  it('still verifies store scope after a valid password',async()=>{
    let requestHash='';query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('INSERT INTO idempotency_keys'))requestHash=String(values[4]);
      return {rows:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('SELECT u.password_hash')?[{password_hash:hash}]:sql.includes('SELECT actor_user_id, request_hash')?[{actor_user_id:userId,request_hash:requestHash,response_status:null,response_body:null}]:[],rowCount:0};
    });
    const response=await app.inject({method:'POST',url:`/commerce/stores/${store}/inventory-adjustments`,headers:await headers(),payload:{variantId:variant,expectedVersion:1,delta:1,kind:'ENTRY',reason:'Contagem teste',confirmationPassword:'test-only-confirmation'}});
    expect(response.statusCode).toBe(404);
    expect(query.mock.calls.some(([sql])=>typeof sql==='string'&&sql.includes('commerce_adjust_inventory'))).toBe(false);
  });
  it('uses only the public projection without tenant authentication and disables caching',async()=>{
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('commerce_public_store')?[{data:{slug:'loja-teste',title:'Loja teste',description:'',categories:[]}}]:sql.includes('commerce_public_products')?[{data:{data:[],total:0}}]:[],rowCount:0}));
    const response=await app.inject({url:'/public/commerce/stores/loja-teste/products'});
    expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.json()).toEqual({data:[],total:0});
    expect(query.mock.calls.some(([sql])=>typeof sql==='string'&&sql.includes('tenant_session_is_current'))).toBe(false);
  });
  it('rate limits repeated password attempts',async()=>{
    const auth=await headers();for(let i=0;i<10;i++)await app.inject({method:'POST',url:`/commerce/stores/${store}/inventory-adjustments`,headers:auth,payload:{}});
    expect((await app.inject({method:'POST',url:`/commerce/stores/${store}/inventory-adjustments`,headers:auth,payload:{}})).statusCode).toBe(429);
  });
});
