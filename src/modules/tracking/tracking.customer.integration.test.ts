import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real PostgreSQL RLS with no .env or shared database access.
describe('authenticated customer tracking under operational RLS', () => {
  const pg = new PGlite();
  const tenant=randomUUID(),user=randomUUID(),customer=randomUUID(),order=randomUUID(),store=randomUUID();
  const otherUser=randomUUID(),otherCustomer=randomUUID(),otherOrder=randomUUID();
  beforeAll(async()=>{
    await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;
      GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.user_id',true),'')::uuid$$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.tenant_id',true),'')::uuid$$;
      CREATE FUNCTION tenant_is_active(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      CREATE TABLE users(id uuid,name text,status text);
      CREATE TABLE customer_profiles(id uuid,tenant_id uuid,user_id uuid,status text);
      CREATE TABLE customer_sessions(customer_profile_id uuid,tenant_id uuid,token_hash text,expires_at timestamptz,revoked_at timestamptz);
      CREATE TABLE customer_push_subscriptions(customer_profile_id uuid,tenant_id uuid,endpoint_hash text,active boolean);
      CREATE TABLE stores(id uuid,name text,contact_phone text);
      CREATE TABLE courier_profiles(id uuid,user_id uuid);
      CREATE TABLE routes(id uuid,eta_calculated_at timestamptz);
      CREATE TABLE route_stops(route_id uuid,delivery_id uuid,stop_type text,status text,sequence integer,estimated_arrival_at timestamptz);
      CREATE TABLE deliveries(id uuid,tenant_id uuid,store_id uuid,customer_profile_id uuid,courier_profile_id uuid,route_id uuid,
        external_reference text,status text,address_line text,address_number text,neighborhood text,city text,state text,postal_code text,
        latitude float8,longitude float8,promised_window_start timestamptz,promised_window_end timestamptz,delivered_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE courier_last_locations(tenant_id uuid,courier_profile_id uuid,delivery_id uuid,latitude float8,longitude float8,accuracy float8,heading float8,captured_at timestamptz);
      CREATE TABLE delivery_proofs(id uuid,delivery_id uuid,public_visible boolean,recipient_name text,created_at timestamptz);
      CREATE TABLE delivery_status_history(delivery_id uuid,to_status text,created_at timestamptz,delivery_version integer);
      CREATE TABLE driver_operational_events(id uuid,tenant_id uuid,status text,occurred_at timestamptz,resolved_at timestamptz,affects_eta boolean,customer_visibility text);
      CREATE TABLE driver_event_deliveries(event_id uuid,delivery_id uuid);
      ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
      ALTER TABLE stores ENABLE ROW LEVEL SECURITY;ALTER TABLE stores FORCE ROW LEVEL SECURITY;
      CREATE POLICY operation_only ON deliveries USING(false);
      CREATE POLICY operation_only ON stores USING(false);
      GRANT SELECT ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0052_customer_authenticated_tracking.sql',import.meta.url),'utf8')+'COMMIT;');
    await pg.query("INSERT INTO users VALUES($1,'Cliente','ACTIVE'),($2,'Outro','ACTIVE')",[user,otherUser]);
    await pg.query("INSERT INTO customer_profiles VALUES($1,$3,$4,'ACTIVE'),($2,$3,$5,'ACTIVE')",[customer,otherCustomer,tenant,user,otherUser]);
    await pg.query("INSERT INTO stores VALUES($1,'Loja','34999999999')",[store]);
    await pg.query("INSERT INTO deliveries(id,tenant_id,store_id,customer_profile_id,status,city,state) VALUES($1,$3,$4,$5,'IN_ROUTE','Uberlândia','MG'),($2,$3,$4,$6,'DELIVERED','Uberlândia','MG')",[order,otherOrder,tenant,store,customer,otherCustomer]);
  },30000);
  afterAll(async()=>pg.close());
  async function snapshot(orderId=order,profileId=customer,userId=user,sessionHash=''){
    await pg.exec('BEGIN;SET LOCAL ROLE rastreia_runtime;');
    try{
      await pg.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true),set_config('app.customer_session_hash',$3,true)",[userId,tenant,sessionHash]);
      expect((await pg.query('SELECT * FROM deliveries')).rows).toHaveLength(0);
      return (await pg.query<{snapshot:{delivery:{status:string};history:unknown[]}|null}>('SELECT customer_tracking_snapshot($1,$2,$3,86400,86400) AS snapshot',[orderId,profileId,tenant])).rows[0]!.snapshot;
    }finally{await pg.exec('ROLLBACK');}
  }
  it('loads the owned active order without a public token and without granting store access',async()=>{
    expect((await snapshot())?.delivery.status).toBe('IN_ROUTE');
  });
  it('does not expose another customer even when all their IDs are supplied',async()=>{
    expect(await snapshot(otherOrder,otherCustomer)).toBeNull();
    expect(await snapshot(order,customer,otherUser)).toBeNull();
  });
  it('keeps completed history accessible after the public link grace period',async()=>{
    await pg.query("UPDATE deliveries SET delivered_at=now()-interval '10 days',status='DELIVERED' WHERE id=$1",[order]);
    expect((await snapshot())?.delivery.status).toBe('DELIVERED');
  });
  it('accepts only a current legacy customer session',async()=>{
    await pg.query("INSERT INTO customer_sessions VALUES($1,$2,'legacy',now()+interval '1 hour',NULL)",[customer,tenant]);
    expect(await snapshot(order,customer,randomUUID(),'legacy')).not.toBeNull();
    await pg.exec("UPDATE customer_sessions SET expires_at=now()-interval '1 second'");
    expect(await snapshot(order,customer,randomUUID(),'legacy')).toBeNull();
  });
  it('reassigns a shared device without leaving another account subscribed',async()=>{
    await pg.query("INSERT INTO customer_push_subscriptions VALUES($1,$3,'device',true),($2,$3,'different-device',true)",[otherCustomer,customer,tenant]);
    await pg.exec('BEGIN;SET LOCAL ROLE rastreia_runtime;');
    try{
      await pg.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[user,tenant]);
      await pg.query("SELECT claim_customer_push_endpoint($1,'device')",[customer]);
      expect((await pg.query<{active:boolean}>("SELECT active FROM customer_push_subscriptions WHERE endpoint_hash='device'")).rows[0]!.active).toBe(false);
      expect((await pg.query<{active:boolean}>("SELECT active FROM customer_push_subscriptions WHERE endpoint_hash='different-device'")).rows[0]!.active).toBe(true);
    }finally{await pg.exec('ROLLBACK');}
  });
  it('rejects a device claim on behalf of another customer',async()=>{
    await pg.exec('BEGIN;SET LOCAL ROLE rastreia_runtime;');
    try{
      await pg.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[user,tenant]);
      await expect(pg.query("SELECT claim_customer_push_endpoint($1,'device')",[otherCustomer])).rejects.toThrow('customer push ownership required');
    }finally{await pg.exec('ROLLBACK');}
  });
});
