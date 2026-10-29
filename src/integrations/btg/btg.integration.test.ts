import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { parseAppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import type { AuthContext } from '../../modules/auth/auth.types.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import { saveCompanyService,resolveCompanyService,safeCompanyService } from '../../modules/company-settings/company-settings.service.js';
import { createBtgStore } from './btg.store.js';
import { BTG_SCOPE, createState, hash, readState } from './btg.oauth.js';
import { btgRoutes } from './btg.routes.js';
import { createTokenPair } from '../../modules/auth/token.service.js';
import { companySettingsRoutes } from '../../modules/company-settings/company-settings.routes.js';

describe('BTG migration and durable tenant isolation',()=>{
  const pg=new PGlite();
  const database={connect:async()=>({query:async(sql:string,params:unknown[]=[])=>{
    const result=await pg.query(sql,params);return {...result,rowCount:Math.max(result.affectedRows??0,result.rows.length)};
  },release:()=>{}})} as unknown as Database;
  const env=parseAppEnv({NODE_ENV:'test',DATABASE_URL:'postgresql://unused:unused@localhost/unused',
    JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40),TRACKING_TOKEN_PEPPER:'c'.repeat(40),
    BTG_ENABLED:'true',BTG_CLIENT_ID:'test-client',BTG_CLIENT_SECRET:'test-secret',BTG_ENCRYPTION_SECRET:'d'.repeat(40),
    BTG_REDIRECT_URI:'https://api.example.com/integrations/btg/callback'});
  const auth:AuthContext={tenantId:randomUUID(),userId:randomUUID(),role:'TENANT_MANAGER',storeIds:[randomUUID()],sessionId:randomUUID()};
  const other:AuthContext={...auth,tenantId:randomUUID(),userId:randomUUID(),storeIds:[randomUUID()]};
  const company=randomUUID(),otherCompany=randomUUID(),siblingCompany=randomUUID();
  const store=createBtgStore(database,env);
  const credentials={mode:'sandbox' as const,clientId:'company-client',clientSecret:'company-secret',version:1};
  const tokens={access_token:'sensitive-access',refresh_token:'sensitive-refresh',token_type:'Bearer',expires_in:3600,scope:BTG_SCOPE};
  beforeAll(async()=>{
    await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;
      GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.user_id',true),'')::uuid$$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.tenant_id',true),'')::uuid$$;
      CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now();RETURN NEW;END;$$;
      CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
      CREATE TABLE users(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE',password_hash text);
      CREATE TABLE tenant_users(tenant_id uuid,user_id uuid,role text,status text DEFAULT 'ACTIVE');
      CREATE TABLE companies(id uuid PRIMARY KEY,tenant_id uuid,name text DEFAULT 'Test company',status text DEFAULT 'ACTIVE',UNIQUE(id,tenant_id));
      CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid);
      CREATE FUNCTION store_in_scope(requested uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM stores s WHERE s.id=requested AND s.tenant_id=current_tenant_id())
        AND current_setting('app.store_ids',true)::jsonb ? requested::text$$;
      CREATE FUNCTION tenant_session_is_current(t uuid,u uuid,r text,ids uuid[]) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM tenant_users m WHERE m.tenant_id=t AND m.user_id=u AND m.role=r AND m.status='ACTIVE')$$;
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0049_company_service_settings.sql',import.meta.url),'utf8')+'COMMIT;');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0065_btg_authorization.sql',import.meta.url),'utf8')+'COMMIT;');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0066_btg_company_settings.sql',import.meta.url),'utf8')+'COMMIT;');
    for(const [ctx,c] of [[auth,company],[other,otherCompany]] as const){
      await pg.query('INSERT INTO tenants(id) VALUES($1)',[ctx.tenantId]);
      await pg.query('INSERT INTO users(id) VALUES($1)',[ctx.userId]);
      await pg.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'TENANT_MANAGER')",[ctx.tenantId,ctx.userId]);
      await pg.query('INSERT INTO companies(id,tenant_id) VALUES($1,$2)',[c,ctx.tenantId]);
      await pg.query('INSERT INTO stores VALUES($1,$2,$3)',[ctx.storeIds[0],ctx.tenantId,c]);
      await withTenantTransaction(database,ctx,client=>saveCompanyService(client,env,{tenantId:ctx.tenantId,companyId:c,provider:'BTG',enabled:true,publicConfig:{mode:credentials.mode,clientId:ctx===auth?credentials.clientId:'other-client'},secrets:{clientSecret:ctx===auth?credentials.clientSecret:'other-secret'},updatedBy:ctx.userId}));
    }
    await pg.query('INSERT INTO companies(id,tenant_id) VALUES($1,$2)',[siblingCompany,auth.tenantId]);
    await pg.query('INSERT INTO stores VALUES($1,$2,$3)',[randomUUID(),auth.tenantId,siblingCompany]);
    await pg.query('UPDATE users SET password_hash=$1',[await argon2.hash('test-only-manager-password')]);
  },20000);
  afterAll(async()=>{await pg.close();});
  it('initiates only with the current manager password and sets the browser-binding cookie',async()=>{
    const app=Fastify();app.decorateRequest('auth');await app.register(cookie);await btgRoutes(app,database,env);
    const access=await createTokenPair(env,auth);
    const request={method:'POST' as const,url:`/companies/${company}/integrations/btg/authorization`,headers:{authorization:`Bearer ${access.accessToken}`}};
    try{
      expect((await app.inject({...request,payload:{confirmationPassword:'wrong'}})).statusCode).toBe(403);
      const result=await app.inject({...request,payload:{confirmationPassword:'test-only-manager-password'}});
      expect(result.statusCode).toBe(200);
      const binding=String(result.headers['set-cookie']);
      expect(binding).toContain('Secure');expect(binding).toContain('HttpOnly');expect(binding).toContain('SameSite=None');
      const data=result.json<{authorizationUrl:string}>(),ticket=new URL(data.authorizationUrl).searchParams.get('state')!;
      expect(readState(env,ticket).companyId).toBe(company);
      expect(result.body).not.toContain('test-only-manager-password');
      expect((await app.inject({...request,url:`/companies/${otherCompany}/integrations/btg/authorization`,payload:{confirmationPassword:'test-only-manager-password'}})).statusCode).toBe(400);
    }finally{await app.close();}
  });
  it('denies a courier even with valid credentials',async()=>{
    const app=Fastify();app.decorateRequest('auth');await app.register(cookie);await btgRoutes(app,database,env);
    await pg.query("UPDATE tenant_users SET role='COURIER' WHERE user_id=$1",[auth.userId]);
    try{
      const access=await createTokenPair(env,{...auth,role:'COURIER'});
      const result=await app.inject({method:'POST',url:`/companies/${company}/integrations/btg/authorization`,headers:{authorization:`Bearer ${access.accessToken}`},payload:{confirmationPassword:'test-only-manager-password'}});
      expect(result.statusCode).toBe(403);
    }finally{await pg.query("UPDATE tenant_users SET role='TENANT_MANAGER' WHERE user_id=$1",[auth.userId]);await app.close();}
  });
  it('rejects another tenant and a company outside the unit scope',async()=>{
    for(const id of [otherCompany,siblingCompany]){
      const {state,ticket}=createState(env,auth,id,credentials);
      await expect(store.begin(state,hash(ticket),hash('browser'))).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
    }
  });
  it('consumes once, rejects another browser and encrypts tokens with only safe audit data',async()=>{
    const {state,ticket}=createState(env,auth,company,credentials),key=hash(ticket),browser=hash('browser');
    await store.begin(state,key,browser);
    expect(await store.consume(state,key,hash('different-browser'))).toBe(false);
    expect(await store.consume(state,key,browser)).toBe(true);
    expect(await store.consume(state,key,browser)).toBe(false);
    await store.save(state,key,tokens);
    const result=await withTenantTransaction(database,auth,client=>client.query<{tokens_encrypted:string;status:string}>('SELECT * FROM btg_authorizations'));
    expect(result.rows).toHaveLength(1);expect(result.rows[0]!.status).toBe('PENDING_ACCOUNT_VALIDATION');
    expect(result.rows[0]!.tokens_encrypted).not.toContain('sensitive');
    expect(decryptPayload(result.rows[0]!.tokens_encrypted,env.BTG_ENCRYPTION_SECRET)).toMatchObject({...tokens,companyId:company,tenantId:auth.tenantId});
    expect(JSON.stringify((await pg.query('SELECT * FROM audit_logs')).rows)).not.toContain('sensitive');
    expect((await withTenantTransaction(database,other,client=>client.query('SELECT * FROM btg_authorizations'))).rows).toHaveLength(0);
  });
  it('does not let an older callback replace a newer authorization attempt',async()=>{
    const a=createState(env,auth,company,credentials),b=createState(env,auth,company,credentials),browser=hash('browser');
    await store.begin(a.state,hash(a.ticket),browser);await store.consume(a.state,hash(a.ticket),browser);
    await store.begin(b.state,hash(b.ticket),browser);
    await expect(store.save(a.state,hash(a.ticket),tokens)).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
    expect(await store.consume(a.state,hash(a.ticket),browser)).toBe(false);
  });
  it('rejects revoked managers and expired authorization in the database',async()=>{
    const {state,ticket}=createState(env,auth,company,credentials);
    await store.begin({...state,exp:Date.now()-1000},hash(ticket),hash('browser'));
    expect(await store.consume(state,hash(ticket),hash('browser'))).toBe(false);
    await pg.query("UPDATE tenant_users SET role='COURIER' WHERE user_id=$1",[auth.userId]);
    try{
      await expect(store.begin(state,hash(ticket),hash('browser'))).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
      expect((await withTenantTransaction(database,auth,client=>client.query('SELECT * FROM btg_authorizations'))).rows).toHaveLength(0);
    }finally{await pg.query("UPDATE tenant_users SET role='TENANT_MANAGER' WHERE user_id=$1",[auth.userId]);}
  });
  it('loads separate credentials and never returns secrets in the configuration response',async()=>{
    expect(await store.configuration(auth,company)).toMatchObject(credentials);
    expect(await store.configuration(other,otherCompany)).toMatchObject({clientId:'other-client',clientSecret:'other-secret'});
    const safe=await withTenantTransaction(database,auth,async client=>safeCompanyService(await resolveCompanyService(client,env,company,'BTG')));
    expect(safe.configuredSecrets).toEqual(['clientSecret']);expect(JSON.stringify(safe)).not.toContain(credentials.clientSecret);
    const missing=await withTenantTransaction(database,auth,async client=>resolveCompanyService(client,env,siblingCompany,'BTG'));
    expect(missing.enabled).toBe(false);expect(missing.values['clientSecret']).toBeUndefined();
    expect(missing.values['clientId']).toBe('');
  });
  it('invalidates pending authorization when settings change, without touching another company',async()=>{
    const old=createState(env,auth,company,credentials);
    await store.begin(old.state,hash(old.ticket),hash('browser'));
    await withTenantTransaction(database,auth,client=>saveCompanyService(client,env,{tenantId:auth.tenantId,companyId:company,provider:'BTG',enabled:true,publicConfig:{mode:'sandbox',clientId:credentials.clientId},secrets:{clientSecret:'new-company-secret'},updatedBy:auth.userId}));
    await expect(store.consume(old.state,hash(old.ticket),hash('browser'))).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
    expect((await store.configuration(other,otherCompany)).clientSecret).toBe('other-secret');
  });
  it('requires a new secret after a client/environment change and refuses disabled configuration',async()=>{
    const save=(enabled:boolean,mode:string)=>withTenantTransaction(database,auth,client=>saveCompanyService(client,env,{tenantId:auth.tenantId,companyId:company,provider:'BTG',enabled,publicConfig:{mode,clientId:'changed-client'},secrets:{clientSecret:''},updatedBy:auth.userId}));
    await expect(save(true,'production')).rejects.toMatchObject({code:'BTG_CREDENTIALS_REQUIRED'});
    await save(false,'production');
    await expect(store.configuration(auth,company)).rejects.toMatchObject({code:'BTG_COMPANY_NOT_CONFIGURED'});
  });
  it('exposes safe status and directs BTG configuration to platform activation',async()=>{
    const app=Fastify();app.decorateRequest('auth');await companySettingsRoutes(app,database,env);
    const access=await createTokenPair(env,other),headers={authorization:`Bearer ${access.accessToken}`};
    try{
      const listed=await app.inject({url:'/company-service-settings',headers});
      expect(listed.statusCode).toBe(200);expect(listed.body).not.toContain('other-secret');
      const data=listed.json<{data:Array<{company:{id:string};services:Array<{provider:string;publicConfig:Record<string,unknown>}>}>}>().data;
      expect(data.map(item=>item.company.id)).toEqual([otherCompany]);
      expect(data[0]!.services.find(service=>service.provider==='BTG')!.publicConfig).toMatchObject({managedByActivation:true,serverReady:true});
      expect(listed.body).not.toContain('other-client');
      const payload={provider:'BTG',enabled:true,publicConfig:{mode:'sandbox',clientId:'other-client'},secrets:{clientSecret:'http-test-secret'},confirmationPassword:'test-only-manager-password'};
      expect((await app.inject({method:'PUT',url:`/companies/${company}/service-settings`,headers,payload})).statusCode).toBe(403);
      const saved=await app.inject({method:'PUT',url:`/companies/${otherCompany}/service-settings`,headers,payload});
      expect(saved.statusCode).toBe(403);expect(saved.body).not.toContain('http-test-secret');
      expect((await store.configuration(other,otherCompany)).clientSecret).toBe('other-secret');
    }finally{await app.close();}
  });
});
