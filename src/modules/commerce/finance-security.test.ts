import { randomUUID } from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import { ZodError } from 'zod';
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { createTokenPair } from '../auth/token.service.js';
import type { TenantRole } from '../auth/auth.types.js';
import { financeRoutes } from './finance.routes.js';
describe('finance HTTP security',()=>{
 const store=randomUUID(),id=randomUUID(),userId=randomUUID(),tenantId=randomUUID();
 const env={NODE_ENV:'test',JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
 const query=vi.fn(),db={connect:async()=>({query,release:()=>{}}),query} as unknown as Database,base=`/commerce/stores/${store}/finance`;
 let app:FastifyInstance;
 const headers=async(role:TenantRole='TENANT_MANAGER')=>({authorization:`Bearer ${(await createTokenPair(env,{userId,tenantId,role,storeIds:[store]})).accessToken}`,'idempotency-key':'finance-security-test'});
 beforeEach(async()=>{query.mockReset();query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:[],rowCount:0}));app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(error instanceof ZodError?422:e.statusCode??500).send({message:e.message});});await financeRoutes(app,db,env);await app.ready();});
 afterEach(()=>app.close());
 it('requires identity on every financial route',async()=>{
  for(const [method,path] of [['GET','/report'],['GET','/entries'],['GET','/categories'],['GET','/inventory'],['GET',`/entries/${id}/settlements`],['POST','/entries'],['POST','/categories'],['POST','/categories/defaults'],['POST',`/inventory/${id}/initialize-cost`],['POST',`/entries/${id}/cancel`],['POST',`/entries/${id}/settlements`],['POST',`/entries/${id}/settlements/${id}/reverse`]] as const)expect((await app.inject({method,url:base+path})).statusCode).toBe(401);
 });
 it.each(['COURIER','STORE_OPERATOR'] as const)('denies %s before finance access',async role=>{const h=await headers(role);expect((await app.inject({url:base+'/categories',headers:h})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:base+'/categories/defaults',headers:h,payload:{}})).statusCode).toBe(403);expect(query.mock.calls.some(([sql])=>String(sql).includes('commerce_finance'))).toBe(false);});
 it('checks store access before idempotency replay',async()=>{const response=await app.inject({method:'POST',url:base+'/categories/defaults',headers:await headers(),payload:{}});expect(response.statusCode).toBe(404);expect(query.mock.calls.some(([sql])=>String(sql).includes('idempotency_keys'))).toBe(false);});
 it('rejects identity overrides, invalid dates and missing idempotency keys',async()=>{
  const h=await headers(),input={categoryId:id,description:'Aluguel',amountCents:1000,competenceDate:'2026-10-01',dueDate:'2026-10-10'};
  for(const extra of [{tenantId},{storeId:store},{direction:'IN'},{amountCents:1.1},{competenceDate:'2026-02-30'}])expect((await app.inject({method:'POST',url:base+'/entries',headers:h,payload:{...input,...extra}})).statusCode).toBe(422);
  expect((await app.inject({url:base+'/report?from=2026-11-01&to=2026-10-01',headers:h})).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url:base+'/categories/defaults',headers:{authorization:h.authorization},payload:{}})).statusCode).toBe(409);
 });
});
