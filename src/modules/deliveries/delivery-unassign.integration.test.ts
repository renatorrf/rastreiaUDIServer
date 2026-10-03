import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import { assignDelivery, getDelivery, listDeliveries, unassignDelivery } from './delivery.service.js';

// Isolated PostgreSQL engine: no .env, shared data or external dispatch.
describe('Delivery unassignment', () => {
  let pg: PGlite; let database: Database; let id: string;
  const tenant = randomUUID(), store = randomUUID(), courier = randomUUID(), courierUser = randomUUID();
  const manager: AuthContext = { tenantId: tenant, userId: randomUUID(), sessionId: randomUUID(), role: 'TENANT_MANAGER', storeIds: [store] };
  const input = () => ({ courierId: courier, version: 2, reason: 'Entregador selecionado incorretamente' });
  beforeAll(async () => {
    pg = new PGlite();
    const client = { query: async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params); return { ...result, rowCount: result.affectedRows || result.rows.length };
    }, release: () => {} };
    database = { connect: async () => client, query: client.query } as unknown as Database;
    await pg.exec(`CREATE SCHEMA rastreia; SET search_path=rastreia,public;
      CREATE ROLE rastreia_runtime; GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE TYPE delivery_status AS ENUM ('DRAFT','AWAITING_COURIER','ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','DELIVERED','CANCELLED','DELIVERY_FAILED','RETURN_STARTED','RETURNED');
      CREATE TABLE tenants(id uuid PRIMARY KEY, timezone text DEFAULT 'America/Sao_Paulo');
      CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE users(id uuid PRIMARY KEY,name text);
      CREATE TABLE courier_profiles(id uuid PRIMARY KEY,user_id uuid,status text DEFAULT 'ACTIVE');
      CREATE TABLE courier_store_links(tenant_id uuid,store_id uuid,courier_profile_id uuid,status text DEFAULT 'ACTIVE');
      CREATE TABLE courier_workdays(tenant_id uuid,store_id uuid,courier_profile_id uuid,status text,service_date date DEFAULT current_date,ends_at timestamptz DEFAULT now()+interval '8 hours');
      CREATE TABLE deliveries(id uuid PRIMARY KEY,tenant_id uuid,store_id uuid,route_id uuid,courier_profile_id uuid,
        external_reference text,origin text DEFAULT 'MANUAL',external_order_id uuid,recipient_name text DEFAULT 'Cliente teste',
        recipient_phone text,recipient_whatsapp text,address_line text,address_number text,complement text,neighborhood text,
        city text,state text,postal_code text,latitude float8,longitude float8,address_confidence float8,delivery_instructions text,
        status delivery_status DEFAULT 'AWAITING_PICKUP',promised_window_start timestamptz,promised_window_end timestamptz,
        arrived_at timestamptz,waiting_at_gate_at timestamptz,collected_at timestamptz,out_for_delivery_at timestamptz,
        delivered_at timestamptz,cancelled_at timestamptz,failed_at timestamptz,failure_reason text,version int DEFAULT 2,
        updated_by uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE delivery_offers(delivery_id uuid,status text);
      CREATE TABLE delivery_status_history(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,delivery_id uuid,from_status delivery_status,
        to_status delivery_status,reason text,metadata jsonb,actor_user_id uuid,delivery_version int,created_at timestamptz DEFAULT now(),UNIQUE(delivery_id,delivery_version));
      CREATE TABLE background_tracking_sessions(tenant_id uuid,delivery_id uuid,revoked_at timestamptz);
      CREATE TABLE outbox_events(tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status int,response_body jsonb,UNIQUE(tenant_id,idempotency_key,operation));
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;
      ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
      ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_scope ON deliveries USING (tenant_id=current_setting('app.tenant_id',true)::uuid);
      ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_scope ON idempotency_keys USING (tenant_id=current_setting('app.tenant_id',true)::uuid);`);
    await pg.query('INSERT INTO tenants(id) VALUES($1)', [tenant]);
    await pg.query("INSERT INTO stores VALUES($1,$2,'Loja teste')", [store, tenant]);
    await pg.query("INSERT INTO users VALUES($1,'Entregador teste')", [courierUser]);
    await pg.query('INSERT INTO courier_profiles(id,user_id) VALUES($1,$2)', [courier, courierUser]);
    await pg.query('INSERT INTO courier_store_links(tenant_id,store_id,courier_profile_id) VALUES($1,$2,$3)', [tenant, store, courier]);
    await pg.query("INSERT INTO courier_workdays(tenant_id,store_id,courier_profile_id,status) VALUES($1,$2,$3,'CONFIRMED')", [tenant, store, courier]);
  }, 30000);
  beforeEach(async () => {
    id = randomUUID();
    await pg.query('INSERT INTO deliveries(id,tenant_id,store_id,courier_profile_id) VALUES($1,$2,$3,$4)', [id, tenant, store, courier]);
  });
  afterAll(async () => pg?.close());
  it('returns the delivery to the routes queue, audits it and revokes only its delivery tracking', async () => {
    const other = randomUUID();
    await pg.query('INSERT INTO background_tracking_sessions(tenant_id,delivery_id) VALUES($1,$2),($1,$3)', [tenant, id, other]);
    const result = await unassignDelivery(database, manager, randomUUID(), id, input());
    expect(result.body).toMatchObject({ status: 'AWAITING_COURIER', courierId: null, courierName: null, routeId: null, version: 3 });
    expect(result.body.nextActions).toContain('assign');
    const queue = await listDeliveries(database, manager, { status: 'AWAITING_COURIER', view: 'active', limit: 100 });
    expect(queue.data.some(row => row.id === id && !row.routeId)).toBe(true);
    const history = await pg.query<{ reason: string; metadata: { previousCourierId: string } }>('SELECT reason,metadata FROM delivery_status_history WHERE delivery_id=$1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: input().reason, metadata: { previousCourierId: courier } });
    expect((await pg.query('SELECT * FROM audit_logs WHERE entity_id=$1', [id])).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1', [id])).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM background_tracking_sessions WHERE delivery_id=$1 AND revoked_at IS NOT NULL', [id])).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM background_tracking_sessions WHERE delivery_id=$1 AND revoked_at IS NULL', [other])).rows).toHaveLength(1);
    expect((await pg.query("SELECT * FROM courier_workdays WHERE status='CONFIRMED'")).rows).toHaveLength(1);
    await expect(getDelivery(database, { ...manager, role: 'COURIER', userId: courierUser }, id)).rejects.toMatchObject({ statusCode: 404 });
    // The ordinary reassignment path remains usable and still requires confirmed presence.
    const assigned = await assignDelivery(database, manager, randomUUID(), id, courier);
    expect(assigned.body).toMatchObject({ status: 'AWAITING_PICKUP', courierId: courier, version: 5 });
  });
  it('replays the same request once and prevents stale screens from undoing a new assignment', async () => {
    const key = randomUUID();
    await unassignDelivery(database, manager, key, id, input());
    expect((await unassignDelivery(database, manager, key, id, input())).replayed).toBe(true);
    await assignDelivery(database, manager, randomUUID(), id, courier);
    await expect(unassignDelivery(database, manager, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 409 });
    expect((await getDelivery(database, manager, id)).courierId).toBe(courier);
    expect((await pg.query("SELECT * FROM audit_logs WHERE entity_id=$1 AND action='delivery.unassigned'", [id])).rows).toHaveLength(1);
  });
  it('also corrects an iFood assignment without cancelling the external order', async () => {
    await pg.query("UPDATE deliveries SET status='ASSIGNED',origin='IFOOD' WHERE id=$1", [id]);
    const result=await unassignDelivery(database, manager, randomUUID(), id, input());
    expect(result.body).toMatchObject({status:'AWAITING_COURIER',origin:'IFOOD',cancelledAt:null,courierId:null});
  });
  it('allows the unit operator but denies another unit, tenant and courier', async () => {
    await expect(unassignDelivery(database, { ...manager, role: 'STORE_OPERATOR', storeIds: [randomUUID()] }, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 404 });
    await expect(unassignDelivery(database, { ...manager, tenantId: randomUUID() }, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 404 });
    await expect(unassignDelivery(database, { ...manager, role: 'COURIER', userId: courierUser }, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 403 });
    expect((await unassignDelivery(database, { ...manager, role: 'STORE_OPERATOR' }, randomUUID(), id, input())).body.courierId).toBeNull();
  });
  it.each(['COLLECTED','IN_ROUTE','NEXT_STOP','DELIVERED','CANCELLED','DELIVERY_FAILED','RETURN_STARTED','RETURNED'])('rejects %s without side effects', async status => {
    await pg.query('UPDATE deliveries SET status=$2 WHERE id=$1', [id, status]);
    await expect(unassignDelivery(database, manager, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 409 });
    expect((await getDelivery(database, manager, id)).courierId).toBe(courier);
    expect((await pg.query('SELECT * FROM delivery_status_history WHERE delivery_id=$1', [id])).rows).toHaveLength(0);
  });
  it('rejects route membership, marketplace commitments and inconsistent collection timestamps', async () => {
    await pg.query('UPDATE deliveries SET route_id=$2 WHERE id=$1', [id, randomUUID()]);
    await expect(unassignDelivery(database, manager, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 409 });
    await pg.query('UPDATE deliveries SET route_id=NULL,collected_at=now() WHERE id=$1', [id]);
    await expect(unassignDelivery(database, manager, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 409 });
    await pg.query('UPDATE deliveries SET collected_at=NULL WHERE id=$1', [id]);
    await pg.query("INSERT INTO delivery_offers VALUES($1,'ACCEPTED')", [id]);
    await expect(unassignDelivery(database, manager, randomUUID(), id, input())).rejects.toMatchObject({ statusCode: 409 });
  });
});
