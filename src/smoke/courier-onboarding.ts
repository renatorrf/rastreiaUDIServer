import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { createObjectStorage } from '../integrations/objects/object-storage.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string; status?: string }
interface OnboardingBody {
  readiness: { state: string; required: number; completedRequired: number };
  documents: Array<{ id: string; status: string }>;
  vehicles: Array<{ plateMasked: string | null }>;
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

function multipartPdf(boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from('%PDF-1.4\n% synthetic onboarding smoke\n'), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const suffix = runId.slice(0, 8);
const tenantId = randomUUID();
const managerId = randomUUID();
const courierUserId = randomUUID();
const courierProfileId = randomUUID();
const slug = `onboarding-${suffix}`;
const managerEmail = `onboarding-manager-${runId}@example.invalid`;
const courierEmail = `onboarding-courier-${runId}@example.invalid`;
const password = `Onboarding-smoke-${runId}`;
let storedObjectKey: string | undefined;

const setup = createPool(env);
await withTransaction(setup, async (client) => {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  });
  await client.query('INSERT INTO rastreia.tenants (id, slug, name) VALUES ($1,$2,$3)',
    [tenantId, slug, `Onboarding Smoke ${suffix}`]);
  await client.query(
    `INSERT INTO rastreia.users (id, name, email, password_hash) VALUES
       ($1, 'Gestor Onboarding', $2, $5), ($3, 'Entregador Onboarding', $4, $5)`,
    [managerId, managerEmail, courierUserId, courierEmail, passwordHash],
  );
  await client.query(
    `INSERT INTO rastreia.tenant_users (tenant_id, user_id, role, created_by, updated_by) VALUES
       ($1,$2,'TENANT_MANAGER',$2,$2), ($1,$3,'COURIER',$2,$2)`, [tenantId, managerId, courierUserId],
  );
  await client.query(
    `INSERT INTO rastreia.courier_profiles (id, user_id, phone, vehicle_type, status)
     VALUES ($1,$2,'+5511999999999','OTHER','ACTIVE')`, [courierProfileId, courierUserId],
  );
});
await setup.end();

const app = await buildApp({ env });
try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: slug, email: managerEmail, password,
  } }), 200, 'login do gestor');
  const courier = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: slug, email: courierEmail, password,
  } }), 200, 'login do entregador');
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  const courierHeaders = { authorization: `Bearer ${courier.accessToken}` };

  const initial = body<OnboardingBody>(await app.inject({ method: 'GET', url: '/onboarding/me', headers: courierHeaders }),
    200, 'consultar onboarding sem regras');
  if (initial.readiness.state !== 'NOT_CONFIGURED') throw new Error('Empresa sem requisitos foi marcada como pronta.');

  const requirement = body<EntityBody>(await app.inject({
    method: 'POST', url: '/onboarding/requirements', headers: managerHeaders,
    payload: { code: 'identidade', label: 'Documento de identidade', description: 'Regra sintética',
      required: true, requiresReview: true, requiresExpiry: false, active: true, sortOrder: 10 },
  }), 201, 'criar requisito configurável');

  const boundary = `onboarding-${suffix}`;
  const uploaded = body<EntityBody>(await app.inject({
    method: 'POST', url: `/onboarding/me/documents/${requirement.id}`,
    headers: { ...courierHeaders, 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartPdf(boundary),
  }), 201, 'enviar documento privado');
  if (uploaded.status !== 'PENDING') throw new Error('Documento sujeito a revisão não ficou pendente.');

  const vehicle = body<{ plateMasked: string }>(await app.inject({
    method: 'POST', url: '/onboarding/me/vehicles', headers: courierHeaders,
    payload: { typeLabel: 'Utilitário leve', plate: 'ABC1D23', capacityKg: 350, notes: 'Veículo sintético' },
  }), 201, 'cadastrar veículo');
  if (vehicle.plateMasked !== '***1D23') throw new Error('A placa completa foi retornada ou mascarada incorretamente.');

  const queue = body<{ data: EntityBody[] }>(await app.inject({
    method: 'GET', url: '/onboarding/review-queue', headers: managerHeaders,
  }), 200, 'listar fila de revisão');
  if (!queue.data.some((item) => item.id === uploaded.id)) throw new Error('Documento pendente não apareceu na fila.');
  const privateFile = await app.inject({
    method: 'GET', url: `/onboarding/documents/${uploaded.id}/file`, headers: managerHeaders,
  });
  if (privateFile.statusCode !== 200 || !privateFile.headers['content-type']?.startsWith('application/pdf')) {
    throw new Error('Gestor autorizado não conseguiu abrir o documento privado.');
  }

  const reviewKey = randomUUID();
  body(await app.inject({ method: 'POST', url: `/onboarding/documents/${uploaded.id}/review`,
    headers: { ...managerHeaders, 'idempotency-key': reviewKey },
    payload: { status: 'APPROVED', notes: 'Documento sintético válido' },
  }), 200, 'aprovar documento');
  const replay = await app.inject({ method: 'POST', url: `/onboarding/documents/${uploaded.id}/review`,
    headers: { ...managerHeaders, 'idempotency-key': reviewKey },
    payload: { status: 'APPROVED', notes: 'Documento sintético válido' },
  });
  if (replay.statusCode !== 200 || replay.headers['idempotency-replayed'] !== 'true') {
    throw new Error('A revisão não preservou idempotência.');
  }

  const completed = body<OnboardingBody>(await app.inject({ method: 'GET', url: '/onboarding/me', headers: courierHeaders }),
    200, 'consultar onboarding concluído');
  if (completed.readiness.state !== 'READY' || completed.readiness.completedRequired !== 1
      || completed.documents[0]?.status !== 'APPROVED' || completed.vehicles[0]?.plateMasked !== '***1D23') {
    throw new Error('O contexto final do onboarding está inconsistente.');
  }

  const lookup = createPool(env);
  storedObjectKey = await withTransaction(lookup, async (client) => {
    const result = await client.query<{ object_key: string }>(
      'SELECT object_key FROM rastreia.courier_documents WHERE id = $1', [uploaded.id]);
    return result.rows[0]?.object_key;
  });
  await lookup.end();

  process.stdout.write(`${JSON.stringify({
    ok: true, configurableRequirements: true, noDefaultGate: true, privatePdf: true,
    managerReview: true, idempotentReview: true, readiness: 'READY', plateMinimized: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      await client.query('DELETE FROM rastreia.outbox_events WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.audit_logs WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.onboarding_events WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.courier_documents WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.courier_vehicles WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.onboarding_requirements WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.refresh_sessions WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.tenant_users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierProfileId]);
      await client.query('DELETE FROM rastreia.users WHERE id = ANY($1::uuid[])', [[managerId, courierUserId]]);
      await client.query('DELETE FROM rastreia.tenants WHERE id = $1', [tenantId]);
    });
  } finally {
    await cleanup.end();
  }
  if (storedObjectKey) await createObjectStorage(env).remove(storedObjectKey);
}
