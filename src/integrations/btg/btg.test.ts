import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseAppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { AuthContext } from '../../modules/auth/auth.types.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { btgRoutes } from './btg.routes.js';
import { BTG_SCOPE, createState, readState, exchangeCode, hash, authorizationUrl, assertStateCredentials } from './btg.oauth.js';
import type { BtgStore } from './btg.store.js';

const source={ NODE_ENV:'test',DATABASE_URL:'postgresql://unused:unused@localhost/unused',
  JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40),TRACKING_TOKEN_PEPPER:'c'.repeat(40),
  BTG_ENABLED:'true',BTG_MODE:'sandbox',BTG_CLIENT_ID:'test-client',BTG_CLIENT_SECRET:'test-secret',
  BTG_ENCRYPTION_SECRET:'test-only-encryption-key-32-characters',BTG_REDIRECT_URI:'https://api.example.com/integrations/btg/callback' };
const env=parseAppEnv(source);
const credentials={mode:'sandbox' as const,clientId:'test-client',clientSecret:'test-secret',version:1};
const auth:AuthContext={tenantId:randomUUID(),userId:randomUUID(),storeIds:[randomUUID()],role:'TENANT_MANAGER',sessionId:randomUUID()};
const tokens={access_token:'private-access-token',refresh_token:'private-refresh-token',token_type:'Bearer',expires_in:3600,scope:BTG_SCOPE};
afterEach(()=>vi.restoreAllMocks());

async function fixture(enabled=true){
  const store:BtgStore={configuration:vi.fn(async()=>credentials),begin:vi.fn(),consume:vi.fn(async()=>true),save:vi.fn()};
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(tokens)));
  const app=Fastify();await app.register(cookie);
  await btgRoutes(app,{} as Database,{...env,BTG_ENABLED:enabled},{store,fetcher});
  const {state,ticket}=createState(env,auth,randomUUID(),credentials);
  return {app,store,fetcher,state,ticket};
}
describe('BTG authorization security',()=>{
  it('requires explicit configuration and an exact HTTPS callback',()=>{
    expect(parseAppEnv({...source,BTG_ENABLED:'false',BTG_CLIENT_SECRET:''}).BTG_ENABLED).toBe(false);
    for(const uri of ['http://api.example.com/integrations/btg/callback','https://api.example.com/other','https://api.example.com/integrations/btg/callback?x=1']){
      expect(()=>parseAppEnv({...source,BTG_REDIRECT_URI:uri})).toThrow();
    }
    expect(parseAppEnv({...source,BTG_CLIENT_SECRET:'',BTG_CLIENT_ID:''}).BTG_ENABLED).toBe(true);
  });
  it('rejects expired, tampered and other-environment state',()=>{
    const {state,ticket}=createState(env,auth,randomUUID(),credentials);
    expect(readState(env,ticket).tenantId).toBe(auth.tenantId);
    expect(()=>readState(env,ticket.slice(0,-8)+'corrupted')).toThrow();
    expect(()=>assertStateCredentials(state,{...credentials,mode:'production'})).toThrow();
    expect(()=>assertStateCredentials(state,{...credentials,version:2})).toThrow();
    expect(()=>readState(env,encryptPayload({...state,exp:Date.now()-1},env.BTG_ENCRYPTION_SECRET))).toThrow();
  });
  it('uses Basic authentication, form-urlencoded and the registered callback without redirects',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(tokens)));
    expect(await exchangeCode(env,'one-time-code',credentials,fetcher)).toEqual(tokens);
    const [url,options]=fetcher.mock.calls[0]!;
    expect(url).toBe('https://id.sandbox.btgpactual.com/oauth2/token');
    expect(options?.redirect).toBe('error');expect(options?.signal).toBeDefined();
    expect(new Headers(options?.headers).get('authorization')).toBe(`Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
    expect(options?.body).toBeInstanceOf(URLSearchParams);
    expect((options?.body as URLSearchParams).toString()).toContain('grant_type=authorization_code');
    expect((options?.body as URLSearchParams).toString()).toContain(encodeURIComponent(env.BTG_REDIRECT_URI));
  });
  it('sanitizes provider failures and refuses missing scopes',async()=>{
    for(const response of [new Response('private-provider-details',{status:400}),new Response(JSON.stringify({...tokens,scope:'openid'}))]){
      await expect(exchangeCode(env,'sensitive-code',credentials,async()=>response)).rejects.toMatchObject({code:'BTG_TOKEN_EXCHANGE_FAILED'});
    }
  });
  it('requires authentication to initiate and fails closed when disabled',async()=>{
    const {app,fetcher}=await fixture(false);
    try {
      expect((await app.inject({method:'POST',url:`/companies/${randomUUID()}/integrations/btg/authorization`,payload:{}})).statusCode).toBe(401);
      expect((await app.inject('/integrations/btg/callback')).statusCode).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
  it('uses the bound browser and stores tokens without exposing them',async()=>{
    const {app,store,fetcher,state,ticket}=await fixture();
    try{
      const destination=new URL(authorizationUrl(env,ticket,credentials));
      expect(destination.origin).toBe('https://id.sandbox.btgpactual.com');
      expect(destination.searchParams.get('state')).toBe(ticket);
      const result=await app.inject({url:`/integrations/btg/callback?${new URLSearchParams({state:ticket,code:'private-code',iss:destination.origin}).toString()}`,headers:{cookie:`__Secure-rastreia-btg=${'x'.repeat(43)}`}});
      expect(result.statusCode).toBe(200);expect(result.body).toContain('Autorização recebida');
      expect(result.body).not.toContain(tokens.access_token);expect(result.body).not.toContain('private-code');
      expect(result.headers['cache-control']).toBe('no-store');expect(result.headers['referrer-policy']).toBe('no-referrer');
      expect(store.save).toHaveBeenCalledWith(state,hash(ticket),tokens);expect(fetcher).toHaveBeenCalledOnce();
    }finally{await app.close();}
  });
  it.each(['missing-cookie','bad-issuer','replay','denied','duplicate-code'])('rejects %s without exchanging tokens',async kind=>{
    const {app,store,fetcher,ticket}=await fixture();
    try{
      if(kind==='replay')vi.mocked(store.consume).mockResolvedValue(false);
      const query=new URLSearchParams({state:ticket,iss:kind==='bad-issuer'?'https://evil.example':'https://id.sandbox.btgpactual.com',...(kind==='denied'?{error:'access_denied'}:{code:'secret'})});
      if(kind==='duplicate-code')query.append('code','another');
      const result=await app.inject({url:`/integrations/btg/callback?${query.toString()}`,headers:kind==='missing-cookie'?{}:{cookie:`__Secure-rastreia-btg=${'x'.repeat(43)}`}});
      expect(result.statusCode).toBe(400);expect(fetcher).not.toHaveBeenCalled();expect(store.save).not.toHaveBeenCalled();
      expect(result.body).not.toContain(ticket);
    }finally{await app.close();}
  });
  it('requires a new authorization after a timeout, without saving tokens',async()=>{
    const {app,store,fetcher,ticket}=await fixture();
    fetcher.mockRejectedValue(new Error('sensitive-upstream-error'));
    try{
      const result=await app.inject({url:`/integrations/btg/callback?${new URLSearchParams({state:ticket,iss:'https://id.sandbox.btgpactual.com',code:'secret'}).toString()}`,headers:{cookie:`__Secure-rastreia-btg=${'x'.repeat(43)}`}});
      expect(result.statusCode).toBe(502);expect(store.consume).toHaveBeenCalledOnce();expect(store.save).not.toHaveBeenCalled();
      expect(result.body).not.toContain('sensitive-upstream-error');
    }finally{await app.close();}
  });
});
