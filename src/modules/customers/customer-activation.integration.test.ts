import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import { setTenantContext, withRuntimeTransaction } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import { activateCustomer, prepareCustomerActivation } from './customer-activation.js';
import { preregisterCustomer, type CustomerOrderData } from './customer-preregistration.js';
import { assertIdentity, passwordOptions, refreshIdentity, signInCustomer, signInIdentity } from '../auth/identity.service.js';
import { trackingTokenHash } from '../tracking/tracking-token.js';
import { customerRoutes } from './customer.routes.js';
import { identityRoutes } from '../auth/identity.routes.js';
import { linkDeliveryCustomerWhatsapp, listDeliveries } from '../deliveries/delivery.service.js';
import type { AuthContext } from '../auth/auth.types.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';

// Real PostgreSQL in memory; never reads .env or touches the deployed database.
describe('customer pre-registration and WhatsApp activation', () => {
  let pg: PGlite; let database: Database; let app: FastifyInstance;
  const tenant=randomUUID(), otherTenant=randomUUID(), store=randomUUID();
  const env={TRACKING_TOKEN_PEPPER:'isolated-test-pepper',CUSTOMER_REGISTRATION_GRACE_SECONDS:86400,
    JWT_ACCESS_SECRET:'isolated-access-secret',JWT_REFRESH_SECRET:'isolated-refresh-secret',
    ACCESS_TOKEN_TTL_SECONDS:900,REFRESH_TOKEN_TTL_SECONDS:86400} as AppEnv;
  const order:CustomerOrderData={recipientName:'Maria Silva',recipientPhone:'+55 (34) 99999-1234',
    addressLine:'Avenida Brasil',addressNumber:'2662',neighborhood:'Centro',city:'Uberlândia',state:'MG',postalCode:'38400000',latitude:-18.9,longitude:-48.2};
  const token='a'.repeat(43),delivery=randomUUID(),tracking=randomUUID();
  let profileId:string;let accountId:string;

  beforeAll(async()=>{
    pg=new PGlite({extensions:{citext}});
    const client={query:async(sql:string,params:unknown[]=[])=>{const result=await pg.query(sql,params);return {...result,rowCount:result.affectedRows||result.rows.length};},release:()=>{}};
    database={connect:async()=>client} as unknown as Database;
    await pg.exec(`CREATE EXTENSION citext;CREATE SCHEMA rastreia;SET search_path=rastreia,public;
      CREATE ROLE rastreia_runtime;GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE TYPE user_status AS ENUM('ACTIVE','INACTIVE');CREATE TYPE delivery_status AS ENUM('DRAFT','AWAITING_COURIER','ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','DELIVERED','CANCELLED','DELIVERY_FAILED','RETURN_STARTED','RETURNED');
      CREATE TABLE tenants(id uuid PRIMARY KEY,timezone text DEFAULT 'America/Sao_Paulo');
      CREATE TABLE users(id uuid PRIMARY KEY,name text,email citext NOT NULL UNIQUE,password_hash text NOT NULL,status user_status DEFAULT 'ACTIVE',email_verified_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE tenant_users(user_id uuid,tenant_id uuid);
      CREATE TABLE courier_profiles(id uuid,user_id uuid,status text);
      CREATE TABLE courier_service_preferences(courier_profile_id uuid,registration_status text);
      CREATE TABLE identity_sessions(id uuid PRIMARY KEY,user_id uuid,token_hash text,expires_at timestamptz,revoked_at timestamptz);
      CREATE TABLE stores(id uuid PRIMARY KEY,name text,contact_phone text);
      CREATE TABLE deliveries(id uuid PRIMARY KEY,tenant_id uuid,store_id uuid,recipient_name text,recipient_phone text,recipient_whatsapp text,
        address_line text,address_number text,complement text,neighborhood text,city text,state text,postal_code text,latitude float8,longitude float8,address_confidence numeric,
        external_reference text,status delivery_status DEFAULT 'AWAITING_COURIER',created_at timestamptz DEFAULT now(),delivered_at timestamptz);
      CREATE TABLE tracking_tokens(id uuid PRIMARY KEY,tenant_id uuid,delivery_id uuid,token_hash text,expires_at timestamptz,revoked_at timestamptz);
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid$$;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('app.user_id',true),'')::uuid$$;
      CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now();RETURN NEW;END$$;
      CREATE FUNCTION identity_by_email(text) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
      CREATE FUNCTION identity_units(uuid) RETURNS TABLE(id uuid) LANGUAGE sql AS $$SELECT NULL::uuid WHERE false$$;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;ALTER TABLE users FORCE ROW LEVEL SECURITY;
      CREATE POLICY user_identity ON users USING(id=current_user_id());
      ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
      CREATE POLICY delivery_tenant ON deliveries USING(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    for(const migration of ['0042_customer_portal','0044_customer_identity_qualification','0045_customer_registration_context','0046_customer_delivery_history_link','0047_customer_order_history','0050_customer_whatsapp_login']){
      await pg.exec('BEGIN;'+await readFile(new URL(`../../../migrations/${migration}.sql`,import.meta.url),'utf8')+'COMMIT;');
    }
    await pg.exec(`ALTER TABLE deliveries ADD COLUMN route_id uuid,ADD COLUMN courier_profile_id uuid,ADD COLUMN origin text,
      ADD COLUMN external_order_id uuid,ADD COLUMN delivery_instructions text,ADD COLUMN promised_window_start timestamptz,ADD COLUMN promised_window_end timestamptz,
      ADD COLUMN collected_at timestamptz,ADD COLUMN out_for_delivery_at timestamptz,ADD COLUMN cancelled_at timestamptz,ADD COLUMN failed_at timestamptz,
      ADD COLUMN failure_reason text,ADD COLUMN version int DEFAULT 1,ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN updated_by uuid;
      CREATE TABLE outbox_events(tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status int,response_body jsonb,UNIQUE(tenant_id,idempotency_key,operation));
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec(await readFile(new URL('../../../migrations/0051_delivery_customer_alerts.sql',import.meta.url),'utf8'));
    await pg.query('INSERT INTO tenants(id) VALUES($1),($2)',[tenant,otherTenant]);
    await pg.query("INSERT INTO stores VALUES($1,'Loja teste','34988887777')",[store]);
    await pg.query(`INSERT INTO deliveries(id,tenant_id,store_id,recipient_name,recipient_phone,address_line,address_number,neighborhood,city,state,postal_code,latitude,longitude)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[delivery,tenant,store,order.recipientName,order.recipientPhone,order.addressLine,order.addressNumber,order.neighborhood,order.city,order.state,order.postalCode,order.latitude,order.longitude]);
    await pg.query("INSERT INTO tracking_tokens(id,tenant_id,delivery_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[tracking,tenant,delivery,trackingTokenHash(token,env.TRACKING_TOKEN_PEPPER)]);
    app=Fastify();await app.register(cookie);
    app.setErrorHandler((error:Error & {statusCode?:number},_request,reply)=>reply.code(error instanceof ZodError?422:error.statusCode??500).send({message:error.message}));
    await identityRoutes(app,database,env);
    await customerRoutes(app,database,{} as Parameters<typeof customerRoutes>[2],env,{} as Parameters<typeof customerRoutes>[4],{} as Parameters<typeof customerRoutes>[5]);
  },30000);
  afterAll(async()=>{await app?.close();await pg?.close();});

  it('collects an iFood phone after delivery, prepares a contact without consent, and never changes another customer',async()=>{
    const id=randomUUID(),courierId=randomUUID(),user=randomUUID();
    await pg.query('INSERT INTO courier_profiles(id,user_id,status) VALUES($1,$2,\'ACTIVE\')',[courierId,user]);
    await pg.query(`INSERT INTO deliveries(id,tenant_id,store_id,courier_profile_id,origin,status,recipient_name,recipient_phone,address_line,address_number,city,state,latitude,longitude)
      VALUES($1,$2,$3,$4,'IFOOD','DELIVERED','Cliente iFood','Não informado pelo iFood','Rua teste','22','Uberlândia','MG',-18.9,-48.2)`,[id,tenant,store,courierId]);
    const auth:AuthContext={tenantId:tenant,userId:user,role:'COURIER',storeIds:[store],sessionId:randomUUID()};
    await expect(linkDeliveryCustomerWhatsapp(database,{...auth,userId:randomUUID()},randomUUID(),id,'34988881234')).rejects.toMatchObject({statusCode:404});
    const key=randomUUID();const result=await linkDeliveryCustomerWhatsapp(database,auth,key,id,'+55 (34) 98888-1234');
    expect(result.body.recipientWhatsapp).toBe('34988881234');expect(result.body.recipientPhone).toBe('34988881234');
    expect((await linkDeliveryCustomerWhatsapp(database,auth,key,id,'+55 (34) 98888-1234')).replayed).toBe(true);
    const profile=(await pg.query(`SELECT p.user_id,p.consent_at,p.first_name,p.address_line FROM customer_profiles p JOIN deliveries d ON d.customer_profile_id=p.id WHERE d.id=$1`,[id])).rows[0];
    expect(profile).toEqual({user_id:null,consent_at:null,first_name:'Cliente',address_line:'Rua teste'});
    await expect(linkDeliveryCustomerWhatsapp(database,auth,randomUUID(),id,'34988889999')).rejects.toMatchObject({statusCode:409});
    await pg.query("UPDATE deliveries SET status='IN_ROUTE' WHERE id=$1",[id]);
    await expect(linkDeliveryCustomerWhatsapp(database,auth,randomUUID(),id,'34988881234')).rejects.toMatchObject({statusCode:409});
    await pg.query("UPDATE deliveries SET status='DELIVERED' WHERE id=$1",[id]);
  });

  it('filters today in tenant timezone before pagination; closed history and older pending remain queryable',async()=>{
    const auth:AuthContext={tenantId:tenant,userId:randomUUID(),role:'STORE_OPERATOR',storeIds:[store],sessionId:randomUUID()};
    const today=randomUUID(),yesterday=randomUUID(),pending=randomUUID(),foreign=randomUUID();
    const midnight="date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'";
    await pg.query(`INSERT INTO deliveries(id,tenant_id,store_id,status,created_at) VALUES
      ($1,$5,$6,'DELIVERED',(${midnight})+interval '1 minute'),
      ($2,$5,$6,'DELIVERED',(${midnight})-interval '1 minute'),
      ($3,$5,$6,'AWAITING_COURIER',(${midnight})-interval '2 days'),
      ($4,$7,$6,'DELIVERED',(${midnight})+interval '1 minute')`,[today,yesterday,pending,foreign,tenant,store,otherTenant]);
    const current=await listDeliveries(database,auth,{period:'today',limit:100});
    expect(current.data.map(d=>d.id)).toContain(today);expect(current.data.map(d=>d.id)).not.toContain(yesterday);
    expect(current.data.map(d=>d.id)).not.toContain(foreign);
    const history=await listDeliveries(database,auth,{view:'history',limit:100});
    expect(history.data.map(d=>d.id)).toContain(yesterday);expect(history.data.map(d=>d.id)).not.toContain(pending);
    const previous=await listDeliveries(database,auth,{view:'active',period:'previous',limit:100});
    expect(previous.data.map(d=>d.id)).toContain(pending);expect(previous.data.map(d=>d.id)).not.toContain(today);
    const page1=await listDeliveries(database,auth,{period:'today',limit:1,offset:0});
    const page2=await listDeliveries(database,auth,{period:'today',limit:1,offset:1});
    expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
  });

  it('creates a tenant-local contact with no password, user or consent; retries reuse it',async()=>{
    profileId=(await withRuntimeTransaction(database,async client=>{
      await setTenantContext(client,{tenantId:tenant,userId:randomUUID()});
      const first=await preregisterCustomer(client,tenant,order);
      expect(await preregisterCustomer(client,tenant,{...order,recipientName:'Alterado',addressLine:'Outro endereço'})).toBe(first);
      return first;
    }))!;
    const profile=(await pg.query('SELECT first_name,address_line,user_id,consent_at FROM customer_profiles WHERE id=$1',[profileId])).rows[0];
    expect(profile).toEqual({first_name:'Maria',address_line:'Avenida Brasil',user_id:null,consent_at:null});
  });
  it('ignores missing/masked phones without inventing contact details',async()=>{
    await withRuntimeTransaction(database,async client=>{
      await setTenantContext(client,{tenantId:tenant,userId:randomUUID()});
      expect(await preregisterCustomer(client,tenant,{...order,recipientPhone:'Não informado'})).toBeNull();
    });
  });
  it('allows a single-word name without fabricating a surname',async()=>{
    await withRuntimeTransaction(database,async client=>{
      await setTenantContext(client,{tenantId:tenant,userId:randomUUID()});
      const id=await preregisterCustomer(client,tenant,{...order,recipientName:'Maria',recipientPhone:'34999994321'});
      expect((await client.query('SELECT last_name FROM customer_profiles WHERE id=$1',[id])).rows[0].last_name).toBe('');
    });
  });
  it('activates from the order, links its history, and uses the chosen password immediately',async()=>{
    const context=await app.inject({method:'POST',url:'/public/customers/registration-context',payload:{trackingToken:token}});
    expect(context.statusCode).toBe(200);expect(context.json()).toEqual({firstName:'Maria',whatsappMasked:'•••• 1234',hasAccount:false});
    expect(context.headers['cache-control']).toBe('no-store');
    const activation=await app.inject({method:'POST',url:'/public/customers/register',payload:{trackingToken:token,password:'Ab3Def7H',consent:true}});
    expect(activation.statusCode).toBe(200);const result=activation.json();
    expect(result).toEqual({accountCreated:true,whatsapp:'34999991234'});
    const session=await signInCustomer(database,env,'+55 (34) 99999-1234','Ab3Def7H');accountId=session.user.id;
    expect(session.user.email).toBeNull();expect(session.user.mustChangePassword).toBe(false);expect(session.customer.id).toBe(profileId);
    expect((await pg.query<{customer_profile_id:string}>('SELECT customer_profile_id FROM deliveries WHERE id=$1',[delivery])).rows[0]?.customer_profile_id).toBe(profileId);
    expect(await assertIdentity(database,env,`Bearer ${session.accessToken}`)).toMatchObject({userId:accountId});
    expect((await refreshIdentity(database,env,session.refreshToken)).customer.id).toBe(profileId);
    const login=await app.inject({method:'POST',url:'/auth/customer/sign-in',payload:{whatsapp:'+55 (34) 99999-1234',password:'Ab3Def7H'}});
    expect(login.statusCode).toBe(200);expect(login.json().refreshToken).toBeUndefined();
    expect(login.headers['set-cookie']).toContain('rastreia_identity_refresh=');
    expect(login.headers['cache-control']).toBe('no-store');
  });
  it('validates password length and consent before accessing the database',async()=>{
    for(const payload of [{trackingToken:token,password:'short',consent:true},{trackingToken:token,password:'Ab3Def7H',consent:false}]){
      expect((await app.inject({method:'POST',url:'/public/customers/register',payload})).statusCode).toBe(422);
    }
  });
  it('rejects wrong passwords and cannot reset an activated account using the tracking link',async()=>{
    await expect(signInCustomer(database,env,'34999991234','Wrong123')).rejects.toMatchObject({statusCode:401});
    await expect(withRuntimeTransaction(database,client=>activateCustomer(client,env,token,'NewPass1',passwordOptions))).rejects.toMatchObject({statusCode:409});
    expect((await signInCustomer(database,env,'34999991234','Ab3Def7H')).user.id).toBe(accountId);
  });
  it('rejects unknown, revoked and expired links without making new accounts',async()=>{
    await expect(withRuntimeTransaction(database,client=>prepareCustomerActivation(client,env,'x'.repeat(43)))).rejects.toMatchObject({statusCode:404});
    await pg.query('UPDATE tracking_tokens SET revoked_at=now() WHERE id=$1',[tracking]);
    await expect(withRuntimeTransaction(database,client=>prepareCustomerActivation(client,env,token))).rejects.toMatchObject({statusCode:404});
    expect((await signInCustomer(database,env,'34999991234','Ab3Def7H',token)).user.id).toBe(accountId);
    await pg.query("UPDATE tracking_tokens SET revoked_at=NULL,expires_at=now()-interval '3 days' WHERE id=$1",[tracking]);
    await expect(withRuntimeTransaction(database,client=>prepareCustomerActivation(client,env,token))).rejects.toMatchObject({statusCode:404});
    await pg.query("UPDATE tracking_tokens SET expires_at=now()-interval '1 hour' WHERE id=$1",[tracking]);
    expect((await withRuntimeTransaction(database,client=>prepareCustomerActivation(client,env,token))).profile.id).toBe(profileId);
  });
  it('does not let phone-only identities bypass staff email login',async()=>{
    await expect(signInIdentity(database,env,'unknown@example.test','Ab3Def7H')).rejects.toMatchObject({statusCode:401});
  });
  it('requires the existing password to claim a same-phone order from another tenant',async()=>{
    const otherDelivery=randomUUID(),otherToken='b'.repeat(43);
    await pg.query(`INSERT INTO deliveries SELECT $1,$2,store_id,recipient_name,recipient_phone,recipient_whatsapp,address_line,address_number,complement,neighborhood,city,state,postal_code,
      latitude,longitude,address_confidence,external_reference,status,created_at,delivered_at,NULL FROM deliveries WHERE id=$3`,[otherDelivery,otherTenant,delivery]);
    await pg.query("INSERT INTO tracking_tokens(id,tenant_id,delivery_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[randomUUID(),otherTenant,otherDelivery,trackingTokenHash(otherToken,env.TRACKING_TOKEN_PEPPER)]);
    await expect(withRuntimeTransaction(database,client=>activateCustomer(client,env,otherToken,'NewPass1',passwordOptions))).rejects.toMatchObject({statusCode:409});
    const session=await signInCustomer(database,env,'34999991234','Ab3Def7H',otherToken);
    expect(session.user.id).toBe(accountId);expect(session.customer.tenantId).toBe(otherTenant);
    expect((await pg.query<{count:number}>('SELECT count(*)::int AS count FROM users WHERE customer_login_phone=$1',['34999991234'])).rows[0]?.count).toBe(1);
    const orders=await app.inject({method:'GET',url:'/customer/orders',headers:{authorization:`Bearer ${session.accessToken}`}});
    expect(orders.statusCode).toBe(200);expect(orders.json<{data:Array<{id:string}>}>().data.map(item=>item.id).sort()).toEqual([delivery,otherDelivery].sort());
    await withRuntimeTransaction(database,async client=>{
      await client.query("SELECT set_config('app.user_id',$1,true)",[accountId]);
      expect((await client.query('SELECT * FROM rastreia.customer_identity_order_scope($1)',[delivery])).rows[0]).toEqual({id:profileId,tenant_id:tenant});
      expect((await client.query('SELECT * FROM rastreia.customer_identity_order_scope($1)',[randomUUID()])).rows).toEqual([]);
      await client.query("SELECT set_config('app.user_id',$1,true)",[randomUUID()]);
      expect((await client.query('SELECT * FROM rastreia.customer_identity_orders()')).rows).toEqual([]);
    });
  });
});
