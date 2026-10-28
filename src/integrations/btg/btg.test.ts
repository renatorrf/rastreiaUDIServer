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

async function fixture(enabled=true,logs?:string[]){
  const store:BtgStore={configuration:vi.fn(async()=>credentials),begin:vi.fn(),consume:vi.fn(async()=>true),save:vi.fn()};
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(tokens)));
  const app=Fastify({logger:logs?{level:'warn',stream:{write:(line:string)=>{logs.push(line);}}}:false});await app.register(cookie);
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
  it.each([
    [400,'invalid_grant'],[401,'invalid_client'],[403,'unauthorized_client'],[429,'temporarily_unavailable'],[500,'server_error'],
  ])('diagnoses HTTP %i with only an allowlisted OAuth code',async(status,error)=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error,error_description:'private-code secret token',access_token:'sensitive'}),{status}));
    await expect(exchangeCode(env,'private-code',credentials,fetcher)).rejects.toMatchObject({
      code:'BTG_TOKEN_EXCHANGE_FAILED',diagnostic:{category:'HTTP_REJECTED',httpStatus:status,oauthError:error},
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('never includes arbitrary provider errors, token values or schema input in diagnostics',async()=>{
    for(const response of [
      new Response(JSON.stringify({error:'private-token',error_description:'private-secret'}),{status:400}),
      new Response(JSON.stringify({...tokens,expires_in:'private-token',refresh_token:null,extra:'private-secret'})),
      new Response('private-token'),
    ]){
      const error=await exchangeCode(env,'private-code',credentials,async()=>response).catch((e:unknown)=>e);
      const serialized=JSON.stringify(error);
      for(const secret of ['private-token','private-secret','private-code',tokens.access_token])expect(serialized).not.toContain(secret);
      expect(error).toMatchObject({code:'BTG_TOKEN_EXCHANGE_FAILED'});
    }
  });
  it('distinguishes JSON, schema and scope validation failures without relaxing validation',async()=>{
    await expect(exchangeCode(env,'code',credentials,async()=>new Response('not json'))).rejects.toMatchObject({diagnostic:{category:'INVALID_JSON',httpStatus:200}});
    await expect(exchangeCode(env,'code',credentials,async()=>new Response(JSON.stringify({...tokens,expires_in:'3600',refresh_token:null})))).rejects.toMatchObject({
      diagnostic:{category:'INVALID_TOKEN_RESPONSE',invalidFields:['refresh_token','expires_in']},
    });
    await expect(exchangeCode(env,'code',credentials,async()=>new Response(JSON.stringify({...tokens,scope:'openid'})))).rejects.toMatchObject({
      diagnostic:{category:'MISSING_SCOPES',missingScopes:['pix_cash_in']},
    });
  });
  it.each(['TimeoutError','AbortError','TypeError'])('classifies %s without logging exception text or retrying',async name=>{
    const failure=new Error('private-url-with-code');failure.name=name;
    const fetcher=vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(exchangeCode(env,'private-code',credentials,fetcher)).rejects.toMatchObject({
      diagnostic:{category:name==='TypeError'?'NETWORK_ERROR':'TIMEOUT'},
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('logs safe exchange details without exposing provider data in logs or HTML',async()=>{
    const logs:string[]=[];const {app,fetcher,store,ticket}=await fixture(true,logs);
    fetcher.mockResolvedValue(new Response(JSON.stringify({error:'invalid_client',error_description:'DO_NOT_LOG_THIS',access_token:tokens.access_token}),{status:401}));
    try{
      const result=await app.inject({url:`/integrations/btg/callback?${new URLSearchParams({state:ticket,iss:'https://id.sandbox.btgpactual.com',code:'private-code'}).toString()}`,headers:{cookie:`__Secure-rastreia-btg=${'x'.repeat(43)}`}});
      expect(result.statusCode).toBe(502);expect(store.save).not.toHaveBeenCalled();
      const record=logs.map(line=>JSON.parse(line) as Record<string,unknown>).find(line=>line['msg']==='BTG authorization not completed');
      expect(record).toMatchObject({reason:'BTG_TOKEN_EXCHANGE_FAILED',stage:'exchange',diagnostic:{category:'HTTP_REJECTED',httpStatus:401,oauthError:'invalid_client'}});
      for(const secret of ['DO_NOT_LOG_THIS','private-code',tokens.access_token,ticket,'x'.repeat(43),credentials.clientSecret]){
        expect(logs.join('')).not.toContain(secret);expect(result.body).not.toContain(secret);
      }
      expect(result.body).not.toContain('invalid_client');
    }finally{await app.close();}
  });
  it('identifies save failures without logging database exception details',async()=>{
    const logs:string[]=[];const {app,store,ticket}=await fixture(true,logs);
    vi.mocked(store.save).mockRejectedValue(new Error('private-database-details'));
    try{
      await app.inject({url:`/integrations/btg/callback?${new URLSearchParams({state:ticket,iss:'https://id.sandbox.btgpactual.com',code:'private-code'}).toString()}`,headers:{cookie:`__Secure-rastreia-btg=${'x'.repeat(43)}`}});
      expect(logs.join('')).toContain('"stage":"save"');expect(logs.join('')).not.toContain('private-database-details');
    }finally{await app.close();}
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
