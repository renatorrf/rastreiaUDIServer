import { randomUUID } from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import { ZodError } from 'zod';
import { beforeEach,afterEach,it,expect,vi,describe } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { createTokenPair } from '../auth/token.service.js';
import { liveVideoRoutes } from './live-video.routes.js';
describe('IVS HTTP boundaries',()=>{
  const store=randomUUID(),id=randomUUID(),tenantId=randomUUID(),userId=randomUUID();
  const env={NODE_ENV:'test',IVS_ENABLED:true,IVS_REGION:'us-east-1',IVS_CHANNELS_JSON:JSON.stringify({[store]:'arn:aws:ivs:us-east-1:123456789012:channel/demo'}),IVS_PLAYBACK_PRIVATE_KEY:'test',APP_ORIGINS:'https://example.test',JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
  const query=vi.fn(),db={query,connect:async()=>({query,release:()=>{}})} as unknown as Database;
  const provider={channel:vi.fn(),key:vi.fn(),online:vi.fn(),stop:vi.fn(),revoke:vi.fn(),playback:vi.fn()};
  let app:FastifyInstance;const base=`/commerce/stores/${store}/lives/${id}/studio`;
  const headers=async(role:'TENANT_MANAGER'|'COURIER'='TENANT_MANAGER')=>({authorization:`Bearer ${(await createTokenPair(env,{userId,tenantId,role,storeIds:[store]})).accessToken}`});
  beforeEach(async()=>{vi.clearAllMocks();query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:[],rowCount:0}));app=Fastify();app.setErrorHandler((e,_,reply)=>{reply.code(e instanceof ZodError?422:(e as {statusCode?:number}).statusCode??500).send({error:(e as Error).message});});await liveVideoRoutes(app,db,env,provider);await app.ready();});
  afterEach(async()=>{await app.close();});
  it('requires authentication and a manager on all studio operations',async()=>{
    for(const action of ['connect','heartbeat','disconnect']){
      expect((await app.inject({method:'POST',url:`${base}/${action}`,payload:{leaseToken:'a'.repeat(64)}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:`${base}/${action}`,headers:await headers('COURIER'),payload:{leaseToken:'a'.repeat(64)}})).statusCode).toBe(403);
    }
    expect((await app.inject({url:base})).statusCode).toBe(401);expect(provider.key).not.toHaveBeenCalled();
  });
  it('validates ownership before touching AWS and rejects injected channel/tenant fields',async()=>{
    expect((await app.inject({url:base,headers:await headers()})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`${base}/connect`,headers:await headers(),payload:{leaseToken:'a'.repeat(64)}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`${base}/connect`,headers:await headers(),payload:{leaseToken:'a'.repeat(64),channelArn:'foreign'}})).statusCode).toBe(422);
    expect(provider.channel).not.toHaveBeenCalled();expect(provider.key).not.toHaveBeenCalled();
  });
  it('returns only a signed viewer grant without caching or broadcaster keys',async()=>{
    query.mockResolvedValue({rows:[{data:{id:randomUUID(),channelArn:'arn',playbackUrl:'https://demo',deadlineAt:'2099-01-01'}}],rowCount:1});provider.playback.mockResolvedValue('signed-playback');
    const response=await app.inject({method:'POST',url:`/public/lives/${'f'.repeat(64)}/video/join`,payload:{leaseToken:'c'.repeat(64)}});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({playbackUrl:'signed-playback',deadlineAt:'2099-01-01'});expect(response.headers['cache-control']).toBe('no-store');expect(provider.key).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql])=>String(sql).includes('idempotency_keys'))).toBe(false);
  });
});
