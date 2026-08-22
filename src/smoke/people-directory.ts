import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string; userId?: string }

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
if (!env.BOOTSTRAP_TENANT_SLUG || !env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('Preencha as credenciais BOOTSTRAP_* para o smoke do diretório.');
}

const runId = randomUUID();
const suffix = runId.slice(0, 8);
const secondTenantId = randomUUID();
const secondManagerId = randomUUID();
const secondSlug = `people-${suffix}`;
const secondManagerEmail = `people-manager-${runId}@example.invalid`;
const secondManagerPassword = `People-manager-${runId}`;
const staffEmail = `people-staff-${runId}@example.invalid`;
const courierEmail = `people-courier-${runId}@example.invalid`;
const sharedPassword = `People-shared-${runId}`;
let firstStoreId: string | undefined;
let secondStoreId: string | undefined;
let staffUserId: string | undefined;
let courierUserId: string | undefined;
let courierProfileId: string | undefined;

const setup = createPool(env);
await withTransaction(setup, async (client) => {
  const managerHash = await argon2.hash(secondManagerPassword, {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  });
  await client.query('INSERT INTO rastreia.tenants (id, slug, name) VALUES ($1, $2, $3)', [
    secondTenantId, secondSlug, `Empresa Pessoas ${suffix}`,
  ]);
  await client.query('INSERT INTO rastreia.users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)', [
    secondManagerId, 'Gestor Pessoas Smoke', secondManagerEmail, managerHash,
  ]);
  await client.query(
    `INSERT INTO rastreia.tenant_users (tenant_id, user_id, role, created_by, updated_by)
     VALUES ($1, $2, 'TENANT_MANAGER', $2, $2)`,
    [secondTenantId, secondManagerId],
  );
});
await setup.end();

const app = await buildApp({ env });
try {
  const firstManager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login do primeiro gestor');
  const secondManager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: secondSlug, email: secondManagerEmail, password: secondManagerPassword,
  } }), 200, 'login do segundo gestor');
  const firstHeaders = { authorization: `Bearer ${firstManager.accessToken}` };
  const secondHeaders = { authorization: `Bearer ${secondManager.accessToken}` };

  firstStoreId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: firstHeaders, payload: {
    name: `Loja Pessoas A ${suffix}`, addressLine: 'Avenida Paulista', city: 'São Paulo', state: 'SP',
    latitude: -23.5614, longitude: -46.6559,
  } }), 201, 'criar loja A').id;
  secondStoreId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: secondHeaders, payload: {
    name: `Loja Pessoas B ${suffix}`, addressLine: 'Rua Vergueiro', city: 'São Paulo', state: 'SP',
    latitude: -23.5733, longitude: -46.6404,
  } }), 201, 'criar loja B').id;

  const staff = body<EntityBody>(await app.inject({ method: 'POST', url: '/users', headers: firstHeaders, payload: {
    name: 'Operador Pessoas Smoke', email: staffEmail, password: sharedPassword,
    role: 'STORE_OPERATOR', storeIds: [firstStoreId],
  } }), 201, 'criar operador');
  staffUserId = staff.id;
  const staffLogin = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: staffEmail, password: sharedPassword,
  } }), 200, 'login do operador');
  const staffHeaders = { authorization: `Bearer ${staffLogin.accessToken}` };
  body(await app.inject({ method: 'POST', url: '/users/link', headers: secondHeaders, payload: {
    email: staffEmail, role: 'STORE_OPERATOR', storeIds: [secondStoreId],
  } }), 201, 'vincular operador ao segundo tenant');
  body(await app.inject({ method: 'PATCH', url: `/users/${staffUserId}`, headers: firstHeaders, payload: {
    role: 'STORE_OPERATOR', status: 'BLOCKED', storeIds: [firstStoreId], reason: 'Validação de bloqueio imediato',
  } }), 200, 'bloquear operador no primeiro tenant');
  const blockedStaff = await app.inject({ method: 'GET', url: '/stores', headers: staffHeaders });
  if (blockedStaff.statusCode !== 401) throw new Error('Access token do operador bloqueado continuou válido.');
  body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: secondSlug, email: staffEmail, password: sharedPassword,
  } }), 200, 'login do operador no segundo tenant');

  const courier = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: firstHeaders, payload: {
    name: 'Entregador Pessoas Smoke', email: courierEmail, password: sharedPassword,
    phone: '+5511999999999', vehicleType: 'MOTORCYCLE', storeIds: [firstStoreId],
  } }), 201, 'criar entregador');
  courierProfileId = courier.id;
  courierUserId = courier.userId;
  const firstCourier = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: courierEmail, password: sharedPassword,
  } }), 200, 'login do entregador no primeiro tenant');
  body(await app.inject({ method: 'POST', url: '/couriers/link', headers: secondHeaders, payload: {
    email: courierEmail, storeIds: [secondStoreId],
  } }), 201, 'vincular entregador ao segundo tenant');
  const secondCourier = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: secondSlug, email: courierEmail, password: sharedPassword,
  } }), 200, 'login do entregador no segundo tenant');
  body(await app.inject({ method: 'PATCH', url: `/couriers/${courierProfileId}`, headers: firstHeaders, payload: {
    status: 'BLOCKED', storeIds: [firstStoreId], reason: 'Validação de bloqueio isolado por tenant',
  } }), 200, 'bloquear entregador no primeiro tenant');
  const blockedCourier = await app.inject({
    method: 'GET', url: '/tenants/current', headers: { authorization: `Bearer ${firstCourier.accessToken}` },
  });
  if (blockedCourier.statusCode !== 401) throw new Error('Access token do entregador bloqueado continuou válido.');
  body(await app.inject({
    method: 'GET', url: '/tenants/current', headers: { authorization: `Bearer ${secondCourier.accessToken}` },
  }), 200, 'manter entregador ativo no segundo tenant');

  const firstDirectory = body<{ data: EntityBody[] }>(await app.inject({
    method: 'GET', url: '/couriers', headers: firstHeaders,
  }), 200, 'listar entregador bloqueado');
  const secondDirectory = body<{ data: EntityBody[] }>(await app.inject({
    method: 'GET', url: '/couriers', headers: secondHeaders,
  }), 200, 'listar entregador vinculado');
  if (!firstDirectory.data.some((item) => item.id === courierProfileId)
      || !secondDirectory.data.some((item) => item.id === courierProfileId)) {
    throw new Error('O perfil único não apareceu nos dois diretórios autorizados.');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true, uniqueCourierAcrossTenants: true, existingUserLinked: true,
    blockedAccessInvalidatedImmediately: true, tenantScopedBlock: true, inactivePeopleRemainVisible: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      const userIds = [staffUserId, courierUserId, secondManagerId].filter((id): id is string => Boolean(id));
      await client.query('DELETE FROM rastreia.audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR entity_id = ANY($1::uuid[])', [userIds]);
      await client.query('DELETE FROM rastreia.refresh_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await client.query('DELETE FROM rastreia.user_store_access WHERE tenant_user_id IN (SELECT id FROM rastreia.tenant_users WHERE user_id = ANY($1::uuid[]))', [userIds]);
      if (courierProfileId) await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = $1', [courierProfileId]);
      await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = ANY($1::uuid[])', [userIds]);
      if (courierProfileId) await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierProfileId]);
      await client.query('DELETE FROM rastreia.users WHERE id = ANY($1::uuid[])', [userIds]);
      const storeIds = [firstStoreId, secondStoreId].filter((id): id is string => Boolean(id));
      await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [storeIds]);
      await client.query('DELETE FROM rastreia.stores WHERE id = ANY($1::uuid[])', [storeIds]);
      await client.query('DELETE FROM rastreia.refresh_sessions WHERE tenant_id = $1', [secondTenantId]);
      await client.query('DELETE FROM rastreia.audit_logs WHERE tenant_id = $1', [secondTenantId]);
      await client.query('DELETE FROM rastreia.tenants WHERE id = $1', [secondTenantId]);
    });
  } finally {
    await cleanup.end();
  }
}
