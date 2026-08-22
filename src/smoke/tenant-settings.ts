import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';

interface LoginBody { accessToken: string }
interface TenantBody {
  id: string; name: string; legalName: string | null; contactPhone: string | null;
  timezone: string; updatedAt: string; capabilities: Record<string, boolean>;
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const suffix = runId.slice(0, 8);
const tenantId = randomUUID();
const managerId = randomUUID();
const operatorId = randomUUID();
const tenantSlug = `settings-${suffix}`;
const managerEmail = `settings-manager-${runId}@example.invalid`;
const operatorEmail = `settings-operator-${runId}@example.invalid`;
const password = `Settings-smoke-${runId}`;

const setup = createPool(env);
await withTransaction(setup, async (client) => {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  });
  await client.query('INSERT INTO rastreia.tenants (id, slug, name) VALUES ($1, $2, $3)',
    [tenantId, tenantSlug, `Empresa Configuração ${suffix}`]);
  await client.query(
    `INSERT INTO rastreia.users (id, name, email, password_hash) VALUES
       ($1, 'Gestor Configuração Smoke', $2, $5),
       ($3, 'Operador Configuração Smoke', $4, $5)`,
    [managerId, managerEmail, operatorId, operatorEmail, passwordHash],
  );
  await client.query(
    `INSERT INTO rastreia.tenant_users (tenant_id, user_id, role, created_by, updated_by) VALUES
       ($1, $2, 'TENANT_MANAGER', $2, $2),
       ($1, $3, 'STORE_OPERATOR', $2, $2)`,
    [tenantId, managerId, operatorId],
  );
});
await setup.end();

const app = await buildApp({ env });
try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug, email: managerEmail, password,
  } }), 200, 'login do gestor');
  const operator = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug, email: operatorEmail, password,
  } }), 200, 'login do operador');
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  const operatorHeaders = { authorization: `Bearer ${operator.accessToken}` };

  const current = body<TenantBody>(await app.inject({
    method: 'GET', url: '/tenants/current', headers: managerHeaders,
  }), 200, 'consultar configurações');
  const expectedCapabilities = ['maps', 'realtime', 'webPush', 'whatsapp', 'sms', 'objectStorage'];
  if (!expectedCapabilities.every((key) => typeof current.capabilities[key] === 'boolean')) {
    throw new Error('O diagnóstico de capacidades não retornou somente indicadores booleanos.');
  }

  const payload = {
    name: `Empresa Configurada ${suffix}`, legalName: 'Empresa Configurada LTDA',
    contactPhone: '+55 11 4000-0000', timezone: 'America/Manaus', updatedAt: current.updatedAt,
  };
  const denied = await app.inject({ method: 'PATCH', url: '/tenants/current', headers: operatorHeaders, payload });
  if (denied.statusCode !== 403) throw new Error('Operador sem papel de gestor conseguiu alterar a empresa.');

  const updated = body<TenantBody>(await app.inject({
    method: 'PATCH', url: '/tenants/current', headers: managerHeaders, payload,
  }), 200, 'salvar configurações');
  if (updated.name !== payload.name || updated.timezone !== payload.timezone) {
    throw new Error('Os dados salvos não foram retornados corretamente.');
  }

  const stale = await app.inject({ method: 'PATCH', url: '/tenants/current', headers: managerHeaders, payload });
  if (stale.statusCode !== 409) throw new Error('Uma versão desatualizada sobrescreveu configurações recentes.');
  const invalidTimezone = await app.inject({
    method: 'PATCH', url: '/tenants/current', headers: managerHeaders,
    payload: { ...payload, updatedAt: updated.updatedAt, timezone: 'Brazil/Invalid' },
  });
  if (invalidTimezone.statusCode !== 400) throw new Error('Um fuso horário inválido foi aceito.');

  const auditPool = createPool(env);
  const auditCount = await withTransaction(auditPool, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rastreia.audit_logs
       WHERE tenant_id = $1 AND action = 'tenant.updated' AND actor_user_id = $2`,
      [tenantId, managerId],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  await auditPool.end();
  if (auditCount !== 1) throw new Error('A alteração não gerou exatamente um registro de auditoria.');

  process.stdout.write(`${JSON.stringify({
    ok: true, managerOnlyWrite: true, optimisticConcurrency: true,
    timezoneValidated: true, capabilitiesWithoutSecrets: true, auditRecorded: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      await client.query('DELETE FROM rastreia.refresh_sessions WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.audit_logs WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.tenant_users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.users WHERE id = ANY($1::uuid[])', [[managerId, operatorId]]);
      await client.query('DELETE FROM rastreia.tenants WHERE id = $1', [tenantId]);
    });
  } finally {
    await cleanup.end();
  }
}
