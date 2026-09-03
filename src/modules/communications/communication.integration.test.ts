import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import {
  getPushStatus, getPushSubscriptionStatus, queuePushTest, savePushSubscription,
} from './communication.service.js';

// Real PostgreSQL in memory. Never reads .env or connects to the shared database.
describe('push subscription diagnostics and test delivery', () => {
  let pg: PGlite;
  let database: Database;
  const tenantId=randomUUID(),userId=randomUUID();
  const auth:AuthContext={tenantId,userId,role:'COURIER',storeIds:[],sessionId:randomUUID()};
  const env={PUSH_VAPID_SUBJECT:'mailto:test@example.test',PUSH_VAPID_PUBLIC_KEY:'public-test-key',
    PUSH_VAPID_PRIVATE_KEY:'private-test-key'} as AppEnv;

  beforeAll(async()=>{
    pg=new PGlite();
    const client={query:async(sql:string,params:unknown[]=[])=>{const result=await pg.query(sql,params);return {...result,rowCount:result.affectedRows||result.rows.length};},release:()=>{}};
    database={connect:async()=>client} as unknown as Database;
    await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE TABLE push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,user_id uuid,endpoint text,endpoint_hash text,p256dh text,auth_secret text,
        expiration_time timestamptz,user_agent text,active boolean DEFAULT true,failure_count int DEFAULT 0,last_failure_at timestamptz,last_success_at timestamptz,
        UNIQUE(tenant_id,user_id,endpoint_hash));
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status int,response_body jsonb,
        UNIQUE(tenant_id,idempotency_key,operation));
      CREATE TABLE outbox_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
  });
  afterAll(async()=>pg?.close());

  it('upserts one device and reports whether that exact endpoint is synchronized',async()=>{
    const input={endpoint:'https://push.example.test/device',keys:{p256dh:'synthetic-p256dh-key',auth:'synthetic-auth'}};
    await savePushSubscription(database,auth,input,'test-agent');
    await savePushSubscription(database,auth,input,'updated-agent');
    expect((await pg.query('SELECT id FROM push_subscriptions')).rows).toHaveLength(1);
    expect(await getPushSubscriptionStatus(database,auth,input.endpoint)).toMatchObject({synchronized:true});
    expect(await getPushStatus(database,auth,env)).toMatchObject({configured:true,activeDevices:1});
  });

  it('queues and audits a test once when the idempotency key is replayed',async()=>{
    const key=randomUUID();
    const first=await queuePushTest(database,auth,key);
    const replay=await queuePushTest(database,auth,key);
    expect(first).toMatchObject({statusCode:202,replayed:false,body:{queued:true}});
    expect(replay).toMatchObject({statusCode:202,replayed:true,body:{queued:true}});
    const events=await pg.query<{payload:{notificationKey:string}}>("SELECT payload FROM outbox_events WHERE event_type='push.test'");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.payload.notificationKey).toBe(`push-test:${userId}`);
    expect((await pg.query("SELECT action FROM audit_logs WHERE action='push.test.queued'")).rows).toHaveLength(1);
  });
});
