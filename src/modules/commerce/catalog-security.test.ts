import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import argon2 from 'argon2';
import sharp from 'sharp';
import Fastify,{type FastifyInstance} from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { afterEach,beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { createTokenPair } from '../auth/token.service.js';
import type { TenantRole } from '../auth/auth.types.js';
import { catalogImportRoutes } from './catalog-import.routes.js';
import { mediaRoutes } from './media.routes.js';
describe('catalog import and media route boundaries',()=>{
  const store=randomUUID(),product=randomUUID(),id=randomUUID(),userId=randomUUID(),tenantId=randomUUID();
  const env={NODE_ENV:'test',JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
  const query=vi.fn(),db={connect:async()=>({query,release:()=>{}}),query} as unknown as Database;
  const storage={put:vi.fn(),open:vi.fn(),remove:vi.fn()};let app:FastifyInstance,hash:string;
  const headers=async(role:TenantRole='TENANT_MANAGER')=>({authorization:`Bearer ${(await createTokenPair(env,{userId,tenantId,role,storeIds:[store]})).accessToken}`,'idempotency-key':'catalog-security-test'});
  const base=`/commerce/stores/${store}`,imagePath=`${base}/products/${product}/images`;
  beforeAll(async()=>{hash=await argon2.hash('test-confirmation');});
  beforeEach(async()=>{query.mockReset();storage.open.mockReset();storage.put.mockReset();storage.remove.mockReset();query.mockImplementation(async(sql:string)=>({rows:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('SELECT u.password_hash')?[{password_hash:hash}]:[],rowCount:0}));
    app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(error instanceof ZodError?422:e.statusCode??500).send({message:e.message});});
    await app.register(multipart);await app.register(rateLimit,{global:false});await catalogImportRoutes(app,db,env);await mediaRoutes(app,db,env,storage);await app.ready();
  });
  afterEach(()=>app.close());
  it('requires authentication for imports and images',async()=>{
    for(const url of [`${base}/imports`,imagePath,`${imagePath}/${id}/file`])expect((await app.inject({url})).statusCode).toBe(401);
  });
  it.each(['COURIER','STORE_OPERATOR'] as const)('denies %s before reading files or data',async role=>{
    const h=await headers(role);for(const url of [`${base}/imports`,imagePath]){expect((await app.inject({url,headers:h})).statusCode).toBe(403);expect((await app.inject({method:'POST',url,headers:h})).statusCode).toBe(403);}expect(storage.put).not.toHaveBeenCalled();
  });
  it('checks store access before file processing and idempotent replay',async()=>{
    const h=await headers();expect((await app.inject({method:'POST',url:`${imagePath}?expectedVersion=1`,headers:h})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`${base}/imports`,headers:h})).statusCode).toBe(404);
    expect((await app.inject({method:'PATCH',url:imagePath,headers:h,payload:{expectedVersion:1,images:[]}})).statusCode).toBe(404);
    expect(storage.put).not.toHaveBeenCalled();expect(query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO idempotency_keys'))).toBe(false);
  });
  it('requires manager password before import writes',async()=>{
    const route={method:'POST' as const,url:`${base}/imports/${id}/apply`,headers:await headers()};
    expect((await app.inject({...route,payload:{}})).statusCode).toBe(422);expect((await app.inject({...route,payload:{confirmationPassword:'wrong'}})).statusCode).toBe(403);
    expect(query.mock.calls.some(([sql])=>/^(INSERT|UPDATE)/.test(String(sql)))).toBe(false);
  });
  it('processes multipart images once even when the same request is retried',async()=>{
    let requestHash='',responseBody:unknown=null;
    query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('INSERT INTO idempotency_keys'))requestHash=String(values[4]);
      if(sql.includes('UPDATE idempotency_keys'))responseBody=JSON.parse(String(values[4]));
      return {rows:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('commerce_manage_store')?[{allowed:true}]:sql.includes('media_version AS version')?[{version:1,name:'Café teste'}]:sql.includes('SELECT actor_user_id, request_hash')?[{actor_user_id:userId,request_hash:requestHash,response_status:responseBody?200:null,response_body:responseBody}]:[],rowCount:0};
    });storage.put.mockResolvedValue({objectUrl:'test-object'});
    const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#339966'}}).png().toBuffer();
    const payload=Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n'),bytes,Buffer.from('\r\n--testboundary--\r\n')]);
    const request={method:'POST' as const,url:`${imagePath}?expectedVersion=1`,headers:{...await headers(),'content-type':'multipart/form-data; boundary=testboundary'},payload};
    const first=await app.inject(request);expect(first.statusCode).toBe(200);expect(storage.put).toHaveBeenCalledTimes(2);expect(first.json().version).toBe(2);
    const retry=await app.inject(request);expect(retry.statusCode).toBe(200);expect(retry.headers['idempotency-replayed']).toBe('true');expect(retry.json()).toEqual(first.json());expect(storage.put).toHaveBeenCalledTimes(2);
  });
  it('serves public images only via the scoped projection and uses no-store',async()=>{
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('commerce_public_image')?[{key:'private/photo.webp'}]:[],rowCount:0}));storage.open.mockResolvedValue(Readable.from(Buffer.from('image')));
    const response=await app.inject({url:`/public/commerce/stores/loja-teste/images/${id}`});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('image/webp');expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');expect(storage.open).toHaveBeenCalledWith('private/photo.webp');
    query.mockResolvedValue({rows:[{key:null}],rowCount:1});storage.open.mockClear();expect((await app.inject({url:`/public/commerce/stores/loja-teste/images/${id}`})).statusCode).toBe(404);expect(storage.open).not.toHaveBeenCalled();
  });
});
