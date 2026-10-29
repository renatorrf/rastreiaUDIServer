import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { ZodError } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import { hashToken, verifyAccessToken } from '../auth/token.service.js';
import type { AppEnv } from '../../config/env.js';
import { mobileExpenseRoutes } from './mobile-expenses.routes.js';
import { today } from './finance.service.js';

describe('mobile expenses: real isolated PostgreSQL transactions and session RLS', () => {
  const pg = new PGlite(), user = randomUUID(), otherUser = randomUUID(), tenant = randomUUID(), store = randomUUID(), otherStore = randomUUID();
  const category = randomUUID(), incoming = randomUUID(), noncash = randomUUID();
  const password = 'test-only-password-987', email = 'expense-test@example.invalid';
  let app: FastifyInstance;
  const client = { query: async (sql: string, values?: unknown[]) => {
    const result = await pg.query(sql, values); return { ...result, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) };
  }, release: () => {} };
  const db = { connect: async () => client } as unknown as Database;
  const login = () => app.inject({ method: 'POST', url: '/mobile-expenses/login', payload: { email, password } });
  const token = async (): Promise<string> => { const result = await login(); expect(result.statusCode).toBe(200); return result.json<{token:string}>().token; };
  const headers = (value: string, key = randomUUID()) => ({ authorization: `Bearer ${value}`, 'idempotency-key': key });
  const input = () => ({ categoryId: category, description: 'Embalagens de teste', amountCents: 2590, competenceDate: today(), dueDate: today(), document: '', payment: { paidDate: today(), method: 'PIX' } });
  const send = (value: string, payload: unknown, key = randomUUID(), target = store) => app.inject({ method: 'POST', url: `/mobile-expenses/stores/${target}/entries`, headers: headers(value, key), payload: payload as object });
  const count = async (table: string) => Number((await pg.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
  beforeAll(async () => {
    await pg.exec(`CREATE SCHEMA rastreia; SET search_path=rastreia,public; CREATE ROLE rastreia_runtime;
      GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.user_id',true),'')::uuid$$;
      CREATE TABLE users(id uuid PRIMARY KEY,name text,email text,password_hash text,status text DEFAULT 'ACTIVE',email_verified_at timestamptz DEFAULT now(),must_change_password boolean DEFAULT false);
      CREATE TABLE units(id uuid,user_id uuid,tenant_id uuid,name text,tenant_name text,role text,active boolean DEFAULT true);
      CREATE FUNCTION identity_by_email(text) RETURNS SETOF users LANGUAGE sql SECURITY DEFINER AS $$SELECT * FROM users WHERE email=$1$$;
      CREATE FUNCTION identity_units(uuid) RETURNS TABLE(id uuid,name text,tenant_id uuid,tenant_name text,role text) LANGUAGE sql AS $$SELECT id,name,tenant_id,tenant_name,role FROM units WHERE user_id=$1 AND user_id=current_user_id() AND active$$;
      CREATE FUNCTION commerce_manage_store(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM units WHERE id=$1 AND user_id=current_user_id() AND role='TENANT_MANAGER' AND active AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$$;
      CREATE TABLE commerce_finance_categories(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,name text,direction text,dre_group text,UNIQUE(store_id,name));
      CREATE TABLE commerce_finance_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,category_id uuid,description text,direction text,dre_group text,amount_cents bigint,competence_date date,due_date date,document text,created_by uuid,version integer DEFAULT 1,cancelled_at timestamptz);
      CREATE TABLE commerce_finance_settlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,store_id uuid,entry_id uuid,amount_cents bigint,paid_date date,method text,note text,created_by uuid,reversed_date date);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status integer,response_body jsonb,expires_at timestamptz DEFAULT now()+interval '1 day',UNIQUE(tenant_id,idempotency_key,operation));
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
      CREATE POLICY users_self ON users USING(id=current_user_id()) WITH CHECK(id=current_user_id());`);
    await pg.exec('BEGIN;' + await readFile(new URL('../../../migrations/0070_mobile_expense_sessions.sql', import.meta.url), 'utf8') + 'COMMIT');
    await pg.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [user, 'Gestor teste', email, await argon2.hash(password), otherUser, 'Outro gestor', 'other@example.invalid']);
    await pg.query("INSERT INTO units(id,user_id,tenant_id,name,tenant_name,role) VALUES($1,$2,$3,'Loja teste','Empresa teste','TENANT_MANAGER'),($4,$5,$6,'Outra loja','Outra empresa','TENANT_MANAGER')", [store, user, tenant, otherStore, otherUser, randomUUID()]);
    await pg.query("INSERT INTO commerce_finance_categories(id,tenant_id,store_id,name,direction,dre_group) VALUES($1,$4,$5,'Embalagens','OUT','VARIABLE'),($2,$4,$5,'Vendas','IN','REVENUE'),($3,$4,$5,'Depreciação','OUT','DEPRECIATION')", [category, incoming, noncash, tenant, store]);
    app = Fastify(); app.setErrorHandler((error, _req, reply) => {
      const e = error as Error & { statusCode?: number }; reply.code(error instanceof ZodError ? 422 : e.statusCode ?? 500).send({ message: e.message });
    });
    await mobileExpenseRoutes(app, db); await app.ready();
  }, 30000);
  afterAll(async () => { await app?.close(); await pg.close(); });
  it('authenticates verified managers only and does not grant general JWT access', async () => {
    expect((await app.inject({ method: 'POST', url: '/mobile-expenses/login', payload: { email, password: 'wrong-password' } })).statusCode).toBe(401);
    const value = await token(); expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (await pg.query<{token_hash:string}>('SELECT token_hash FROM mobile_expense_sessions WHERE token_hash=$1', [hashToken(value)])).rows[0]!;
    expect(row.token_hash).not.toBe(value);
    await expect(verifyAccessToken({ JWT_ACCESS_SECRET: 'not-a-real-secret' } as AppEnv, value)).rejects.toThrow();
    await pg.query("UPDATE mobile_expense_sessions SET created_at=now()-interval '2 years' WHERE token_hash=$1", [hashToken(value)]);
    expect((await app.inject({ url: '/mobile-expenses/session', headers: headers(value) })).statusCode).toBe(200);
    for (const role of ['COURIER', 'STORE_OPERATOR']) {
      await pg.query('UPDATE units SET role=$1 WHERE user_id=$2', [role, user]);
      expect((await login()).statusCode).toBe(403);
      expect((await send(value, input())).statusCode).toBe(403);
    }
    await pg.query("UPDATE units SET role='TENANT_MANAGER' WHERE user_id=$1", [user]);
  });
  it('rejects missing tokens, foreign stores and forged identity/tenant fields', async () => {
    expect((await app.inject({ url: '/mobile-expenses/session' })).statusCode).toBe(401);
    const value = await token();
    expect((await send(value, input(), randomUUID(), otherStore)).statusCode).toBe(403);
    for (const extra of [{ tenantId: randomUUID() }, { userId: otherUser }, { direction: 'IN' }, { amountCents: 1.5 }]) {
      expect((await send(value, { ...input(), ...extra })).statusCode).toBe(422);
    }
    expect((await send(value, { ...input(), categoryId: incoming })).statusCode).toBe(422);
    expect((await send(value, { ...input(), categoryId: noncash })).statusCode).toBe(422);
    expect((await send(value, { ...input(), payment: { paidDate: '2099-01-01', method: 'PIX' } })).statusCode).toBe(422);
  });
  it('creates entry, settlement and audit atomically; retries remain idempotent beyond retention', async () => {
    const value = await token(), key = randomUUID(), before = await count('commerce_finance_entries'), payments = await count('commerce_finance_settlements');
    const result = await send(value, input(), key); expect(result.statusCode, result.body).toBe(200);
    const repeat = await send(value, input(), key); expect(repeat.json()).toEqual(result.json()); expect(repeat.headers['idempotency-replayed']).toBe('true');
    expect(await count('commerce_finance_entries')).toBe(before + 1); expect(await count('commerce_finance_settlements')).toBe(payments + 1);
    expect((await pg.query<{expiry:string}>('SELECT expires_at::text AS expiry FROM idempotency_keys WHERE idempotency_key=$1', [key])).rows[0]!.expiry).toBe('infinity');
    expect((await send(value, { ...input(), amountCents: 1 }, key)).statusCode).toBe(409);
    const audit = await pg.query('SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND tenant_id=$2', [user, tenant]); expect(audit.rows.length).toBeGreaterThan(0);
  });
  it('rolls back the entry and idempotency receipt when payment persistence fails', async () => {
    const value = await token(), key = randomUUID(), before = await count('commerce_finance_entries');
    await pg.exec("ALTER TABLE commerce_finance_settlements ADD CONSTRAINT simulated_failure CHECK (amount_cents <> 777)");
    const body = { ...input(), amountCents: 777 };
    expect((await send(value, body, key)).statusCode).toBe(500); expect(await count('commerce_finance_entries')).toBe(before);
    await pg.exec('ALTER TABLE commerce_finance_settlements DROP CONSTRAINT simulated_failure');
    expect((await send(value, body, key)).statusCode).toBe(200); expect(await count('commerce_finance_entries')).toBe(before + 1);
  });
  it('validates current unit access even when replaying a successful request', async () => {
    const value = await token(), key = randomUUID(); expect((await send(value, input(), key)).statusCode).toBe(200);
    await pg.query('UPDATE units SET active=false WHERE user_id=$1', [user]);
    expect((await send(value, input(), key)).statusCode).toBe(403);
    await pg.query('UPDATE units SET active=true WHERE user_id=$1', [user]);
  });
  it('revokes on logout and password/account changes, with no resurrection on reactivation', async () => {
    let value = await token();
    expect((await app.inject({ method: 'POST', url: '/mobile-expenses/logout', headers: headers(value) })).statusCode).toBe(204);
    expect((await app.inject({ url: '/mobile-expenses/session', headers: headers(value) })).statusCode).toBe(401);
    value = await token(); await pg.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user, await argon2.hash(password)]);
    expect((await app.inject({ url: '/mobile-expenses/session', headers: headers(value) })).statusCode).toBe(401);
    value = await token(); await pg.query("UPDATE users SET status='BLOCKED' WHERE id=$1", [user]); await pg.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [user]);
    expect((await app.inject({ url: '/mobile-expenses/session', headers: headers(value) })).statusCode).toBe(401);
    await pg.query('UPDATE users SET must_change_password=true WHERE id=$1', [user]); expect((await login()).statusCode).toBe(409);
    await pg.query('UPDATE users SET must_change_password=false,email_verified_at=NULL WHERE id=$1', [user]); expect((await login()).statusCode).toBe(401);
    await pg.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [user]);
  });
  it('RLS hides sessions from another user and denies token/fingerprint replacement', async () => {
    await token(); await pg.exec('BEGIN; SET LOCAL ROLE rastreia_runtime');
    try {
      await pg.query("SELECT set_config('app.user_id',$1,true)", [otherUser]);
      expect((await pg.query('SELECT id FROM mobile_expense_sessions WHERE user_id=$1', [user])).rows).toHaveLength(0);
      await expect(pg.query("UPDATE mobile_expense_sessions SET credential_fingerprint=repeat('0',64)")).rejects.toThrow(/permission denied/);
    } finally { await pg.exec('ROLLBACK'); }
  });
  it('revocation trigger also works with a non-BYPASSRLS owner and restores caller context', async () => {
    const value = await token();
    await pg.exec('ALTER FUNCTION rastreia.revoke_mobile_expense_credentials() OWNER TO rastreia_runtime');
    await pg.query("SELECT set_config('app.user_id',$1,false)", [otherUser]);
    await pg.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user, await argon2.hash(password)]);
    expect((await pg.query<{id:string}>("SELECT current_setting('app.user_id') AS id")).rows[0]!.id).toBe(otherUser);
    await pg.query("SELECT set_config('app.user_id','',false)");
    expect((await app.inject({ url: '/mobile-expenses/session', headers: headers(value) })).statusCode).toBe(401);
  });
});
