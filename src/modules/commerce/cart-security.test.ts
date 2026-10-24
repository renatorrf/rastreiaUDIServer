import { randomUUID } from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import { cartRoutes,cartTokenHash } from './cart.routes.js';
describe('guest cart HTTP boundary',()=>{
  const query=vi.fn(),db={connect:async()=>({query,release:()=>{}})} as unknown as Database;
  let app:FastifyInstance;const id=randomUUID(),variant=randomUUID(),token='a'.repeat(43),headers={'x-commerce-cart-token':token,'idempotency-key':'cart-operation-test'};
  beforeEach(async()=>{query.mockReset();query.mockResolvedValue({rows:[{data:{id,items:[]},id}],rowCount:1});app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number;code?:string};reply.code(error instanceof ZodError?422:e.statusCode??500).send({error:{code:e.code,message:e.message}});});await app.register(rateLimit,{global:false});await cartRoutes(app,db);await app.ready();});
  afterEach(()=>app.close());
  it('requires possession, never accepts token in query string and does not require a merchant login',async()=>{
    expect((await app.inject({url:`/public/commerce/carts/${id}?token=${token}`})).statusCode).toBe(401);
    const valid=await app.inject({url:`/public/commerce/carts/${id}`,headers});expect(valid.statusCode).toBe(200);expect(valid.headers['cache-control']).toBe('no-store');expect(JSON.stringify(query.mock.calls)).not.toContain(token);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('tenant_session_is_current'))).toBe(false);
  });
  it('accepts only variant, quantity and version; ignores no client prices or tenant overrides',async()=>{
    const request={method:'PUT' as const,url:`/public/commerce/carts/${id}/items/${variant}`,headers};
    for(const payload of [{quantity:1,expectedVersion:1,priceCents:1},{quantity:1,expectedVersion:1,tenantId:randomUUID()},{quantity:1.5,expectedVersion:1},{quantity:100,expectedVersion:1}])expect((await app.inject({...request,payload})).statusCode).toBe(422);
    expect((await app.inject({...request,payload:{quantity:2,expectedVersion:1}})).statusCode).toBe(200);
    const call=query.mock.calls.find(([sql])=>String(sql).includes('commerce_cart_change'))!;expect(call[1][1]).toBe(cartTokenHash(token));expect(call[1][3]).toBe(2);
  });
  it('requires idempotency on creation and writes and gives retryable stock/version errors',async()=>{
    expect((await app.inject({method:'POST',url:'/public/commerce/stores/loja-teste/carts',headers:{'x-commerce-cart-token':token},payload:{}})).statusCode).toBe(409);
    query.mockImplementation(async(sql:string)=>{if(sql.includes('commerce_cart_change'))throw Object.assign(new Error('private db error'),{code:'40001'});return {rows:[]};});
    const response=await app.inject({method:'PUT',url:`/public/commerce/carts/${id}/items/${variant}`,headers,payload:{quantity:2,expectedVersion:1}});expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('CART_VERSION_CONFLICT');expect(response.body).not.toContain('private db error');
  });
  it('returns no data for a cart owned by someone else',async()=>{
    query.mockResolvedValue({rows:[{data:null}],rowCount:1});expect((await app.inject({url:`/public/commerce/carts/${id}`,headers})).statusCode).toBe(404);
  });
  it('validates preparation notes and includes them in the idempotency payload',async()=>{
    const req={method:'PUT' as const,url:`/public/commerce/carts/${id}/items/${variant}`,headers};
    for(const preparationNotes of [123,'x'.repeat(501)])expect((await app.inject({...req,payload:{quantity:1,expectedVersion:1,preparationNotes}})).statusCode).toBe(422);
    const hashes=[];
    for(const preparationNotes of ['Sem alface','Sem cebola']){
      query.mockClear();expect((await app.inject({...req,payload:{quantity:1,expectedVersion:1,preparationNotes}})).statusCode).toBe(200);
      const call=query.mock.calls.find(([sql])=>String(sql).includes('commerce_cart_change_with_notes'))!;
      expect(call[1][8]).toBe(preparationNotes);hashes.push(call[1][6]);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
