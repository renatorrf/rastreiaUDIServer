import { randomUUID } from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import { ZodError } from 'zod';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import { orderRoutes } from './order.routes.js';
vi.mock('../auth/identity.service.js',()=>({
  assertIdentity:vi.fn(async(_db:unknown,_env:unknown,authorization:string)=>{if(authorization!=='Bearer valid-customer')throw Object.assign(new Error('Login required'),{statusCode:401});return {userId:'customer'};}),
  setIdentity:vi.fn(async()=>{}),
}));
describe('checkout HTTP boundary',()=>{
  const query=vi.fn(),db={connect:async()=>({query,release:()=>{}})} as unknown as Database;
  let app:FastifyInstance;const id=randomUUID(),headers={authorization:'Bearer valid-customer','x-commerce-cart-token':'a'.repeat(43),'idempotency-key':'checkout-test-key'};
  const payload={expectedVersion:2,profileId:randomUUID(),profileVersion:'2026-10-23 12:34:56.123456+00',fulfillment:'DELIVERY',consent:true};
  beforeEach(async()=>{query.mockReset();query.mockResolvedValue({rows:[{must_change_password:false,data:{id,status:'RECEIVED'}}],rowCount:1});app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number;code?:string};reply.code(error instanceof ZodError?422:e.statusCode??500).send({error:{code:e.code,message:e.message}});});await orderRoutes(app,db,{} as AppEnv);await app.ready();});
  afterEach(()=>app.close());
  const request=()=>({method:'POST' as const,url:`/customer/commerce/carts/${id}/checkout`,headers,payload});
  it('requires both customer identity and cart possession',async()=>{
    expect((await app.inject({...request(),headers:{...headers,authorization:''}})).statusCode).toBe(401);
    expect((await app.inject({...request(),headers:{authorization:headers.authorization,'idempotency-key':'checkout-test-key'}})).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects price, identity, address overrides, invalid versions and missing consent',async()=>{
    for(const change of [{subtotalCents:1},{tenantId:randomUUID()},{customerUserId:randomUUID()},{address:{city:'Other'}},{profileVersion:'invalid'},{consent:false},{fulfillment:'OTHER'}])expect((await app.inject({...request(),payload:{...payload,...change}})).statusCode).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });
  it('sends a possession hash, authenticated operation and server-side snapshot request',async()=>{
    const response=await app.inject(request());expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    const call=query.mock.calls.find(([sql])=>String(sql).includes('commerce_checkout'))!;expect(call[1][1]).toHaveLength(64);expect(call[1][4]).toBe('DELIVERY');expect(call[1][5]).toBe(payload.profileId);expect(JSON.stringify(query.mock.calls)).not.toContain(headers['x-commerce-cart-token']);
  });
  it('maps stock and stale profile failures to actionable conflict responses',async()=>{
    for(const [code,expected] of [['40001','ORDER_REVIEW_REQUIRED'],['23514','CART_INSUFFICIENT_STOCK']]){
      query.mockImplementation(async(sql:string)=>{if(sql.includes('commerce_checkout'))throw Object.assign(new Error('internal SQL details'),{code});return {rows:[{must_change_password:false}]};});
      const response=await app.inject(request());expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe(expected);expect(response.body).not.toContain('internal SQL');
    }
  });
  it('requires password replacement before submitting and protects private history',async()=>{
    query.mockResolvedValue({rows:[{must_change_password:true}],rowCount:1});expect((await app.inject(request())).statusCode).toBe(409);
    expect((await app.inject({url:'/customer/commerce/orders'})).statusCode).toBe(401);
  });
});
