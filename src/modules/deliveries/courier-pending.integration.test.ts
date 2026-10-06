import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import { getCourierPendingSummary } from './courier-pending.service.js';

describe('Courier pending summary (isolated PostgreSQL)', () => {
  let pg: PGlite, database: Database;
  const tenant=randomUUID(), store=randomUUID(), courier=randomUUID(), otherCourier=randomUUID();
  const auth: AuthContext={tenantId:tenant,userId:randomUUID(),sessionId:randomUUID(),role:'COURIER',storeIds:[store]};
  beforeAll(async () => {
    pg=new PGlite();
    database={connect:async()=>({query:(sql:string,params:unknown[]=[])=>pg.query(sql,params),release:()=>{}})} as unknown as Database;
    await pg.exec(`CREATE ROLE rastreia_runtime;
      CREATE TABLE courier_profiles(id uuid PRIMARY KEY,user_id uuid);
      CREATE TABLE deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,courier_profile_id uuid,route_id uuid,status text);
      CREATE TABLE routes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,courier_profile_id uuid,status text);
      CREATE TABLE route_stops(route_id uuid,status text);
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO rastreia_runtime;`);
    await pg.query('INSERT INTO courier_profiles VALUES($1,$2),($3,$4)',[courier,auth.userId,otherCourier,randomUUID()]);
  },30000);
  beforeEach(async()=>{await pg.exec('TRUNCATE deliveries,routes,route_stops');});
  afterAll(async()=>pg?.close());
  const delivery=(status='AWAITING_PICKUP',routeId:string|null=null,tenantId=tenant,storeId=store,courierId=courier)=>
    pg.query('INSERT INTO deliveries(tenant_id,store_id,courier_profile_id,route_id,status) VALUES($1,$2,$3,$4,$5)',[tenantId,storeId,courierId,routeId,status]);
  const route=async(status='DRAFT',tenantId=tenant,storeId=store,courierId=courier)=>{
    const id=randomUUID();
    await pg.query('INSERT INTO routes VALUES($1,$2,$3,$4,$5)',[id,tenantId,storeId,courierId,status]);
    await pg.query("INSERT INTO route_stops VALUES($1,'PENDING'),($1,'PENDING'),($1,'PENDING')",[id]);
    return id;
  };
  it('counts three batch deliveries only once, in routes, and keeps standalone work separate',async()=>{
    const id=await route();
    for(let i=0;i<3;i++)await delivery('AWAITING_PICKUP',id);
    await delivery();await delivery('IN_ROUTE');await delivery('DELIVERED');await delivery('CANCELLED');
    expect(await getCourierPendingSummary(database,auth)).toEqual({deliveries:2,routes:1});
  });
  it('isolates tenant, store and courier, including routes',async()=>{
    const anotherTenant=randomUUID(),anotherStore=randomUUID();
    await delivery('AWAITING_PICKUP',null,anotherTenant);await delivery('AWAITING_PICKUP',null,tenant,anotherStore);
    await delivery('AWAITING_PICKUP',null,tenant,store,otherCourier);
    await route('DRAFT',anotherTenant);await route('DRAFT',tenant,anotherStore);await route('DRAFT',tenant,store,otherCourier);
    expect(await getCourierPendingSummary(database,auth)).toEqual({deliveries:0,routes:0});
  });
  it('ignores completed/cancelled routes and routes without pending stops',async()=>{
    await route('COMPLETED');await route('CANCELLED');const id=await route('ACTIVE');
    await pg.query("UPDATE route_stops SET status='COMPLETED' WHERE route_id=$1",[id]);
    expect(await getCourierPendingSummary(database,auth)).toEqual({deliveries:0,routes:0});
  });
  it('does not truncate counts to a page and handles empty store access',async()=>{
    for(let i=0;i<105;i++)await delivery();
    expect((await getCourierPendingSummary(database,auth)).deliveries).toBe(105);
    expect(await getCourierPendingSummary(database,{...auth,storeIds:[]})).toEqual({deliveries:0,routes:0});
  });
  it('rejects non-courier roles',async()=>{
    await expect(getCourierPendingSummary(database,{...auth,role:'STORE_OPERATOR'})).rejects.toMatchObject({statusCode:403});
  });
});
