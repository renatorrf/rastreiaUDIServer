import { describe,it,expect,vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AppEnv } from '../../config/env.js';
import { normalizeIfoodOrder,deliveryInput } from './ifood.normalizer.js';
import { mockOrder } from './ifood.mock.js';
import { IfoodClient,IfoodHttpError,IfoodAuthService } from './ifood.client.js';
import { IfoodProvider } from './ifood.provider.js';
import { validIfoodSignature } from './ifood.routes.js';
import { advancesExternalStatus,externalStatus } from './ifood.status.js';
import { createIfoodWorker } from './ifood.worker.js';
import type { Database } from '../../database/pool.js';
const merchant='744c8e3f-ef9f-47b7-8c3e-1a8a5bf12ad4';
const env={IFOOD_BASE_URL:'https://merchant-api.ifood.com.br',IFOOD_CLIENT_ID:'client',IFOOD_CLIENT_SECRET:'secret',IFOOD_REQUEST_TIMEOUT_MS:1000} as AppEnv;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const token=()=>json({accessToken:'synthetic-token',expiresIn:3600});
describe('iFood normalization',()=>{
 it('maps own delivery, address, observations, items and integer cents',()=>{const n=normalizeIfoodOrder(mockOrder('own',merchant));expect(n.ownDelivery).toBe(true);expect(n.items[0]?.options[0]?.name).toBe('Queijo extra');expect(n.totalCents).toBe(6500);expect(deliveryInput(n,merchant)).toMatchObject({addressLine:'Avenida Brasil',addressNumber:'2662',latitude:-18.9});});
 it('maps cash change, prepaid and discounts independently of courier payout',()=>{expect(normalizeIfoodOrder(mockOrder('cash',merchant)).payments[0]).toMatchObject({prepaid:false,cashChangeForCents:10000,valueCents:6500});expect(normalizeIfoodOrder(mockOrder('prepaid',merchant)).payments[0]?.prepaid).toBe(true);});
 it('does not assume missing fields mean merchant delivery',()=>{expect(normalizeIfoodOrder({id:merchant,merchant:{id:merchant}}).ownDelivery).toBe(false);expect(normalizeIfoodOrder(mockOrder('ifood',merchant)).ownDelivery).toBe(false);});
 it('rejects incomplete destination instead of inventing coordinates',()=>{const o=mockOrder('own',merchant);delete (o.delivery.deliveryAddress as Partial<typeof o.delivery.deliveryAddress>).coordinates;expect(()=>deliveryInput(normalizeIfoodOrder(o),merchant)).toThrow();});
 it('normalizes missing optional fields and rejects malformed ids',()=>{const n=normalizeIfoodOrder({id:merchant,merchant:{id:merchant}});expect(n.items).toEqual([]);expect(n.totalCents).toBeNull();expect(()=>normalizeIfoodOrder({})).toThrow();});
});
describe('iFood client and official contract',()=>{
 it('uses provider reason codes returned by the cancellation endpoint',async()=>{
   const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({reasons:[{code:'503',description:'Indisponível'}]})).mockResolvedValue(new Response(null,{status:202}));
   const provider=new IfoodProvider(new IfoodClient(env,http));const reasons=await provider.getCancellationReasons(merchant);
   expect(reasons).toEqual([{cancellationCode:'503',description:'Indisponível'}]);await provider.requestCancellation(merchant,reasons[0]!);
   expect(http.mock.calls[2]?.[1]).toMatchObject({method:'POST',body:'{"reason":"503"}'});
 });
 it('preserves unknown event metadata returned by polling for encrypted audit',async()=>{
   const event={id:'event-1',merchantId:merchant,orderId:merchant,code:'PLC',fullCode:'PLACED',createdAt:new Date().toISOString(),metadata:{source:'test'}};
   const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json([event]));
   expect(await new IfoodProvider(new IfoodClient(env,http)).pollEvents([merchant])).toEqual([event]);
 });
 it('renews expired tokens without storing them in the database',async()=>{
   vi.useFakeTimers();try{const http=vi.fn<typeof fetch>().mockImplementation(async()=>token());const auth=new IfoodAuthService(env,http);
   await auth.getAccessToken();vi.advanceTimersByTime(3600000);await auth.getAccessToken();expect(http).toHaveBeenCalledTimes(2);}finally{vi.useRealTimers();}
 });
 it('caches tokens and coalesces parallel authentication',async()=>{const http=vi.fn<typeof fetch>().mockResolvedValue(token());const auth=new IfoodAuthService(env,http);await Promise.all([auth.getAccessToken(),auth.getAccessToken()]);await auth.getAccessToken();expect(http).toHaveBeenCalledTimes(1);expect((http.mock.calls[0]?.[1]?.body as URLSearchParams).toString()).toContain('grantType=client_credentials');});
 it('refreshes once on 401, not on every call',async()=>{const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({},401)).mockResolvedValueOnce(token()).mockResolvedValueOnce(json({id:merchant}));await new IfoodClient(env,http).request('/test');expect(http).toHaveBeenCalledTimes(4);});
 it.each([401,403,404,429,500])('reports HTTP %i without an uncontrolled retry',async status=>{const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({},status)).mockResolvedValueOnce(token()).mockResolvedValue(json({},status));await expect(new IfoodClient(env,http).request('/test')).rejects.toMatchObject({status});expect(http.mock.calls.length).toBeLessThanOrEqual(4);});
 it('classifies timeout without leaking upstream error or token',async()=>{const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockRejectedValue(new Error('secret-sensitive-url'));await expect(new IfoodClient(env,http).request('/test')).rejects.toEqual(new IfoodHttpError(0));});
 it('honors retry-after on throttling',async()=>{const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'120'}}));await expect(new IfoodClient(env,http).request('/test')).rejects.toMatchObject({status:429,retryAfterSeconds:120});});
 it('uses Events polling/ACK and merchant dispatch only via backend POST',async()=>{const http=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValue(new Response(null,{status:202}));const p=new IfoodProvider(new IfoodClient(env,http));expect(await p.pollEvents([merchant])).toEqual([]);await p.acknowledge(['a','a']);await p.dispatchOrder(merchant);expect(http.mock.calls[1]?.[0]).toContain('/events/v1.0/events:polling?excludeHeartbeat=true');expect(http.mock.calls[2]?.[1]?.body).toBe('[{"id":"a"}]');expect(http.mock.calls[3]?.[1]).toMatchObject({method:'POST',body:'{"deliveredBy":"MERCHANT"}'});});
});
describe('iFood worker recovery',()=>{
 it('clears its busy flag when acquiring a connection fails',async()=>{
   const connect=vi.fn().mockRejectedValue(new Error('connection unavailable'));
   const worker=createIfoodWorker({connect} as unknown as Database,{...env,IFOOD_ENABLED:true,IFOOD_MODE:'mock'});
   await expect(worker()).rejects.toThrow('connection unavailable');await expect(worker()).rejects.toThrow('connection unavailable');
   expect(connect).toHaveBeenCalledTimes(2);
 });
});
describe('event security and status order',()=>{
 it('validates raw-byte HMAC without accepting altered body or missing secret',()=>{const raw=Buffer.from('{ "id": "test" }');const signature=createHmac('sha256','secret').update(raw).digest('hex');expect(validIfoodSignature(raw,signature,'secret')).toBe(true);expect(validIfoodSignature(Buffer.from('{"id":"test"}'),signature,'secret')).toBe(false);expect(validIfoodSignature(raw,'bad','secret')).toBe(false);expect(validIfoodSignature(raw,signature,'')).toBe(false);});
 it('does not regress state for duplicates or delayed PLACED after cancellation',()=>{expect(externalStatus('CFM','')).toBe('CONFIRMED');expect(externalStatus('XYZ','UNKNOWN')).toBeNull();expect(advancesExternalStatus('CANCELLED','PLACED')).toBe(false);expect(advancesExternalStatus('DISPATCHED','CONFIRMED')).toBe(false);expect(advancesExternalStatus('CONFIRMED','CANCELLED')).toBe(true);});
});
