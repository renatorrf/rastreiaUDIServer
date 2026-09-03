import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import type { AuthContext } from '../auth/auth.types.js';
import { getMyWorkdays, maintainWorkdays, respondWorkday } from './workday.service.js';
import { createWorkdayTrackingSession, ingestNativeWorkdayPoint, ingestWorkdayPoints } from './workday-tracking.service.js';
import type { LocationUpdate } from '../locations/location.types.js';

// Real PostgreSQL in memory. Never reads .env or connects to the shared database.
describe('courier workday SQL / authorization / tracking',()=>{
  let pg:PGlite;let database:Database;let dayId:string;
  const tenant=randomUUID(),otherTenant=randomUUID(),store=randomUUID(),otherStore=randomUUID(),user=randomUUID(),otherUser=randomUUID(),courier=randomUUID();
  const auth:AuthContext={tenantId:tenant,userId:user,role:'COURIER',storeIds:[store],sessionId:randomUUID()};
  const env={TRACKING_TOKEN_PEPPER:'test-only-pepper-not-a-real-secret',BACKGROUND_TRACKING_SESSION_TTL_SECONDS:43200} as AppEnv;
  const published:LocationUpdate[]=[];const publisher={publish:async(u:LocationUpdate)=>{published.push(u);}};
  beforeAll(async()=>{
    pg=new PGlite();
    const client={query:async(sql:string,params:unknown[]=[])=>{const r=await pg.query(sql,params);return {...r,rowCount:r.affectedRows||r.rows.length};},release:()=>{}};
    database={connect:async()=>client} as unknown as Database;
    await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE TABLE tenants(id uuid PRIMARY KEY,name text,status text DEFAULT 'ACTIVE',timezone text DEFAULT 'America/Sao_Paulo');
      CREATE TABLE users(id uuid PRIMARY KEY,name text,status text DEFAULT 'ACTIVE');
      CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenants(id),name text,status text DEFAULT 'ACTIVE',address_line text,address_number text,city text,UNIQUE(id,tenant_id));
      CREATE TABLE courier_profiles(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),status text DEFAULT 'ACTIVE');
      CREATE TABLE courier_store_links(store_id uuid REFERENCES stores(id),courier_profile_id uuid REFERENCES courier_profiles(id),status text DEFAULT 'ACTIVE');
      CREATE TABLE tenant_users(tenant_id uuid,user_id uuid,role text DEFAULT 'COURIER',status text DEFAULT 'ACTIVE');
      CREATE TABLE deliveries(id uuid PRIMARY KEY,tenant_id uuid,store_id uuid,courier_profile_id uuid,status text,route_id uuid,out_for_delivery_at timestamptz,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
      CREATE TABLE outbox_events(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status int,response_body jsonb,UNIQUE(tenant_id,idempotency_key,operation));
      CREATE TABLE courier_last_locations(tenant_id uuid,courier_profile_id uuid,delivery_id uuid,store_id uuid,latitude float8,longitude float8,accuracy float8,speed float8,heading float8,altitude float8,captured_at timestamptz,received_at timestamptz,updated_at timestamptz,UNIQUE(tenant_id,courier_profile_id));
      CREATE TABLE location_points(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,courier_profile_id uuid,delivery_id uuid,store_id uuid,client_event_id uuid,latitude float8,longitude float8,accuracy float8,speed float8,heading float8,altitude float8,captured_at timestamptz);
      CREATE TABLE location_event_receipts(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,courier_profile_id uuid,delivery_id uuid,client_event_id uuid,captured_at timestamptz,UNIQUE(tenant_id,courier_profile_id,client_event_id));
      CREATE TABLE background_tracking_sessions(tenant_id uuid,courier_profile_id uuid,revoked_at timestamptz);
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid $$;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id',true),'')::uuid $$;
      CREATE FUNCTION is_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION store_in_scope(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM stores s JOIN courier_store_links l ON l.store_id=s.id JOIN courier_profiles p ON p.id=l.courier_profile_id
          JOIN tenants t ON t.id=s.tenant_id WHERE s.id=target AND s.tenant_id=current_tenant_id() AND s.status='ACTIVE' AND t.status='ACTIVE'
          AND p.user_id=current_user_id() AND p.status='ACTIVE' AND l.status='ACTIVE'
          AND (NULLIF(current_setting('app.store_ids',true),'') IS NULL OR current_setting('app.store_ids',true)::jsonb='[]'::jsonb
            OR current_setting('app.store_ids',true)::jsonb ? target::text)) $$;
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0038_courier_workdays.sql',import.meta.url),'utf8')+'COMMIT;');
    await pg.query('INSERT INTO tenants(id,name) VALUES($1,\'Loja teste\'),($2,\'Outro grupo\')',[tenant,otherTenant]);
    await pg.query('INSERT INTO users(id,name) VALUES($1,\'Entregador teste\'),($2,\'Outro usuário\')',[user,otherUser]);
    await pg.query('INSERT INTO stores(id,tenant_id,name,opening_time,closing_time) VALUES($1,$2,\'Unidade teste\',\'09:00\',\'23:00\'),($3,$2,\'Outra unidade\',\'09:00\',\'23:00\')',[store,tenant,otherStore]);
    await pg.query('INSERT INTO courier_profiles(id,user_id) VALUES($1,$2)',[courier,user]);
    await pg.query('INSERT INTO courier_store_links(store_id,courier_profile_id) VALUES($1,$3),($2,$3)',[store,otherStore,courier]);
    await pg.query('INSERT INTO tenant_users(tenant_id,user_id) VALUES($1,$2)',[tenant,user]);
  },30000);
  afterAll(async()=>pg?.close());
  it('materializes local opening/closing hours exactly once; respects selected store RLS',async()=>{
    const first=await getMyWorkdays(database,auth);const second=await getMyWorkdays(database,auth);
    expect(second.data.length).toBe(first.data.length);expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.every(d=>d.storeId===store)).toBe(true);
    dayId=first.data[0]!.id;
    const times=await pg.query<{start:string;end:string}>(`SELECT to_char(starts_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS start,to_char(ends_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS end FROM courier_workdays WHERE id=$1`,[dayId]);
    expect(times.rows[0]).toEqual({start:'09:00',end:'23:00'});
  });
  it('queues one reminder within two hours; confirmation alone does not permit GPS',async()=>{
    await pg.query("UPDATE courier_workdays SET starts_at=now()+interval '1 hour',ends_at=now()+interval '8 hours' WHERE id=$1",[dayId]);
    const before=await pg.query('SELECT * FROM outbox_events');
    await maintainWorkdays(database,true);await maintainWorkdays(database,true);
    const events=await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1',[dayId]);
    expect(events.rows).toHaveLength(1);expect(before.rows).toHaveLength(0);
    expect((events.rows[0] as {payload:{notificationKey:string}}).payload.notificationKey).toBe(`presence:${dayId}:requested`);
    await expect(respondWorkday(database,auth,dayId,randomUUID(),'check-in',true)).rejects.toMatchObject({statusCode:409});
    const confirmationKey=randomUUID();
    await respondWorkday(database,auth,dayId,confirmationKey,'confirm',false);
    expect((await respondWorkday(database,auth,dayId,confirmationKey,'confirm',false)).replayed).toBe(true);
    await respondWorkday(database,auth,dayId,randomUUID(),'confirm',false);
    const confirmationAudits=await pg.query("SELECT * FROM audit_logs WHERE entity_id=$1 AND action='workday.confirm'",[dayId]);
    expect(confirmationAudits.rows).toHaveLength(1);
    await expect(createWorkdayTrackingSession(database,env,auth,dayId,'android')).rejects.toMatchObject({statusCode:422});
  });
  it('requires explicit consent; check-in is idempotent and only one store may be active',async()=>{
    await expect(respondWorkday(database,auth,dayId,randomUUID(),'check-in',false)).rejects.toMatchObject({statusCode:409});
    const key=randomUUID();const first=await respondWorkday(database,auth,dayId,key,'check-in',true);
    expect(first.body.status).toBe('CHECKED_IN');expect((await respondWorkday(database,auth,dayId,key,'check-in',true)).replayed).toBe(true);
    const second=(await getMyWorkdays(database,{...auth,storeIds:[otherStore]})).data[0]!;
    await pg.query("UPDATE courier_workdays SET starts_at=now(),ends_at=now()+interval '8 hours' WHERE id=$1",[second.id]);
    await expect(respondWorkday(database,{...auth,storeIds:[otherStore]},second.id,randomUUID(),'check-in',true)).rejects.toMatchObject({statusCode:409});
  });
  it('hides another tenant/user/store and rejects cross-scope writes',async()=>{
    for(const denied of [{...auth,userId:otherUser},{...auth,tenantId:otherTenant},{...auth,storeIds:[otherStore]}]){
      const rows=await withTenantTransaction(database,denied,c=>c.query('SELECT id FROM courier_workdays WHERE id=$1',[dayId]));expect(rows.rows).toHaveLength(0);
      await expect(respondWorkday(database,denied,dayId,randomUUID(),'confirm',false)).rejects.toMatchObject({statusCode:404});
    }
  });
  it('private check-in positions never publish to a delivery; native token rotates and invalidates old token',async()=>{
    const token=await createWorkdayTrackingSession(database,env,auth,dayId,'android');
    const point={eventId:randomUUID(),latitude:-18.9,longitude:-48.2,accuracy:10,capturedAt:new Date()};
    expect((await ingestWorkdayPoints(database,publisher,auth,dayId,[point])).results[0]?.accepted).toBe(true);
    expect((await ingestWorkdayPoints(database,publisher,auth,dayId,[point])).results[0]?.duplicate).toBe(true);
    expect(published).toHaveLength(0);
    await createWorkdayTrackingSession(database,env,auth,dayId,'android');
    await expect(ingestNativeWorkdayPoint(database,publisher,env,token.token,{latitude:-18.9,longitude:-48.2,accuracy:10,time:Date.now()})).rejects.toMatchObject({statusCode:401});
  });
  it('automatically targets only the current route stop; never moves old queued locations into the next delivery',async()=>{
    const deliveryId=randomUUID(),waitingId=randomUUID(),routeId=randomUUID();
    await pg.query(`INSERT INTO deliveries(id,tenant_id,store_id,courier_profile_id,status,route_id,out_for_delivery_at,updated_at)
      VALUES($1,$2,$3,$4,'NEXT_STOP',$5,now(),now()),($6,$2,$3,$4,'IN_ROUTE',$5,now(),now())`,[deliveryId,tenant,store,courier,routeId,waitingId]);
    const point={eventId:randomUUID(),latitude:-18.9,longitude:-48.2,accuracy:10,capturedAt:new Date(Date.now()+100)};
    await ingestWorkdayPoints(database,publisher,auth,dayId,[point]);
    expect(published).toHaveLength(1);expect(published[0]?.deliveryId).toBe(deliveryId);expect(published[0]?.publicVisible).toBe(true);
    await pg.query("UPDATE deliveries SET status='DELIVERED' WHERE id=$1",[deliveryId]);
    await pg.query("UPDATE deliveries SET status='NEXT_STOP',updated_at=now()+interval '1 second' WHERE id=$1",[waitingId]);
    await ingestWorkdayPoints(database,publisher,auth,dayId,[{...point,eventId:randomUUID(),capturedAt:new Date(Date.now()+200)}]);
    expect(published).toHaveLength(1);
    await ingestWorkdayPoints(database,publisher,auth,dayId,[{...point,eventId:randomUUID(),capturedAt:new Date(Date.now()+2000)}]);
    expect(published.at(-1)?.deliveryId).toBe(waitingId);
    await expect(respondWorkday(database,auth,dayId,randomUUID(),'check-out',false)).rejects.toMatchObject({statusCode:409});
  });
  it('rejects removed links, ends tracking on checkout, revokes scoped tokens, clears private coordinates',async()=>{
    const token=await createWorkdayTrackingSession(database,env,auth,dayId,'android');
    await pg.query("UPDATE courier_store_links SET status='INACTIVE' WHERE store_id=$1",[store]);
    await expect(ingestNativeWorkdayPoint(database,publisher,env,token.token,{latitude:-18.9,longitude:-48.2,accuracy:10,time:Date.now()})).rejects.toMatchObject({statusCode:404});
    await pg.query("UPDATE courier_store_links SET status='ACTIVE' WHERE store_id=$1",[store]);
    await pg.exec("UPDATE deliveries SET status='DELIVERED'");
    await respondWorkday(database,auth,dayId,randomUUID(),'check-out',false);
    await expect(ingestNativeWorkdayPoint(database,publisher,env,token.token,{latitude:-18.9,longitude:-48.2,accuracy:10,time:Date.now()})).rejects.toMatchObject({statusCode:401});
    const result=await pg.query<{latitude:number|null;status:string}>('SELECT latitude,status FROM courier_workdays WHERE id=$1',[dayId]);
    expect(result.rows[0]).toEqual({latitude:null,status:'COMPLETED'});
  });
});
