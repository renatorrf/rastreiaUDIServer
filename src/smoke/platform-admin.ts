import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';

loadLocalEnv();
const env = getEnv();
const database = createPool(env);
const prefix = `smoke-platform-${Date.now()}`;
const adminId = randomUUID();
const adminEmail = `${prefix}@example.invalid`;
const adminPassword = `Admin-${randomUUID()}-segura`;
const managerEmail = `${prefix}-manager@example.invalid`;
const managerPassword = `Manager-${randomUUID()}-segura`;
let tenantId = '';
let managerId = '';

function body<T>(response: { statusCode: number; body: string }, expected: number): T {
  if (response.statusCode !== expected) throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body) as T;
}

function cookie(response: { headers: Record<string, string | string[] | number | undefined> }, name: string): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  const pair = typeof value === 'string' ? value.split(';')[0] : undefined;
  if (!pair?.startsWith(`${name}=`)) throw new Error(`Cookie ${name} ausente.`);
  return pair;
}

const passwordHash = await argon2.hash(adminPassword, {
  type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
});
await withTransaction(database, async (client) => {
  await client.query("SELECT set_config('app.platform_admin_id', $1, true)", [adminId]);
  await client.query(
    'INSERT INTO rastreia.platform_admins (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
    [adminId, 'Administrador Smoke', adminEmail, passwordHash],
  );
});

const app = await buildApp({ env, database });
try {
  const platformLogin = await app.inject({ method: 'POST', url: '/platform/auth/login', payload: {
    email: adminEmail, password: adminPassword,
  } });
  const platform = body<{ accessToken: string }>(platformLogin, 200);
  const platformHeaders = { authorization: `Bearer ${platform.accessToken}` };
  cookie(platformLogin, 'rastreia_platform_refresh');

  const createPayload = {
      slug: prefix, name: 'Empresa Smoke Plataforma', timezone: 'America/Sao_Paulo',
      manager: { name: 'Gestor Smoke', email: managerEmail, password: managerPassword },
  };
  const createRequest = { method: 'POST' as const, url: '/platform/tenants',
    headers: { ...platformHeaders, 'idempotency-key': prefix }, payload: createPayload };
  const created = body<{ id: string }>(await app.inject(createRequest), 201);
  tenantId = created.id;
  const replayedCreate = await app.inject(createRequest);
  if (body<{ id: string }>(replayedCreate, 201).id !== tenantId
      || replayedCreate.headers['idempotency-replayed'] !== 'true') {
    throw new Error('Criação administrativa não foi reproduzida com idempotência.');
  }
  const manager = await database.query<{ id: string }>('SELECT id FROM rastreia.users WHERE email = $1', [managerEmail]);
  managerId = manager.rows[0]?.id ?? '';

  const tenantLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: prefix, email: managerEmail, password: managerPassword,
  } });
  const tenant = body<{ accessToken: string }>(tenantLogin, 200);
  const tenantCookie = cookie(tenantLogin, 'rastreia_refresh');
  const tenantHeaders = { authorization: `Bearer ${tenant.accessToken}` };

  const crossed = await app.inject({ method: 'GET', url: '/platform/tenants', headers: tenantHeaders });
  if (crossed.statusCode !== 401) throw new Error('Token tenant atravessou a audiência administrativa.');

  const suspendRequest = { method: 'PATCH' as const, url: `/platform/tenants/${tenantId}/status`,
    headers: { ...platformHeaders, 'idempotency-key': `${prefix}-suspend` },
    payload: { status: 'SUSPENDED', reason: 'Ensaio automatizado de bloqueio global.' } };
  body(await app.inject(suspendRequest), 200);
  const replayedSuspend = await app.inject(suspendRequest);
  body(replayedSuspend, 200);
  if (replayedSuspend.headers['idempotency-replayed'] !== 'true') {
    throw new Error('Mudança de status não foi reproduzida com idempotência.');
  }
  const blockedAccess = await app.inject({ method: 'GET', url: '/stores', headers: tenantHeaders });
  if (blockedAccess.statusCode !== 401) throw new Error('Access token permaneceu válido após suspensão.');
  const blockedRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: tenantCookie } });
  if (blockedRefresh.statusCode !== 401) throw new Error('Refresh permaneceu válido após suspensão.');

  body(await app.inject({ method: 'PATCH', url: `/platform/tenants/${tenantId}/status`,
    headers: { ...platformHeaders, 'idempotency-key': `${prefix}-activate` },
    payload: { status: 'ACTIVE', reason: 'Conclusão do ensaio de reativação.' } }), 200);
  body(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: prefix, email: managerEmail, password: managerPassword,
  } }), 200);
  body(await app.inject({ method: 'PATCH', url: `/platform/tenants/${tenantId}/status`,
    headers: { ...platformHeaders, 'idempotency-key': `${prefix}-archive` },
    payload: { status: 'ARCHIVED', reason: 'Conclusão e limpeza do ensaio automatizado.' } }), 200);
  const invalidRestore = await app.inject({ method: 'PATCH', url: `/platform/tenants/${tenantId}/status`,
    headers: { ...platformHeaders, 'idempotency-key': `${prefix}-restore` },
    payload: { status: 'ACTIVE', reason: 'Tentativa inválida de restauração.' } });
  if (invalidRestore.statusCode !== 409) throw new Error('Tenant arquivado foi reativado.');
  const audit = body<{ data: Array<{ targetTenantId: string }> }>(await app.inject({
    method: 'GET', url: '/platform/audit', headers: platformHeaders,
  }), 200);
  if (audit.data.filter((entry) => entry.targetTenantId === tenantId).length < 4) {
    throw new Error('Auditoria global incompleta.');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, idempotentMutations: true, isolatedAudience: true, suspendedAccessBlocked: true,
    suspendedRefreshBlocked: true, archivedIsFinal: true, audited: true,
  }, null, 2)}\n`);
} finally {
  try {
    await withTransaction(database, async (client) => {
      await client.query("SELECT set_config('app.platform_admin_id', $1, true)", [adminId]);
      if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      if (managerId) await client.query("SELECT set_config('app.user_id', $1, true)", [managerId]);
      if (tenantId) {
        await client.query('DELETE FROM rastreia.platform_audit_logs WHERE target_tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM rastreia.refresh_sessions WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM rastreia.tenant_users WHERE tenant_id = $1', [tenantId]);
        if (managerId) await client.query('DELETE FROM rastreia.users WHERE id = $1', [managerId]);
        await client.query('DELETE FROM rastreia.tenants WHERE id = $1', [tenantId]);
      }
      await client.query('DELETE FROM rastreia.platform_refresh_sessions WHERE platform_admin_id = $1', [adminId]);
      await client.query('DELETE FROM rastreia.platform_idempotency_keys WHERE platform_admin_id = $1', [adminId]);
      await client.query('DELETE FROM rastreia.platform_admins WHERE id = $1', [adminId]);
    });
  } finally { await app.close(); }
}
