import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import type { Database } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import type { AuthContext } from '../auth/auth.types.js';
import { notifyDeliveryCustomer } from './delivery-customer-alert.service.js';
import { processCustomerPush } from '../../workers/notification-worker.service.js';

vi.mock('web-push', () => ({ default: { sendNotification: vi.fn().mockResolvedValue({}) } }));

// Real, isolated PostgreSQL; no .env, shared DB or real notifications.
describe('courier arrival and private customer notifications', () => {
  let pg: PGlite; let database: Database; let id: string;
  const tenant = randomUUID(), user = randomUUID(), courier = randomUUID(), store = randomUUID(), customer = randomUUID();
  const auth: AuthContext = { tenantId: tenant, userId: user, role: 'COURIER', storeIds: [store], sessionId: randomUUID() };
  const env = { PUSH_VAPID_SUBJECT: 'mailto:test@example.test', PUSH_VAPID_PUBLIC_KEY: 'test-only',
    PUSH_VAPID_PRIVATE_KEY: 'test-only', PUSH_APP_URL: 'https://example.test' } as AppEnv;
  beforeAll(async () => {
    pg = new PGlite();
    const client = { query: async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params); return { ...result, rowCount: result.affectedRows || result.rows.length };
    }, release: () => {} };
    database = { connect: async () => client, query: client.query } as unknown as Database;
    await pg.exec(`CREATE SCHEMA rastreia; SET search_path=rastreia,public;
      CREATE ROLE rastreia_runtime; GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE TABLE courier_profiles(id uuid PRIMARY KEY,user_id uuid);
      CREATE TABLE deliveries(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid,store_id uuid,courier_profile_id uuid,
        customer_profile_id uuid,route_id uuid,status text,version int DEFAULT 1,updated_at timestamptz DEFAULT now());
      CREATE TABLE routes(id uuid PRIMARY KEY);
      CREATE TABLE route_stops(route_id uuid,delivery_id uuid,stop_type text,status text,sequence int);
      CREATE TABLE courier_workdays(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,courier_profile_id uuid,
        status text,ends_at timestamptz,location_consent_at timestamptz);
      CREATE TABLE outbox_events(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status int,response_body jsonb,UNIQUE(tenant_id,idempotency_key,operation));
      CREATE TABLE customer_push_subscriptions(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,customer_profile_id uuid,
        endpoint text,p256dh text,auth_secret text,active boolean,last_success_at timestamptz,last_failure_at timestamptz,failure_count int DEFAULT 0);
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec(await readFile(new URL('../../../migrations/0051_delivery_customer_alerts.sql', import.meta.url), 'utf8'));
    await pg.query('INSERT INTO courier_profiles VALUES($1,$2)', [courier, user]);
    await pg.query(`INSERT INTO courier_workdays(tenant_id,store_id,courier_profile_id,status,ends_at,location_consent_at)
      VALUES($1,$2,$3,'CHECKED_IN',now()+interval '8 hours',now())`, [tenant, store, courier]);
  }, 30000);
  beforeEach(async () => {
    vi.mocked(webpush.sendNotification).mockClear(); id = randomUUID();
    await pg.query(`UPDATE courier_workdays SET status='CHECKED_IN'`);
    await pg.query(`INSERT INTO deliveries(id,tenant_id,company_id,store_id,courier_profile_id,customer_profile_id,status)
      VALUES($1,$2,$2,$3,$4,$5,'IN_ROUTE')`, [id, tenant, store, courier, customer]);
  });
  afterAll(async () => pg?.close());
  it('records arrival once, including retries with a new idempotency key', async () => {
    const key = randomUUID();
    const first = await notifyDeliveryCustomer(database, auth, id, key, 'ARRIVED');
    expect(first.body.alreadyRecorded).toBe(false);
    expect((await notifyDeliveryCustomer(database, auth, id, key, 'ARRIVED')).replayed).toBe(true);
    expect((await notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).body.alreadyRecorded).toBe(true);
    expect((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1', [id])).rows).toHaveLength(1);
    await notifyDeliveryCustomer(database, auth, id, randomUUID(), 'WAITING_AT_GATE');
    expect((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1', [id])).rows).toHaveLength(2);
  });
  it('rejects other couriers, tenants, managers and absent check-in', async () => {
    for (const changed of [{ userId: randomUUID() }, { tenantId: randomUUID() }]) {
      await expect(notifyDeliveryCustomer(database, { ...auth, ...changed }, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(notifyDeliveryCustomer(database, { ...auth, role: 'TENANT_MANAGER' }, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 403 });
    await pg.exec("UPDATE courier_workdays SET status='CONFIRMED'");
    await expect(notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 409 });
    expect((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1', [id])).rows).toHaveLength(0);
  });
  it('requires arrival before waiting and rejects completed deliveries', async () => {
    await expect(notifyDeliveryCustomer(database, auth, id, randomUUID(), 'WAITING_AT_GATE')).rejects.toMatchObject({ statusCode: 409 });
    await pg.query("UPDATE deliveries SET status='DELIVERED' WHERE id=$1", [id]);
    await expect(notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 409 });
  });
  it('only allows the next customer destination, never pickup or a later stop', async () => {
    const route = randomUUID(); await pg.query('INSERT INTO routes VALUES($1)', [route]);
    await pg.query('UPDATE deliveries SET route_id=$2 WHERE id=$1', [id, route]);
    await pg.query("INSERT INTO route_stops VALUES($1,$2,'DELIVERY','PENDING',1)", [route, randomUUID()]);
    await expect(notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 409 });
    await pg.query("UPDATE route_stops SET delivery_id=$2,stop_type='PICKUP' WHERE route_id=$1", [route, id]);
    await expect(notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).rejects.toMatchObject({ statusCode: 409 });
    await pg.query("UPDATE route_stops SET stop_type='DELIVERY' WHERE route_id=$1", [route]);
    expect((await notifyDeliveryCustomer(database, auth, id, randomUUID(), 'ARRIVED')).statusCode).toBe(200);
  });
  it('push SQL targets only active devices of the order customer and tenant, and suppresses stale arrival', async () => {
    await pg.exec('DELETE FROM customer_push_subscriptions');
    for (const [scope, profile, active, endpoint] of [[tenant, customer, true, 'own'], [tenant, customer, false, 'disabled'],
      [tenant, randomUUID(), true, 'other-customer'], [randomUUID(), customer, true, 'other-tenant']] as const) {
      await pg.query(`INSERT INTO customer_push_subscriptions(tenant_id,customer_profile_id,active,endpoint,p256dh,auth_secret)
        VALUES($1,$2,$3,$4,'test-only','test-only')`, [scope, profile, active, endpoint]);
    }
    const event = { id: randomUUID(), tenant_id: tenant, aggregate_type: 'delivery', aggregate_id: id,
      event_type: 'delivery.arrived', payload: {}, attempts: 0, occurred_at: new Date() };
    await processCustomerPush(database, env, event);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0]![0].endpoint).toBe('own');
    expect(String(vi.mocked(webpush.sendNotification).mock.calls[0]![1])).toContain('Seu entregador chegou');
    await pg.query("UPDATE deliveries SET status='DELIVERED' WHERE id=$1", [id]);
    await processCustomerPush(database, env, event);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
