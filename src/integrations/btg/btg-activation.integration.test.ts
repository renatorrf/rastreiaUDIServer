import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { ZodError } from 'zod';
import { afterAll,beforeAll,describe,it,expect } from 'vitest';
import { parseAppEnv } from '../../config/env.js';
import { withTenantTransaction,withPlatformTransaction,type Database } from '../../database/pool.js';
import { createPlatformTokenPair,createTokenPair } from '../../modules/auth/token.service.js';
import { resolveCompanyService } from '../../modules/company-settings/company-settings.service.js';
import { companySettingsRoutes } from '../../modules/company-settings/company-settings.routes.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { btgActivationRoutes } from './btg-activation.routes.js';
import { createBtgStore } from './btg.store.js';
import { createState,hash } from './btg.oauth.js';

describe('BTG activation: isolated PostgreSQL migration, HTTP and RLS',()=>{
 const pg=new PGlite(),admin=randomUUID(),user=randomUUID(),tenant=randomUUID(),company=randomUUID(),unit=randomUUID(),otherCompany=randomUUID();
 const password='test-master-password';let app:FastifyInstance,applicationId:string,headers:Record<string,string>,managerHeaders:Record<string,string>;
 const env=parseAppEnv({NODE_ENV:'test',DATABASE_URL:'postgresql://unused:unused@localhost/unused',JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40),TRACKING_TOKEN_PEPPER:'c'.repeat(40),BTG_ENCRYPTION_SECRET:'d'.repeat(40),BTG_ENABLED:'true',BTG_REDIRECT_URI:'https://api.example.test/integrations/btg/callback'});
 const query=async(sql:string,params:unknown[]=[])=>{const r=await pg.query(sql,params);return {...r,rowCount:Math.max(r.affectedRows??0,r.rows.length)};};
 const db={query,connect:async()=>({query,release:()=>{}})} as unknown as Database;
 const manager={userId:user,tenantId:tenant,storeIds:[unit],sessionId:randomUUID(),role:'TENANT_MANAGER' as const};
 const master={userId:admin,sessionId:randomUUID(),role:'PLATFORM_ADMIN' as const};
 const input={name:'Integrator sandbox',mode:'sandbox',clientId:'central-test-client',clientSecret:'central-test-private',reason:'Local isolated test',confirmationPassword:password};
 const bind=(expectedVersion:number,extra={})=>app.inject({method:'PUT',url:`/platform/btg/companies/${company}`,headers,payload:{applicationId,pixKey:'test-key',enabled:true,expectedVersion,reason:'Local connection test',confirmationPassword:password,...extra}});
 beforeAll(async()=>{
  await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
   CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.user_id',true),'')::uuid$$;
   CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.tenant_id',true),'')::uuid$$;
   CREATE TABLE platform_admins(id uuid PRIMARY KEY,password_hash text,status text DEFAULT 'ACTIVE');
   CREATE FUNCTION is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM platform_admins WHERE id=nullif(current_setting('app.platform_admin_id',true),'')::uuid AND status='ACTIVE')$$;
   CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
   CREATE TABLE users(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE',password_hash text);
   CREATE TABLE tenant_users(tenant_id uuid,user_id uuid,role text,status text DEFAULT 'ACTIVE');
   CREATE TABLE companies(id uuid PRIMARY KEY,tenant_id uuid,name text DEFAULT 'Test company',status text DEFAULT 'ACTIVE',UNIQUE(id,tenant_id));
   CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid);
   CREATE FUNCTION store_in_scope(requested uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM stores WHERE id=requested AND tenant_id=current_tenant_id()) AND current_setting('app.store_ids',true)::jsonb ? requested::text$$;
   CREATE FUNCTION tenant_session_is_current(t uuid,u uuid,r text,ids uuid[]) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM tenant_users WHERE tenant_id=t AND user_id=u AND role=r AND status='ACTIVE')$$;
   CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now();RETURN NEW;END;$$;
   CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
   CREATE TABLE platform_audit_logs(actor_platform_admin_id uuid,action text,entity_type text,entity_id uuid,target_tenant_id uuid,before_data jsonb,after_data jsonb,reason text);
   CREATE TABLE commerce_pix_payments(order_id uuid PRIMARY KEY,company_id uuid,status text,refund_required boolean DEFAULT false,paid_at timestamptz,created_at timestamptz DEFAULT now());
   GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
  for(const name of ['0049_company_service_settings.sql','0065_btg_authorization.sql','0066_btg_company_settings.sql','0071_btg_platform_activation.sql'])
   await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/'+name,import.meta.url),'utf8')+'COMMIT;');
  const hashed=await argon2.hash(password);
  await query('INSERT INTO platform_admins(id,password_hash) VALUES($1,$2)',[admin,hashed]);
  await query('INSERT INTO tenants(id) VALUES($1)',[tenant]);await query('INSERT INTO users(id,password_hash) VALUES($1,$2)',[user,hashed]);
  await query("INSERT INTO tenant_users VALUES($1,$2,'TENANT_MANAGER','ACTIVE')",[tenant,user]);
  await query('INSERT INTO companies(id,tenant_id) VALUES($1,$3),($2,$3)',[company,otherCompany,tenant]);await query('INSERT INTO stores VALUES($1,$2,$3)',[unit,tenant,company]);
  await query("INSERT INTO company_service_settings(tenant_id,company_id,provider,enabled,public_config,secret_config_encrypted) VALUES($1,$2,'BTG',true,$3,$4)",[tenant,company,JSON.stringify({mode:'sandbox',clientId:'legacy-client'}),encryptPayload({clientSecret:'legacy-test-private'},env.BTG_ENCRYPTION_SECRET)]);
  app=Fastify();app.setErrorHandler((err,_req,res)=>{const e=err as Error&{statusCode?:number};res.code(err instanceof ZodError?422:e.statusCode??500).send({message:e.message});});
  await btgActivationRoutes(app,db,env);await companySettingsRoutes(app,db,env);
  headers={authorization:`Bearer ${(await createPlatformTokenPair(env,master)).accessToken}`};managerHeaders={authorization:`Bearer ${(await createTokenPair(env,manager)).accessToken}`};
 },30000);
 afterAll(async()=>{await app?.close();await pg.close();});
 it('requires platform authentication and the correct master password',async()=>{
  expect((await app.inject({url:'/platform/btg/activation'})).statusCode).toBe(401);
  expect((await app.inject({url:'/platform/btg/activation',headers:managerHeaders})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/platform/btg/applications',headers,payload:{...input,confirmationPassword:'wrong'}})).statusCode).toBe(403);
 });
 it('creates an immutable encrypted revision and only exposes safe metadata',async()=>{
  const r=await app.inject({method:'POST',url:'/platform/btg/applications',headers,payload:input});expect(r.statusCode,r.body).toBe(201);applicationId=r.json<{id:string}>().id;
  const overview=await app.inject({url:'/platform/btg/activation',headers});expect(overview.statusCode,overview.body).toBe(200);expect(overview.body).not.toContain(input.clientSecret);
  expect(JSON.stringify((await query('SELECT * FROM btg_platform_applications')).rows)).not.toContain(input.clientSecret);
  expect(JSON.stringify((await query('SELECT * FROM platform_audit_logs')).rows)).not.toContain(input.clientSecret);
  expect((await withTenantTransaction(db,manager,c=>c.query('SELECT * FROM btg_platform_applications'))).rows).toHaveLength(0);
  expect((await query("SELECT has_table_privilege('rastreia_runtime','btg_platform_applications','UPDATE') AS allowed")).rows[0]).toEqual({allowed:false});
 });
 it('binds explicitly, preserves legacy secrets and invalidates an earlier OAuth state',async()=>{
  const store=createBtgStore(db,env);const credentials=await store.configuration(manager,company);const pending=createState(env,manager,company,credentials);
  await store.begin(pending.state,hash(pending.ticket),hash('browser'));
  const before=(await query('SELECT secret_config_encrypted FROM company_service_settings')).rows[0];
  const r=await bind(1);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toEqual({version:2,status:'AWAITING_AUTHORIZATION'});
  expect((await query('SELECT secret_config_encrypted FROM company_service_settings')).rows[0]).toEqual(before);
  expect(await store.configuration(manager,company)).toMatchObject({clientId:input.clientId,clientSecret:input.clientSecret,version:2});
  await expect(store.consume(pending.state,hash(pending.ticket),hash('browser'))).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
  await expect(store.configuration(manager,otherCompany)).rejects.toMatchObject({code:'BTG_AUTHORIZATION_INVALID'});
 });
 it('blocks stale edits and changes while payments await reconciliation',async()=>{
  expect((await bind(1)).statusCode).toBe(409);
  const payment=randomUUID();await query("INSERT INTO commerce_pix_payments(order_id,company_id,status) VALUES($1,$2,'REQUESTED')",[payment,company]);
  expect((await bind(2)).statusCode).toBe(409);
  await query("UPDATE commerce_pix_payments SET paid_at=now(),status='PAID',refund_required=true WHERE order_id=$1",[payment]);expect((await bind(2)).statusCode).toBe(409);
  await query('DELETE FROM commerce_pix_payments WHERE order_id=$1',[payment]);
 });
 it('denies company edits at both HTTP and database layers and hides technical credentials',async()=>{
  const result=await app.inject({url:'/company-service-settings',headers:managerHeaders});expect(result.statusCode,result.body).toBe(200);
  expect(result.body).not.toContain(input.clientId);expect(result.body).not.toContain(input.clientSecret);
  const payload={provider:'BTG',enabled:true,publicConfig:{mode:'sandbox',clientId:'attacker'},secrets:{clientSecret:'attacker'},confirmationPassword:password};
  expect((await app.inject({method:'PUT',url:`/companies/${company}/service-settings`,headers:managerHeaders,payload})).statusCode).toBe(403);
  await expect(withTenantTransaction(db,manager,c=>c.query("UPDATE company_service_settings SET enabled=false WHERE company_id=$1 AND provider='BTG'",[company]))).rejects.toThrow('platform activation');
 });
 it('does not silently fall back and does not provision validated accounts',async()=>{
  await withPlatformTransaction(db,master,c=>c.query("UPDATE company_service_settings SET public_config=public_config||jsonb_build_object('platformApplicationId',$2::text) WHERE company_id=$1",[company,randomUUID()]));
  const config=await withTenantTransaction(db,manager,c=>resolveCompanyService(c,env,company,'BTG'));expect(config.enabled).toBe(false);expect(config.values['clientSecret']).toBeUndefined();
  expect((await query('SELECT * FROM company_bank_accounts')).rows).toHaveLength(0);
 });
});
